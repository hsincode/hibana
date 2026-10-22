import { describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import { loadConfig } from "../config";
import { ProviderError } from "../llm-errors";
import type { Context } from "../types";
import { createWorkspaceClient, SessionGone } from "../workspace/client";
import {
  abortKind,
  budgetNotice,
  openRunsNotice,
  quiesce,
  runTurn,
  timeoutNotice,
  type TurnInput,
  type TurnResult,
} from "../workspace/runner";
import type {
  RawEvent,
  WorkspaceCall,
  WorkspaceResult,
} from "../workspace/types";
import { offline } from "./workspace-offline";

// Decision record: #76. One turn of an Anthropic Workspace session against a
// session that lives in this file: the requests the runner makes, in what
// order, and what it does with the events it is given. Nothing is sent, and
// the waits between reconnects are skipped.
// Should the client ever turn to the global `fetch`, that reaches no host.
offline();

type Json = Record<string, any>;
type Sent = {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: Json;
};
const SESSION = "/v1/sessions/sesn_1";
const usd = (amount: number) => ({ amount: String(amount), currency: "USD" });
// `retry-after-ms` keeps the SDK's own retries (two, as in production) from
// taking seconds; it changes when a request is tried again, not whether.
const rejected = (
  status: number,
  error: Json = { type: "invalid_request_error", message: "upstream text" },
) =>
  Response.json(
    { type: "error", error },
    { status, headers: { "retry-after-ms": "1" } },
  );

/**
 * One session of the Managed Agents API. Tests set its state, decide what it
 * emits and when, and read back every request. An emitted event goes to the
 * open stream and into the list, as on the real API.
 *
 * What it does at its budget follows the public documentation ("When a
 * session reaches its budget", "Resume a session at its budget"): there it
 * takes no `user.message`, an interrupt is accepted and stops nothing, a new
 * budget has to be above what was used, and an accepted one resumes the work
 * the budget had paused without anything more from the client.
 */
class FakeSession {
  sent: Sent[] = [];
  state: Json;
  history: RawEvent[] = [];
  /** Called when the turn's message arrives; what it emits is the turn. */
  onMessage: (fake: FakeSession) => void = () => {};
  onResult: (event: Json, fake: FakeSession) => void = () => {};
  /** An interrupt that found something to stop. Not called at the budget. */
  onInterrupt: (fake: FakeSession) => void = () => {};
  /** The budget was raised on a session paused at it: what was paused goes on. */
  onResume: (fake: FakeSession) => void = () => {};
  onStream: (fake: FakeSession, opened: number) => void = () => {};
  /** Events one page of the list holds. */
  pageSize = Infinity;
  private routes = new Map<string, (request: Sent) => Response | undefined>();
  private streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  private n = 0;
  private message?: RawEvent;
  readonly client = createWorkspaceClient(
    loadConfig({
      ANTHROPIC_WORKSPACE_API_KEY: "fixture",
      RUNTIME_STATE_PATH: "",
      LOG_DIR: "",
    }),
    // The client's own default of two retries is kept, as in production: what
    // must be sent only once has to say so itself.
    {
      fetch: ((input: unknown, init?: RequestInit) =>
        this.fetch(input, init)) as unknown as typeof fetch,
    },
  );

  /** By default at rest as the last turn left it: 40 cents used, the budget lowered to 41. */
  constructor(
    state: {
      status?: string;
      budget?: number | null;
      used?: number | null;
      usage?: Json;
    } = {},
  ) {
    this.state = {
      id: "sesn_1",
      type: "session",
      status: state.status ?? "idle",
      archived_at: null,
      budget:
        state.budget === null
          ? null
          : { type: "limit", max_list_cost: usd(state.budget ?? 41) },
      usage:
        state.usage ??
        (state.used === null
          ? {}
          : { list_cost: usd(state.used ?? 40), input_tokens: 10 }),
    };
  }

  /** Replaces one route's answer; returning nothing falls through to the default. */
  on(key: string, reply: (request: Sent) => Response | undefined) {
    this.routes.set(key, reply);
  }
  of(method: string, path: string) {
    return this.sent.filter((r) => r.method === method && r.path === path);
  }
  /** Request lines in order, with what was sent for the ones that send events. */
  get log() {
    return this.sent.map((r) => {
      const types = r.body?.events?.map((e: Json) => e.type).join("+");
      const budget = r.body?.budget?.max_list_cost?.amount;
      return `${r.method} ${r.path.replace(SESSION, "") || "/"}${types ? ` ${types}` : ""}${budget ? ` budget=${budget}` : ""}`;
    });
  }
  events(type: string) {
    return this.of("POST", `${SESSION}/events`)
      .flatMap((r) => r.body!.events as Json[])
      .filter((e) => e.type === type);
  }
  get streamsOpened() {
    return this.of("GET", `${SESSION}/events/stream`).length;
  }

  /** Emits events: each gets an id and a time unless it brings its own. */
  emit(...events: Json[]) {
    for (const event of events) {
      const full = {
        id: `sevt_${++this.n}`,
        processed_at: new Date(
          Date.UTC(2026, 9, 12, 0, 0, this.n),
        ).toISOString(),
        ...event,
      } as RawEvent;
      this.history.push(full);
      this.write(`event: ${full.type}\ndata: ${JSON.stringify(full)}\n\n`);
    }
  }
  /** Into the list only: what happened while no stream was open. */
  missed(...events: Json[]) {
    for (const event of events)
      this.history.push({
        id: `sevt_${++this.n}`,
        processed_at: new Date(
          Date.UTC(2026, 9, 12, 0, 0, this.n),
        ).toISOString(),
        ...event,
      } as RawEvent);
  }
  write(text: string) {
    try {
      this.streams.at(-1)?.enqueue(new TextEncoder().encode(text));
    } catch {}
  }
  /** Ends the open stream, as a dropped connection would. */
  drop() {
    try {
      this.streams.at(-1)?.close();
    } catch {}
  }
  /** The turn's message leaves the queue: it is echoed again, now processed.
   *  `at` gives it a time of its own; `echo: false` leaves the stream out. */
  process(how: { at?: string; echo?: boolean } = {}) {
    if (!this.message || this.message.processed_at) return;
    this.history = this.history.filter((e) => e !== this.message);
    this.message = {
      ...this.message,
      processed_at:
        how.at ?? new Date(Date.UTC(2026, 9, 12, 0, 0, ++this.n)).toISOString(),
    };
    this.history.push(this.message);
    if (how.echo !== false)
      this.write(
        `event: user.message\ndata: ${JSON.stringify(this.message)}\n\n`,
      );
  }
  use(amount: number, more: Json = {}) {
    this.state.usage = { ...this.state.usage, list_cost: usd(amount), ...more };
  }
  get used() {
    return Number(this.state.usage?.list_cost?.amount ?? 0);
  }
  /** Paused at its budget: what it has used has reached the limit. */
  get capped() {
    return (
      !!this.state.budget &&
      Number(this.state.budget.max_list_cost.amount) <= this.used
    );
  }

  private async fetch(input: unknown, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const request: Sent = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    this.sent.push(request);
    const key = `${request.method} ${request.path}`;
    const replaced = this.routes.get(key)?.(request);
    if (replaced) return replaced;
    switch (key) {
      case `GET ${SESSION}`:
        return Response.json(this.state);
      case `POST ${SESSION}`: {
        if (!request.body?.budget) return Response.json(this.state);
        if (!(Number(request.body.budget.max_list_cost.amount) > this.used))
          return rejected(400, {
            type: "invalid_request_error",
            message:
              "budget.max_list_cost must be greater than the session's consumed list cost",
          });
        const paused = this.capped;
        this.state.budget = request.body.budget;
        if (paused) this.onResume(this);
        return Response.json(this.state);
      }
      case `GET ${SESSION}/events/stream`: {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.streams.push(controller);
          },
        });
        // The session's own clock, a tick past everything it has emitted.
        const date = new Date(
          Date.UTC(2026, 9, 12, 0, 0, ++this.n),
        ).toUTCString();
        this.onStream(this, this.streams.length);
        return new Response(body, {
          headers: { "content-type": "text/event-stream", date },
        });
      }
      case `GET ${SESSION}/events`: {
        const types = request.query.getAll("types[]");
        const data = this.history.filter(
          (e) => !types.length || types.includes(e.type),
        );
        if (request.query.get("order") === "desc") data.reverse();
        const from = Number(request.query.get("page") ?? 0),
          to = from + this.pageSize;
        return Response.json({
          data: data.slice(from, to),
          next_page: to < data.length ? String(to) : null,
        });
      }
      case `POST ${SESSION}/events`: {
        const events = request.body!.events as Json[];
        // One event the session does not take refuses the whole request.
        if (
          this.capped &&
          events.some((event) => event.type === "user.message")
        )
          return rejected(400, {
            type: "invalid_request_error",
            message:
              "at its budget the session accepts only user.tool_confirmation, user.tool_result, user.custom_tool_result and user.interrupt",
          });
        // In the order they were sent: an interrupt ahead of a message ends
        // what was running before the message is taken up.
        const data: Json[] = [];
        for (const event of events) {
          if (event.type === "user.message") {
            // Queued first: no `processed_at` until the agent takes it up.
            this.message = {
              id: "sevt_msg",
              type: "user.message",
              content: event.content,
              processed_at: null,
            };
            this.history.push(this.message);
            this.write(
              `event: user.message\ndata: ${JSON.stringify(this.message)}\n\n`,
            );
            this.onMessage(this);
            data.push(this.message);
            continue;
          }
          if (event.type === "user.interrupt" && !this.capped)
            this.onInterrupt(this);
          if (event.type === "user.custom_tool_result") {
            this.history.push({
              id: `sevt_${++this.n}`,
              processed_at: new Date().toISOString(),
              ...event,
            } as RawEvent);
            this.onResult(event, this);
          }
          data.push({ id: `sevt_${++this.n}`, ...event });
        }
        return Response.json({ data });
      }
    }
    return rejected(404, { type: "not_found_error", message: "no such route" });
  }
}

const said = (text: string): Json => ({
  type: "agent.message",
  content: [{ type: "text", text }],
});
const idle = (type = "end_turn", more: Json = {}): Json => ({
  type: "session.status_idle",
  stop_reason: { type, ...more },
  stop_details: null,
});
const running = (): Json => ({ type: "session.status_running" });
const reported = (amount: number, more: Json = {}): Json => ({
  type: "session.usage",
  usage: { list_cost: usd(amount), ...more },
});
const calls = (
  name: string,
  id: string,
  input: Json = {},
  thread?: string,
): Json => ({
  type: "agent.custom_tool_use",
  id,
  name,
  input,
  ...(thread && { session_thread_id: thread }),
});
const ok = (text: string): WorkspaceResult => ({
  content: [{ type: "text", text }],
  is_error: false,
});
/** A whole plain answer: the message is taken up, the model replies, the session rests. */
const answers =
  (text: string, used = 57) =>
  (fake: FakeSession) => {
    fake.process();
    fake.use(used);
    fake.emit(running(), said(text), reported(used), idle());
  };

const context = (extra: Partial<Context> = {}): Context => ({
  channelId: "10",
  userId: "20",
  botId: "30",
  thread: false,
  depth: 0,
  delivered: false,
  harness: "workspace",
  ...extra,
});
function turn(fake: FakeSession, over: Partial<TurnInput> = {}): TurnInput {
  return {
    client: fake.client,
    sessionId: "sesn_1",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: "hello" }],
    ctx: context(),
    signal: new AbortController().signal,
    budget: { allowCents: 100 },
    deadlineAt: Date.now() + 60_000,
    executeTool: async () => ok("done"),
    limits: {
      idleMs: 10_000,
      reconnects: 2,
      graceMs: 30,
      interruptWaitMs: 60,
      settleMs: 60,
      timeoutMs: 1_200_000,
    },
    hooks: { sleep: async () => {} },
    ...over,
  };
}
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the condition never held");
    await Bun.sleep(1);
  }
}
async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("the turn did not fail");
}

