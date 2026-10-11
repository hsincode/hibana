import { describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import { loadConfig } from "../config";
import { ProviderError } from "../llm-errors";
import type { Context } from "../types";
import { createWorkspaceClient, SessionGone } from "../workspace/client";
import {
  abortKind, budgetNotice, openRunsNotice, quiesce, runTurn, timeoutNotice, type TurnInput, type TurnResult,
} from "../workspace/runner";
import type { RawEvent, WorkspaceCall, WorkspaceResult } from "../workspace/types";

// Decision record: #76. One turn of an Anthropic Workspace session against a
// session that lives in this file: the requests the runner makes, in what
// order, and what it does with the events it is given. Nothing is sent, and
// the waits between reconnects are skipped.

type Json = Record<string, any>;
type Sent = { method: string; path: string; query: URLSearchParams; body?: Json };
const SESSION = "/v1/sessions/sesn_1";
const usd = (amount: number) => ({ amount: String(amount), currency: "USD" });
const rejected = (status: number, error: Json = { type: "invalid_request_error", message: "upstream text" }) =>
  Response.json({ type: "error", error }, { status });

/**
 * One session of the Managed Agents API. Tests set its state, decide what it
 * emits and when, and read back every request. An emitted event goes to the
 * open stream and into the list, as on the real API.
 */
class FakeSession {
  sent: Sent[] = [];
  state: Json;
  history: RawEvent[] = [];
  /** Called when the turn's message arrives; what it emits is the turn. */
  onMessage: (fake: FakeSession) => void = () => {};
  onResult: (event: Json, fake: FakeSession) => void = () => {};
  onInterrupt: (fake: FakeSession) => void = () => {};
  onStream: (fake: FakeSession, opened: number) => void = () => {};
  private routes = new Map<string, (request: Sent) => Response | undefined>();
  private streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  private n = 0;
  private message?: RawEvent;
  readonly client = createWorkspaceClient(
    loadConfig({ ANTHROPIC_WORKSPACE_API_KEY: "fixture", RUNTIME_STATE_PATH: "", LOG_DIR: "" }),
    { fetch: ((input: unknown, init?: RequestInit) => this.fetch(input, init)) as unknown as typeof fetch, maxRetries: 0 });

  /** By default at rest as the last turn left it: 40 cents used, the budget lowered to 41. */
  constructor(state: { status?: string; budget?: number | null; used?: number | null; usage?: Json } = {}) {
    this.state = {
      id: "sesn_1", type: "session", status: state.status ?? "idle", archived_at: null,
      budget: state.budget === null ? null : { type: "limit", max_list_cost: usd(state.budget ?? 41) },
      usage: state.usage ?? (state.used === null ? {} : { list_cost: usd(state.used ?? 40), input_tokens: 10 }),
    };
  }

  /** Replaces one route's answer; returning nothing falls through to the default. */
  on(key: string, reply: (request: Sent) => Response | undefined) { this.routes.set(key, reply); }
  of(method: string, path: string) { return this.sent.filter((r) => r.method === method && r.path === path); }
  /** Request lines in order, with what was sent for the ones that send events. */
  get log() {
    return this.sent.map((r) => {
      const types = r.body?.events?.map((e: Json) => e.type).join("+");
      const budget = r.body?.budget?.max_list_cost?.amount;
      return `${r.method} ${r.path.replace(SESSION, "") || "/"}${types ? ` ${types}` : ""}${budget ? ` budget=${budget}` : ""}`;
    });
  }
  events(type: string) {
    return this.of("POST", `${SESSION}/events`).flatMap((r) => r.body!.events as Json[]).filter((e) => e.type === type);
  }
  get streamsOpened() { return this.of("GET", `${SESSION}/events/stream`).length; }

  /** Emits events: each gets an id and a time unless it brings its own. */
  emit(...events: Json[]) {
    for (const event of events) {
      const full = { id: `sevt_${++this.n}`, processed_at: new Date(Date.UTC(2026, 9, 12, 0, 0, this.n)).toISOString(), ...event } as RawEvent;
      this.history.push(full);
      this.write(`event: ${full.type}\ndata: ${JSON.stringify(full)}\n\n`);
    }
  }
  /** Into the list only: what happened while no stream was open. */
  missed(...events: Json[]) {
    for (const event of events)
      this.history.push({ id: `sevt_${++this.n}`, processed_at: new Date(Date.UTC(2026, 9, 12, 0, 0, this.n)).toISOString(), ...event } as RawEvent);
  }
  write(text: string) {
    try { this.streams.at(-1)?.enqueue(new TextEncoder().encode(text)); } catch {}
  }
  /** Ends the open stream, as a dropped connection would. */
  drop() {
    try { this.streams.at(-1)?.close(); } catch {}
  }
  /** The turn's message leaves the queue: it is echoed again, now processed. */
  process() {
    if (!this.message || this.message.processed_at) return;
    this.history = this.history.filter((e) => e !== this.message);
    this.message = { ...this.message, processed_at: new Date(Date.UTC(2026, 9, 12, 0, 0, ++this.n)).toISOString() };
    this.history.push(this.message);
    this.write(`event: user.message\ndata: ${JSON.stringify(this.message)}\n\n`);
  }
  use(amount: number, more: Json = {}) { this.state.usage = { ...this.state.usage, list_cost: usd(amount), ...more }; }

  private async fetch(input: unknown, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const request: Sent = {
      method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query: url.searchParams,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    this.sent.push(request);
    const key = `${request.method} ${request.path}`;
    const replaced = this.routes.get(key)?.(request);
    if (replaced) return replaced;
    switch (key) {
      case `GET ${SESSION}`:
        return Response.json(this.state);
      case `POST ${SESSION}`:
        if (request.body?.budget) this.state.budget = request.body.budget;
        return Response.json(this.state);
      case `GET ${SESSION}/events/stream`: {
        const body = new ReadableStream<Uint8Array>({ start: (controller) => { this.streams.push(controller); } });
        this.onStream(this, this.streams.length);
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      case `GET ${SESSION}/events`: {
        const types = request.query.getAll("types[]");
        const data = this.history.filter((e) => !types.length || types.includes(e.type));
        return Response.json({ data: request.query.get("order") === "desc" ? [...data].reverse() : data, next_page: null });
      }
      case `POST ${SESSION}/events`: {
        const event = request.body!.events[0] as Json;
        if (event.type === "user.message") {
          // Queued first: no `processed_at` until the agent takes it up.
          this.message = { id: "sevt_msg", type: "user.message", content: event.content, processed_at: null };
          this.history.push(this.message);
          this.write(`event: user.message\ndata: ${JSON.stringify(this.message)}\n\n`);
          this.onMessage(this);
          return Response.json({ data: [this.message] });
        }
        if (event.type === "user.interrupt") this.onInterrupt(this);
        if (event.type === "user.custom_tool_result") {
          this.history.push({ id: `sevt_${++this.n}`, processed_at: new Date().toISOString(), ...event } as RawEvent);
          this.onResult(event, this);
        }
        return Response.json({ data: [{ id: `sevt_${++this.n}`, ...event }] });
      }
    }
    return rejected(404, { type: "not_found_error", message: "no such route" });
  }
}

const said = (text: string): Json => ({ type: "agent.message", content: [{ type: "text", text }] });
const idle = (type = "end_turn", more: Json = {}): Json =>
  ({ type: "session.status_idle", stop_reason: { type, ...more }, stop_details: null });
const running = (): Json => ({ type: "session.status_running" });
const reported = (amount: number, more: Json = {}): Json => ({ type: "session.usage", usage: { list_cost: usd(amount), ...more } });
const calls = (name: string, id: string, input: Json = {}, thread?: string): Json =>
  ({ type: "agent.custom_tool_use", id, name, input, ...(thread && { session_thread_id: thread }) });
const ok = (text: string): WorkspaceResult => ({ content: [{ type: "text", text }], is_error: false });
/** A whole plain answer: the message is taken up, the model replies, the session rests. */
const answers = (text: string, used = 57) => (fake: FakeSession) => {
  fake.process();
  fake.use(used);
  fake.emit(running(), said(text), reported(used), idle());
};

const context = (extra: Partial<Context> = {}): Context => ({
  channelId: "10", userId: "20", botId: "30", thread: false, depth: 0, delivered: false, harness: "workspace", ...extra,
});
function turn(fake: FakeSession, over: Partial<TurnInput> = {}): TurnInput {
  return {
    client: fake.client, sessionId: "sesn_1", model: "claude-haiku-5-5",
    content: [{ type: "text", text: "hello" }], ctx: context(), signal: new AbortController().signal,
    budget: { allowCents: 100 }, deadlineAt: Date.now() + 60_000,
    executeTool: async () => ok("done"),
    limits: { idleMs: 10_000, reconnects: 2, graceMs: 30, interruptWaitMs: 60, settleMs: 60, timeoutMs: 1_200_000 },
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
    const result = await runTurn(turn(fake, {
      onLease: (ceiling) => { order.push(`lease ${ceiling} after ${fake.sent.length} requests`); },
      onSent: async (mark) => { order.push(`sent ${mark.eventId} ${mark.ceilingCents}`); },
    }));
    expect(fake.log).toEqual([
      "GET /",
      "POST / budget=140",
      "GET /events/stream",
      "POST /events user.message",
      "GET /",
      "POST / budget=58",
    ]);
    expect(order).toEqual(["lease 140 after 1 requests", "sent sevt_msg 140"]);
    expect(fake.events("user.message")).toEqual([{ type: "user.message", content: [{ type: "text", text: "hello" }] }]);
    expect(result).toMatchObject({
      text: "こんにちは", stop: "end_turn", rounds: 0, costReported: true, released: true,
      openRuns: [], runsStarted: [], compacted: false,
    });
    expect(result.notice).toBeUndefined();
    expect(result.cumulative?.list_cost_cents).toBe(57);
  });

  test("the final text is what the last model request said; what came before a tool call is passed on", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(
        running(), { type: "span.model_request_start" }, said("調べます。"),
        { type: "agent.tool_use", name: "bash", input: { command: "ls" }, evaluated_permission: "allow" },
        { type: "span.model_request_end", is_error: false, model_usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
        { type: "agent.tool_result", tool_use_id: "x" },
        { type: "span.model_request_start" }, said("一つ目。"), said("二つ目。"),
        { type: "span.model_request_end", is_error: false, model_usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } },
        { type: "agent.thread_context_compacted" },
        idle(),
      );
    };
    const spoken: string[] = [], seen: string[] = [];
    const result = await runTurn(turn(fake, {
      say: (text) => { spoken.push(text); },
      observe: (event) => { seen.push(event.type); if (event.type === "agent.tool_use") throw new Error("a progress bug"); },
    }));
    expect(result.text).toBe("一つ目。\n\n二つ目。");
    expect(spoken).toEqual(["調べます。"]);
    expect(result).toMatchObject({ rounds: 2, context: 155, compacted: true });
    // Everything after the turn's own message, in order, and a thrown observer changes nothing.
    expect(seen.slice(0, 4)).toEqual(["session.status_running", "span.model_request_start", "agent.message", "agent.tool_use"]);
    expect(seen.at(-1)).toBe("session.status_idle");
  });

  test("answers a custom tool call when it arrives, one result per request", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      // No idle in between: with a workflow run open there may never be one.
      f.emit(running(), { type: "session.thread_created", session_thread_id: "sth_1", agent_name: "worker", workflow_run_id: "wrun_1" },
        calls("read_messages", "call_a", { limit: 5 }), calls("guild_info", "call_b", {}, "sth_1"));
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
        return call.id === "call_a" ? ok("five messages") : { content: [{ type: "text", text: "not allowed" }], is_error: true };
      },
    });
    const result = await runTurn(input);
    expect(result.text).toBe("読みました。");
    expect(executed).toEqual([
      { id: "call_a", name: "read_messages", input: { limit: 5 }, threadId: null, runId: null },
      // A call from a run's thread names the thread and the run it belongs to.
      { id: "call_b", name: "guild_info", input: {}, threadId: "sth_1", runId: "wrun_1" },
    ]);
    const posts = fake.of("POST", `${SESSION}/events`).filter((r) => r.body!.events[0].type === "user.custom_tool_result");
    expect(posts.map((r) => r.body!.events)).toEqual([
      [{ type: "user.custom_tool_result", custom_tool_use_id: "call_a", content: [{ type: "text", text: "five messages" }], is_error: false }],
      [{ type: "user.custom_tool_result", custom_tool_use_id: "call_b", content: [{ type: "text", text: "not allowed" }], is_error: true }],
    ]);
    // What a tool recorded on the context it was given reaches the turn's own.
    expect(input.ctx.delivered).toBe(true);
  });

  test("denies a tool call that asks for permission: nobody is there to grant it", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit({ type: "agent.tool_use", id: "tool_1", name: "bash", input: {}, evaluated_permission: "ask" }, said("できませんでした。"), idle());
    };
    await runTurn(turn(fake));
    expect(fake.events("user.tool_confirmation")).toMatchObject([{ tool_use_id: "tool_1", result: "deny" }]);
  });

  test("does not finish while a workflow run is open", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      // The agent's own turn ends, but the run it started is only beginning.
      f.emit(running(), { type: "workflow_run.created", workflow_run_id: "wrun_1", name: "survey", description: null, phases: [] },
        said("調査を始めました。"), idle(), { type: "workflow_run.status_running", workflow_run_id: "wrun_1" });
    };
    const spoken: string[] = [];
    let done = false;
    const work = runTurn(turn(fake, { say: (text) => { spoken.push(text); } }));
    void work.then(() => { done = true; }, () => { done = true; });
    // Well past the grace period, and the turn is still waiting for the run.
    await Bun.sleep(100);
    expect(done).toBe(false);
    fake.emit({ type: "workflow_run.status_ended", workflow_run_id: "wrun_1", result: { type: "completed" } },
      running(), { type: "span.model_request_start" }, said("調査が終わりました。"), idle());
    const result = await work;
    expect(result).toMatchObject({ text: "調査が終わりました。", stop: "end_turn", openRuns: [], runsStarted: [{ id: "wrun_1", name: "survey" }] });
    expect(result.notice).toBeUndefined();
    expect(spoken).toEqual(["調査を始めました。"]);
  });

  test("finishes with a note when a run stays paused past the grace period", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), { type: "workflow_run.created", workflow_run_id: "wrun_1", name: "survey", description: null, phases: [] },
        { type: "workflow_run.status_idle", workflow_run_id: "wrun_1" }, said("途中です。"), idle());
    };
    const result = await runTurn(turn(fake));
    expect(result).toMatchObject({ text: "途中です。", stop: "end_turn", released: true, openRuns: [{ id: "wrun_1", name: "survey" }] });
    expect(result.notice).toBe("バックグラウンドの作業（workflow run）が 1 件、止まったまま残っています。続けるには「続けて」と送ってください。");
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
      f.emit(running(), said("ここまで。"), reported(143), idle("budget_reached"));
    };
    const result = await runTurn(turn(fake));
    expect(result).toMatchObject({ text: "ここまで。", stop: "budget", released: true });
    expect(result.notice).toBe("このターンの費用の上限（$1.00）に達したため、ここで止めました。続けるには、もう一度メッセージを送ってください。");
    expect(result.cumulative?.list_cost_cents).toBe(143);
    // "Used plus a cent" would be a raise here and resume every paused thread.
    expect(fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount)).toEqual(["140"]);
    expect(fake.events("user.interrupt")).toHaveLength(0);
  });

  test("interrupts first when the session was left at its budget, and ignores what precedes its own message", async () => {
    const fake = new FakeSession({ budget: 100, used: 100 });
    fake.onMessage = (f) => {
      // Still the old turn: its end, and a call it made on the way out.
      f.emit(idle(), calls("send_message", "call_old", { content: "late" }));
    };
    // Only after that is the new message taken up.
    fake.onResult = (_event, f) => { f.process(); f.emit(running(), said("新しい返事。"), idle()); };
    let executed = 0;
    const observed: string[] = [];
    const result = await runTurn(turn(fake, {
      executeTool: async () => { executed++; return ok("sent"); },
      observe: (event) => { observed.push(event.type); },
    }));
    expect(fake.log.slice(0, 5)).toEqual([
      "GET /",
      // Alone, and before the raise: the raise would resume what the budget paused.
      "POST /events user.interrupt",
      "POST / budget=200",
      "GET /events/stream",
      "POST /events user.message",
    ]);
    expect(result).toMatchObject({ text: "新しい返事。", stop: "end_turn" });
    expect(executed).toBe(0);
    // Progress starts with the turn, not with what was left over.
    expect(observed).toEqual(["session.status_running", "agent.message", "session.status_idle"]);
    expect(fake.events("user.custom_tool_result")).toEqual([{
      type: "user.custom_tool_result", custom_tool_use_id: "call_old", is_error: true,
      content: [{ type: "text", text: "This call belongs to an earlier turn that was stopped, so it was not run." }],
    }]);
  });

  test("handles each event once across a reconnect and never runs a tool twice", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), { ...said("途中まで。"), id: "sevt_dup" }, { ...said("途中まで。"), id: "sevt_dup" }, calls("read_messages", "call_1"));
    };
    fake.onResult = (event, f) => {
      if (event.custom_tool_use_id === "call_1") {
        // The connection drops. A second call and the model's next step happen while nothing is listening.
        f.missed(calls("read_messages", "call_2"), idle("requires_action", { event_ids: ["call_2"] }));
        f.drop();
      } else f.emit(running(), { type: "span.model_request_start" }, said("終わり。"), idle());
    };
    const executed: string[] = [];
    const spoken: string[] = [];
    const result = await runTurn(turn(fake, {
      executeTool: async (call) => { executed.push(call.id); return ok(call.id); },
      say: (text) => { spoken.push(text); },
    }));
    expect(result.text).toBe("終わり。");
    expect(executed).toEqual(["call_1", "call_2"]);
    expect(fake.events("user.custom_tool_result").map((e) => e.custom_tool_use_id)).toEqual(["call_1", "call_2"]);
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
    fake.onMessage = (f) => { f.process(); f.emit(running()); f.drop(); };
    let opened = 0;
    fake.on(`GET ${SESSION}/events/stream`, () => (++opened > 1 ? rejected(503, { type: "overloaded_error", message: "busy" }) : undefined));
    fake.state.status = "running";
    const error = await failure(runTurn(turn(fake, { limits: { idleMs: 10_000, reconnects: 2 } })));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "transient", retryable: true, status: 503 });
    expect((error as ProviderError).diagnostics).toMatchObject({ phase: "stream", retries: 2, model: "claude-haiku-5-5" });
    expect(fake.streamsOpened).toBe(3);
    expect(fake.log.slice(-3)).toEqual(["GET /", "POST /events user.interrupt", "POST / budget=41"]);
  });

  test("reopens a stream that went quiet without counting it as a failure", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => { f.process(); f.emit(running()); };
    // Nothing more arrives on the first connection; the answer is in the list by the time it is reopened.
    fake.onStream = (f, opened) => { if (opened === 2) { f.missed(said("静かでした。")); f.emit(idle()); } };
    const result = await runTurn(turn(fake, { limits: { idleMs: 40, reconnects: 0 } }));
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
        f.write(++beats % 2 ? ": keep-alive\n\n" : "event: ping\ndata: {\"type\":\"ping\"}\n\n");
        if (beats === 15) { clearInterval(beat); f.emit(said("生きています。"), idle()); }
      }, 40);
    };
    const result = await runTurn(turn(fake, { limits: { idleMs: 400, reconnects: 0 } }));
    expect(result.text).toBe("生きています。");
    expect(fake.streamsOpened).toBe(1);
  });

  test("keeps session.usage and tolerates frames it does not know", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      // The typed stream of the SDK would drop the first of these.
      f.write(`event: session.usage\ndata: ${JSON.stringify({ id: "sevt_u1", processed_at: "2026-10-12T00:00:01Z", ...reported(61, { input_tokens: 900, output_tokens: 40 }) })}\n\n`);
      f.write(`data: ${JSON.stringify({ id: "sevt_u2", processed_at: "2026-10-12T00:00:02Z", ...reported(66, { input_tokens: 1200 }) })}\n\n`);
      f.write("event: something.new\ndata: {\"type\":\"something.new\",\"id\":\"sevt_x\",\"processed_at\":\"2026-10-12T00:00:03Z\"}\n\n");
      f.write("event: ping\ndata: {\"type\":\"ping\"}\n\n");
      f.write("data: {broken\n\n");
      f.write("data: {\"no\":\"type\"}\n\n");
      f.write("data: [1,2,3]\n\n");
      f.emit(said("大丈夫。"), idle());
    };
    // The session's own figure is read a moment later and can be behind the stream.
    fake.use(64, { input_tokens: 1000, output_tokens: 40 });
    const result = await runTurn(turn(fake));
    expect(result.text).toBe("大丈夫。");
    expect(result.costReported).toBe(true);
    expect(result.cumulative).toMatchObject({ list_cost_cents: 66, input_tokens: 1200, output_tokens: 40 });
    expect(fake.log.at(-1)).toBe("POST / budget=65");
  });

  test("an error event on the stream is a disconnect, not the end of the turn", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running());
      f.write("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"upstream text\"}}\n\n");
    };
    fake.onStream = (f, opened) => { if (opened === 2) f.emit(said("戻りました。"), idle()); };
    const result = await runTurn(turn(fake));
    expect(result.text).toBe("戻りました。");
    expect(fake.streamsOpened).toBe(2);
  });
});

