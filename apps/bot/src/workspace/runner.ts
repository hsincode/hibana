import { APIConnectionError, type Anthropic } from "@anthropic-ai/sdk";
import { Stream } from "@anthropic-ai/sdk/core/streaming";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsUserMessageEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { WORKSPACE_PROVIDER } from "@hibana/shared/catalog";
import type { Logger } from "pino";
import { sleep, withAbort } from "../io";
import { apiFailure, ProviderError } from "../llm-errors";
import { retryDelay } from "../llm-request";
import { scopedContext, type Context } from "../types";
import { apiErrorInfo, SessionGone, toProviderError, type ApiErrorInfo } from "./client";
import { budgetLimit, cents } from "./resources";
import type { RawEvent, WorkspaceCall, WorkspaceResult } from "./types";
import { sessionTotals, totalsMax, type WorkspaceTotals } from "./usage";

export type TurnInput = {
  client: Anthropic;
  sessionId: string;
  model: string;
  content: BetaManagedAgentsUserMessageEventParams["content"];
  ctx: Context;
  /** Shutdown, or the conversation being cleared. In effect from the start. */
  signal: AbortSignal;
  /** The same person wrote again. Only looked at once `onSent` has returned,
   *  so a message that was written is never dropped before it is recorded. */
  steering?: AbortSignal;
  /** A new turn brings what it may add; a resumed one the absolute ceiling
   *  its first start was given. */
  budget: { allowCents: number } | { ceilingCents: number };
  /** Absolute time (ms). A resumed turn still counts from its first start. */
  deadlineAt: number;
  /** Must not reject. */
  executeTool: (call: WorkspaceCall, ctx: Context) => Promise<WorkspaceResult>;
  /** The speaker was blocked or the bot disabled here. Asked on every event
   *  and every 30 seconds. */
  shouldStop?: () => boolean;
  /** Every event after the turn's own message, for progress. */
  observe?: (event: RawEvent) => void;
  /** What the model said before it went on to call a tool. */
  say?: (text: string) => void;
  /** Called synchronously just before the session's budget is raised. */
  onLease?: (ceilingCents: number) => void;
  onSent?: (mark: { eventId: string; ceilingCents: number }) => Promise<void>;
  baseline?: WorkspaceTotals;
  /** Workflow runs the session row still lists as open. */
  knownRuns?: { id: string; name: string }[];
  limits: {
    idleMs: number; reconnects: number; graceMs?: number; interruptWaitMs?: number; settleMs?: number;
    /** How long a tool result that could not be delivered waits to be sent again. */
    resendMs?: number;
    /** The configured length of a turn, for the wording of the timeout notice. */
    timeoutMs?: number;
  };
  hooks?: { sleep?: typeof sleep; now?: () => number };
  log?: Logger;
};
export type TurnResult = {
  text: string;
  /** `stopped`: `shouldStop` said so, or the conversation was cleared. */
  stop: "end_turn" | "interrupted" | "timeout" | "budget" | "stopped";
  notice?: string;
  rounds: number;
  context: number;
  cumulative?: WorkspaceTotals;
  costReported: boolean;
  openRuns: { id: string; name: string }[];
  runsStarted: { id: string; name: string }[];
  compacted: boolean;
  /** The session can spend no more: its budget was lowered to what it has
   *  used, or it is paused at its budget. */
  released: boolean;
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const budgetNotice = (cents: number) =>
  `このターンの費用の上限（${usd(cents)}）に達したため、ここで止めました。続けるには、もう一度メッセージを送ってください。`;
export const timeoutNotice = (ms: number) =>
  `このターンの時間の上限（${Math.max(1, Math.round(ms / 60_000))} 分）に達したため、中断しました。続けるには、もう一度メッセージを送ってください。`;
export const openRunsNotice = (count: number) =>
  `バックグラウンドの作業（workflow run）が ${count} 件、止まったまま残っています。続けるには「続けて」と送ってください。`;

class TurnTimeout extends Error {
  constructor() { super("Turn timeout"); }
}
class TurnStopped extends Error {
  constructor() { super("Turn stopped"); }
}
/** Why a turn's signal fired, read from the reasons bot.ts aborts with. */
export function abortKind(reason: unknown): "steering" | "shutdown" | "cleared" | "timeout" | "other" {
  if (reason instanceof TurnTimeout) return "timeout";
  const message = reason instanceof Error ? reason.message : "";
  return message === "User steering" ? "steering"
    : message === "Shutdown" ? "shutdown"
    : message === "Conversation cleared" ? "cleared"
    : "other";
}

const GRACE_MS = 15_000;
const INTERRUPT_WAIT_MS = 30_000;
const SETTLE_MS = 10_000;
// main.ts gives the whole shutdown 25 seconds.
const SHUTDOWN_MS = 8_000;
const CLEANUP_MS = 20_000;
const NOTE_WAIT_MS = 5_000;
const READER_WAIT_MS = 3_000;
const STOP_CHECK_MS = 30_000;
const RESEND_MS = 30_000;
const STREAM_OPEN_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 15_000;
const UNKNOWN_SEND_WAIT_MS = 2_000;
const RAISE_ATTEMPTS = 3;
const LOWER_ATTEMPTS = 6;
// Events one look at the list reads at most. The list is read newest first
// and stops at the turn's own message, so only a very large turn gets here.
const LIST_MAX_EVENTS = 10_000;
// How far before the turn's message a call the session waits on is looked for.
const LIST_PAST_EVENTS = 2_000;

const STILL_RUNNING = "This call was still running when the turn was stopped and may have taken effect. Check before repeating it.";
const LEFTOVER_CALL = "This call belongs to an earlier turn that was stopped, so it was not run.";
// For a call from before this turn began. The turn it was made in may have
// run it and then failed to deliver the result, or been shut down over it.
const OPEN_CALL = "This call was left open by an earlier turn. Whether it was carried out is not known here, so check before repeating it.";
const REFUSED_RESULT = "This call was carried out, but the session did not accept its result. It may have taken effect. Check before repeating it.";
const STOPPED_CALL = "The turn was stopped before this call started, so it was not run.";
const DENIED = "Permission requests are not answered in this session.";
const failed = (text: string): WorkspaceResult => ({ content: [{ type: "text", text }], is_error: true });

type Reading = { totals: WorkspaceTotals; cost: boolean };
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const stopType = (event: RawEvent) => text((event.stop_reason as { type?: unknown } | undefined)?.type);
const asksPermission = (event: RawEvent) =>
  (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use") && event.evaluated_permission === "ask";
/** A message's text and how many blocks it has: enough to recognize the
 *  turn's own message in the list without comparing image data. */
const contentShape = (content: unknown) => {
  const blocks = Array.isArray(content) ? (content as { type?: unknown; text?: unknown }[]) : [];
  return JSON.stringify([blocks.filter((b) => b?.type === "text").map((b) => b.text), blocks.length]);
};
// The update's rejection for a budget at or below what the session has used.
// Where the reason is carried is not verified against the API: the type
// definitions name it, the documentation only gives the sentence.
export const budgetNotRaised = (info: ApiErrorInfo) =>
  info.code === "budget_not_raised" || /budget_not_raised|greater than the session's consumed/i.test(info.message);

async function interrupt(client: Anthropic, sessionId: string, signal?: AbortSignal, log?: Logger): Promise<boolean> {
  try {
    await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] }, { signal });
    return true;
  } catch (error) {
    log?.warn({ session: sessionId, status: apiErrorInfo(error).status }, "workspace interrupt was not accepted");
    return false;
  }
}

/** Lowers the budget to just above what the session has used, so nothing
 *  that is still running can spend the rest of a turn's allowance. True when
 *  the session is left with no room to spend. */