describe("a turn", () => {
  test("raises the budget, opens the stream, sends once, and takes the rest of the allowance back", async () => {
    const fake = new FakeSession({ budget: 41, used: 40 });
    fake.onMessage = answers("こんにちは");
    const order: string[] = [];
    const result = await runTurn(
      turn(fake, {
        onLease: (ceiling) => {
          order.push(`lease ${ceiling} after ${fake.sent.length} requests`);
        },
        onSent: async (mark) => {
          order.push(`sent ${mark.eventId} ${mark.ceilingCents}`);
        },
      }),
    );
    expect(fake.log).toEqual([
      "GET /",
      "POST / budget=140",
      "GET /events/stream",
      "POST /events user.message",
      "GET /",
      "POST / budget=58",
    ]);
    expect(order).toEqual(["lease 140 after 1 requests", "sent sevt_msg 140"]);
    expect(fake.events("user.message")).toEqual([
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(result).toMatchObject({
      text: "こんにちは",
      stop: "end_turn",
      rounds: 0,
      costReported: true,
      released: true,
      openRuns: [],
      runsStarted: [],
      compacted: false,
    });
    expect(result.notice).toBeUndefined();
    expect(result.cumulative?.list_cost_cents).toBe(57);
  });

  test("the final text is what the last model request said; what came before a tool call is passed on", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        { type: "span.model_request_start" },
        said("調べます。"),
        {
          type: "agent.tool_use",
          name: "bash",
          input: { command: "ls" },
          evaluated_permission: "allow",
        },
        {
          type: "span.model_request_end",
          is_error: false,
          model_usage: {
            input_tokens: 50,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        { type: "agent.tool_result", tool_use_id: "x" },
        { type: "span.model_request_start" },
        said("一つ目。"),
        said("二つ目。"),
        {
          type: "span.model_request_end",
          is_error: false,
          model_usage: {
            input_tokens: 100,
            output_tokens: 30,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
        },
        { type: "agent.thread_context_compacted" },
        idle(),
      );
    };
    const spoken: string[] = [],
      seen: string[] = [];
    const result = await runTurn(
      turn(fake, {
        say: (text) => {
          spoken.push(text);
        },
        observe: (event) => {
          seen.push(event.type);
          if (event.type === "agent.tool_use")
            throw new Error("a progress bug");
        },
      }),
    );
    expect(result.text).toBe("一つ目。\n\n二つ目。");
    expect(spoken).toEqual(["調べます。"]);
    expect(result).toMatchObject({ rounds: 2, context: 155, compacted: true });
    // Everything after the turn's own message, in order, and a thrown observer changes nothing.
    expect(seen.slice(0, 4)).toEqual([
      "session.status_running",
      "span.model_request_start",
      "agent.message",
      "agent.tool_use",
    ]);
    expect(seen.at(-1)).toBe("session.status_idle");
  });

  test("answers a custom tool call when it arrives, one result per request", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      // No idle in between: with a workflow run open there may never be one.
      f.emit(
        running(),
        {
          type: "session.thread_created",
          session_thread_id: "sth_1",
          agent_name: "worker",
          workflow_run_id: "wrun_1",
        },
        calls("read_messages", "call_a", { limit: 5 }),
        calls("guild_info", "call_b", {}, "sth_1"),
      );
    };
    const results: Json[] = [];
    fake.onResult = (event, f) => {
      results.push(event);
      if (results.length === 2) f.emit(said("読みました。"), idle());
    };
    const executed: WorkspaceCall[] = [];
    const input = turn(fake, {
      executeTool: async (call, ctx) => {
        executed.push(call);
        ctx.delivered = true;
        return call.id === "call_a"
          ? ok("five messages")
          : {
              content: [{ type: "text", text: "not allowed" }],
              is_error: true,
            };
      },
    });
    const result = await runTurn(input);
    expect(result.text).toBe("読みました。");
    expect(executed).toEqual([
      {
        id: "call_a",
        name: "read_messages",
        input: { limit: 5 },
        threadId: null,
        runId: null,
      },
      // A call from a run's thread names the thread and the run it belongs to.
      {
        id: "call_b",
        name: "guild_info",
        input: {},
        threadId: "sth_1",
        runId: "wrun_1",
      },
    ]);
    const posts = fake
      .of("POST", `${SESSION}/events`)
      .filter((r) => r.body!.events[0].type === "user.custom_tool_result");
    expect(posts.map((r) => r.body!.events)).toEqual([
      [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: "call_a",
          content: [{ type: "text", text: "five messages" }],
          is_error: false,
        },
      ],
      [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: "call_b",
          content: [{ type: "text", text: "not allowed" }],
          is_error: true,
        },
      ],
    ]);
    // What a tool recorded on the context it was given reaches the turn's own.
    expect(input.ctx.delivered).toBe(true);
  });

  test("denies a tool call that asks for permission: nobody is there to grant it", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        {
          type: "agent.tool_use",
          id: "tool_1",
          name: "bash",
          input: {},
          evaluated_permission: "ask",
        },
        said("できませんでした。"),
        idle(),
      );
    };
    await runTurn(turn(fake));
    expect(fake.events("user.tool_confirmation")).toMatchObject([
      { tool_use_id: "tool_1", result: "deny" },
    ]);
  });

  test("does not finish while a workflow run is open", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      // The agent's own turn ends, but the run it started is only beginning.
      f.emit(
        running(),
        {
          type: "workflow_run.created",
          workflow_run_id: "wrun_1",
          name: "survey",
          description: null,
          phases: [],
        },
        said("調査を始めました。"),
        idle(),
        { type: "workflow_run.status_running", workflow_run_id: "wrun_1" },
      );
    };
    const spoken: string[] = [];
    let done = false;
    const work = runTurn(
      turn(fake, {
        say: (text) => {
          spoken.push(text);
        },
      }),
    );
    void work.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    // Well past the grace period, and the turn is still waiting for the run.
    await Bun.sleep(100);
    expect(done).toBe(false);
    fake.emit(
      {
        type: "workflow_run.status_ended",
        workflow_run_id: "wrun_1",
        result: { type: "completed" },
      },
      running(),
      { type: "span.model_request_start" },
      said("調査が終わりました。"),
      idle(),
    );
    const result = await work;
    expect(result).toMatchObject({
      text: "調査が終わりました。",
      stop: "end_turn",
      openRuns: [],
      runsStarted: [{ id: "wrun_1", name: "survey" }],
    });
    expect(result.notice).toBeUndefined();
    expect(spoken).toEqual(["調査を始めました。"]);
  });

  test("what the model writes when it stops with a run open is passed on while the run works, and only once", async () => {
    const request = (type: "start" | "end"): Json => ({
      type: `span.model_request_${type}`,
      ...(type === "end" && {
        is_error: false,
        model_usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      // The model says what it is about to do, starts the run with a tool
      // call, then writes its one line and stops, as the Ultra prompt asks.
      // No idle follows: the session stays running while the run works.
      f.emit(
        running(),
        request("start"),
        said("12 件に分けて調べます。"),
        {
          type: "agent.tool_use",
          name: "start_workflow",
          input: {},
          evaluated_permission: "allow",
        },
        {
          type: "workflow_run.created",
          workflow_run_id: "wrun_1",
          name: "survey",
          description: null,
          phases: [],
        },
        { type: "workflow_run.status_running", workflow_run_id: "wrun_1" },
        request("end"),
        request("start"),
        said("40 件のファイルを確認する run を始めました。"),
        request("end"),
      );
    };
    const spoken: string[] = [];
    const work = runTurn(
      turn(fake, {
        say: (text) => {
          spoken.push(text);
        },
      }),
    );
    await until(() => fake.events("user.message").length === 1);
    // The run works for a while: several times this test's grace period.
    await Bun.sleep(100);
    expect(spoken).toEqual([
      "12 件に分けて調べます。",
      "40 件のファイルを確認する run を始めました。",
    ]);
    fake.emit(
      {
        type: "workflow_run.status_ended",
        workflow_run_id: "wrun_1",
        result: { type: "completed" },
      },
      running(),
      request("start"),
      said("確認が終わりました。"),
      request("end"),
      idle(),
    );
    const result = await work;
    // Shown already, so not said again when the next request begins; and the reply is the last request's.
    expect(spoken).toEqual([
      "12 件に分けて調べます。",
      "40 件のファイルを確認する run を始めました。",
    ]);
    expect(result.text).toBe("確認が終わりました。");

    // A request that ends in a tool call has passed its text on already, and
    // without a run open nothing is shown early: it may be the reply.
    const plain = new FakeSession();
    plain.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        request("start"),
        said("これが返事です。"),
        request("end"),
      );
      setTimeout(() => f.emit(idle()), 60);
    };
    const early: string[] = [];
    expect(
      (
        await runTurn(
          turn(plain, {
            say: (text) => {
              early.push(text);
            },
          }),
        )
      ).text,
    ).toBe("これが返事です。");
    expect(early).toEqual([]);
  });

  test("finishes with a note when a run stays paused past the grace period", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        {
          type: "workflow_run.created",
          workflow_run_id: "wrun_1",
          name: "survey",
          description: null,
          phases: [],
        },
        { type: "workflow_run.status_idle", workflow_run_id: "wrun_1" },
        said("途中です。"),
        idle(),
      );
    };
    const result = await runTurn(turn(fake));
    expect(result).toMatchObject({
      text: "途中です。",
      stop: "end_turn",
      released: true,
      openRuns: [{ id: "wrun_1", name: "survey" }],
    });
    expect(result.notice).toBe(
      "バックグラウンドの作業（workflow run）が 1 件、止まったまま残っています。続けるには「続けて」と送ってください。",
    );
    expect(result.notice).toBe(openRunsNotice(1));
    // Idle already: lowering the budget is what keeps the paused run from spending.
    expect(fake.events("user.interrupt")).toHaveLength(0);
    expect(fake.log.at(-1)).toBe("POST / budget=41");
  });

  test("stops at the budget and then leaves the budget alone", async () => {
    const fake = new FakeSession({ budget: 41, used: 40 });
    fake.onMessage = (f) => {
      f.process();
      f.use(143);
      f.emit(
        running(),
        said("ここまで。"),
        reported(143),
        idle("budget_reached"),
      );
    };
    const result = await runTurn(turn(fake));
    expect(result).toMatchObject({
      text: "ここまで。",
      stop: "budget",
      released: true,
    });
    expect(result.notice).toBe(
      "このターンの費用の上限（$1.00）に達したため、ここで止めました。続けるには、もう一度メッセージを送ってください。",
    );
    expect(result.cumulative?.list_cost_cents).toBe(143);
    // "Used plus a cent" would be a raise here and resume every paused thread.
    expect(
      fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount),
    ).toEqual(["140"]);
    expect(fake.events("user.interrupt")).toHaveLength(0);
  });

  test("a session left at its budget is stopped again once the budget is raised, and the turn starts at its own message", async () => {
    const fake = new FakeSession({ budget: 100, used: 100 });
    // The raise lets the paused work go on.
    fake.onResume = (f) => {
      f.state.status = "running";
      f.emit(running(), said("（止まっていた作業の続き）"));
    };
    // An interrupt after the raise ends it: its idle, and a call it made on the way out.
    fake.onInterrupt = (f) => {
      f.state.status = "idle";
      f.emit(idle(), calls("send_message", "call_old", { content: "late" }));
    };
    fake.onMessage = (f) => {
      if (f.state.status !== "running") return;
      // Nobody stopped the resumed work, so the message waits behind it
      // while the turn's allowance goes to the old request.
      f.use(195);
      f.emit(said("（止まっていた作業の結果）"), reported(195), idle());
      f.process();
      f.use(198);
      f.emit(
        running(),
        said("作業は上のとおり終わっています。"),
        reported(198),
        idle(),
      );
    };
    // Only when the old call is closed is the new message taken up.
    fake.onResult = (_event, f) => {
      f.process();
      f.use(104);
      f.emit(running(), said("新しい返事。"), reported(104), idle());
    };
    let executed = 0;
    const observed: string[] = [];
    const result = await runTurn(
      turn(fake, {
        executeTool: async () => {
          executed++;
          return ok("sent");
        },
        observe: (event) => {
          observed.push(event.type);
        },
      }),
    );
    expect(fake.log.slice(0, 5)).toEqual([
      "GET /",
      // At its budget this stops no thread. It is there for runs: one that an
      // interrupt paused stays paused when the budget goes up.
      "POST /events user.interrupt",
      "POST / budget=200",
      "GET /events/stream",
      // The raise resumed what the budget had paused. That is stopped in the
      // request that brings the message, and ahead of it.
      "POST /events user.interrupt+user.message",
    ]);
    expect(result).toMatchObject({ text: "新しい返事。", stop: "end_turn" });
    expect(result.cumulative?.list_cost_cents).toBe(104);
    expect(executed).toBe(0);
    // Progress starts with the turn, not with what was left over.
    expect(observed).toEqual([
      "session.status_running",
      "agent.message",
      "session.usage",
      "session.status_idle",
    ]);
    expect(fake.events("user.custom_tool_result")).toEqual([
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "call_old",
        is_error: true,
        content: [
          {
            type: "text",
            text: "This call belongs to an earlier turn that was stopped, so it was not run.",
          },
        ],
      },
    ]);
  });

  test("a session that was still working is interrupted before the raise, and its message goes out alone", async () => {
    const fake = new FakeSession({ status: "running", budget: 141, used: 40 });
    fake.onInterrupt = (f) => {
      f.state.status = "idle";
      f.emit(idle());
    };
    fake.onMessage = answers("止めてから答えました。");
    const result = await runTurn(turn(fake));
    expect(fake.log.slice(0, 5)).toEqual([
      "GET /",
      "POST /events user.interrupt",
      "POST / budget=140",
      "GET /events/stream",
      "POST /events user.message",
    ]);
    expect(result.text).toBe("止めてから答えました。");
  });

  test("a budget stop while the turn's message is still queued ends the turn as a budget stop", async () => {
    const fake = new FakeSession({ budget: 100, used: 100 });
    fake.onResume = (f) => {
      f.state.status = "running";
      f.emit(running());
    };
    // The interrupt is not applied while a tool call of the resumed work
    // runs, and the request after that call takes the session to its budget.
    fake.onInterrupt = () => {};
    fake.onMessage = (f) => {
      f.use(201);
      f.emit(reported(201), idle("budget_reached"));
    };
    const started = Date.now();
    const result = await runTurn(turn(fake, { deadlineAt: Date.now() + 600 }));
    // Nothing moves until the budget does: waiting for the message to be
    // taken up would last until the time limit.
    expect(Date.now() - started).toBeLessThan(400);
    expect(result).toMatchObject({ text: "", stop: "budget", released: true });
    expect(result.notice).toBe(budgetNotice(100));
    expect(result.cumulative?.list_cost_cents).toBe(201);
    // Paused at its budget: it is neither interrupted again nor is its budget
    // touched. The list was asked once whether the stop came after the message.
    expect(fake.log.slice(-3)).toEqual([
      "POST /events user.interrupt+user.message",
      "GET /events",
      "GET /",
    ]);
    expect(
      fake.history.find((event) => event.type === "user.message"),
    ).toMatchObject({ id: "sevt_msg", processed_at: null });
  });

  test("exhausted retries while the turn's message is still queued end the turn, unless the session goes on", async () => {
    const overloaded: Json = {
      type: "session.error",
      error: {
        type: "model_overloaded_error",
        message: "upstream text",
        retry_status: { type: "exhausted" },
      },
    };
    // Older work was still going. It fails for good, and with that the
    // session drops what was queued behind it: the message is never taken up.
    const fake = new FakeSession({ status: "running", budget: 141, used: 40 });
    fake.onMessage = (f) => {
      f.emit(overloaded, idle("retries_exhausted"));
    };
    const started = Date.now();
    const error = (await failure(
      runTurn(turn(fake, { deadlineAt: Date.now() + 600 })),
    )) as ProviderError;
    expect(Date.now() - started).toBeLessThan(400);
    expect([error.kind, error.retryable, error.diagnostics.type]).toEqual([
      "transient",
      true,
      "model_overloaded_error",
    ]);

    // The same, but the message is taken up after all.
    const goes = new FakeSession({ status: "running", budget: 141, used: 40 });
    goes.onMessage = (f) => {
      f.emit(overloaded, idle("retries_exhausted"));
      f.process();
      f.emit(running());
      setTimeout(() => f.emit(said("続けられました。"), idle()), 80);
    };
    expect((await runTurn(turn(goes))).text).toBe("続けられました。");
  });

  test("handles each event once across a reconnect and never runs a tool twice", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        { ...said("途中まで。"), id: "sevt_dup" },
        { ...said("途中まで。"), id: "sevt_dup" },
        calls("read_messages", "call_1"),
      );
    };
    fake.onResult = (event, f) => {
      if (event.custom_tool_use_id === "call_1") {
        // The connection drops. A second call and the model's next step happen while nothing is listening.
        f.missed(
          calls("read_messages", "call_2"),
          idle("requires_action", { event_ids: ["call_2"] }),
        );
        f.drop();
      } else
        f.emit(
          running(),
          { type: "span.model_request_start" },
          said("終わり。"),
          idle(),
        );
    };
    const executed: string[] = [];
    const spoken: string[] = [];
    const result = await runTurn(
      turn(fake, {
        executeTool: async (call) => {
          executed.push(call.id);
          return ok(call.id);
        },
        say: (text) => {
          spoken.push(text);
        },
      }),
    );
    expect(result.text).toBe("終わり。");
    expect(executed).toEqual(["call_1", "call_2"]);
    expect(
      fake.events("user.custom_tool_result").map((e) => e.custom_tool_use_id),
    ).toEqual(["call_1", "call_2"]);
    expect(spoken).toEqual(["途中まで。"]);
    expect(fake.streamsOpened).toBe(2);
    // Open, then list, then read: the list is asked for after the second stream was opened.
    const reopened = fake.log.lastIndexOf("GET /events/stream");
    expect(fake.log[reopened + 1]).toBe("GET /events");
    expect(fake.sent[reopened + 1]!.query.get("order")).toBe("desc");
    expect(fake.sent[reopened + 1]!.query.has("limit")).toBe(false);
  });

  test("gives up after the allowed number of failed reconnects, and still takes the allowance back", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running());
      f.drop();
    };
    let opened = 0;
    fake.on(`GET ${SESSION}/events/stream`, () =>
      ++opened > 1
        ? rejected(503, { type: "overloaded_error", message: "busy" })
        : undefined,
    );
    fake.state.status = "running";
    const error = await failure(
      runTurn(turn(fake, { limits: { idleMs: 10_000, reconnects: 2 } })),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      kind: "transient",
      retryable: true,
      status: 503,
    });
    expect((error as ProviderError).diagnostics).toMatchObject({
      phase: "stream",
      retries: 2,
      model: "claude-haiku-5-5",
    });
    expect(fake.streamsOpened).toBe(3);
    expect(fake.log.slice(-3)).toEqual([
      "GET /",
      "POST /events user.interrupt",
      "POST / budget=41",
    ]);
  });

  test("reopens a stream that went quiet without counting it as a failure", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running());
    };
    // Nothing more arrives on the first connection; the answer is in the list by the time it is reopened.
    fake.onStream = (f, opened) => {
      if (opened === 2) {
        f.missed(said("静かでした。"));
        f.emit(idle());
      }
    };
    const result = await runTurn(
      turn(fake, { limits: { idleMs: 40, reconnects: 0 } }),
    );
    expect(result.text).toBe("静かでした。");
    expect(fake.streamsOpened).toBe(2);
  });

  test("a ping or a comment line counts as a sign of life", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running());
      let beats = 0;
      // Half again as long as the quiet limit, in beats far shorter than it.
      const beat = setInterval(() => {
        f.write(
          ++beats % 2
            ? ": keep-alive\n\n"
            : 'event: ping\ndata: {"type":"ping"}\n\n',
        );
        if (beats === 15) {
          clearInterval(beat);
          f.emit(said("生きています。"), idle());
        }
      }, 40);
    };
    const result = await runTurn(
      turn(fake, { limits: { idleMs: 400, reconnects: 0 } }),
    );
    expect(result.text).toBe("生きています。");
    expect(fake.streamsOpened).toBe(1);
  });

  test("keeps session.usage and tolerates frames it does not know", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      // The typed stream of the SDK would drop the first of these.
      f.write(
        `event: session.usage\ndata: ${JSON.stringify({ id: "sevt_u1", processed_at: "2026-10-12T00:00:01Z", ...reported(61, { input_tokens: 900, output_tokens: 40 }) })}\n\n`,
      );
      f.write(
        `data: ${JSON.stringify({ id: "sevt_u2", processed_at: "2026-10-12T00:00:02Z", ...reported(66, { input_tokens: 1200 }) })}\n\n`,
      );
      f.write(
        'event: something.new\ndata: {"type":"something.new","id":"sevt_x","processed_at":"2026-10-12T00:00:03Z"}\n\n',
      );
      f.write('event: ping\ndata: {"type":"ping"}\n\n');
      f.write("data: {broken\n\n");
      f.write('data: {"no":"type"}\n\n');
      f.write("data: [1,2,3]\n\n");
      f.emit(said("大丈夫。"), idle());
    };
    // The session's own figure is read a moment later and can be behind the stream.
    fake.use(64, { input_tokens: 1000, output_tokens: 40 });
    const result = await runTurn(turn(fake));
    expect(result.text).toBe("大丈夫。");
    expect(result.costReported).toBe(true);
    expect(result.cumulative).toMatchObject({
      list_cost_cents: 66,
      input_tokens: 1200,
      output_tokens: 40,
    });
    expect(fake.log.at(-1)).toBe("POST / budget=65");
  });

  test("an error event on the stream is a disconnect, not the end of the turn", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running());
      f.write(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"upstream text"}}\n\n',
      );
    };
    fake.onStream = (f, opened) => {
      if (opened === 2) f.emit(said("戻りました。"), idle());
    };
    const result = await runTurn(turn(fake));
    expect(result.text).toBe("戻りました。");
    expect(fake.streamsOpened).toBe(2);
  });
});