describe("catching up", () => {
  test("a result that could not be delivered is sent again after the reconnect; the tool is not run again", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => { f.process(); f.emit(running(), calls("read_messages", "call_1")); };
    let refusedOnce = false;
    fake.on(`POST ${SESSION}/events`, (request) => {
      if (request.body!.events[0].type !== "user.custom_tool_result" || refusedOnce) return undefined;
      refusedOnce = true;
      setTimeout(() => fake.drop(), 5);
      return rejected(503, { type: "overloaded_error", message: "busy" });
    });
    fake.onResult = (_event, f) => { f.emit(said("読めました。"), idle()); };
    let executed = 0;
    const result = await runTurn(turn(fake, { executeTool: async () => { executed++; return ok("five messages"); } }));
    expect(result.text).toBe("読めました。");
    expect(executed).toBe(1);
    expect(fake.events("user.custom_tool_result")).toMatchObject([
      { custom_tool_use_id: "call_1", content: [{ type: "text", text: "five messages" }] },
      { custom_tool_use_id: "call_1", content: [{ type: "text", text: "five messages" }] },
    ]);
  });

  test("a call the session still waits on from before the turn is closed, not run", async () => {
    // A run's agent asked while the last turn was being stopped; nobody answered.
    const fake = new FakeSession({ status: "running" });
    fake.missed({ ...calls("read_messages", "call_before", {}, "sth_9"), processed_at: "2026-10-11T23:59:00Z" });
    fake.onMessage = (f) => { f.process(); f.emit(running(), idle("requires_action", { event_ids: ["call_before"] })); };
    fake.onResult = (_event, f) => { f.emit(running(), said("続けます。"), idle()); };
    let executed = 0;
    const result = await runTurn(turn(fake, { executeTool: async () => { executed++; return ok("x"); } }));
    expect(result.text).toBe("続けます。");
    expect(executed).toBe(0);
    expect(fake.events("user.custom_tool_result")).toMatchObject([{ custom_tool_use_id: "call_before", is_error: true }]);
  });

  test("the runs a session row lists are checked against the session's own events", async () => {
    const created = (id: string, name: string): Json => ({ type: "workflow_run.created", workflow_run_id: id, name, description: null, phases: [] });
    const fake = new FakeSession();
    fake.missed(created("wrun_a", "first"), { type: "workflow_run.status_ended", workflow_run_id: "wrun_a", result: { type: "completed" } },
      created("wrun_b", "second"));
    fake.onMessage = answers("まだ一つ残っています。");
    const result = await runTurn(turn(fake, { knownRuns: [{ id: "wrun_a", name: "first" }, { id: "wrun_b", name: "stale name" }] }));
    expect(fake.of("GET", `${SESSION}/events`)[0]!.query.getAll("types[]")).toEqual(["workflow_run.created", "workflow_run.status_ended"]);
    // One is still open, so whatever it was doing is interrupted before the budget is raised.
    expect(fake.log.slice(1, 4)).toEqual(["GET /events", "POST /events user.interrupt", "POST / budget=140"]);
    expect(result.openRuns).toEqual([{ id: "wrun_b", name: "second" }]);
    expect(result.runsStarted).toEqual([]);
    expect(result.notice).toBe(openRunsNotice(1));

    // All of them ended while nobody was listening: the session is simply at rest.
    const rested = new FakeSession();
    rested.missed(created("wrun_a", "first"), { type: "workflow_run.status_ended", workflow_run_id: "wrun_a", result: { type: "stopped" } });
    rested.onMessage = answers("全部終わっています。");
    const after = await runTurn(turn(rested, { knownRuns: [{ id: "wrun_a", name: "first" }] }));
    expect(rested.events("user.interrupt")).toHaveLength(0);
    expect(after.openRuns).toEqual([]);
    expect(after.notice).toBeUndefined();
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
      fake.history.push({ id: "sevt_arrived", type: "user.message", content: request.body!.events[0].content, processed_at: null });
      setTimeout(() => {
        fake.history.at(-1)!.processed_at = "2026-10-12T00:00:09Z";
        fake.emit({ ...fake.history.at(-1)!, id: "sevt_arrived" }, running(), said("届いていました。"), idle());
      }, 5);
      throw new TypeError("socket hang up");
    });
    let mark: unknown;
    const result = await runTurn(turn(fake, { onSent: async (m) => { mark = m; } }));
    expect(posts).toBe(1);
    expect(mark).toEqual({ eventId: "sevt_arrived", ceilingCents: 140 });
    expect(result.text).toBe("届いていました。");
    const lookup = fake.of("GET", `${SESSION}/events`)[0]!;
    expect(lookup.query.getAll("types[]")).toEqual(["user.message"]);
    expect(lookup.query.get("order")).toBe("desc");
  });

  test("fails without a second copy when it cannot be found, and does not take an older message with the same words", async () => {
    const fake = new FakeSession();
    fake.history.push({ id: "sevt_before", type: "user.message", content: [{ type: "text", text: "hello" }], processed_at: "2026-10-11T23:00:00Z" });
    let posts = 0;
    fake.on(`POST ${SESSION}/events`, (request) => {
      if (request.body!.events[0].type !== "user.message") return undefined;
      posts++;
      throw new TypeError("socket hang up");
    });
    let marked = false;
    const error = await failure(runTurn(turn(fake, { onSent: async () => { marked = true; } })));
    expect(error).toMatchObject({ kind: "transient", retryable: true });
    expect(posts).toBe(1);
    expect(marked).toBe(false);
    // The allowance is taken back even though nothing ran.
    expect(fake.log.at(-1)).toBe("POST / budget=41");
  });

  test("closes the calls an earlier turn left open, then sends once more", async () => {
    const fake = new FakeSession();
    fake.history.push(
      { id: "sevt_old_msg", type: "user.message", content: [{ type: "text", text: "earlier" }], processed_at: "2026-10-11T23:00:00Z" },
      { id: "call_done", type: "agent.custom_tool_use", name: "read_messages", input: {}, processed_at: "2026-10-11T23:00:01Z" },
      { id: "sevt_r", type: "user.custom_tool_result", custom_tool_use_id: "call_done", processed_at: "2026-10-11T23:00:02Z" },
      { id: "call_open", type: "agent.custom_tool_use", name: "send_message", input: {}, processed_at: "2026-10-11T23:00:03Z" },
      { id: "sevt_i", type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["call_open"] }, processed_at: "2026-10-11T23:00:04Z" },
    );
    let blocked = true;
    fake.on(`POST ${SESSION}/events`, (request) => {
      const type = request.body!.events[0].type;
      if (type === "user.custom_tool_result") blocked = false;
      return type === "user.message" && blocked ? rejected(400) : undefined;
    });
    fake.onMessage = answers("続きです。");
    let executed = 0;
    const result = await runTurn(turn(fake, { executeTool: async () => { executed++; return ok("x"); } }));
    expect(result.text).toBe("続きです。");
    expect(executed).toBe(0);
    expect(fake.log.filter((line) => line.startsWith("POST /events"))).toEqual([
      "POST /events user.message",
      "POST /events user.interrupt",
      "POST /events user.custom_tool_result",
      "POST /events user.message",
    ]);
    expect(fake.events("user.custom_tool_result")).toMatchObject([{ custom_tool_use_id: "call_open", is_error: true }]);
  });

  test("a second rejection is the turn's failure", async () => {
    const fake = new FakeSession();
    fake.on(`POST ${SESSION}/events`, (request) => (request.body!.events[0].type === "user.message" ? rejected(400) : undefined));
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
      return rejected(400, { type: "invalid_request_error", message: "budget.max_list_cost must be greater than the session's consumed list cost" });
    });
    fake.onMessage = answers("はい。", 60);
    const leases: number[] = [];
    const result = await runTurn(turn(fake, { onLease: (ceiling) => { leases.push(ceiling); } }));
    expect(result.stop).toBe("end_turn");
    expect(leases).toEqual([140, 145]);
    expect(fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount)).toEqual(["140", "145", "61"]);
    // The budget is replaced by another limit every time, never removed.
    expect(fake.of("POST", SESSION).every((r) => r.body!.budget?.type === "limit" && Object.keys(r.body!).length === 1)).toBe(true);
  });

  test("any other rejection stops the turn before a message is sent", async () => {
    const fake = new FakeSession();
    fake.on(`POST ${SESSION}`, () => rejected(400, { type: "invalid_request_error", message: "no list price is available for the model" }));
    const error = await failure(runTurn(turn(fake)));
    expect(error).toMatchObject({ kind: "protocol", retryable: false, status: 400 });
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
    const result = await runTurn(turn(fake, { budget: { ceilingCents: 140 }, onLease: (c) => { leases.push(c); } }));
    expect(result.text).toBe("再開しました。");
    expect(leases).toEqual([140]);
    // Nothing to raise; only the lowering at the end touches the budget.
    expect(fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount)).toEqual(["96"]);
  });

  test("a resumed turn that has used its ceiling sends nothing", async () => {
    const fake = new FakeSession({ budget: 140, used: 141 });
    const result = await runTurn(turn(fake, { budget: { ceilingCents: 140 }, baseline: { list_cost_cents: 40 } as TurnResult["cumulative"] }));
    expect(result).toMatchObject({ text: "", stop: "budget", released: true });
    expect(result.notice).toBe(budgetNotice(100));
    expect(fake.log).toEqual(["GET /", "GET /"]);
  });

  test("a turn that is already out of time sends nothing", async () => {
    const fake = new FakeSession({ budget: 140, used: 80 });
    const result = await runTurn(turn(fake, { budget: { ceilingCents: 140 }, deadlineAt: Date.now() - 1 }));
    expect(result).toMatchObject({ text: "", stop: "timeout", released: true });
    expect(result.notice).toBe(timeoutNotice(1_200_000));
    expect(fake.log).toEqual(["GET /", "GET /", "POST / budget=81"]);
  });

  test("a used session that reports no cost is not given a ceiling", async () => {
    const fake = new FakeSession({ usage: { input_tokens: 5000, output_tokens: 300 } });
    const error = await failure(runTurn(turn(fake)));
    expect(error).toMatchObject({ kind: "protocol", retryable: false });
    expect((error as ProviderError).diagnostics.code).toBe("list_cost_missing");
    expect(fake.log).toEqual(["GET /"]);
  });

  test("a session that was never used may report none yet", async () => {
    const fake = new FakeSession({ used: null, budget: 50 });
    fake.onMessage = answers("最初の返事。", 12);
    const result = await runTurn(turn(fake));
    expect(result.text).toBe("最初の返事。");
    expect(fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount)).toEqual(["100", "13"]);
    // Whether it was used is asked of the list, since the usage cannot say.
    expect(fake.of("GET", `${SESSION}/events`)[0]!.query.getAll("types[]")).toEqual(["user.message"]);
  });
});