async function lower(
  client: Anthropic,
  session: BetaManagedAgentsSession,
  options: { signal?: AbortSignal; log?: Logger },
): Promise<boolean> {
  const max = cents(session.budget?.max_list_cost);
  if (max === undefined) {
    options.log?.warn({ session: session.id }, "workspace session has no budget to lower");
    return false;
  }
  const consumed = sessionTotals(session.usage).totals.list_cost_cents;
  // At or past its budget the session is paused already. Any accepted change
  // there would resume every paused thread for one more request.
  if (max <= consumed + 1) return true;
  // The reported cost is rounded and may be behind what is enforced, so a
  // rejected value is widened: +1, +2, +4, … and never back up to the budget.
  for (let attempt = 0, width = 1; attempt < LOWER_ATTEMPTS; attempt++, width *= 2) {
    if (consumed + width >= max) break;
    try {
      await client.beta.sessions.update(session.id, { budget: budgetLimit(consumed + width) }, { signal: options.signal });
      return true;
    } catch (error) {
      const status = apiErrorInfo(error).status;
      if (status === 404) return true;
      if (status !== 400) {
        options.log?.warn({ session: session.id, status }, "workspace budget could not be lowered");
        return false;
      }
    }
  }
  options.log?.warn({ session: session.id }, "workspace budget was not lowered: every value was rejected");
  return false;
}

type Rest = { status: string; lowered: boolean; totals?: WorkspaceTotals; costReported?: boolean };
/** `interrupt`: `always`, only when the session reads as `running`, or
 *  `never` for a session that has just reported the end of its turn (its
 *  status can lag the stream by a moment). */
async function settleSession(
  client: Anthropic,
  sessionId: string,
  options: { signal?: AbortSignal; interrupt: "always" | "running" | "never"; log?: Logger },
): Promise<Rest> {
  let session: BetaManagedAgentsSession;
  try {
    session = await client.beta.sessions.retrieve(sessionId, {}, { signal: options.signal });
  } catch (error) {
    const status = apiErrorInfo(error).status;
    // A session that no longer exists cannot spend.
    if (status === 404) return { status: "deleted", lowered: true };
    options.log?.warn({ session: sessionId, status }, "workspace session could not be read");
    return { status: "unknown", lowered: false };
  }
  const { totals, cost } = sessionTotals(session.usage);
  const report = { status: session.status, totals, costReported: cost };
  if (session.status === "terminated") return { ...report, lowered: true };
  const working = session.status === "running" || session.status === "rescheduling";
  if (options.interrupt === "always" || (options.interrupt === "running" && working))
    await interrupt(client, sessionId, options.signal, options.log);
  return { ...report, lowered: await lower(client, session, options) };
}

/**
 * Brings a session to rest: interrupts it when asked or when it is running,
 * then lowers its budget to what it has used. Used at the end of a turn and
 * by the sweep for sessions a turn left behind. Never rejects; `lowered`
 * false means it has to be tried again. A session paused at its budget is
 * left exactly as it is.
 */
export function quiesce(
  client: Anthropic,
  sessionId: string,
  options: { signal?: AbortSignal; interrupt?: boolean; log?: Logger } = {},
): Promise<Rest> {
  return settleSession(client, sessionId, { ...options, interrupt: options.interrupt ? "always" : "running" });
}

/** A fetch body that reports every chunk, comment lines and pings included,
 *  and fails the read when the connection is given up. */
function watched(body: ReadableStream<Uint8Array>, signal: AbortSignal, onChunk: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let over = false;
  let abort = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (!over) {
          over = true;
          try { controller.error(signal.reason ?? new Error("Stream closed")); } catch {}
        }
        void reader.cancel().catch(() => {});
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (over) return;
        if (next.done) {
          over = true;
          signal.removeEventListener("abort", abort);
          controller.close();
        } else {
          onChunk();
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (over) return;
        over = true;
        signal.removeEventListener("abort", abort);
        try { controller.error(error); } catch {}
      }
    },
    cancel(reason) {
      over = true;
      signal.removeEventListener("abort", abort);
      return reader.cancel(reason).catch(() => {});
    },
  });
}

type Outcome =
  | { kind: "end"; notice?: string }
  | { kind: "budget" }
  | { kind: "abort"; reason: unknown; steering?: boolean }
  | { kind: "error"; error: unknown };
type CallState = {
  /** `abandoned`: answered for the tool while it was still running; what it
   *  returns later is dropped. */
  status: "running" | "done" | "abandoned";
  settled?: Promise<void>;
  /** A result that could not be delivered yet. It is sent again, the tool is
   *  not run again. */
  unsent?: WorkspaceResult;
};
/** `refused`: a 400. `gone`: the session is. `failed`: nothing came back, or
 *  the server failed, after the client's own retries. */
type Delivery = "sent" | "refused" | "gone" | "failed";

/**
 * One turn of an Anthropic Workspace session (#76): raise the session's
 * budget by the turn's allowance, send the message, follow the event stream
 * until the session is done, and take the allowance back. Nothing here writes
 * to Discord or to a store; progress and state leave through the callbacks.
 */
class Turn {
  private readonly client: Anthropic;
  private readonly sid: string;
  private readonly log?: Logger;
  private readonly sleep: typeof sleep;
  private readonly now: () => number;
  // Aborted when the turn object is done with: late sends and waits end.
  private readonly life = new AbortController();
  // What a running tool sees as its signal: aborted as soon as the turn stops.
  private readonly work = new AbortController();
  private readonly toolCtx: Context;
  private readonly cleanups: (() => void)[] = [];

  private readonly startedAt: number;
  private ceiling = 0;
  private allowance = 0;
  private leased = false;
  private before?: Reading;

  // The turn's own message. Until it is seen as processed, events may belong
  // to whatever the session was doing before.
  private sent = false;
  private anchorId = "";
  private anchored = false;
  // Seen as processed, on the stream or in the list. A turn that began on a
  // session at rest is anchored without it.
  private taken = false;
  // Set while the list is all that placed the message: see `precedes`.
  private anchorAt?: number;
  // The connection in use has yet to deliver the message as processed. What
  // it carries until then is older than the turn, whatever the list says in
  // the meantime: the list can be ahead of what has been read from the stream.
  private echoDue = false;
  private streamOpenedAt?: number;

  private conn?: AbortController;
  private response?: Response;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private stalled = false;
  private closed = false;
  private pumping: Promise<void> = Promise.resolve();
  private reconciling = false;
  private resending?: Promise<void>;
  private resendTimer?: ReturnType<typeof setTimeout>;

  private outcome?: Outcome;
  private readonly decision: Promise<Outcome>;
  private settle!: (outcome: Outcome) => void;
  private readonly rested: Promise<void>;
  private rest!: () => void;
  // Shutdown while a stop is already under way: its waits end at once, and
  // the requests that are left get a few seconds.
  private readonly rush = new AbortController();
  private readonly rushed: Promise<void>;
  private hurry!: () => void;
  private grace?: { timer: ReturnType<typeof setTimeout>; run: () => void };
  private idleNow = false;

  private readonly seen = new Set<string>();
  private readonly calls = new Map<string, CallState>();
  private readonly confirmed = new Set<string>();
  private readonly threadRuns = new Map<string, string>();
  private openRuns = new Map<string, string>();
  private readonly runsStarted: { id: string; name: string }[] = [];
  private readonly ignored = new Set<string>();
  private tail: string[] = [];
  // What of the tail was passed on as status while a run was open.
  private shown?: string;
  private rounds = 0;
  private context = 0;
  private compacted = false;
  private usage?: Reading;
  private lastError?: string;