describe("catching up", () => {
  /** The session refuses a call's result as often as told, each attempt of
   *  the client's own retries included, and counts what it was sent. */
  function refusing(fake: FakeSession, times: number, status = 503) {
    const seen = { posts: 0, refused: 0 };
    fake.on(`POST ${SESSION}/events`, (request) => {
      if (request.body!.events[0].type !== "user.custom_tool_result")
        return undefined;
      seen.posts++;
      if (seen.refused >= times) return undefined;
      seen.refused++;
      return rejected(
        status,
        status === 400
          ? undefined
          : { type: "overloaded_error", message: "busy" },
      );
    });
    return seen;
  }
  const fiveMessages = {
    custom_tool_use_id: "call_1",
    is_error: false,
    content: [{ type: "text", text: "five messages" }],
  };

  test("a result that could not be delivered is sent again after the reconnect; the tool is not run again", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), calls("read_messages", "call_1"));
    };
    // All three attempts of the first delivery fail, then the connection drops.
    const seen = refusing(fake, 3);
    fake.onResult = (_event, f) => {
      f.emit(said("読めました。"), idle());
    };
    let executed = 0;
    const work = runTurn(
      turn(fake, {
        executeTool: async () => {
          executed++;
          return ok("five messages");
        },
      }),
    );
    await until(() => seen.refused === 3);
    await Bun.sleep(5);
    fake.drop();
    const result = await work;
    expect(result.text).toBe("読めました。");
    expect(executed).toBe(1);
    expect(fake.streamsOpened).toBe(2);
    expect(fake.events("user.custom_tool_result")).toMatchObject([
      fiveMessages,
      fiveMessages,
      fiveMessages,
      fiveMessages,
    ]);
  });

  test("a result that could not be delivered is sent again while the stream stays open", async () => {
    const fake = new FakeSession();
    // The session says at once that it waits on the call, as it always does.
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        calls("send_message", "call_1"),
        idle("requires_action", { event_ids: ["call_1"] }),
      );
    };
    refusing(fake, 3);
    fake.onResult = (_event, f) => {
      f.emit(running(), said("送りました。"), idle());
    };
    // Pings keep the connection from being reopened for having gone quiet.
    const ping = setInterval(
      () => fake.write('event: ping\ndata: {"type":"ping"}\n\n'),
      10,
    );
    let executed = 0;
    try {
      const result = await runTurn(
        turn(fake, {
          deadlineAt: Date.now() + 1500,
          executeTool: async () => {
            executed++;
            return ok("five messages");
          },
          limits: {
            idleMs: 100,
            reconnects: 2,
            graceMs: 30,
            interruptWaitMs: 60,
            settleMs: 60,
            resendMs: 40,
          },
        }),
      );
      expect(result).toMatchObject({ text: "送りました。", stop: "end_turn" });
    } finally {
      clearInterval(ping);
    }
    // The tool ran once; its result went out again by itself, on the same connection.
    expect(executed).toBe(1);
    expect(fake.streamsOpened).toBe(1);
    expect(fake.events("user.custom_tool_result")).toMatchObject([
      fiveMessages,
      fiveMessages,
      fiveMessages,
      fiveMessages,
    ]);
  });

  test("a session that says it still waits on a call gets the undelivered result at once", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), calls("send_message", "call_1"));
    };
    const seen = refusing(fake, 3);
    fake.onResult = (_event, f) => {
      f.emit(running(), said("送りました。"), idle());
    };
    let executed = 0;
    // The wait before the result goes out again by itself is far longer than this turn may take.
    const work = runTurn(
      turn(fake, {
        deadlineAt: Date.now() + 1500,
        executeTool: async () => {
          executed++;
          return ok("five messages");
        },
      }),
    );
    await until(() => seen.refused === 3);
    await Bun.sleep(5);
    fake.emit(idle("requires_action", { event_ids: ["call_1"] }));
    expect(await work).toMatchObject({
      text: "送りました。",
      stop: "end_turn",
    });
    expect(executed).toBe(1);
    expect(seen.posts).toBe(4);
  });

  test("a result the session refuses is replaced once by a plain one, so the session does not wait for the call", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), calls("send_message", "call_1"));
    };
    refusing(fake, 1, 400);
    fake.onResult = (_event, f) => {
      f.emit(running(), said("結果は受け取れませんでした。"), idle());
    };
    let executed = 0;
    const result = await runTurn(
      turn(fake, {
        deadlineAt: Date.now() + 1500,
        executeTool: async () => {
          executed++;
          return ok("five messages");
        },
      }),
    );
    expect(result.text).toBe("結果は受け取れませんでした。");
    expect(executed).toBe(1);
    expect(fake.events("user.custom_tool_result")).toEqual([
      { type: "user.custom_tool_result", ...fiveMessages },
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "call_1",
        is_error: true,
        content: [
          {
            type: "text",
            text: "This call was carried out, but the session did not accept its result. It may have taken effect. Check before repeating it.",
          },
        ],
      },
    ]);

    // Refused again: the call takes no result any more (its thread is gone), and nothing more is sent for it.
    const late = new FakeSession();
    late.onMessage = (f) => {
      f.process();
      f.emit(running(), calls("send_message", "call_1", {}, "sth_1"));
      setTimeout(() => f.emit(said("先に進みました。"), idle()), 60);
    };
    const refusals = refusing(late, 5, 400);
    expect((await runTurn(turn(late))).text).toBe("先に進みました。");
    expect(refusals.posts).toBe(2);
  });

  test("a turn that is stopped sends what could not be delivered once more before it ends", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), calls("send_message", "call_1"));
    };
    fake.onInterrupt = (f) => {
      f.emit(idle());
    };
    const seen = refusing(fake, 3);
    const steering = new AbortController();
    const work = runTurn(
      turn(fake, {
        steering: steering.signal,
        executeTool: async () => ok("five messages"),
      }),
    );
    await until(() => seen.refused === 3);
    await Bun.sleep(5);
    steering.abort(new Error("User steering"));
    expect((await work).stop).toBe("interrupted");
    // Left unanswered, the next turn would have to close the call without knowing that it ran.
    expect(fake.events("user.custom_tool_result")).toMatchObject([
      fiveMessages,
      fiveMessages,
      fiveMessages,
      fiveMessages,
    ]);
  });

  test("a reconnect before the turn's message was taken up replays nothing of earlier turns", async () => {
    const fake = new FakeSession();
    fake.pageSize = 4;
    fake.missed(
      {
        type: "user.message",
        content: [{ type: "text", text: "もっと前の質問" }],
      },
      running(),
      said("もっと前の返事。"),
      idle(),
    );
    // The turn before this one, with a call whose result never reached the session.
    fake.missed(
      { type: "user.message", content: [{ type: "text", text: "前の質問" }] },
      running(),
      calls("delete_message", "call_prev", { message_id: "1" }),
      said("前のターンの返事。"),
      idle(),
    );
    fake.onMessage = (f) => {
      // The connection breaks right after the send, and the list is read
      // while the message is still waiting to be taken up.
      f.drop();
      setTimeout(() => {
        f.process();
        f.use(55);
        f.emit(running(), said("今回の返事。"), reported(55), idle());
      }, 60);
    };
    const executed: string[] = [],
      observed: string[] = [];
    const result = await runTurn(
      turn(fake, {
        executeTool: async (call) => {
          executed.push(call.id);
          return ok("x");
        },
        observe: (event) => {
          observed.push(event.type);
        },
      }),
    );
    expect(fake.streamsOpened).toBe(2);
    expect(result).toMatchObject({ text: "今回の返事。", stop: "end_turn" });
    // Not run for the person who is speaking now, and not answered for either.
    expect(executed).toEqual([]);
    expect(fake.events("user.custom_tool_result")).toEqual([]);
    expect(observed).toEqual([
      "session.status_running",
      "agent.message",
      "session.usage",
      "session.status_idle",
    ]);
    expect(fake.log.at(-1)).toBe("POST / budget=56");
    // The look back ends at the last message an earlier turn had processed:
    // two pages of four, not the session's whole history.
    expect(
      fake.of("GET", `${SESSION}/events`).map((r) => r.query.get("page")),
    ).toEqual([null, "4"]);
  });

  test("without an id from the send, an older message with the same words is not taken for the turn's", async () => {
    const fake = new FakeSession();
    fake.missed(
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
      running(),
      said("前に同じ質問へ返した答え。"),
      idle(),
    );
    fake.on(`POST ${SESSION}/events`, (request) => {
      if (request.body!.events[0].type !== "user.message") return undefined;
      // Accepted, but the answer names no event and the list does not have it yet.
      setTimeout(() => {
        const message = {
          id: "sevt_late",
          type: "user.message",
          content: request.body!.events[0].content,
          processed_at: null as string | null,
        };
        fake.history.push(message);
        fake.drop();
        setTimeout(() => {
          fake.history = fake.history.filter((event) => event !== message);
          fake.emit(
            { ...message, processed_at: "2026-10-12T00:01:00Z" },
            running(),
            said("今回の答え。"),
            idle(),
          );
        }, 60);
      }, 5);
      return Response.json({});
    });
    let mark: unknown;
    const result = await runTurn(
      turn(fake, {
        onSent: async (m) => {
          mark = m;
        },
      }),
    );
    expect(mark).toEqual({ eventId: "", ceilingCents: 140 });
    expect(fake.streamsOpened).toBe(2);
    expect(result.text).toBe("今回の答え。");
  });

  test("what the stream still carries from before the turn's message is not the turn's, whatever the list says", async () => {
    // The last turn was still going. Its interrupt ends it with a call, a
    // usage report and its idle; by the time the first of these is read, the
    // list already shows the new message as taken up.
    const stale = (f: FakeSession) =>
      f.emit(calls("read_messages", "call_old"), reported(41), idle());
    const later = (f: FakeSession) =>
      setTimeout(() => {
        f.use(60);
        f.emit(said("本当の返事。"), reported(60), idle());
      }, 60);
    const fake = new FakeSession({ status: "running", budget: 141, used: 40 });
    fake.onMessage = (f) => {
      stale(f);
      f.process();
      f.emit(running());
      later(f);
    };
    let executed = 0;
    const result = await runTurn(
      turn(fake, {
        executeTool: async () => {
          executed++;
          return ok("x");
        },
      }),
    );
    expect(result).toMatchObject({ text: "本当の返事。", stop: "end_turn" });
    expect(executed).toBe(0);
    expect(fake.events("user.custom_tool_result")).toMatchObject([
      { custom_tool_use_id: "call_old", is_error: true },
    ]);
    // The turn's own allowance was not taken back under it.
    expect(fake.log.filter((line) => line.includes("budget="))).toEqual([
      "POST / budget=140",
      "POST / budget=61",
    ]);

    // One stale idle that carries the very time the message was taken up at.
    const at = "2026-10-12T00:05:00Z";
    const same = new FakeSession({ status: "running", budget: 141, used: 40 });
    same.onMessage = (f) => {
      f.emit({ ...idle(), processed_at: at });
      f.process({ at });
      f.emit({ ...running(), processed_at: at });
      later(f);
    };
    expect((await runTurn(turn(same))).text).toBe("本当の返事。");

    // The list shows the message as taken up while the stream is still at
    // the old turn's last events, and the interrupt was sent twice.
    const twice = new FakeSession({ status: "running", budget: 141, used: 40 });
    twice.onMessage = (f) => {
      f.emit(idle(), idle());
      f.process();
      f.emit(running());
      later(f);
    };
    expect((await runTurn(turn(twice))).text).toBe("本当の返事。");
  });

  test("after a reconnect, what the new connection still carries from before the turn's message is not the turn's", async () => {
    const later = (f: FakeSession) =>
      setTimeout(() => {
        f.use(60);
        f.emit(said("本当の返事。"), reported(60), idle());
      }, 60);
    // The connection breaks while the old turn is still going. The new one
    // is open when that turn ends and the message is taken up, and the list
    // is read only after both.
    const fake = new FakeSession({ status: "running", budget: 141, used: 40 });
    fake.onMessage = (f) => {
      f.drop();
    };
    fake.onStream = (f, opened) => {
      if (opened !== 2) return;
      f.emit(said("（前のターンの最後の文）"), idle());
      f.process();
      f.emit(running());
      later(f);
    };
    expect(await runTurn(turn(fake))).toMatchObject({
      text: "本当の返事。",
      stop: "end_turn",
    });
    expect(fake.streamsOpened).toBe(2);

    // The message is still queued when the list is read after the reconnect:
    // the new connection is then the one that shows it being taken up, and
    // its order decides, even where the times are the same.
    const at = "2026-10-12T00:05:00Z";
    const queued = new FakeSession({
      status: "running",
      budget: 141,
      used: 40,
    });
    queued.onMessage = (f) => {
      f.drop();
    };
    queued.onStream = (f, opened) => {
      if (opened !== 2) return;
      setTimeout(() => {
        f.emit(
          { ...said("（前のターンの最後の文）"), processed_at: at },
          { ...idle(), processed_at: at },
        );
        f.process({ at });
        f.emit({ ...running(), processed_at: at });
        later(f);
      }, 20);
    };
    expect(await runTurn(turn(queued))).toMatchObject({
      text: "本当の返事。",
      stop: "end_turn",
    });
  });

  test("a stream that never shows the turn's message as taken up is placed by the list", async () => {
    // Not what the documentation describes. If it happened, every event of
    // the turn would be taken for the old turn's and the reply would be lost.
    const plain = new FakeSession({ status: "running", budget: 141, used: 40 });
    plain.onMessage = (f) => {
      f.emit(said("（前のターンの続き）"));
      f.process({ echo: false });
      f.use(60);
      f.emit(running(), said("本当の返事。"), reported(60), idle());
    };
    expect(await runTurn(turn(plain))).toMatchObject({
      text: "本当の返事。",
      stop: "end_turn",
    });

    const fake = new FakeSession({ status: "running", budget: 141, used: 40 });
    fake.onMessage = (f) => {
      f.process({ echo: false });
      f.emit(
        running(),
        { type: "span.model_request_start" },
        said("調べます。"),
        calls("read_messages", "call_1"),
      );
    };
    fake.onResult = (_event, f) => {
      f.emit(
        running(),
        { type: "span.model_request_start" },
        said("読みました。"),
        idle(),
      );
    };
    const executed: string[] = [],
      spoken: string[] = [];
    const result = await runTurn(
      turn(fake, {
        executeTool: async (call) => {
          executed.push(call.id);
          return ok("x");
        },
        say: (text) => {
          spoken.push(text);
        },
      }),
    );
    expect(result).toMatchObject({ text: "読みました。", stop: "end_turn" });
    expect(executed).toEqual(["call_1"]);
    expect(spoken).toEqual(["調べます。"]);

    // A turn that stops at its budget keeps what it had said.
    const stopped = new FakeSession({
      status: "running",
      budget: 141,
      used: 40,
    });
    stopped.onMessage = (f) => {
      f.process({ echo: false });
      f.use(143);
      f.emit(
        running(),
        said("ここまで。"),
        reported(143),
        idle("budget_reached"),
      );
    };
    expect(await runTurn(turn(stopped))).toMatchObject({
      text: "ここまで。",
      stop: "budget",
    });
  });

  test("a call the session still waits on from before the turn is closed, not run", async () => {
    // A run's agent asked while the last turn was being stopped; nobody answered.
    const fake = new FakeSession({ status: "running" });
    fake.missed({
      ...calls("read_messages", "call_before", {}, "sth_9"),
      processed_at: "2026-10-11T23:59:00Z",
    });
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        idle("requires_action", { event_ids: ["call_before"] }),
      );
    };
    fake.onResult = (_event, f) => {
      f.emit(running(), said("続けます。"), idle());
    };
    let executed = 0;
    const result = await runTurn(
      turn(fake, {
        executeTool: async () => {
          executed++;
          return ok("x");
        },
      }),
    );
    expect(result.text).toBe("続けます。");
    expect(executed).toBe(0);
    // Made while an earlier turn was listening: that turn may have run it.
    expect(fake.events("user.custom_tool_result")).toEqual([
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "call_before",
        is_error: true,
        content: [
          {
            type: "text",
            text: "This call was left open by an earlier turn. Whether it was carried out is not known here, so check before repeating it.",
          },
        ],
      },
    ]);
  });

  test("the runs a session row lists are checked against the session's own events", async () => {
    const created = (id: string, name: string): Json => ({
      type: "workflow_run.created",
      workflow_run_id: id,
      name,
      description: null,
      phases: [],
    });
    const fake = new FakeSession();
    fake.missed(
      created("wrun_a", "first"),
      {
        type: "workflow_run.status_ended",
        workflow_run_id: "wrun_a",
        result: { type: "completed" },
      },
      created("wrun_b", "second"),
    );
    fake.onMessage = answers("まだ一つ残っています。");
    const result = await runTurn(
      turn(fake, {
        knownRuns: [
          { id: "wrun_a", name: "first" },
          { id: "wrun_b", name: "stale name" },
        ],
      }),
    );
    expect(
      fake.of("GET", `${SESSION}/events`)[0]!.query.getAll("types[]"),
    ).toEqual([
      "workflow_run.created",
      "workflow_run.status_ended",
      "session.thread_created",
    ]);
    // One is still open, so whatever it was doing is interrupted before the budget is raised.
    expect(fake.log.slice(1, 4)).toEqual([
      "GET /events",
      "POST /events user.interrupt",
      "POST / budget=140",
    ]);
    expect(result.openRuns).toEqual([{ id: "wrun_b", name: "second" }]);
    expect(result.runsStarted).toEqual([]);
    expect(result.notice).toBe(openRunsNotice(1));

    // Two that are still open are kept in the order they were started in.
    const both = new FakeSession();
    both.missed(created("wrun_a", "first"), created("wrun_b", "second"));
    both.onMessage = answers("二つ残っています。");
    const two = await runTurn(
      turn(both, {
        knownRuns: [
          { id: "wrun_b", name: "second" },
          { id: "wrun_a", name: "first" },
        ],
      }),
    );
    expect(two.openRuns).toEqual([
      { id: "wrun_a", name: "first" },
      { id: "wrun_b", name: "second" },
    ]);

    // All of them ended while nobody was listening: the session is simply at rest.
    const rested = new FakeSession();
    rested.missed(created("wrun_a", "first"), {
      type: "workflow_run.status_ended",
      workflow_run_id: "wrun_a",
      result: { type: "stopped" },
    });
    rested.onMessage = answers("全部終わっています。");
    const after = await runTurn(
      turn(rested, { knownRuns: [{ id: "wrun_a", name: "first" }] }),
    );
    expect(rested.events("user.interrupt")).toHaveLength(0);
    expect(after.openRuns).toEqual([]);
    expect(after.notice).toBeUndefined();
  });

  test("a call from a thread that an earlier turn's run created names that run", async () => {
    // The run was left open by the last turn. Its threads go on in this one
    // without being announced again, and a call's event names only the thread.
    const fake = new FakeSession();
    fake.missed(
      {
        type: "workflow_run.created",
        workflow_run_id: "wrun_1",
        name: "review",
        description: null,
        phases: [],
      },
      {
        type: "session.thread_created",
        session_thread_id: "sth_1",
        agent_name: "reader",
        workflow_run_id: "wrun_1",
      },
      // A thread that is not part of any run stays without one.
      {
        type: "session.thread_created",
        session_thread_id: "sth_other",
        agent_name: "helper",
        workflow_run_id: null,
      },
    );
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        calls("read_messages", "call_run", {}, "sth_1"),
        calls("read_messages", "call_other", {}, "sth_other"),
      );
    };
    let results = 0;
    fake.onResult = (_event, f) => {
      if (++results === 2)
        f.emit(
          {
            type: "workflow_run.status_ended",
            workflow_run_id: "wrun_1",
            result: { type: "completed" },
          },
          said("終わりました。"),
          idle(),
        );
    };
    const executed: WorkspaceCall[] = [];
    const result = await runTurn(
      turn(fake, {
        knownRuns: [{ id: "wrun_1", name: "review" }],
        executeTool: async (call) => {
          executed.push(call);
          return ok("x");
        },
      }),
    );
    expect(result.text).toBe("終わりました。");
    expect(
      executed.map((call) => [call.id, call.threadId, call.runId]),
    ).toEqual([
      ["call_run", "sth_1", "wrun_1"],
      ["call_other", "sth_other", null],
    ]);
    // Read with the runs, in the one request that was made already.
    expect(fake.of("GET", `${SESSION}/events`)).toHaveLength(1);
  });

  test("the look for open runs goes back no further than the oldest run the row lists", async () => {
    const created = (id: string, name: string): Json => ({
      type: "workflow_run.created",
      workflow_run_id: id,
      name,
      description: null,
      phases: [],
    });
    const thread = (id: string, run: string): Json => ({
      type: "session.thread_created",
      session_thread_id: id,
      agent_name: "reader",
      workflow_run_id: run,
    });
    const ended = (id: string): Json => ({
      type: "workflow_run.status_ended",
      workflow_run_id: id,
      result: { type: "completed" },
    });
    const fake = new FakeSession();
    fake.pageSize = 4;
    // Runs that ended long ago, with their threads: a session lives for weeks.
    fake.missed(
      created("wrun_1", "one"),
      thread("sth_1", "wrun_1"),
      thread("sth_2", "wrun_1"),
      ended("wrun_1"),
      created("wrun_2", "two"),
      thread("sth_3", "wrun_2"),
      ended("wrun_2"),
      // The one the last turn left open, and one the row never heard of.
      created("wrun_3", "three"),
      thread("sth_4", "wrun_3"),
      created("wrun_4", "four"),
      thread("sth_5", "wrun_4"),
    );
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        calls("read_messages", "call_1", {}, "sth_4"),
        calls("read_messages", "call_2", {}, "sth_5"),
      );
    };
    let results = 0;
    fake.onResult = (_event, f) => {
      if (++results === 2)
        f.emit(
          ended("wrun_3"),
          ended("wrun_4"),
          said("終わりました。"),
          idle(),
        );
    };
    const executed: WorkspaceCall[] = [];
    const result = await runTurn(
      turn(fake, {
        knownRuns: [{ id: "wrun_3", name: "three" }],
        executeTool: async (call) => {
          executed.push(call);
          return ok("x");
        },
      }),
    );
    expect(result.text).toBe("終わりました。");
    expect(executed.map((call) => [call.threadId, call.runId])).toEqual([
      ["sth_4", "wrun_3"],
      ["sth_5", "wrun_4"],
    ]);
    // Newest first, and done with the first page: the run's own start is on it.
    const looks = fake
      .of("GET", `${SESSION}/events`)
      .filter((r) => r.query.has("types[]"));
    expect(
      looks.map((r) => [r.query.get("order"), r.query.get("page")]),
    ).toEqual([["desc", null]]);
  });
});