describe("stopping a turn", () => {
  /** A turn whose model called a tool that the test finishes when it wants to. */
  function withTool(fake: FakeSession) {
    let finish!: (result: WorkspaceResult) => void;
    const tool = new Promise<WorkspaceResult>((resolve) => { finish = resolve; });
    let ctx: Context | undefined;
    fake.onMessage = (f) => { f.process(); f.emit(running(), said("送ります。"), calls("send_message", "call_1", { content: "hi" })); };
    fake.onInterrupt = (f) => { f.use(52); f.state.status = "idle"; };
    fake.onResult = (_event, f) => { f.emit(idle()); };
    return { finish, started: () => ctx, executeTool: async (_call: WorkspaceCall, c: Context) => { ctx = c; return tool; } };
  }

  test("a new message from the same person interrupts, and a running tool still reports its real result", async () => {
    const fake = new FakeSession();
    const tool = withTool(fake);
    const steering = new AbortController();
    const work = runTurn(turn(fake, {
      steering: steering.signal, executeTool: tool.executeTool,
      limits: { idleMs: 10_000, reconnects: 2, settleMs: 5_000, interruptWaitMs: 60 },
    }));
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
      { custom_tool_use_id: "call_1", is_error: false, content: [{ type: "text", text: "message sent" }] },
    ]);
    expect(fake.log.at(-1)).toBe("POST / budget=53");
  });

  test("a tool that does not finish in time is answered for, and its late result is dropped", async () => {
    const fake = new FakeSession();
    const tool = withTool(fake);
    const steering = new AbortController();
    const work = runTurn(turn(fake, { steering: steering.signal, executeTool: tool.executeTool }));
    await until(() => !!tool.started());
    steering.abort(new Error("User steering"));
    const result = await work;
    expect(result.stop).toBe("interrupted");
    expect(fake.events("user.custom_tool_result")).toEqual([{
      type: "user.custom_tool_result", custom_tool_use_id: "call_1", is_error: true,
      content: [{ type: "text", text: "This call was still running when the turn was stopped and may have taken effect. Check before repeating it." }],
    }]);
    tool.finish(ok("message sent"));
    await Bun.sleep(10);
    expect(fake.events("user.custom_tool_result")).toHaveLength(1);
  });

  test("a message written before the turn's own was recorded does not drop it", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => { f.process(); f.emit(running(), said("途中。")); };
    fake.onInterrupt = (f) => { f.emit(idle()); };
    const steering = new AbortController();
    steering.abort(new Error("User steering"));
    const order: string[] = [];
    const result = await runTurn(turn(fake, {
      steering: steering.signal,
      onSent: async () => { await Bun.sleep(5); order.push(`recorded after ${fake.events("user.interrupt").length} interrupts`); },
    }));
    expect(order).toEqual(["recorded after 0 interrupts"]);
    expect(fake.events("user.message")).toHaveLength(1);
    expect(fake.events("user.interrupt")).toHaveLength(1);
    expect(result).toMatchObject({ stop: "interrupted", released: true });
  });

  test("the time limit interrupts and says so", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => { f.process(); f.emit(running(), said("長い作業の途中です。")); };
    fake.onInterrupt = (f) => { f.use(90); f.emit(reported(90), idle()); };
    const result = await runTurn(turn(fake, { deadlineAt: Date.now() + 40 }));
    expect(result).toMatchObject({ stop: "timeout", text: "長い作業の途中です。", released: true });
    expect(result.notice).toBe("このターンの時間の上限（20 分）に達したため、中断しました。続けるには、もう一度メッセージを送ってください。");
    expect(fake.events("user.interrupt")).toHaveLength(1);
    expect(fake.log.at(-1)).toBe("POST / budget=91");
  });

  test("a speaker who was blocked meanwhile gets no reply", async () => {
    const fake = new FakeSession();
    let blocked = false;
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), said("秘密の内容。"));
      setTimeout(() => { blocked = true; f.emit({ type: "agent.thinking" }); }, 5);
    };
    fake.onInterrupt = (f) => { f.emit(idle()); };
    const result = await runTurn(turn(fake, { shouldStop: () => blocked }));
    expect(result).toMatchObject({ stop: "stopped", text: "", released: true });
    expect(fake.events("user.interrupt")).toHaveLength(1);
  });

  test("a cleared conversation ends quietly", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => { f.process(); f.emit(running(), said("途中。")); };
    fake.onInterrupt = (f) => { f.emit(idle()); };
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
    const work = runTurn(turn(fake, {
      signal: shutdown.signal, executeTool: tool.executeTool,
      limits: { idleMs: 10_000, reconnects: 2, settleMs: 5_000, interruptWaitMs: 5_000 },
    }));
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
    const steering = new AbortController(), shutdown = new AbortController();
    const work = runTurn(turn(fake, {
      signal: shutdown.signal, steering: steering.signal, executeTool: tool.executeTool,
      limits: { idleMs: 10_000, reconnects: 2, settleMs: 5_000, interruptWaitMs: 5_000 },
    }));
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
    fake.on(`POST ${SESSION}`, () => { shutdown.abort(reason); return undefined; });
    expect(await failure(runTurn(turn(fake, { signal: shutdown.signal })))).toBe(reason);
    expect(fake.events("user.message")).toHaveLength(0);
    // The raise had gone through, so it is taken back.
    expect(fake.log.at(-1)).toBe("POST / budget=41");
  });

  test("the notices name the limit that was reached", () => {
    expect(budgetNotice(300)).toBe("このターンの費用の上限（$3.00）に達したため、ここで止めました。続けるには、もう一度メッセージを送ってください。");
    expect(budgetNotice(5)).toContain("（$0.05）");
    expect(timeoutNotice(3_600_000)).toBe("このターンの時間の上限（60 分）に達したため、中断しました。続けるには、もう一度メッセージを送ってください。");
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
    expect(await gone((f) => f.on(`GET ${SESSION}`, () => rejected(404, { type: "not_found_error", message: "x" })))).toEqual([false, "not_found"]);
    expect(await gone((f) => { f.state.status = "terminated"; })).toEqual([false, "terminated"]);
    expect(await gone((f) => { f.state.archived_at = "2026-10-12T00:00:00Z"; f.state.status = "terminated"; })).toEqual([false, "archived"]);
    // An uncapped session is never used: a budget cannot be added afterwards.
    expect(await gone((f) => { f.state.budget = null; })).toEqual([false, "no_budget"]);
  });

  test("a session that ends under the turn must not be repeated", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => { f.process(); f.emit(running(), { type: "session.status_terminated" }); };
    const error = await failure(runTurn(turn(fake)));
    expect(error).toBeInstanceOf(SessionGone);
    expect(error).toMatchObject({ sent: true, why: "terminated" });
  });

  test("a refusal is reported as one, and the allowance is taken back", async () => {
    const fake = new FakeSession();
    fake.onMessage = (f) => {
      f.process();
      f.emit(running(), { ...idle("refusal"), stop_details: { type: "refusal", category: "cyber", explanation: "upstream text" } });
    };
    const warnings: unknown[][] = [];
    const error = await failure(runTurn(turn(fake, { log: { warn: (...a: unknown[]) => { warnings.push(a); }, debug: () => {} } as unknown as Logger })));
    expect(error).toMatchObject({ kind: "refusal", retryable: false });
    // The category goes to the log; the explanation goes nowhere.
    expect(JSON.stringify(warnings)).toContain("cyber");
    expect(JSON.stringify(warnings) + (error as Error).message).not.toContain("upstream");
    expect(fake.log.at(-1)).toBe("POST / budget=41");
  });

  test("exhausted retries are named after the last error the session reported", async () => {
    const kind = async (type: string | undefined) => {
      const fake = new FakeSession();
      fake.onMessage = (f) => {
        f.process();
        f.emit(running(), ...(type ? [{ type: "session.error", error: { type, message: "upstream text", retry_status: { type: "exhausted" } } }] : []),
          idle("retries_exhausted"));
      };
      const error = await failure(runTurn(turn(fake))) as ProviderError;
      return [error.kind, error.diagnostics.type];
    };
    expect(await kind("billing_error")).toEqual(["quota", "billing_error"]);
    expect(await kind("model_overloaded_error")).toEqual(["transient", "model_overloaded_error"]);
    expect(await kind("mcp_connection_failed_error")).toEqual(["protocol", "mcp_connection_failed_error"]);
    expect(await kind(undefined)).toEqual(["transient", undefined]);
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
    expect(fake.log).toEqual(["GET /", "POST /events user.interrupt", "POST / budget=121"]);
    expect(rest).toMatchObject({ status: "running", lowered: true, costReported: true });
    expect(rest.totals?.list_cost_cents).toBe(120);
  });

  test("leaves an idle session's events alone unless told to interrupt", async () => {
    const idleSession = new FakeSession({ status: "idle", budget: 300, used: 120 });
    await quiesce(idleSession.client, "sesn_1");
    expect(idleSession.log).toEqual(["GET /", "POST / budget=121"]);
    const asked = new FakeSession({ status: "idle", budget: 300, used: 120 });
    await quiesce(asked.client, "sesn_1", { interrupt: true });
    expect(asked.log).toEqual(["GET /", "POST /events user.interrupt", "POST / budget=121"]);
  });

  test("widens a rejected value, and never back up to the budget it is lowering", async () => {
    const fake = new FakeSession({ status: "idle", budget: 300, used: 120 });
    // The reported cost is behind: the session has really used a little over 123 cents.
    fake.on(`POST ${SESSION}`, (request) => (Number(request.body!.budget.max_list_cost.amount) <= 123 ? rejected(400) : undefined));
    expect((await quiesce(fake.client, "sesn_1")).lowered).toBe(true);
    expect(fake.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount)).toEqual(["121", "122", "124"]);

    const tight = new FakeSession({ status: "idle", budget: 125, used: 120 });
    tight.on(`POST ${SESSION}`, () => rejected(400));
    expect((await quiesce(tight.client, "sesn_1")).lowered).toBe(false);
    expect(tight.of("POST", SESSION).map((r) => r.body!.budget.max_list_cost.amount)).toEqual(["121", "122", "124"]);
  });

  test("does not touch a session that is paused at its budget", async () => {
    for (const used of [100, 101, 99]) {
      const fake = new FakeSession({ status: "idle", budget: 100, used });
      expect(await quiesce(fake.client, "sesn_1")).toMatchObject({ lowered: true });
      expect(fake.log).toEqual(["GET /"]);
    }
  });

  test("a session that no longer exists is at rest; one that cannot be read is not", async () => {
    const gone = new FakeSession();
    gone.on(`GET ${SESSION}`, () => rejected(404, { type: "not_found_error", message: "x" }));
    expect(await quiesce(gone.client, "sesn_1")).toEqual({ status: "deleted", lowered: true });
    const down = new FakeSession();
    down.on(`GET ${SESSION}`, () => rejected(503, { type: "overloaded_error", message: "x" }));
    expect(await quiesce(down.client, "sesn_1")).toEqual({ status: "unknown", lowered: false });
  });
});