  constructor(private readonly input: TurnInput) {
    this.client = input.client;
    this.sid = input.sessionId;
    this.log = input.log;
    this.sleep = input.hooks?.sleep ?? sleep;
    this.now = input.hooks?.now ?? Date.now;
    this.startedAt = this.now();
    this.toolCtx = scopedContext(input.ctx, { signal: this.work.signal });
    this.decision = new Promise((resolve) => { this.settle = resolve; });
    this.rested = new Promise((resolve) => { this.rest = resolve; });
    this.rushed = new Promise((resolve) => { this.hurry = resolve; });
  }

  async run(): Promise<TurnResult> {
    try {
      const early = await this.begin();
      if (early) return early;
      return await this.finish(await this.follow());
    } catch (error) {
      return await this.fail(error);
    } finally {
      this.dispose();
    }
  }

  // ── Before the message ────────────────────────────────────────────────

  private async begin(): Promise<TurnResult | undefined> {
    const { input } = this;
    const session = await this.retrieve();
    const reading = sessionTotals(session.usage);
    const ahead = await this.requireCost(reading);
    this.before = reading;
    await this.rebuildRuns();
    const max = cents(session.budget?.max_list_cost);
    if (max === undefined) throw this.protocol("budget_unreadable");
    const consumed = reading.totals.list_cost_cents;
    this.ceiling = "allowCents" in input.budget ? consumed + input.budget.allowCents : input.budget.ceilingCents;
    this.allowance = "allowCents" in input.budget
      ? input.budget.allowCents
      : Math.max(1, this.ceiling - (input.baseline?.list_cost_cents ?? consumed));
    if (consumed >= this.ceiling) return this.unstarted("budget");
    if (this.now() >= input.deadlineAt) return this.unstarted("timeout");
    // A session that is not at rest is still working on something older.
    // That is stopped first, on its own, so the allowance goes to this turn's
    // message. A session paused at its budget is the exception: there the
    // interrupt stops no thread, since all of them are paused already, and
    // the raise resumes them. It is still sent, for the runs: one that an
    // interrupt paused stays paused when the budget goes up. What the raise
    // resumed is stopped with the message itself (`post`).
    // A message still waiting to be taken up is older work as well, whatever
    // status the session reads as: events are taken up in the order they
    // were sent, so the next thing the session does is that message. It is
    // only known where the list was read for the cost (`requireCost`); a
    // session that reports a cost is not asked. Treating it like work under
    // way is a choice the owner has not confirmed yet (#76).
    const capped = max <= consumed;
    const dirty = session.status !== "idle" || capped || this.openRuns.size > 0 || ahead;
    if (dirty) {
      try {
        await this.client.beta.sessions.events.send(this.sid, { events: [{ type: "user.interrupt" }] }, { signal: input.signal });
      } catch (error) {
        throw this.requestError(error);
      }
    }
    const early = await this.raise(session);
    if (early) return early;
    const opening = this.open();
    // Cancelled meanwhile: `fail` closes the connection and this settles later.
    opening.catch(() => {});
    try {
      await withAbort(opening, input.signal);
    } catch (error) {
      throw this.requestError(error);
    }
    await this.post(dirty, capped);
  }

  private async retrieve(): Promise<BetaManagedAgentsSession> {
    let session: BetaManagedAgentsSession;
    try {
      session = await this.client.beta.sessions.retrieve(this.sid, {}, { signal: this.input.signal });
    } catch (error) {
      throw this.requestError(error);
    }
    if (session.archived_at) throw new SessionGone(false, "archived");
    if (session.status === "terminated") throw new SessionGone(false, "terminated");
    // A session without a budget is uncapped and a budget cannot be added.
    if (!session.budget) throw new SessionGone(false, "no_budget");
    return session;
  }

  /** A session that has been used but reports no list cost cannot be given a
   *  ceiling: "what it has used plus the allowance" would start from zero.
   *  Used: it reports tokens or running time, the bot has counted use for it
   *  before, or it has taken a message up. A message that is only queued is
   *  not use. A new session is taken to report no cost until its first
   *  message is taken up (the SDK's types call the figure absent until cost
   *  tracking is available; not verified against the API), and the same
   *  person may write again before that. True when such a message waits
   *  ahead of this turn's. */
  private async requireCost(reading: Reading): Promise<boolean> {
    if (reading.cost) return false;
    const some = (totals?: WorkspaceTotals) => !!totals && Object.values(totals).some((value) => value > 0);
    if (some(reading.totals) || some(this.input.baseline)) throw this.protocol("list_cost_missing");
    let messages: RawEvent[];
    try {
      // In the list's own order, oldest first. Messages are taken up in the
      // order they were sent, so one that was taken up is on the first page.
      const page = await this.client.beta.sessions.events.list(this.sid, { types: ["user.message"] }, { signal: this.input.signal });
      messages = page.data as unknown as RawEvent[];
    } catch (error) {
      throw this.requestError(error);
    }
    if (messages.some((event) => event.processed_at)) throw this.protocol("list_cost_missing");
    return messages.length > 0;
  }

  /** The runs still open, from the session's own events. The row can be
   *  behind: a run may have ended after the last turn stopped listening.
   *  Their threads are read along with them: a thread is announced once, when
   *  it is created, and a run that goes on in this turn calls tools from
   *  threads an earlier turn saw created. Without the run those calls would
   *  all be refused as somebody else's. Read newest first and only back to
   *  where the oldest run the row lists was started, so the threads of every
   *  run the session ever had are not read again on each turn. */
  private async rebuildRuns() {
    for (const run of this.input.knownRuns ?? []) this.openRuns.set(run.id, run.name);
    if (!this.openRuns.size) return;
    try {
      const pending = new Set(this.openRuns.keys()), ended = new Set<string>();
      const open: [string, string][] = [];
      let read = 0;
      const events = this.client.beta.sessions.events.list(
        this.sid, { types: ["workflow_run.created", "workflow_run.status_ended", "session.thread_created"], order: "desc" },
        { signal: this.input.signal });
      for await (const item of events) {
        const event = item as unknown as RawEvent;
        const id = text(event.workflow_run_id);
        const thread = event.type === "session.thread_created" ? text(event.session_thread_id) : undefined;
        if (id && thread) this.threadRuns.set(thread, id);
        else if (id && event.type === "workflow_run.status_ended") ended.add(id);
        else if (id && event.type === "workflow_run.created") {
          if (!ended.has(id)) open.unshift([id, text(event.name) ?? id]);
          pending.delete(id);
          if (!pending.size) break;
        }
        if (++read >= LIST_MAX_EVENTS) return;
      }
      this.openRuns = new Map(open);
    } catch (error) {
      if (this.input.signal.aborted) throw this.input.signal.reason;
      this.log?.warn({ session: this.sid, status: apiErrorInfo(error).status }, "workspace runs could not be listed; keeping the stored ones");
    }
  }

  /** Raises the budget to the turn's ceiling. The budget is only ever
   *  replaced by another limit, never removed. */
  private async raise(session: BetaManagedAgentsSession): Promise<TurnResult | undefined> {
    const { input } = this;
    for (let attempt = 1; ; attempt++) {
      input.onLease?.(this.ceiling);
      this.leased = true;
      // A resumed turn usually finds the ceiling it was started with.
      if (cents(session.budget?.max_list_cost) === this.ceiling) return;
      try {
        // The budget alone: with other fields the whole update is refused
        // while a workflow run is open.
        await this.client.beta.sessions.update(this.sid, { budget: budgetLimit(this.ceiling) }, { signal: input.signal });
        return;
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason;
        const info = apiErrorInfo(error);
        if (info.status !== 400) throw this.requestError(error);
        // Any other rejection will not go away by trying again, and the
        // budget is never taken off to get past it.
        if (!budgetNotRaised(info) || attempt >= RAISE_ATTEMPTS) throw this.protocol("budget_rejected", 400);
      }
      // The session spent more between the read and the update.
      session = await this.retrieve();
      const reading = sessionTotals(session.usage);
      const consumed = reading.totals.list_cost_cents;
      this.before = reading;
      if ("allowCents" in input.budget) this.ceiling = consumed + input.budget.allowCents;
      if (consumed >= this.ceiling) return this.unstarted("budget");
    }
  }