describe("sending the message", () => {
  test("looks for it instead of sending again when the answer to the send was lost", async () => {
    const fake = new FakeSession();
    let posts = 0;
    fake.on(`POST ${SESSION}/events`, (request) => {
      if (request.body!.events[0].type !== "user.message") return undefined;
      posts++;
      // It arrived; only the response did not.
      fake.history.push({
        id: "sevt_arrived",
        type: "user.message",
        content: request.body!.events[0].content,
        processed_at: null,
      });
      setTimeout(() => {
        fake.history.at(-1)!.processed_at = "2026-10-12T00:00:09Z";
        fake.emit(
          { ...fake.history.at(-1)!, id: "sevt_arrived" },
          running(),
          said("届いていました。"),
          idle(),
        );
      }, 5);
      throw new TypeError("socket hang up");
    });
    let mark: unknown;
    const result = await runTurn(
      turn(fake, {
        onSent: async (m) => {
          mark = m;
        },
      }),
    );
    expect(posts).toBe(1);
    expect(mark).toEqual({ eventId: "sevt_arrived", ceilingCents: 140 });
    expect(result.text).toBe("届いていました。");
    const lookup = fake.of("GET", `${SESSION}/events`)[0]!;
    expect(lookup.query.getAll("types[]")).toEqual(["user.message"]);
    expect(lookup.query.get("order")).toBe("desc");
  });

  test("fails without a second copy when it cannot be found, and does not take an older message with the same words", async () => {
    const fake = new FakeSession();
    fake.history.push({
      id: "sevt_before",
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
      processed_at: "2026-10-11T23:00:00Z",
    });
    let posts = 0;
    fake.on(`POST ${SESSION}/events`, (request) => {
      if (request.body!.events[0].type !== "user.message") return undefined;
      posts++;
      throw new TypeError("socket hang up");
    });
    let marked = false;
    const error = await failure(
      runTurn(
        turn(fake, {
          onSent: async () => {
            marked = true;
          },
        }),
      ),
    );
    expect(error).toMatchObject({ kind: "transient", retryable: true });
    expect(posts).toBe(1);
    expect(marked).toBe(false);
    // The allowance is taken back even though nothing ran.
    expect(fake.log.at(-1)).toBe("POST / budget=41");
  });

  test("closes the calls an earlier turn left open, then sends once more", async () => {
    const fake = new FakeSession();
    fake.history.push(
      // Before the last message that was processed: not looked at any more.
      {
        id: "call_ancient",
        type: "agent.custom_tool_use",
        name: "send_message",
        input: {},
        processed_at: "2026-10-11T22:00:00Z",
      },
      {
        id: "sevt_old_msg",
        type: "user.message",
        content: [{ type: "text", text: "earlier" }],
        processed_at: "2026-10-11T23:00:00Z",
      },
      {
        id: "call_done",
        type: "agent.custom_tool_use",
        name: "read_messages",
        input: {},
        processed_at: "2026-10-11T23:00:01Z",
      },
      {
        id: "sevt_r",
        type: "user.custom_tool_result",
        custom_tool_use_id: "call_done",
        processed_at: "2026-10-11T23:00:02Z",
      },
      {
        id: "call_open",
        type: "agent.custom_tool_use",
        name: "send_message",
        input: {},
        processed_at: "2026-10-11T23:00:03Z",
      },
      {
        id: "sevt_i",
        type: "session.status_idle",
        stop_reason: { type: "requires_action", event_ids: ["call_open"] },
        processed_at: "2026-10-11T23:00:04Z",
      },
    );
    let blocked = true;
    fake.on(`POST ${SESSION}/events`, (request) => {
      const type = request.body!.events[0].type;
      if (type === "user.custom_tool_result") blocked = false;
      return type === "user.message" && blocked ? rejected(400) : undefined;
    });
    fake.onMessage = answers("続きです。");
    let executed = 0;
    const result = await runTurn(
      turn(fake, {
        executeTool: async () => {
          executed++;
          return ok("x");
        },
      }),
    );
    expect(result.text).toBe("続きです。");
    expect(executed).toBe(0);
    expect(fake.log.filter((line) => line.startsWith("POST /events"))).toEqual([
      "POST /events user.message",
      "POST /events user.interrupt",
      "POST /events user.custom_tool_result",
      "POST /events user.message",
    ]);
    expect(fake.events("user.custom_tool_result")).toMatchObject([
      {
        custom_tool_use_id: "call_open",
        is_error: true,
        content: [
          { text: expect.stringContaining("left open by an earlier turn") },
        ],
      },
    ]);
  });

  test("a session left at its budget that also waits on a call is interrupted on its own before the second send", async () => {
    const fake = new FakeSession({ budget: 100, used: 100 });
    fake.history.push(
      {
        id: "sevt_old_msg",
        type: "user.message",
        content: [{ type: "text", text: "earlier" }],
        processed_at: "2026-10-11T23:00:00Z",
      },
      {
        id: "call_open",
        type: "agent.custom_tool_use",
        name: "send_message",
        input: {},
        processed_at: "2026-10-11T23:00:03Z",
      },
    );
    let blocked = true;
    fake.on(`POST ${SESSION}/events`, (request) => {
      const types = (request.body!.events as Json[]).map((event) => event.type);
      if (types.includes("user.custom_tool_result")) blocked = false;
      // Refused whole: the interrupt that came with the message did not take effect either.
      return types.includes("user.message") && blocked
        ? rejected(400)
        : undefined;
    });
    fake.onMessage = answers("続きです。", 110);
    const result = await runTurn(turn(fake));
    expect(result.text).toBe("続きです。");
    expect(fake.log.filter((line) => line.startsWith("POST /"))).toEqual([
      "POST /events user.interrupt",
      "POST / budget=200",
      "POST /events user.interrupt+user.message",
      "POST /events user.interrupt",
      "POST /events user.custom_tool_result",
      "POST /events user.message",
      "POST / budget=111",
    ]);
  });

  test("a second rejection is the turn's failure", async () => {
    const fake = new FakeSession();
    fake.on(`POST ${SESSION}/events`, (request) =>
      request.body!.events[0].type === "user.message"
        ? rejected(400)
        : undefined,
    );
    const error = await failure(runTurn(turn(fake)));
    expect(error).toMatchObject({ kind: "invalid_request", status: 400 });
    expect((error as Error).message).not.toContain("upstream");
    expect(fake.events("user.message")).toHaveLength(2);
  });
});