  private async open(): Promise<void> {
    const conn = new AbortController();
    this.conn = conn;
    // The raw response: the SDK's typed stream only passes on event names it
    // lists, and `session.usage` is not among them. The timeout covers the
    // wait for the headers; a stream that goes quiet is watched in `read`.
    this.response = await this.client.beta.sessions.events
      .stream(this.sid, {}, { signal: conn.signal, maxRetries: 0, timeout: STREAM_OPEN_TIMEOUT_MS })
      .asResponse();
    if (this.streamOpenedAt === undefined) {
      const date = Date.parse(this.response.headers.get("date") ?? "");
      if (Number.isFinite(date)) this.streamOpenedAt = date;
    }
  }

  /** Sends the turn's message, once. The stream is already open, so nothing
   *  the session does with it is missed. `resumed`: the session was paused at
   *  its budget, so raising it has set the old work going again. An interrupt
   *  goes ahead of the message in the same request: the old work ends, and
   *  the next thing the session does is this message. Stopping that work,
   *  rather than showing what it goes on to produce as this turn's, is a
   *  choice the owner has not confirmed yet (#76). */
  private async post(dirty: boolean, resumed: boolean) {
    const { input } = this;
    if (input.signal.aborted) throw input.signal.reason;
    const message: BetaManagedAgentsEventParams = { type: "user.message", content: input.content };
    let blocked = false;
    for (;;) {
      try {
        // Not tied to the turn's signal and never retried by the SDK: once
        // the request is on its way, whether it arrived has to be known.
        // After a refusal the interrupt has gone out on its own already.
        const reply = await this.client.beta.sessions.events.send(
          this.sid, { events: resumed && !blocked ? [{ type: "user.interrupt" }, message] : [message] },
          { maxRetries: 0, timeout: SEND_TIMEOUT_MS });
        this.sent = true;
        this.anchorId = reply.data?.find((event) => event.type === "user.message")?.id ?? await this.findMessage() ?? "";
        break;
      } catch (error) {
        const info = apiErrorInfo(error);
        const unknown = error instanceof APIConnectionError || info.status === 408 || (info.status ?? 0) >= 500;
        if (unknown) {
          // It may have arrived. Look instead of sending a second copy; when
          // it is not there the turn fails and the user decides to retry.
          await this.sleep(UNKNOWN_SEND_WAIT_MS, input.signal);
          const id = await this.findMessage();
          if (id === undefined) throw this.requestError(error);
          this.sent = true;
          this.anchorId = id;
          break;
        }
        if (info.status !== 400 || blocked) throw this.requestError(error);
        // A session waiting on tool calls of an earlier turn takes no new
        // message. Those calls are closed, then the message is sent once more.
        blocked = true;
        await interrupt(this.client, this.sid, input.signal, this.log);
        await this.reconcile();
        if (input.signal.aborted) throw input.signal.reason;
      }
    }
    // A session at rest does nothing until the message arrives, so all that
    // follows is the turn's. Otherwise older work may still be reporting, and
    // the turn starts where its own message shows up as processed.
    this.anchored = !dirty && !blocked;
    this.echoDue = !this.anchored;
    await input.onSent?.({ eventId: this.anchorId, ceilingCents: this.ceiling });
  }

  /** The id of the turn's message in the session's list, when it is there.
   *  Only a message that is still queued, or was processed after this turn
   *  opened its stream, counts: the same words may have been sent before. */
  private async findMessage(): Promise<string | undefined> {
    try {
      const page = await this.client.beta.sessions.events.list(
        this.sid, { types: ["user.message"], order: "desc" }, { signal: this.input.signal });
      const wanted = contentShape(this.input.content);
      for (const item of page.data) {
        const event = item as unknown as RawEvent;
        if (event.type !== "user.message" || contentShape(event.content) !== wanted) continue;
        const processed = event.processed_at ? Date.parse(event.processed_at) : undefined;
        if (processed === undefined || (this.streamOpenedAt !== undefined && processed >= this.streamOpenedAt))
          return text(event.id);
      }
    } catch (error) {
      if (this.input.signal.aborted) throw this.input.signal.reason;
      this.log?.warn({ session: this.sid, status: apiErrorInfo(error).status }, "workspace message could not be looked up");
    }
  }

  // ── Following the session ─────────────────────────────────────────────

  private follow(): Promise<Outcome> {
    const { input } = this;
    this.listen(input.signal, (reason) => {
      if (abortKind(reason) !== "cleared") {
        this.hurry();
        const timer = setTimeout(() => this.rush.abort(), SHUTDOWN_MS);
        this.cleanups.push(() => clearTimeout(timer));
      }
      this.decide({ kind: "abort", reason });
    });
    if (input.steering) this.listen(input.steering, (reason) => this.decide({ kind: "abort", reason, steering: true }));
    const deadline = setTimeout(
      () => this.decide({ kind: "abort", reason: new TurnTimeout() }),
      Math.max(0, input.deadlineAt - this.now()));
    const check = setInterval(() => this.checkStop(), STOP_CHECK_MS);
    this.cleanups.push(() => clearTimeout(deadline), () => clearInterval(check));
    this.pumping = this.pump();
    return this.decision;
  }

  private listen(signal: AbortSignal, onAbort: (reason: unknown) => void) {
    if (signal.aborted) return onAbort(signal.reason);
    const listener = () => onAbort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    this.cleanups.push(() => signal.removeEventListener("abort", listener));
  }

  private checkStop() {
    if (this.outcome) return;
    let stop = false;
    try { stop = !!this.input.shouldStop?.(); } catch {}
    if (stop) this.decide({ kind: "abort", reason: new TurnStopped() });
  }

  private decide(outcome: Outcome) {
    if (this.outcome) return;
    this.outcome = outcome;
    this.disarm();
    // A stopped turn keeps listening until the session has come to rest.
    if (outcome.kind !== "abort") this.close();
    this.settle(outcome);
  }