describe("the budget", () => {
  test("a rejected raise is tried again from what the session has used by then", async () => {
    const fake = new FakeSession({ budget: 41, used: 40 });
    let updates = 0;
    fake.on(`POST ${SESSION}`, () => {
      if (++updates > 1) return undefined;
      fake.use(45);
      return rejected(400, {
        type: "invalid_request_error",
        message:
          "budget.max_list_cost must be greater than the session's consumed list cost",
      });
    });
    fake.onMessage = answers("はい。", 60);
    const leases: number[] = [];
    const result = await runTurn(
      turn(fake, {
        onLease: (ceiling) => {
          leases.push(ceiling);
        },
      }),
    );
    expect(result.stop).toBe("end_turn");
    expect(leases).toEqual([140, 145]);
    expect(
      fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount),
    ).toEqual(["140", "145", "61"]);
    // The budget is replaced by another limit every time, never removed.
    expect(
      fake
        .of("POST", SESSION)
        .every(
          (r) =>
            r.body!.budget?.type === "limit" &&
            Object.keys(r.body!).length === 1,
        ),
    ).toBe(true);
  });

  test("a lease that is not taken fails the turn before the budget goes up, on the first try and on a later one", async () => {
    // The caller records the ceiling here, or refuses it: the bot writes the
    // lease to its store, and the smoke script holds a session to its own
    // budget. Both rely on nothing being raised or sent once this throws.
    const refused = new Error("the lease was not taken");
    const fake = new FakeSession({ budget: 41, used: 40 });
    fake.onMessage = answers("はい。", 60);
    expect(
      await failure(
        runTurn(
          turn(fake, {
            onLease: () => {
              throw refused;
            },
          }),
        ),
      ),
    ).toBe(refused);
    expect(fake.log).toEqual(["GET /"]);

    // The session spent more between the read and the update, so the ceiling
    // is worked out again: that one is asked about too, before it is used.
    const later = new FakeSession({ budget: 41, used: 40 });
    later.on(`POST ${SESSION}`, () => {
      later.use(45);
      return rejected(400, {
        type: "invalid_request_error",
        message:
          "budget.max_list_cost must be greater than the session's consumed list cost",
      });
    });
    later.onMessage = answers("はい。", 60);
    const leases: number[] = [];
    const error = await failure(
      runTurn(
        turn(later, {
          onLease: (ceiling) => {
            leases.push(ceiling);
            if (ceiling > 140) throw refused;
          },
        }),
      ),
    );
    expect(error).toBe(refused);
    expect(leases).toEqual([140, 145]);
    // Only the raise that was refused by the session ever went out.
    expect(
      later.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount),
    ).toEqual(["140"]);
    expect(later.events("user.message")).toHaveLength(0);
    expect(later.streamsOpened).toBe(0);
  });

  test("any other rejection stops the turn before a message is sent", async () => {
    const fake = new FakeSession();
    fake.on(`POST ${SESSION}`, () =>
      rejected(400, {
        type: "invalid_request_error",
        message: "no list price is available for the model",
      }),
    );
    const error = await failure(runTurn(turn(fake)));
    expect(error).toMatchObject({
      kind: "protocol",
      retryable: false,
      status: 400,
    });
    expect((error as ProviderError).diagnostics.code).toBe("budget_rejected");
    expect(fake.of("POST", SESSION).length).toBeLessThanOrEqual(2);
    expect(fake.events("user.message")).toHaveLength(0);
    expect(fake.streamsOpened).toBe(0);
  });

  test("a resumed turn keeps the ceiling it was started with", async () => {
    // Restarted in the middle: 80 of the 140 are spent, and the budget is still where the first start put it.
    const fake = new FakeSession({ budget: 140, used: 80 });
    fake.onMessage = answers("再開しました。", 95);
    const leases: number[] = [];
    const result = await runTurn(
      turn(fake, {
        budget: { ceilingCents: 140 },
        onLease: (c) => {
          leases.push(c);
        },
      }),
    );
    expect(result.text).toBe("再開しました。");
    expect(leases).toEqual([140]);
    // Nothing to raise; only the lowering at the end touches the budget.
    expect(
      fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount),
    ).toEqual(["96"]);
  });

  test("a resumed turn that has used its ceiling sends nothing", async () => {
    const fake = new FakeSession({ budget: 140, used: 141 });
    const result = await runTurn(
      turn(fake, {
        budget: { ceilingCents: 140 },
        baseline: { list_cost_cents: 40 } as TurnResult["cumulative"],
      }),
    );
    expect(result).toMatchObject({ text: "", stop: "budget", released: true });
    expect(result.notice).toBe(budgetNotice(100));
    expect(fake.log).toEqual(["GET /", "GET /"]);
  });

  test("a turn that is already out of time sends nothing", async () => {
    const fake = new FakeSession({ budget: 140, used: 80 });
    const result = await runTurn(
      turn(fake, { budget: { ceilingCents: 140 }, deadlineAt: Date.now() - 1 }),
    );
    expect(result).toMatchObject({ text: "", stop: "timeout", released: true });
    expect(result.notice).toBe(timeoutNotice(1_200_000));
    expect(fake.log).toEqual(["GET /", "GET /", "POST / budget=81"]);
  });

  test("a used session that reports no cost is not given a ceiling", async () => {
    const fake = new FakeSession({
      usage: { input_tokens: 5000, output_tokens: 300 },
    });
    const error = await failure(runTurn(turn(fake)));
    expect(error).toMatchObject({ kind: "protocol", retryable: false });
    expect((error as ProviderError).diagnostics.code).toBe("list_cost_missing");
    expect(fake.log).toEqual(["GET /"]);

    // Nor is one the bot has counted use for, when the session itself reports nothing at all.
    const blank = new FakeSession({ used: null });
    blank.onMessage = answers("始まってはいけないターンの返事。");
    const counted = await failure(
      runTurn(
        turn(blank, {
          baseline: { list_cost_cents: 40 } as TurnResult["cumulative"],
        }),
      ),
    );
    expect((counted as ProviderError).diagnostics.code).toBe(
      "list_cost_missing",
    );
    expect(blank.log).toEqual(["GET /"]);
  });

  test("a session that was never used may report none yet", async () => {
    const fake = new FakeSession({ used: null, budget: 50 });
    fake.onMessage = answers("最初の返事。", 12);
    const result = await runTurn(turn(fake));
    expect(result.text).toBe("最初の返事。");
    // Whether it was used is asked of the list, since the usage cannot say:
    // one request, as the list holds no message. Nothing waits ahead of the
    // turn's own message either, so no interrupt is sent on its own first.
    expect(fake.log).toEqual([
      "GET /",
      "GET /events",
      "POST / budget=100",
      "GET /events/stream",
      "POST /events user.message",
      "GET /",
      "POST / budget=13",
    ]);
    expect(fake.events("user.interrupt")).toEqual([]);
    expect(
      fake.of("GET", `${SESSION}/events`)[0]!.query.getAll("types[]"),
    ).toEqual(["user.message"]);
  });

  test("a message the session has not taken up is not use, and the turn begins where its own is taken up", async () => {
    // A new session, and the same person wrote again before it took up the
    // first message: nothing was spent, and no cost is reported yet. That a
    // session reports none until then is read from the SDK's types ("absent
    // until cost tracking is available"); it was not seen on the API.
    const first = {
      id: "sevt_first",
      type: "user.message",
      content: [{ type: "text", text: "最初の依頼" }],
    };
    const fake = new FakeSession({ used: null, budget: 1 });
    fake.history.push({ ...first, processed_at: null } as RawEvent);
    fake.onMessage = (f) => {
      // Events are taken up in the order they were sent ("queued behind
      // earlier events"): the first message, cut short by the interrupt, and
      // only then the turn's own.
      f.history = f.history.filter((event) => event.id !== first.id);
      f.emit(first, running(), said("（最初の依頼に答えかけた文）"), idle());
      setTimeout(() => {
        f.process();
        f.use(12);
        f.emit(running(), said("言い直しへの返事。"), reported(12), idle());
      }, 5);
    };
    const result = await runTurn(turn(fake));
    expect(result).toMatchObject({
      text: "言い直しへの返事。",
      stop: "end_turn",
      costReported: true,
      released: true,
    });
    expect(result.cumulative?.list_cost_cents).toBe(12);
    // The message ahead of the turn's is older work like any other: it is
    // stopped first, on its own, and the allowance is counted from nothing.
    expect(fake.log.slice(0, 6)).toEqual([
      "GET /",
      "GET /events",
      "POST /events user.interrupt",
      "POST / budget=100",
      "GET /events/stream",
      "POST /events user.message",
    ]);
    expect(fake.events("user.message")).toEqual([
      { type: "user.message", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  const message = (id: string, text: string, processed_at: string | null) =>
    ({
      id,
      type: "user.message",
      content: [{ type: "text", text }],
      processed_at,
    }) as RawEvent;
  const taken = message("sevt_first", "最初の依頼", "2026-10-11T23:00:00.000Z");
  const queued = (n: number) =>
    message(`sevt_queued_${n}`, `言い直し ${n}`, null);

  test("a session that took a message up and reports no cost is not given a ceiling, whatever is queued behind it", async () => {
    for (const history of [[taken], [taken, queued(1)]]) {
      const fake = new FakeSession({ used: null, budget: 1 });
      fake.history.push(...history);
      // A turn that went on regardless would end here, not at its time limit.
      fake.onMessage = answers("始まってはいけないターンの返事。");
      const error = await failure(runTurn(turn(fake)));
      expect(error).toMatchObject({ kind: "protocol", retryable: false });
      expect((error as ProviderError).diagnostics.code).toBe(
        "list_cost_missing",
      );
      // Nothing was raised, and nothing was sent.
      expect(fake.log).toEqual(["GET /", "GET /events"]);
    }
  });

  test("the message that was taken up is looked for past the first page of the list", async () => {
    // Where the messages still queued stand in the list, and how many events
    // a page holds, were not seen on the API: the one that was taken up may
    // come after a page of queued ones.
    const lists: [pageSize: number, history: RawEvent[]][] = [
      [1, [queued(1), taken]],
      [2, [queued(1), queued(2), taken]],
      // Found on the second page; the pages behind it are not asked for.
      [1, [queued(1), taken, queued(2), queued(3)]],
    ];
    for (const [pageSize, history] of lists) {
      const fake = new FakeSession({ used: null, budget: 1 });
      fake.pageSize = pageSize;
      fake.history.push(...history);
      fake.onMessage = answers("始まってはいけないターンの返事。");
      const error = await failure(runTurn(turn(fake)));
      expect(error).toMatchObject({ kind: "protocol", retryable: false });
      expect((error as ProviderError).diagnostics.code).toBe(
        "list_cost_missing",
      );
      expect(fake.log).toEqual(["GET /", "GET /events", "GET /events"]);
    }
  });

  test("messages that are only queued are not use, however many pages of them there are", async () => {
    const fake = new FakeSession({ used: null, budget: 1 });
    fake.pageSize = 2;
    fake.history.push(queued(1), queued(2), queued(3));
    // This session leaves the three as they are and takes up the turn's own.
    fake.onMessage = answers("言い直しへの返事。", 12);
    const result = await runTurn(turn(fake));
    expect(result).toMatchObject({
      text: "言い直しへの返事。",
      stop: "end_turn",
      costReported: true,
      released: true,
    });
    expect(result.cumulative?.list_cost_cents).toBe(12);
    // The list is read to its end, two pages, before anything is sent.
    expect(fake.log).toEqual([
      "GET /",
      "GET /events",
      "GET /events",
      "POST /events user.interrupt",
      "POST / budget=100",
      "GET /events/stream",
      "POST /events user.message",
      "GET /",
      "POST / budget=13",
    ]);
  });

  test("a list too long to read through is taken as used", async () => {
    // The look gives up after 10,000 events (`LIST_MAX_EVENTS`). What it did
    // not read may hold a message that was taken up, so the turn is refused
    // rather than begun from a ceiling counted from nothing.
    const fake = new FakeSession({ used: null, budget: 1 });
    fake.pageSize = 2_500;
    for (let n = 1; n <= 10_001; n++) fake.history.push(queued(n));
    fake.onMessage = answers("始まってはいけないターンの返事。");
    const error = await failure(runTurn(turn(fake)));
    expect(error).toMatchObject({ kind: "protocol", retryable: false });
    expect((error as ProviderError).diagnostics.code).toBe("list_cost_missing");
    // Four pages of 2,500; the fifth is not asked for.
    expect(fake.log).toEqual([
      "GET /",
      "GET /events",
      "GET /events",
      "GET /events",
      "GET /events",
    ]);
  });

  test("a list whose pages never end is given up after a fixed number of requests", async () => {
    // Pages without an event that still name a next one: the count of events
    // never gets anywhere, so the requests are counted as well. Refused, as
    // above: what was not read may hold a message that was taken up.
    const fake = new FakeSession({ used: null, budget: 1 });
    let pages = 0;
    fake.on(`GET ${SESSION}/events`, () =>
      Response.json({ data: [], next_page: String(++pages) }),
    );
    fake.onMessage = answers("始まってはいけないターンの返事。");
    const error = await failure(runTurn(turn(fake)));
    expect(error).toMatchObject({ kind: "protocol", retryable: false });
    expect((error as ProviderError).diagnostics.code).toBe("list_cost_missing");
    expect(fake.log).toEqual([
      "GET /",
      ...Array.from({ length: 20 }, () => "GET /events"),
    ]);
  });

  test("a turn that is out of time stops reading the list, and ends as one that ran out of time", async () => {
    const fake = new FakeSession({ used: null, budget: 1 });
    fake.pageSize = 1;
    fake.history.push(queued(1), queued(2), queued(3));
    fake.onMessage = answers("始まってはいけないターンの返事。");
    let now = 1_000;
    // The time limit passes while the first page is on its way.
    fake.on(`GET ${SESSION}/events`, () => {
      now = 5_000;
      return undefined;
    });
    const result = await runTurn(
      turn(fake, {
        deadlineAt: 2_000,
        hooks: { sleep: async () => {}, now: () => now },
      }),
    );
    expect(result).toMatchObject({ stop: "timeout", text: "" });
    // One page, and nothing was raised or sent.
    expect(fake.log.filter((line) => line === "GET /events")).toHaveLength(1);
    expect(fake.sent.filter((request) => request.method === "POST")).toEqual(
      [],
    );
  });

  test("a turn that is stopped stops reading the list", async () => {
    const fake = new FakeSession({ used: null, budget: 1 });
    fake.pageSize = 1;
    fake.history.push(queued(1), queued(2), queued(3));
    fake.onMessage = answers("始まってはいけないターンの返事。");
    const stop = new AbortController();
    fake.on(`GET ${SESSION}/events`, () => {
      stop.abort(new Error("stopped"));
      return undefined;
    });
    await failure(runTurn(turn(fake, { signal: stop.signal })));
    // The second page is not asked for.
    expect(fake.log).toEqual(["GET /", "GET /events"]);
  });

  test("a list that cannot be read does not begin the turn", async () => {
    // Taken as never used, the session would get a ceiling counted from nothing.
    for (const failing of [1, 2]) {
      const fake = new FakeSession({ used: null, budget: 1 });
      fake.pageSize = 1;
      fake.history.push(queued(1), queued(2));
      fake.onMessage = answers("始まってはいけないターンの返事。");
      let asked = 0;
      fake.on(`GET ${SESSION}/events`, () =>
        ++asked === failing
          ? rejected(400, {
              type: "invalid_request_error",
              message: "no such list",
            })
          : undefined,
      );
      const error = await failure(runTurn(turn(fake)));
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).diagnostics.code).not.toBe(
        "list_cost_missing",
      );
      expect(fake.log).toEqual([
        "GET /",
        ...Array.from({ length: failing }, () => "GET /events"),
      ]);
    }
  });
});

describe("stopping a turn", () => {
  /** A turn whose model called a tool that the test finishes when it wants to. */
  function withTool(fake: FakeSession) {
    let finish!: (result: WorkspaceResult) => void;
    const tool = new Promise<WorkspaceResult>((resolve) => {
      finish = resolve;
    });
    let ctx: Context | undefined;
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(),
        said("送ります。"),
        calls("send_message", "call_1", { content: "hi" }),
      );
    };
    fake.onInterrupt = (f) => {
      f.use(52);
      f.state.status = "idle";
    };
    fake.onResult = (_event, f) => {
      f.emit(idle());
    };
    return {
      finish,
      started: () => ctx,
      executeTool: async (_call: WorkspaceCall, c: Context) => {
        ctx = c;
        return tool;
      },
    };
  }

  test("a new message from the same person interrupts, and a running tool still reports its real result", async () => {
    const fake = new FakeSession();
    const tool = withTool(fake);
    const steering = new AbortController();
    const work = runTurn(
      turn(fake, {
        steering: steering.signal,
        executeTool: tool.executeTool,
        limits: {
          idleMs: 10_000,
          reconnects: 2,
          settleMs: 5_000,
          interruptWaitMs: 60,
        },
      }),
    );
    await until(() => !!tool.started());
    steering.abort(new Error("User steering"));
    await until(() => fake.events("user.interrupt").length === 1);
    // The tool sees the stop, and finishes what it had begun.
    expect(tool.started()!.signal?.aborted).toBe(true);
    tool.finish(ok("message sent"));
    const result = await work;
    expect(result).toMatchObject({ stop: "interrupted", released: true });
    expect(result.notice).toBeUndefined();
    expect(fake.events("user.custom_tool_result")).toMatchObject([
      {
        custom_tool_use_id: "call_1",
        is_error: false,
        content: [{ type: "text", text: "message sent" }],
      },
    ]);
    expect(fake.log.at(-1)).toBe("POST / budget=53");
  });

  test("a tool that does not finish in time is answered for, and its late result is dropped", async () => {
    const fake = new FakeSession();
    const tool = withTool(fake);
    const steering = new AbortController();
    const work = runTurn(
      turn(fake, { steering: steering.signal, executeTool: tool.executeTool }),
    );
    await until(() => !!tool.started());
    steering.abort(new Error("User steering"));
    const result = await work;
    expect(result.stop).toBe("interrupted");
    expect(fake.events("user.custom_tool_result")).toEqual([
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: "call_1",
        is_error: true,
        content: [
          {
            type: "text",
            text: "This call was still running when the turn was stopped and may have taken effect. Check before repeating it.",
          },
        ],
      },
    ]);
    tool.finish(ok("message sent"));
    await Bun.sleep(10);
    expect(fake.events("user.custom_tool_result")).toHaveLength(1);
  });

  test("a message written before the turn's own was recorded does not drop it", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), said("途中。"));
    };
    fake.onInterrupt = (f) => {
      f.emit(idle());
    };
    const steering = new AbortController();
    steering.abort(new Error("User steering"));
    const order: string[] = [];
    const result = await runTurn(
      turn(fake, {
        steering: steering.signal,
        onSent: async () => {
          await Bun.sleep(5);
          order.push(
            `recorded after ${fake.events("user.interrupt").length} interrupts`,
          );
        },
      }),
    );
    expect(order).toEqual(["recorded after 0 interrupts"]);
    expect(fake.events("user.message")).toHaveLength(1);
    expect(fake.events("user.interrupt")).toHaveLength(1);
    expect(result).toMatchObject({ stop: "interrupted", released: true });
  });

  test("the time limit interrupts and says so", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), said("長い作業の途中です。"));
    };
    fake.onInterrupt = (f) => {
      f.use(90);
      f.emit(reported(90), idle());
    };
    const result = await runTurn(turn(fake, { deadlineAt: Date.now() + 40 }));
    expect(result).toMatchObject({
      stop: "timeout",
      text: "長い作業の途中です。",
      released: true,
    });
    expect(result.notice).toBe(
      "このターンの時間の上限（20 分）に達したため、中断しました。続けるには、もう一度メッセージを送ってください。",
    );
    expect(fake.events("user.interrupt")).toHaveLength(1);
    expect(fake.log.at(-1)).toBe("POST / budget=91");
  });

  test("a speaker who was blocked meanwhile gets no reply", async () => {
    const fake = new FakeSession();
    let blocked = false;
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), said("秘密の内容。"));
      setTimeout(() => {
        blocked = true;
        f.emit({ type: "agent.thinking" });
      }, 5);
    };
    fake.onInterrupt = (f) => {
      f.emit(idle());
    };
    const result = await runTurn(turn(fake, { shouldStop: () => blocked }));
    expect(result).toMatchObject({ stop: "stopped", text: "", released: true });
    expect(fake.events("user.interrupt")).toHaveLength(1);
  });

  test("a cleared conversation ends quietly", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), said("途中。"));
    };
    fake.onInterrupt = (f) => {
      f.emit(idle());
    };
    const cancel = new AbortController();
    const work = runTurn(turn(fake, { signal: cancel.signal }));
    await until(() => fake.events("user.message").length === 1);
    cancel.abort(new Error("Conversation cleared"));
    expect(await work).toMatchObject({ stop: "stopped", text: "" });
    expect(fake.events("user.interrupt")).toHaveLength(1);
  });

  test("shutdown interrupts, lowers the budget and rethrows its reason without waiting for anything", async () => {
    const fake = new FakeSession();
    const tool = withTool(fake);
    fake.onInterrupt = () => {};
    const shutdown = new AbortController();
    const reason = new Error("Shutdown");
    const work = runTurn(
      turn(fake, {
        signal: shutdown.signal,
        executeTool: tool.executeTool,
        limits: {
          idleMs: 10_000,
          reconnects: 2,
          settleMs: 5_000,
          interruptWaitMs: 5_000,
        },
      }),
    );
    await until(() => !!tool.started());
    const at = Date.now();
    shutdown.abort(reason);
    expect(await failure(work)).toBe(reason);
    expect(Date.now() - at).toBeLessThan(1000);
    expect(fake.events("user.interrupt")).toHaveLength(1);
    expect(fake.log.at(-1)).toBe("POST / budget=41");
    // The call is left for the resumed turn to close; nothing is claimed about it now.
    expect(fake.events("user.custom_tool_result")).toHaveLength(0);
  });

  test("shutdown while a stop is under way ends its waits", async () => {
    const fake = new FakeSession();
    const tool = withTool(fake);
    fake.onInterrupt = () => {};
    const steering = new AbortController(),
      shutdown = new AbortController();
    const work = runTurn(
      turn(fake, {
        signal: shutdown.signal,
        steering: steering.signal,
        executeTool: tool.executeTool,
        limits: {
          idleMs: 10_000,
          reconnects: 2,
          settleMs: 5_000,
          interruptWaitMs: 5_000,
        },
      }),
    );
    await until(() => !!tool.started());
    steering.abort(new Error("User steering"));
    await until(() => fake.events("user.interrupt").length === 1);
    const at = Date.now();
    shutdown.abort(new Error("Shutdown"));
    // The stop that had begun is finished, quickly; the budget is still lowered.
    expect(await work).toMatchObject({ stop: "interrupted", released: true });
    expect(Date.now() - at).toBeLessThan(1000);
    expect(fake.log.at(-1)).toBe("POST / budget=41");
  });

  test("shutdown before the message was sent sends no message", async () => {
    const fake = new FakeSession();
    const shutdown = new AbortController();
    const reason = new Error("Shutdown");
    fake.on(`POST ${SESSION}`, () => {
      shutdown.abort(reason);
      return undefined;
    });
    expect(
      await failure(runTurn(turn(fake, { signal: shutdown.signal }))),
    ).toBe(reason);
    expect(fake.events("user.message")).toHaveLength(0);
    // The raise had gone through, so it is taken back.
    expect(fake.log.at(-1)).toBe("POST / budget=41");
  });

  test("the notices name the limit that was reached", () => {
    expect(budgetNotice(300)).toBe(
      "このターンの費用の上限（$3.00）に達したため、ここで止めました。続けるには、もう一度メッセージを送ってください。",
    );
    expect(budgetNotice(5)).toContain("（$0.05）");
    expect(timeoutNotice(3_600_000)).toBe(
      "このターンの時間の上限（60 分）に達したため、中断しました。続けるには、もう一度メッセージを送ってください。",
    );
    expect(openRunsNotice(3)).toContain("が 3 件、");
  });

  test("the reasons bot.ts aborts with are told apart", () => {
    expect(abortKind(new Error("User steering"))).toBe("steering");
    expect(abortKind(new Error("Shutdown"))).toBe("shutdown");
    expect(abortKind(new Error("Conversation cleared"))).toBe("cleared");
    expect(abortKind(new Error("anything else"))).toBe("other");
    expect(abortKind(undefined)).toBe("other");
  });
});

describe("a turn that cannot go on", () => {
  test("a session that is gone before the message is sent can be replaced", async () => {
    const gone = async (prepare: (fake: FakeSession) => void) => {
      const fake = new FakeSession();
      prepare(fake);
      const error = await failure(runTurn(turn(fake)));
      expect(error).toBeInstanceOf(SessionGone);
      expect(fake.events("user.message")).toHaveLength(0);
      return [(error as SessionGone).sent, (error as SessionGone).why];
    };
    expect(
      await gone((f) =>
        f.on(`GET ${SESSION}`, () =>
          rejected(404, { type: "not_found_error", message: "x" }),
        ),
      ),
    ).toEqual([false, "not_found"]);
    expect(
      await gone((f) => {
        f.state.status = "terminated";
      }),
    ).toEqual([false, "terminated"]);
    expect(
      await gone((f) => {
        f.state.archived_at = "2026-10-12T00:00:00Z";
        f.state.status = "terminated";
      }),
    ).toEqual([false, "archived"]);
    // An uncapped session is never used: a budget cannot be added afterwards.
    expect(
      await gone((f) => {
        f.state.budget = null;
      }),
    ).toEqual([false, "no_budget"]);
  });

  test("a session that ends under the turn must not be repeated", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), { type: "session.status_terminated" });
    };
    const error = await failure(runTurn(turn(fake)));
    expect(error).toBeInstanceOf(SessionGone);
    expect(error).toMatchObject({ sent: true, why: "terminated" });
  });

  test("a refusal is reported as one, and the allowance is taken back", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), {
        ...idle("refusal"),
        stop_details: {
          type: "refusal",
          category: "cyber",
          explanation: "upstream text",
        },
      });
    };
    const warnings: unknown[][] = [];
    const error = await failure(
      runTurn(
        turn(fake, {
          log: {
            warn: (...a: unknown[]) => {
              warnings.push(a);
            },
            debug: () => {},
          } as unknown as Logger,
        }),
      ),
    );
    expect(error).toMatchObject({ kind: "refusal", retryable: false });
    // The category goes to the log; the explanation goes nowhere.
    expect(JSON.stringify(warnings)).toContain("cyber");
    expect(JSON.stringify(warnings) + (error as Error).message).not.toContain(
      "upstream",
    );
    expect(fake.log.at(-1)).toBe("POST / budget=41");
  });

  test("exhausted retries are named after the last error the session reported", async () => {
    const kind = async (type: string | undefined) => {
      const fake = new FakeSession();
      fake.onMessage = (f) => {
        f.process();
        f.emit(
          running(),
          ...(type
            ? [
                {
                  type: "session.error",
                  error: {
                    type,
                    message: "upstream text",
                    retry_status: { type: "exhausted" },
                  },
                },
              ]
            : []),
          idle("retries_exhausted"),
        );
      };
      const error = (await failure(runTurn(turn(fake)))) as ProviderError;
      return [error.kind, error.diagnostics.type];
    };
    expect(await kind("billing_error")).toEqual(["quota", "billing_error"]);
    expect(await kind("model_overloaded_error")).toEqual([
      "transient",
      "model_overloaded_error",
    ]);
    expect(await kind("mcp_connection_failed_error")).toEqual([
      "protocol",
      "mcp_connection_failed_error",
    ]);
    expect(await kind(undefined)).toEqual(["transient", undefined]);

    // An error the old turn reported before the message was taken up is not the turn's.
    const fake = new FakeSession({ status: "running", budget: 141, used: 40 });
    fake.onMessage = (f) => {
      f.emit(
        {
          type: "session.error",
          error: {
            type: "billing_error",
            message: "upstream text",
            retry_status: { type: "retrying" },
          },
        },
        running(),
      );
      f.process();
      f.emit(running(), idle("retries_exhausted"));
    };
    const error = (await failure(runTurn(turn(fake)))) as ProviderError;
    expect([error.kind, error.diagnostics.type]).toEqual([
      "transient",
      undefined,
    ]);
  });

  test("exhausted retries are not the end when the server starts another turn by itself", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), idle("retries_exhausted"), running());
      setTimeout(() => f.emit(said("結果を読みました。"), idle()), 60);
    };
    expect((await runTurn(turn(fake))).text).toBe("結果を読みました。");
  });
});