  private close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.conn?.abort();
  }

  /** Reads the stream, reopening it when it breaks. The order on every
   *  reconnect is open, then list, then read: a stream replays nothing, so
   *  what happened in between is only in the list. */
  private async pump(): Promise<void> {
    let failures = 0;
    for (let first = true; !this.closed; first = false) {
      let failure: ProviderError;
      try {
        if (!first) {
          await this.open();
          if (this.closed) return;
          this.echoDue = false;
          await this.reconcile();
          if (this.closed) return;
          // Still queued when the list was read, and this connection was open
          // before that: it is the one that will show the message taken up.
          this.echoDue = !this.anchored;
        }
        await this.read(() => { failures = 0; });
        // A stream that just ends (a proxy's time limit) is a disconnect too.
        failure = new ProviderError("transient", true);
        failure.diagnostics = { reason: "provider_error" };
      } catch (error) {
        if (this.closed) return;
        if (this.stalled) {
          // Quiet for too long: reopened to see that it is alive, which is
          // not a failure.
          this.stalled = false;
          if (this.outcome) return;
          continue;
        }
        const classified = this.streamError(error);
        if (!classified) return;
        failure = classified;
      }
      // Decided already: the stream was only read for the session's rest.
      if (this.closed || this.outcome) return;
      if (++failures > this.input.limits.reconnects) {
        failure.diagnostics = {
          ...failure.diagnostics, phase: "stream", provider: WORKSPACE_PROVIDER, model: this.input.model,
          retries: failures - 1,
        };
        return this.decide({ kind: "error", error: failure });
      }
      try {
        await this.sleep(retryDelay(null, failures - 1), this.life.signal);
      } catch {
        return;
      }
    }
  }

  /** A failure to count toward the reconnect limit, or nothing when it ends
   *  the turn. */
  private streamError(error: unknown): ProviderError | undefined {
    let failure: ProviderError;
    if (apiErrorInfo(error).status === 404) failure = new SessionGone(this.sent, "not_found");
    else {
      try {
        failure = toProviderError(error, "stream", this.input.model);
      } catch {
        // A body that broke while being read is not an SDK error.
        failure = new ProviderError("transient", true);
        failure.diagnostics = { reason: "transport_error" };
      }
    }
    const final = failure instanceof SessionGone || failure.kind === "authentication"
      || (failure.status !== undefined && !failure.retryable);
    if (!final) return failure;
    this.decide({ kind: "error", error: failure });
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.stalled = true;
      this.conn?.abort();
    }, this.input.limits.idleMs);
  }

  private async read(onEvent: () => void): Promise<void> {
    const conn = this.conn!, response = this.response;
    this.response = undefined;
    if (!response?.body) throw new ProviderError("transient", true);
    this.touch();
    try {
      const body = watched(response.body as ReadableStream<Uint8Array>, conn.signal, () => this.touch());
      for await (const sse of Stream.rawEvents(new Response(body), conn)) {
        if (this.closed) return;
        if (sse.event === "ping") continue;
        const event = this.parse(sse.data);
        if (sse.event === "error" || event?.type === "error") throw this.streamFailure(event);
        if (!event) continue;
        onEvent();
        try {
          await this.handle(event);
        } catch (error) {
          // Not the stream's fault: reconnecting would not help.
          return this.decide({ kind: "error", error });
        }
        if (this.closed) return;
      }
    } finally {
      clearTimeout(this.idleTimer);
      conn.abort();
    }
  }

  /** An event as it came, or nothing for a frame that is not one. The JSON's
   *  own `type` is what counts; data without one is skipped, not fatal. */
  private parse(data: string): RawEvent | undefined {
    try {
      const value = JSON.parse(data) as RawEvent | null;
      if (value && typeof value === "object" && typeof value.type === "string") return value;
    } catch {}
    this.ignore("unreadable");
  }

  private streamFailure(event: RawEvent | undefined): ProviderError {
    const failure = apiFailure(event?.error ?? event, "error");
    failure.diagnostics = { ...failure.diagnostics, phase: "stream", provider: WORKSPACE_PROVIDER, model: this.input.model };
    // An error event ends the connection, not the turn, unless it says the
    // key is wrong. The reconnect limit bounds it.
    return failure.kind === "authentication" ? failure : Object.assign(new ProviderError("transient", true), { diagnostics: failure.diagnostics });
  }

  private ignore(type: string) {
    if (this.ignored.has(type)) return;
    this.ignored.add(type);
    this.log?.debug({ session: this.sid, type: type.slice(0, 64) }, "workspace event ignored");
  }

  // ── Events ────────────────────────────────────────────────────────────

  /** The turn's own message, queued or processed. Without an id from the
   *  send, it is recognized by its content. */
  private own(event: RawEvent): boolean {
    if (!this.sent || event.type !== "user.message") return false;
    return this.anchorId ? event.id === this.anchorId : contentShape(event.content) === contentShape(this.input.content);
  }

  /** The turn's message, processed. `listed`: read from the list, not from
   *  the stream. */
  private isAnchor(event: RawEvent, listed = false): boolean {
    if (!event.processed_at || !this.own(event)) return false;
    // The list goes back to earlier turns, and the same words may have been
    // sent before. Recognized by content alone, only a message processed
    // since this turn opened its stream counts there, as in `findMessage`.
    return !!this.anchorId || !listed
      || (this.streamOpenedAt !== undefined && Date.parse(event.processed_at) >= this.streamOpenedAt);
  }

  private anchor(event: RawEvent, listed = false) {
    if (!this.anchored) {
      // Whatever was being waited out before the message is void.
      this.disarm();
      this.lastError = undefined;
      const at = listed && event.processed_at ? Date.parse(event.processed_at) : NaN;
      this.anchorAt = Number.isFinite(at) ? at : undefined;
    } else if (!listed) {
      this.anchorAt = undefined;
    }
    this.anchored = true;
    this.taken = true;
  }
  /** Older than the turn's message by its time. Only asked while the list is
   *  what placed the message: a connection opened shortly before the message
   *  was taken up may still deliver what came before it. Where the stream
   *  itself showed the message, its order decides and no time is compared
   *  (how fine the timestamps are is not documented). */
  private precedes(event: RawEvent): boolean {
    const at = event.processed_at ? Date.parse(event.processed_at) : NaN;
    return this.anchorAt !== undefined && at < this.anchorAt;
  }

  /** `listed`: read from the list, after the turn's message. */
  private async handle(event: RawEvent, listed = false): Promise<void> {
    this.checkStop();
    const id = text(event.id);
    // Only a processed event is final. The echo of a queued `user.*` event
    // has no `processed_at` and comes again, with the same id, when it has.
    const final = !!id && !!event.processed_at;
    if (!listed && this.echoDue && this.isAnchor(event)) {
      // The stream has reached the turn's message: from here on it is the turn.
      this.echoDue = false;
      if (id) this.seen.add(id);
      this.anchor(event);
      return;
    }
    if (final && this.seen.has(id)) return;
    if (!listed && this.echoDue && !this.reconciling) {
      // A call to run, or the session coming to rest, before the stream has
      // shown the message as processed. Normally it is the old turn's. The
      // list is asked where this very event stands, in case the stream never
      // shows the message: only if the list has it after the message is it
      // the turn's, and then it was handled from there, with all that came
      // before it.
      const rests = event.type === "session.status_idle" && stopType(event) !== "requires_action";
      if (event.type === "agent.custom_tool_use" || rests) {
        await this.reconcile();
        if (final && this.seen.has(id)) {
          this.echoDue = false;
          this.anchorAt = undefined;
          return;
        }
      }
    }
    // The echo of the turn's own message, queued or processed: where the
    // turn begins, not something that happened in it.
    if (this.own(event)) {
      if (final) this.taken = true;
      return;
    }
    const mine = listed || !(this.echoDue || this.precedes(event));
    this.track(event, mine);
    if (!mine) {
      // Left over from before the turn: never run, only kept from blocking.
      // It is not remembered as seen, so the list can still place it.
      if (event.type === "agent.custom_tool_use") await this.refuse(id, LEFTOVER_CALL);
      else if (asksPermission(event)) await this.deny(id);
      else if (!this.anchored) this.queued(event);
      return;
    }
    if (final) this.seen.add(id);
    try { this.input.observe?.(event); } catch {}
    if (this.outcome) return this.wind(event);
    await this.act(event);
  }

  /** While the turn's message is still queued, what the session does is not
   *  the turn's. Two of the ways it can stop there mean the message will not
   *  be taken up, though, and waiting for it would last until the time limit. */
  private queued(event: RawEvent) {
    if (this.outcome) return;
    switch (event.type) {
      case "session.status_running":
      case "workflow_run.status_running":
        return this.disarm();
      case "session.status_idle":
        // At its budget the session takes up nothing until the budget changes.
        if (stopType(event) === "budget_reached") return this.decide({ kind: "budget" });
        // The session drops what was queued when its retries run out. As
        // after the message, it may yet start again by itself.
        if (stopType(event) === "retries_exhausted")
          return this.arm(() => this.decide({ kind: "error", error: this.exhausted("retries_exhausted") }));
    }
  }

  /** State that holds wherever the event falls relative to the turn. */
  private track(event: RawEvent, mine: boolean) {
    switch (event.type) {
      case "workflow_run.created": {
        const id = text(event.workflow_run_id);
        if (!id) return;
        const run = { id, name: text(event.name) ?? id };
        this.openRuns.set(run.id, run.name);
        if (mine && !this.runsStarted.some((r) => r.id === id)) this.runsStarted.push(run);
        // One run at a time is what the prompt asks for.
        if (this.openRuns.size > 1) this.log?.warn({ session: this.sid, open: this.openRuns.size }, "workspace session has more than one workflow run open");
        return;
      }
      case "workflow_run.status_ended": {
        const id = text(event.workflow_run_id);
        if (id) this.openRuns.delete(id);
        return;
      }
      case "session.thread_created": {
        const thread = text(event.session_thread_id), run = text(event.workflow_run_id);
        if (thread && run) this.threadRuns.set(thread, run);
        return;
      }
      case "session.usage": {
        const reading = sessionTotals(event.usage as Parameters<typeof sessionTotals>[0]);
        // A reading from the list can be older than one already taken.
        this.usage = { totals: totalsMax(reading.totals, this.usage?.totals), cost: reading.cost || !!this.usage?.cost };
        return;
      }
      case "session.error": {
        const type = text((event.error as { type?: unknown } | undefined)?.type);
        this.lastError = type && /^[a-z][a-z_]{0,63}$/.test(type) ? type : undefined;
        return;
      }
      case "session.status_running":
        this.idleNow = false;
        return;
      case "session.status_idle":
        this.idleNow = stopType(event) !== "requires_action";
        if (this.idleNow && this.outcome) this.rest();
        return;
      case "session.status_terminated":
      case "session.deleted":
        this.idleNow = true;
        this.rest();
        return this.decide({
          kind: "error",
          error: new SessionGone(this.sent, event.type === "session.deleted" ? "deleted" : "terminated"),
        });
    }
  }

  private async act(event: RawEvent): Promise<void> {
    switch (event.type) {
      case "agent.message": {
        const blocks = Array.isArray(event.content) ? (event.content as { type?: unknown; text?: unknown }[]) : [];
        const said = blocks.map((b) => (b?.type === "text" ? text(b.text) ?? "" : "")).join("");
        if (said) this.tail.push(said);
        return;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        if (!event.session_thread_id) this.flush();
        if (asksPermission(event)) await this.deny(text(event.id));
        return;
      case "agent.custom_tool_use":
        if (!event.session_thread_id) this.flush();
        return this.call(event);
      case "agent.thread_context_compacted":
        this.compacted = true;
        return;
      case "span.model_request_start":
        // What the previous request said was not the answer after all.
        this.flush();
        return;
      case "span.model_request_end": {
        const usage = (event.model_usage ?? {}) as Record<string, unknown>;
        const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
        this.rounds++;
        this.context = count(usage.input_tokens) + count(usage.cache_read_input_tokens)
          + count(usage.cache_creation_input_tokens) + count(usage.output_tokens);
        if (!event.session_thread_id) this.show();
        return;
      }
      case "session.status_running":
      case "workflow_run.status_running":
        this.disarm();
        return;
      case "workflow_run.status_ended":
        // The server now gives the agent a turn to read the result.
        if (this.grace) this.arm(this.grace.run);
        return;
      case "session.status_idle":
        return this.idle(event);
      case "agent.thinking": case "agent.tool_result": case "agent.mcp_tool_result": case "session.error":
      case "session.status_rescheduled": case "session.thread_created": case "session.usage":
      case "workflow_run.created": case "workflow_run.status_idle": case "workflow_run.error":
      case "workflow_run.phase_started": case "workflow_run.phase_ended":
        return;
      default:
        this.ignore(event.type);
    }
  }

  private async idle(event: RawEvent): Promise<void> {
    const reason = (event.stop_reason ?? {}) as { type?: unknown; event_ids?: unknown };
    switch (reason.type) {
      case "requires_action": {
        // Calls are answered as they arrive. One named here that never
        // arrived was missed, and the list has it.
        const ids = Array.isArray(reason.event_ids) ? reason.event_ids.filter((v): v is string => typeof v === "string") : [];
        const unknown = ids.filter((id) => !this.calls.has(id) && !this.confirmed.has(id));
        if (unknown.length && !this.reconciling) await this.reconcile(unknown);
        // One whose result is still here: the session has just said that it
        // waits for it. Not awaited, so the stream goes on being read.
        if (ids.some((id) => this.calls.get(id)?.unsent)) void this.resend();
        return;
      }
      case "end_turn":
        if (!this.openRuns.size) return this.decide({ kind: "end" });
        // A run is still open. If it is working, the session goes back to
        // running within moments; if it is paused, nothing will, and the turn
        // ends with a note that work is left.
        this.show();
        return this.arm(() => this.decide({
          kind: "end",
          ...(this.openRuns.size > 0 && { notice: openRunsNotice(this.openRuns.size) }),
        }));
      case "budget_reached":
        return this.decide({ kind: "budget" });
      case "refusal": {
        const category = text((event.stop_details as { category?: unknown } | null | undefined)?.category);
        this.log?.warn({ session: this.sid, category }, "workspace turn was refused");
        const failure = new ProviderError("refusal", false);
        failure.diagnostics = { phase: "stream", provider: WORKSPACE_PROVIDER, model: this.input.model };
        return this.decide({ kind: "error", error: failure });
      }
      default:
        // `retries_exhausted`, or a reason this code does not know. The
        // server may still start a turn by itself to read a run's result.
        return this.arm(() => this.decide({ kind: "error", error: this.exhausted(text(reason.type)) }));
    }
  }

  private exhausted(stop: string | undefined): ProviderError {
    const type = this.lastError;
    const temporary = ["model_overloaded_error", "model_rate_limited_error", "model_request_failed_error", "unknown_error"];
    const failure = stop !== "retries_exhausted" ? new ProviderError("protocol", false)
      : type === "billing_error" ? new ProviderError("quota", false)
      : !type || temporary.includes(type) ? new ProviderError("transient", true)
      : new ProviderError("protocol", false);
    failure.diagnostics = { phase: "stream", provider: WORKSPACE_PROVIDER, model: this.input.model, ...(type && { type }) };
    return failure;
  }

  private arm(run: () => void) {
    this.disarm();
    this.grace = { run, timer: setTimeout(run, this.input.limits.graceMs ?? GRACE_MS) };
  }
  private disarm() {
    if (this.grace) clearTimeout(this.grace.timer);
    this.grace = undefined;
  }

  private flush() {
    if (!this.tail.length) return;
    const said = this.tail.join("\n\n");
    this.tail = [];
    const shown = said === this.shown;
    this.shown = undefined;
    if (shown) return;
    try { this.input.say?.(said); } catch {}
  }

  /** With a run open, the turn does not end where the model stops, and what
   *  it wrote there is the status of the run, not the reply: the Ultra prompt
   *  tells it so. It is passed on now instead of when the run has ended and
   *  the next request begins. The tail keeps it, because it is the reply
   *  after all if the run stays paused and the turn ends on it. */
  private show() {
    if (!this.openRuns.size || !this.tail.length) return;
    const said = this.tail.join("\n\n");
    if (said === this.shown) return;
    this.shown = said;
    try { this.input.say?.(said); } catch {}
  }

  /** After the turn was decided: only what keeps the session from waiting on
   *  the bot. */
  private async wind(event: RawEvent): Promise<void> {
    if (event.type === "agent.custom_tool_use") await this.refuse(text(event.id), STOPPED_CALL);
    else if (asksPermission(event)) await this.deny(text(event.id));
  }

  // ── Tool calls ────────────────────────────────────────────────────────

  /** Runs a custom tool call as it arrives, without waiting for the session
   *  to go idle: with a workflow run open it may never do so. */
  private call(event: RawEvent) {
    const id = text(event.id);
    if (!id || this.calls.has(id)) return;
    const threadId = text(event.session_thread_id) ?? null;
    const call: WorkspaceCall = {
      id, name: text(event.name) ?? "", input: event.input, threadId,
      runId: threadId ? this.threadRuns.get(threadId) ?? null : null,
    };
    const state: CallState = { status: "running" };
    this.calls.set(id, state);
    state.settled = (async () => {
      let result: WorkspaceResult;
      try {
        result = await this.input.executeTool(call, this.toolCtx);
      } catch {
        result = failed("The tool failed.");
      }
      // The tools run on a copy that carries the turn's signal. What they
      // record on it about the reply belongs on the caller's context.
      if (this.toolCtx.delivered) this.input.ctx.delivered = true;
      if (state.status !== "running") return;
      state.status = "done";
      // A 400 for a result is one that came too late (the server has archived
      // the call's thread) or one the server will not take. The documentation
      // tells them apart by the thread's status. Here a plain result is tried
      // once instead: if the call still takes one, the session stops waiting
      // for it and the model is told; if that is refused too, it was too late.
      if (await this.answer(id, result, state) === "refused") await this.answer(id, failed(REFUSED_RESULT), state);
    })();
  }

  /** One result per request: the server refuses a whole request when it
   *  refuses one of its events. What could not be delivered is kept on the
   *  call and sent again; what was refused is not. */
  private async answer(id: string, result: WorkspaceResult, state?: CallState): Promise<Delivery> {
    try {
      await this.client.beta.sessions.events.send(this.sid, {
        events: [{ type: "user.custom_tool_result", custom_tool_use_id: id, content: result.content, is_error: result.is_error }],
      }, { signal: this.life.signal });
      if (state) delete state.unsent;
      return "sent";
    } catch (error) {
      const status = apiErrorInfo(error).status;
      this.log?.warn({ session: this.sid, status }, "workspace tool result was not accepted");
      if (status === 400 || status === 404) {
        if (state) delete state.unsent;
        return status === 400 ? "refused" : "gone";
      }
      if (state && !this.life.signal.aborted) {
        state.unsent = result;
        this.resendLater();
      }
      return "failed";
    }
  }

  /** Sends again what could not be delivered, one pass at a time. The session
   *  waits on a call until it has a result, and while the stream stays alive
   *  nothing else would bring it one. The tools are not run again. */
  private resend(): Promise<void> {
    return (this.resending ??= (async () => {
      try {
        for (const [id, state] of this.calls) if (state.unsent) await this.answer(id, state.unsent, state);
      } finally {
        this.resending = undefined;
      }
    })());
  }
  private resendLater() {
    if (this.resendTimer || this.life.signal.aborted) return;
    this.resendTimer = setTimeout(() => {
      this.resendTimer = undefined;
      void this.resend();
    }, this.input.limits.resendMs ?? RESEND_MS);
  }

  private async refuse(id: string | undefined, why: string) {
    if (!id || this.calls.has(id)) return;
    const state: CallState = { status: "done" };
    this.calls.set(id, state);
    await this.answer(id, failed(why), state);
  }

  /** What a call found unanswered in the list is told. One made since this
   *  turn opened its stream is the old work's, and nobody has run it. An
   *  older one was made while an earlier turn was listening. */
  private leftover(event: RawEvent): string {
    const at = event.processed_at ? Date.parse(event.processed_at) : NaN;
    return this.streamOpenedAt !== undefined && at >= this.streamOpenedAt ? LEFTOVER_CALL : OPEN_CALL;
  }

  /** The toolset is created with `always_allow`, so nothing should ask. If
   *  something does, nobody is there to approve it. */
  private async deny(id: string | undefined) {
    if (!id || this.confirmed.has(id)) return;
    this.confirmed.add(id);
    try {
      await this.client.beta.sessions.events.send(this.sid, {
        events: [{ type: "user.tool_confirmation", tool_use_id: id, result: "deny", deny_message: DENIED }],
      }, { signal: this.life.signal });
    } catch (error) {
      this.log?.warn({ session: this.sid, status: apiErrorInfo(error).status }, "workspace tool confirmation was not accepted");
    }
  }

  /** Catches up from the session's list. Read newest first up to the turn's
   *  own message, so the cost is this turn's events and not the session's
   *  whole history. `waiting` are calls the session says it waits on: one of
   *  them may be older than the message (a run's agent asked before the turn
   *  began), and is looked for a little further back. A failure is left for
   *  the next reconnect. */
  private async reconcile(waiting: string[] = []): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const newer: RawEvent[] = [], older: RawEvent[] = [];
      const missing = new Set(waiting);
      let found = false, past = 0;
      try {
        const events = this.client.beta.sessions.events.list(this.sid, { order: "desc" }, { signal: this.life.signal });
        for await (const item of events) {
          const event = item as unknown as RawEvent;
          const id = text(event.id);
          if (found) {
            if (id && missing.delete(id)) older.push(event);
            if (!missing.size || ++past >= LIST_PAST_EVENTS) break;
            continue;
          }
          if (this.isAnchor(event, true)) {
            found = true;
            this.anchor(event, true);
            if (!missing.size) break;
            continue;
          }
          // An earlier turn's message. The turn's own is not in the list as
          // processed, then, and everything read so far came before it. This
          // holds for a turn that began on a session at rest as well: its
          // message can still be queued when the stream has to be reopened.
          if (event.type === "user.message" && event.processed_at) break;
          newer.push(event);
          if (id) missing.delete(id);
          if (newer.length >= LIST_MAX_EVENTS) break;
        }
      } catch (error) {
        this.log?.warn({ session: this.sid, status: apiErrorInfo(error).status }, "workspace events could not be listed");
        return;
      }
      newer.reverse();
      const answered = new Set<string>();
      for (const event of newer) {
        const call = event.type === "user.custom_tool_result" ? text(event.custom_tool_use_id) : undefined;
        if (call) answered.add(call);
        const confirmation = event.type === "user.tool_confirmation" ? text(event.tool_use_id) : undefined;
        if (confirmation) this.confirmed.add(confirmation);
      }
      for (const id of answered) if (!this.calls.has(id)) this.calls.set(id, { status: "done" });
      if (found && this.anchorId) this.seen.add(this.anchorId);
      // Without the message, nothing in the list can be told to be the turn's:
      // what was read belongs to earlier turns, and handling it would repeat
      // their replies and run their unanswered calls for whoever speaks now.
      // The one exception is a turn so large that the look ended before it
      // got back to a message that is known to have been processed.
      if (!found && !(this.taken && newer.length >= LIST_MAX_EVENTS)) {
        if (this.anchored) return;
        for (const event of newer) {
          if (event.type === "agent.custom_tool_use") await this.refuse(text(event.id), this.leftover(event));
          else if (asksPermission(event)) await this.deny(text(event.id));
        }
        return;
      }
      // In order, through the same handling as the stream. What was seen
      // there already is skipped by its id; a call is never run twice.
      for (const event of newer) {
        if (this.closed) return;
        try {
          await this.handle(event, true);
        } catch (error) {
          return this.decide({ kind: "error", error });
        }
      }
      for (const event of older) {
        if (event.type === "agent.custom_tool_use") await this.refuse(text(event.id), this.leftover(event));
        else if (asksPermission(event)) await this.deny(text(event.id));
      }
      await this.resend();
    } finally {
      this.reconciling = false;
    }
  }

  // ── Ending ────────────────────────────────────────────────────────────

  private async finish(outcome: Outcome): Promise<TurnResult> {
    switch (outcome.kind) {
      case "error":
        throw outcome.error;
      case "end":
        return this.conclude("end_turn", outcome.notice);
      case "budget":
        return this.conclude("budget", budgetNotice(this.allowance));
      case "abort": {
        const kind = outcome.steering ? "steering"
          : outcome.reason instanceof TurnStopped ? "stopped"
          : abortKind(outcome.reason);
        // Shutdown, or a reason this code does not know: handled in `fail`.
        if (kind === "shutdown" || kind === "other") throw outcome.reason;
        await this.halt(outcome.reason);
        return this.conclude(
          kind === "steering" ? "interrupted" : kind === "timeout" ? "timeout" : "stopped",
          kind === "timeout" ? timeoutNotice(this.limitMs()) : undefined);
      }
    }
  }

  private limitMs() {
    return this.input.limits.timeoutMs ?? Math.max(0, this.input.deadlineAt - this.startedAt);
  }

  /** Stops a turn that is under way: interrupt, give running tools a moment
   *  to finish, then wait for the session to report that it is idle. */
  private async halt(reason: unknown) {
    this.work.abort(reason);
    // A result that never got through: one more try, so the call is not left
    // for the next turn to close without knowing that it ran.
    const resent = this.resend();
    await interrupt(this.client, this.sid, this.cleanup(), this.log);
    // A tool that changes something is not cut off: its real result is
    // returned if it comes in time. Otherwise the model is told that the
    // call may have taken effect, so it checks before repeating it.
    const running = [...this.calls].filter(([, state]) => state.status === "running");
    if (running.length) {
      await this.within(Promise.allSettled(running.map(([, state]) => state.settled)), this.input.limits.settleMs ?? SETTLE_MS);
      for (const [id, state] of running) {
        if (state.status !== "running") continue;
        state.status = "abandoned";
        await this.answer(id, failed(STILL_RUNNING), state);
      }
    }
    await this.within(resent, this.input.limits.settleMs ?? SETTLE_MS);
    // With a run still working the session may not go idle at all.
    if (!this.idleNow)
      await this.within(Promise.race([this.rested, this.pumping]), this.input.limits.interruptWaitMs ?? INTERRUPT_WAIT_MS);
  }

  private async within(work: Promise<unknown>, ms: number) {
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([work, this.rushed, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer!);
  }
  /** The time the requests that end a turn may take together. */
  private cleanup(): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(CLEANUP_MS), this.rush.signal]);
  }

  private async conclude(stop: TurnResult["stop"], notice?: string): Promise<TurnResult> {
    this.close();
    // The reader stops on its own. It is waited for so that nothing changes
    // under the result, but not for long: a request it was in the middle of
    // ends when the turn is disposed.
    await this.within(this.pumping, READER_WAIT_MS);
    const cleanup = this.cleanup();
    if (stop === "budget") {
      // Paused at its budget. Lowering it to "used plus a cent" would raise
      // it, and every paused thread would run one more request.
      let reading: Reading | undefined;
      try {
        reading = sessionTotals((await this.client.beta.sessions.retrieve(this.sid, {}, { signal: cleanup })).usage);
      } catch (error) {
        this.log?.warn({ session: this.sid, status: apiErrorInfo(error).status }, "workspace session could not be read");
      }
      return this.result(stop, true, reading, notice);
    }
    const settled = await settleSession(this.client, this.sid, {
      signal: cleanup, log: this.log,
      interrupt: stop === "end_turn" && this.idleNow && !this.openRuns.size ? "never" : "running",
    });
    return this.result(stop, settled.lowered,
      settled.totals && { totals: settled.totals, cost: !!settled.costReported }, notice);
  }

  /** The turn ended before its message was sent. */
  private async unstarted(stop: "budget" | "timeout"): Promise<TurnResult> {
    const settled = await quiesce(this.client, this.sid, {
      signal: AbortSignal.any([this.input.signal, AbortSignal.timeout(CLEANUP_MS)]),
      log: this.log,
    });
    if (this.input.signal.aborted) throw this.input.signal.reason;
    return this.result(stop, settled.lowered, this.before,
      stop === "budget" ? budgetNotice(this.allowance) : timeoutNotice(this.limitMs()));
  }

  private result(stop: TurnResult["stop"], released: boolean, final?: Reading, notice?: string): TurnResult {
    // The session's own figure after the turn and the last one the stream
    // carried, whichever is further along.
    const readings = [final, this.usage].filter((r): r is Reading => !!r);
    const cumulative = readings.length
      ? readings.map((r) => r.totals).reduce((a, b) => totalsMax(a, b))
      : undefined;
    return {
      text: stop === "stopped" ? "" : this.tail.join("\n\n"),
      stop,
      ...(notice && { notice }),
      rounds: this.rounds,
      context: this.context,
      ...(cumulative && { cumulative }),
      costReported: readings.some((r) => r.cost),
      openRuns: [...this.openRuns].map(([id, name]) => ({ id, name })),
      runsStarted: this.runsStarted,
      compacted: this.compacted,
      released,
    };
  }

  /** Every way out that is not a result. The allowance is taken back first,
   *  whatever went wrong, unless the session itself is gone. */
  private async fail(error: unknown): Promise<TurnResult> {
    const { signal } = this.input;
    const cause = signal.aborted ? signal.reason : error;
    const kind = signal.aborted ? abortKind(cause) : undefined;
    this.work.abort(cause);
    this.close();
    let released = false;
    if (this.leased && !(cause instanceof SessionGone)) {
      if (kind === "shutdown" || kind === "other") {
        // No waiting: both are tried at once and given a few seconds.
        const soon = AbortSignal.timeout(SHUTDOWN_MS);
        await Promise.allSettled([
          this.sent ? interrupt(this.client, this.sid, soon, this.log) : undefined,
          this.client.beta.sessions.retrieve(this.sid, {}, { signal: soon })
            .then((session) => lower(this.client, session, { signal: soon, log: this.log })),
        ]);
      } else {
        const cleanup = this.cleanup();
        const notes: Promise<unknown>[] = [this.resend()];
        for (const [id, state] of this.calls) {
          if (state.status !== "running") continue;
          state.status = "abandoned";
          notes.push(this.answer(id, failed(STILL_RUNNING), state));
        }
        released = (await quiesce(this.client, this.sid, {
          signal: cleanup, interrupt: this.sent && !(this.idleNow && !this.openRuns.size), log: this.log,
        })).lowered;
        await this.within(Promise.allSettled(notes), NOTE_WAIT_MS);
      }
    }
    // Cleared before the message went out: nothing to say, nothing failed.
    if (kind === "cleared") return this.result("stopped", released, this.before);
    throw cause instanceof ProviderError || signal.aborted ? cause : this.unexpected(cause);
  }

  private dispose() {
    this.close();
    this.disarm();
    clearTimeout(this.resendTimer);
    for (const cleanup of this.cleanups) cleanup();
    // What a tool returns from here on has nowhere to go.
    for (const state of this.calls.values()) if (state.status === "running") state.status = "abandoned";
    this.work.abort();
    this.life.abort();
  }

  // ── Errors ────────────────────────────────────────────────────────────

  /** An error from a request made before the message was sent. */
  private requestError(error: unknown): unknown {
    if (this.input.signal.aborted) return this.input.signal.reason;
    if (apiErrorInfo(error).status === 404) return new SessionGone(this.sent, "not_found");
    return this.unexpected(error);
  }
  private unexpected(error: unknown): unknown {
    try {
      return toProviderError(error, this.sent ? "stream" : "request", this.input.model);
    } catch {
      return error;
    }
  }
  private protocol(code: string, status?: number): ProviderError {
    const failure = new ProviderError("protocol", false, status);
    failure.diagnostics = { phase: "request", provider: WORKSPACE_PROVIDER, model: this.input.model, code };
    return failure;
  }
}

/**
 * Runs one turn. Resolves with what the model said and how the turn ended;
 * rejects with a `ProviderError` (a `SessionGone` when the session cannot be
 * used any more) or, on shutdown, with the signal's own reason so the caller
 * keeps the checkpoint.
 */
export function runTurn(input: TurnInput): Promise<TurnResult> {
  return new Turn(input).run();
}