describe("bringing a session to rest", () => {
  test("interrupts a running session, then lowers its budget to what it has used plus a cent", async () => {
    const fake = new FakeSession({ status: "running", budget: 300, used: 120 });
    const rest = await quiesce(fake.client, "sesn_1");
    expect(fake.log).toEqual([
      "GET /",
      "POST /events user.interrupt",
      "POST / budget=121",
    ]);
    expect(rest).toMatchObject({
      status: "running",
      lowered: true,
      costReported: true,
    });
    expect(rest.totals?.list_cost_cents).toBe(120);
  });

  test("leaves an idle session's events alone unless told to interrupt", async () => {
    const idleSession = new FakeSession({
      status: "idle",
      budget: 300,
      used: 120,
    });
    await quiesce(idleSession.client, "sesn_1");
    expect(idleSession.log).toEqual(["GET /", "POST / budget=121"]);
    const asked = new FakeSession({ status: "idle", budget: 300, used: 120 });
    await quiesce(asked.client, "sesn_1", { interrupt: true });
    expect(asked.log).toEqual([
      "GET /",
      "POST /events user.interrupt",
      "POST / budget=121",
    ]);
  });

  test("widens a rejected value, and never back up to the budget it is lowering", async () => {
    const fake = new FakeSession({ status: "idle", budget: 300, used: 120 });
    // The reported cost is behind: the session has really used a little over 123 cents.
    fake.on(`POST ${SESSION}`, (request) =>
      Number(request.body!.budget.max_list_cost.amount) <= 123
        ? rejected(400)
        : undefined,
    );
    expect((await quiesce(fake.client, "sesn_1")).lowered).toBe(true);
    expect(
      fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount),
    ).toEqual(["121", "122", "124"]);

    const tight = new FakeSession({ status: "idle", budget: 125, used: 120 });
    tight.on(`POST ${SESSION}`, () => rejected(400));
    expect((await quiesce(tight.client, "sesn_1")).lowered).toBe(false);
    expect(
      tight.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount),
    ).toEqual(["121", "122", "124"]);
  });

  test("does not touch a session that is paused at its budget", async () => {
    for (const used of [100, 101, 99]) {
      const fake = new FakeSession({ status: "idle", budget: 100, used });
      expect(await quiesce(fake.client, "sesn_1")).toMatchObject({
        lowered: true,
      });
      expect(fake.log).toEqual(["GET /"]);
    }
  });

  test("a session that no longer exists is at rest; one that cannot be read is not", async () => {
    const gone = new FakeSession();
    gone.on(`GET ${SESSION}`, () =>
      rejected(404, { type: "not_found_error", message: "x" }),
    );
    expect(await quiesce(gone.client, "sesn_1")).toEqual({
      status: "deleted",
      lowered: true,
    });
    const down = new FakeSession();
    down.on(`GET ${SESSION}`, () =>
      rejected(503, { type: "overloaded_error", message: "x" }),
    );
    expect(await quiesce(down.client, "sesn_1")).toEqual({
      status: "unknown",
      lowered: false,
    });
  });
});
