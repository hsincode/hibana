import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { WORKSPACE_PROVIDER } from "@hibana/shared/catalog";
import type { Logger } from "pino";
import type { AgentResult } from "../agent";
import { workspaceVariant, type WorkspaceVariant } from "../claude/select";
import type { Config } from "../config";
import type { ConversationStore } from "../conversation-store";
import type { HistoryDrop } from "../history";
import { Semaphore, Serial, withAbort, type sleep } from "../io";
import type { Runtime } from "../runtime";
import type { ToolRegistry } from "../tools";
import { emptyUsage, type Context, type Message, type Usage } from "../types";
import { apiErrorInfo, createWorkspaceClient, SessionGone, workspaceBaseUrl } from "./client";
import { applyRunEvent, coalesce, eventLine, runLine, waitingLine, type RunView } from "./progress";
import { contextDigest, openRunsNote, resumeContent, userContent, workspaceContextBlock, workspaceSystem } from "./prompt";
import { WorkspaceResources } from "./resources";
import { quiesce, runTurn, type TurnInput, type TurnResult } from "./runner";
import { SessionTable, type Disposal, type SessionPatch, type SessionRow } from "./sessions";
import { bindWorkspaceTurn, outputFiles, toolsFingerprint, WorkspaceCalls, workspaceToolParams } from "./tools";
import type { RawEvent, WorkspaceMark, WorkspaceState, WorkspaceTotals } from "./types";
import { sessionTotals, totalsDelta, totalsMax, WorkspaceUsage } from "./usage";

// Anthropic Workspace turns as the bot and its commands see them (#76). A
// turn is one message to a Managed Agents session that Anthropic runs; the
// requests of the turn itself are the runner's. This file decides which
// session a channel talks to, what the turn may add to that session's cost,
// and what is left to put right once it has ended, however it ended.

/** One turn as bot.ts hands it over. */
export type WorkspaceTurn = {
  /** The turn's context, `harness: "workspace"`. Its signal is the shutdown. */
  ctx: Context;
  settings: ReturnType<Runtime["resolve"]>;
  /** `conversationKey(selection, "workspace", variant)`. */
  key: string;
  /** What the person wrote for this turn, as it is recorded locally: what an
   *  earlier attempt that did not finish left, then the new message. Nothing
   *  earlier than that is passed: the session holds the conversation. */
  messages: Message[];
  /** The new message. Absent for `/retry` and for a turn picked up at start. */
  text?: string;
  /** The mark an earlier attempt left in the checkpoint. */
  resume?: WorkspaceMark;
  /** The same person wrote again. */
  steering: AbortSignal;
  /** Saves the mark with the checkpoint. A failure fails the turn. */
  onSent(mark: WorkspaceMark): Promise<void>;
};

export type WorkspaceDeps = {
  runtime: Runtime;
  tools: ToolRegistry;
  store: ConversationStore;
  log: Logger;
  report: (error: unknown) => void;
  shutdown: AbortSignal;
  /** The rest are set by tests only. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: typeof sleep;
  limits?: Partial<TurnInput["limits"]>;
};

type Live = {
  /** Aborted when the conversation is cleared under the turn. */
  cancel: AbortController;
  guildId?: string;
  /** What the turn may still add to the day's and the month's cost, in cents. */
  reserved: number;
  /** The conversation ended while the turn ran: how its session is removed
   *  once the turn is over. */
  dropped?: Disposal["mode"];
};
type Prepared = {
  row?: SessionRow;
  variant: WorkspaceVariant;
  /** What goes to the session: the person's words, or the note that picks
   *  up a message the session already has. */
  send: { text: string; images: string[] } | { resume: WorkspaceMark };
  budget: TurnInput["budget"];
  /** When a resumed turn first started: its time limit still counts from
   *  there. A new turn starts when it has a slot. */
  startedAt?: number;
};

// An allowance below this starts nothing: a single model request can cost more.
const MIN_ALLOW_CENTS = 5;
const SWEEP_MS = 60_000;
// What one session may take in a sweep, so that one that hangs does not hold
// up the others, or the start of the bot.
const SWEEP_SESSION_MS = 30_000;
// A removal that keeps failing waits for the next start after this many tries.
const REMOVAL_ATTEMPTS = 5;
// main.ts gives the whole shutdown 25 seconds.
const CLOSE_MS = 3_000;
// A session's container is kept for this long after it was created, whether
// or not the session is used (Managed Agents, "Resume an idle session").
const CONTAINER_DAYS = 30;
// As many as one Discord message brings (bot.ts).
const MAX_IMAGES = 4;

const SESSION_GONE = "クラウドのセッションが無くなっていたため、新しい会話として始めます。以前の作業ファイルは引き継がれません。";
// No amount: what the bot has spent is the owner's to read (`/usage`, #44).
const DAY_LIMIT = "Anthropic Workspace の 1 日の利用額の上限に達しているため、実行しませんでした。上限は UTC の 0 時に戻ります。";
const MONTH_LIMIT = "Anthropic Workspace の今月の利用額の上限に達しているため、実行しませんでした。";
const LEDGER_UNREAD = "Anthropic Workspace の利用額の記録を読み込めていないため、実行しませんでした。管理者に連絡してください。";
const tooLong = (chars: number, max: number) =>
  `メッセージが長すぎます（${chars} 文字）。Anthropic Workspace に送れるのは ${max} 文字までです。短くして送り直してください。`;
const TURN_OVER = "The turn ended before this call ran.";

const nothing = (): WorkspaceTotals => sessionTotals(undefined).totals;
const some = (totals: WorkspaceTotals) => Object.values(totals).some((value) => value > 0);
/** What a lease still allows its session to add to what the ledger counted. */
const leftover = (row?: SessionRow) =>
  row?.lease ? Math.max(0, row.lease.ceilingCents - (row.totals?.list_cost_cents ?? 0)) : 0;
/** The model a session was created for, from its conversation key. */
function modelOf(key: string): string {
  try {
    const model = (JSON.parse(key) as { model?: unknown }).model;
    return typeof model === "string" ? model : "unknown";
  } catch {
    return "unknown";
  }
}
/** A session's usage in the counting the other providers' turns use
 *  (`normalizeUsage` in llm.ts): the prompt includes what was read from and
 *  written to the cache. */
function turnUsage(delta: WorkspaceTotals, context: number): Usage {
  const written = delta.cache_write_5m_tokens + delta.cache_write_1h_tokens;
  const prompt = delta.input_tokens + delta.cache_read_tokens + written;
  return {
    prompt_tokens: prompt,
    completion_tokens: delta.output_tokens,
    total_tokens: prompt + delta.output_tokens,
    cached_tokens: delta.cache_read_tokens,
    cache_write_tokens: written,
    context_tokens: context,
  };
}

export class Workspace {
  /** What the sessions cost, per day and model. Also what the day's and the
   *  month's limits are checked against. */
  readonly usage: WorkspaceUsage;
  readonly sessions: SessionTable;
  private slots: Semaphore;
  /** The turn running in each channel. A channel runs one turn at a time. */
  private live = new Map<string, Live>();
  /** Sessions the sweep is bringing to rest right now, by channel. */
  private settling = new Map<string, Promise<void>>();
  private sweeps = new Serial();
  private queued?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private swept = false;
  private closed = false;
  private sdk?: Anthropic;
  private agents?: WorkspaceResources;
  private now: () => number;

  constructor(
    private config: Config,
    private deps: WorkspaceDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.usage = new WorkspaceUsage(
      join(config.dataDir, "anthropic_workspace_usage.json"),
      () => new Date(this.now()),
      deps.report,
    );
    this.sessions = new SessionTable(deps.store, this.now);
    this.slots = new Semaphore(config.anthropicWorkspace.concurrency);
  }

  /** Reads the usage ledger. Nothing here calls the API. */
  load(): Promise<void> {
    return this.usage.load();
  }

  /** Made on first use, so a bot without the key starts, and only a Workspace
   *  turn fails: with `ProviderError("authentication")`. */
  private client(): Anthropic {
    return (this.sdk ??= createWorkspaceClient(this.config, { fetch: this.deps.fetch }));
  }
  private resources(client: Anthropic): WorkspaceResources {
    const { networking, allowedHosts } = this.config.anthropicWorkspace;
    return (this.agents ??= new WorkspaceResources(client, {
      path: join(this.config.dataDir, "anthropic_workspace_resources.json"),
      baseUrl: workspaceBaseUrl(this.config.endpoints[WORKSPACE_PROVIDER]!.baseUrl),
      // With a host list alone, pip and npm could not reach their registries.
      networking: networking === "limited"
        ? { type: "limited", allowed_hosts: allowedHosts, allow_package_managers: true }
        : { type: "unrestricted" },
      log: this.deps.log,
    }));
  }

  /**
   * Runs one turn and returns it in the shape of the other harnesses' turns.
   * A turn that is refused here (too long, over the day's limit) returns the
   * refusal as its text and has sent nothing. Rejects with a `ProviderError`,
   * or on shutdown with the signal's reason, so the caller keeps the
   * checkpoint.
   */
  async turn(input: WorkspaceTurn): Promise<AgentResult> {
    const { ctx } = input;
    const client = this.client();
    const live: Live = { cancel: new AbortController(), guildId: ctx.guildId, reserved: 0 };
    this.live.set(ctx.channelId, live);
    const signal = AbortSignal.any([this.deps.shutdown, live.cancel.signal]);
    try {
      // The sweep may be interrupting this channel's session at this moment.
      await this.settling.get(ctx.channelId);
      const first = this.prepare(input, live);
      if ("reply" in first) return this.local(input, first.reply);
      return await this.slot(ctx, signal, async () => {
        let prepared = first;
        for (let retried = false; ; retried = true) {
          try {
            return await this.run(client, input, signal, prepared);
          } catch (error) {
            if (!(error instanceof SessionGone)) throw error;
            // To the removal queue, where a session that does not exist is
            // simply struck off.
            if (this.sessions.retire(ctx.channelId, "archive")) void this.sweep();
            // After the message was accepted the session may have acted on
            // it, so the turn is not run again on a new one.
            if (error.sent || retried) throw error;
            await ctx.notify?.(SESSION_GONE).catch(() => {});
            const next = this.prepare(input, live);
            if ("reply" in next) return this.local(input, next.reply);
            prepared = next;
          }
        }
      });
    } catch (error) {
      // `/clear`, or the channel was deleted: the conversation is over, which
      // is not a failure to tell anyone about.
      if (!live.cancel.signal.aborted || this.deps.shutdown.aborted) throw error;
      if (error !== live.cancel.signal.reason) this.deps.report(error);
      return this.local(input, "");
    } finally {
      this.live.delete(ctx.channelId);
      if (live.dropped && this.sessions.retire(ctx.channelId, live.dropped)) void this.sweep();
      // A lease that outlived its turn is taken back by the sweep.
      else if (this.sessions.get(ctx.channelId)?.lease) this.arm();
    }
  }

  /** A reply that comes from the bot itself; the session was not asked. */
  private local(input: WorkspaceTurn, text: string): AgentResult {
    return {
      text,
      messages: [...input.messages, { role: "assistant", content: text }],
      usage: emptyUsage(),
      rounds: 0,
      context: 0,
    };
  }

  /** What the turn sends, to which session, and under what budget. All from
   *  local state: no request is made, and the allowance is reserved before
   *  the turn waits for a slot. */
  private prepare(input: WorkspaceTurn, live: Live): Prepared | { reply: string } {
    const { ctx, key } = input;
    const limits = this.config.anthropicWorkspace;
    const variant = workspaceVariant(input.settings);
    let row = this.sessions.get(ctx.channelId);
    // History ends a conversation it had. A first turn that failed left none
    // there, but its session is here: it is compared again.
    if (row && (row.key !== key || row.guildId !== ctx.guildId)) {
      this.sessions.retire(ctx.channelId, "archive");
      void this.sweep();
      row = undefined;
    }
    const mark = input.resume?.sessionId === row?.sessionId ? input.resume : undefined;
    if (mark && !input.text) {
      // Picked up under the ceiling of its first start, never a new one: a
      // bot that restarts in a loop must not add an allowance each time.
      live.reserved = Math.max(0, mark.ceilingCents - (row?.totals?.list_cost_cents ?? 0));
      return { row, variant, send: { resume: mark }, budget: { ceilingCents: mark.ceilingCents }, startedAt: mark.startedAt };
    }
    // With a mark the session already has what the earlier attempt sent, and
    // only the new message is missing. Otherwise everything recorded for this
    // turn goes in one message.
    const records = (mark ? input.messages.slice(-1) : input.messages).filter((m) => m.role === "user");
    const text = records.map((m) => m.content ?? "").join("\n\n");
    const images = records.flatMap((m) => m.images ?? []).slice(-MAX_IMAGES);
    if (!text.trim() && !images.length) throw new Error("再開できる作業はありません。");
    if (text.length > limits.inputMaxChars) return { reply: tooLong(text.length, limits.inputMaxChars) };
    // The limits below are checked against the ledger. One that could not be
    // read only knows this process's turns, which would let every restart
    // start the day again.
    if (!this.usage.loaded) return { reply: LEDGER_UNREAD };
    live.reserved = 0;
    const held = this.reserved();
    const day = limits.dailyBudgetCents - this.usage.spentCents("day") - held;
    const month = limits.monthlyBudgetCents - this.usage.spentCents("month") - held;
    const allow = Math.min(variant === "ultra" ? limits.ultraTurnBudgetCents : limits.turnBudgetCents, day, month);
    if (allow < MIN_ALLOW_CENTS) return { reply: month < MIN_ALLOW_CENTS ? MONTH_LIMIT : DAY_LIMIT };
    // With what an unfinished turn on this session may have added since the
    // ledger last counted it.
    live.reserved = allow + leftover(row);
    return { row, variant, send: { text, images }, budget: { allowCents: allow } };
  }

  /** Cents that turns under way may still add and the ledger has not seen:
   *  the allowance of each running turn, and the lease of each session whose
   *  turn ended without taking its allowance back. */
  private reserved(): number {
    const held = new Map<string, number>();
    for (const [channelId, live] of this.live) held.set(channelId, live.reserved);
    for (const row of this.sessions.leased())
      held.set(row.channelId, Math.max(held.get(row.channelId) ?? 0, leftover(row)));
    let sum = 0;
    for (const cents of held.values()) sum += cents;
    return sum;
  }

  /** Runs `work` in one of the bot's Workspace slots. Only the wait for a
   *  slot ends with `signal`; once started, `work` follows the signal itself. */
  private async slot<T>(ctx: Context, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    let entered = false, left = false;
    let enter = () => {};
    const waited = new Promise<void>((resolve) => { enter = resolve; });
    const run = this.slots.run(async () => {
      entered = true;
      enter();
      // The turn gave up while it waited: the slot goes on to the next one.
      return left ? undefined : await work();
    });
    if (!entered) {
      void ctx.progress?.(waitingLine).catch(() => {});
      try {
        await withAbort(waited, signal);
      } catch (error) {
        left = true;
        throw error;
      }
    }
    return (await run) as T;
  }

  /** One attempt on one session: create it if the channel has none, send,
   *  follow the turn, and settle what it cost. */
  private async run(client: Anthropic, input: WorkspaceTurn, signal: AbortSignal, prepared: Prepared): Promise<AgentResult> {
    const { ctx, settings, key } = input;
    const { variant, send, budget } = prepared;
    const { log, tools } = this.deps;
    // The wait for a slot is not part of the turn's time.
    const startedAt = prepared.startedAt ?? this.now();
    const selection = settings.selection;
    const limits = this.config.anthropicWorkspace;
    const timeoutMs = variant === "ultra" ? limits.ultraTurnTimeoutMs : limits.turnTimeoutMs;
    // The same list for everyone in the channel. Who may run a tool is
    // decided when it is called, with the caller's permissions.
    const list = workspaceToolParams(tools.workspaceTools(ctx), { web: tools.workspaceWeb(ctx) });
    const fingerprint = toolsFingerprint(list);
    let row = prepared.row;
    if (!row) {
      if (!("allowCents" in budget)) throw new Error("A resumed Workspace turn has no session");
      const { session, effort } = await this.resources(client).createSession({
        variant, selection, system: await workspaceSystem(variant), tools: list,
        budgetCents: budget.allowCents, channelId: ctx.channelId,
      }, signal);
      // Leased from the start: the session was created with the allowance.
      row = this.sessions.save({
        channelId: ctx.channelId, guildId: ctx.guildId, key, sessionId: session.id, variant,
        state: { toolsFingerprint: fingerprint, turns: 0 },
        lease: { ceilingCents: budget.allowCents, at: this.now() },
      });
      this.usage.record({
        model: selection.model, ultra: variant === "ultra", delta: nothing(), cost_reported: true,
        turn: false, new_session: true,
      });
      log.info({ channel: ctx.channelId, turn_id: ctx.turnId, session: session.id, variant, model: selection.model, effort },
        "Workspace session created");
    } else if (row.state?.toolsFingerprint && row.state.toolsFingerprint !== fingerprint) {
      // A session keeps the prompt and tools it was created with.
      log.info({ channel: ctx.channelId, session: row.sessionId }, "Workspace session keeps an older tool list");
    }
    const { channelId, sessionId } = row;
    const state: WorkspaceState = { ...row.state };
    // Who started each workflow run. A run outlives its turn, and its agents
    // read Discord with the permissions of whoever the turn answers.
    const owners: Record<string, string> = { ...state.runOwners };
    let digest: string | undefined;
    let content: TurnInput["content"];
    if ("resume" in send) content = resumeContent(new Date(this.now()));
    else {
      const block = await workspaceContextBlock(this.deps.runtime, ctx);
      // Sent with a session's first message, and again only when it changed.
      if (contextDigest(block) !== state.contextDigest) digest = contextDigest(block);
      content = await userContent({
        text: send.text, images: send.images, signal, now: new Date(this.now()),
        ...(digest && { context: block }),
        ...(state.openRuns?.length && { notes: [openRunsNote(state.openRuns.map((run) => run.name))] }),
      });
    }
    bindWorkspaceTurn(ctx, { sessionId, files: outputFiles(client), ...(this.deps.sleep && { sleep: this.deps.sleep }) });
    const calls = new WorkspaceCalls({
      execute: (name, args, c) => tools.execute(name, args, c),
      runOwner: (runId) => owners[runId],
    });
    // Asked by the runner on every event, and here before a status line: a
    // person who was blocked in the middle of a turn sees nothing more of it.
    const stopped = () => this.deps.runtime.snapshot.blocked_users.includes(ctx.userId) ||
      !!this.deps.runtime.guild(ctx.guildId).bot_disabled;
    const write = ctx.progress && coalesce(ctx.progress);
    const status = (text: string) => { if (!stopped()) write?.(text); };
    const runs = new Map<string, RunView>(), threadRuns = new Map<string, string>();
    const runStatus = new Map<string, (text: string) => void>();
    const ended = new Set<string>();
    const observe = (event: RawEvent) => {
      const runId = typeof event.workflow_run_id === "string" ? event.workflow_run_id : undefined;
      // At once: the run's agents may call a tool before anything else arrives.
      if (runId && event.type === "workflow_run.created") owners[runId] ??= ctx.userId;
      if (runId && event.type === "workflow_run.status_ended") ended.add(runId);
      const line = eventLine(event);
      if (line) status(line);
      // Each run keeps one status message of its own.
      const run = applyRunEvent(runs, threadRuns, event, this.now());
      if (!run || !ctx.openStatus || stopped()) return;
      let update = runStatus.get(run.id);
      if (!update) runStatus.set(run.id, (update = coalesce(ctx.openStatus())));
      update(runLine(run, this.now()));
    };
    let result: TurnResult | undefined;
    let delta = nothing();
    try {
      result = await runTurn({
        client, sessionId, model: selection.model, content, ctx, signal, steering: input.steering,
        budget, deadlineAt: startedAt + timeoutMs,
        executeTool: (call, c) => calls.run(call, c),
        shouldStop: stopped,
        observe,
        say: status,
        // Synchronous and on disk before the ceiling goes up: a process that
        // dies in the turn leaves the lease for the next one to find.
        onLease: (ceilingCents) => { this.sessions.touch(channelId, sessionId, { lease: { ceilingCents } }); },
        onSent: async ({ eventId, ceilingCents }) => {
          if (digest) {
            state.contextDigest = digest;
            this.sessions.touch(channelId, sessionId, { state });
          }
          await input.onSent({
            sessionId, eventId, ceilingCents, startedAt,
            resumes: "resume" in send ? send.resume.resumes : 0,
          });
        },
        baseline: row.totals,
        knownRuns: state.openRuns,
        limits: {
          idleMs: this.config.llmStreamIdleMs, reconnects: this.config.llmStreamRetries, timeoutMs,
          ...this.deps.limits,
        },
        hooks: { sleep: this.deps.sleep, now: this.deps.now },
        log,
      });
    } finally {
      calls.close(TURN_OVER);
      // Counted once: the difference to what the row holds goes to the
      // ledger, and the row is brought up to it, with nothing in between.
      const patch: SessionPatch = {};
      if (result) {
        if (result.cumulative) {
          delta = totalsDelta(result.cumulative, row.totals);
          patch.totals = totalsMax(result.cumulative, row.totals);
        }
        this.usage.record({ model: selection.model, ultra: variant === "ultra", delta, cost_reported: result.costReported });
        // Otherwise the lease stays, and the sweep takes the allowance back.
        if (result.released) patch.lease = null;
      }
      // A turn that threw still learned which runs it started.
      const open = (result?.openRuns ?? [
        ...(state.openRuns ?? []),
        ...[...runs.values()].filter((run) => !state.openRuns?.some((known) => known.id === run.id)),
      ].filter((run) => !ended.has(run.id))).map((run) => ({ id: run.id, name: run.name.slice(0, 200) }));
      const next: WorkspaceState = {
        ...state,
        openRuns: open,
        runOwners: Object.fromEntries(open.flatMap((run) => (owners[run.id] ? [[run.id, owners[run.id]!]] : []))),
        turns: (state.turns ?? 0) + (result ? 1 : 0),
      };
      // The summary that replaced the conversation swallowed the block.
      if (result?.compacted) delete next.contextDigest;
      patch.state = next;
      this.sessions.touch(channelId, sessionId, patch);
    }
    log.info({
      channel: channelId, turn_id: ctx.turnId, session: sessionId, variant, stop: result.stop, released: result.released,
      list_cost_cents: delta.list_cost_cents, cost_reported: result.costReported, rounds: result.rounds,
      runs_started: result.runsStarted.length, open_runs: result.openRuns.length,
    }, "Workspace turn finished");
    // A turn stopped because its speaker was blocked says nothing at all.
    const text = result.stop === "stopped" ? "" : [result.text, result.notice].filter(Boolean).join("\n\n");
    return {
      text,
      messages: [...input.messages, { role: "assistant", content: text }],
      usage: turnUsage(delta, result.context),
      rounds: result.rounds,
      context: result.context,
    };
  }

  /**
   * A conversation ended in History; its session ends with it. The row leaves
   * the channel here and now, and the session is removed on Anthropic's side
   * afterwards. While a turn runs in the channel, the row stays until that
   * turn is over: a clear stops the turn, anything else lets it finish.
   * Never throws: History calls this after its own change is done.
   */
  drop(drop: HistoryDrop): void {
    try {
      if (drop.cause === "guild") {
        for (const live of this.live.values())
          if (!drop.guildId || live.guildId === drop.guildId) live.dropped ??= "archive";
        if (this.sessions.retireGuild(drop.guildId, "archive", [...this.live.keys()]).length) void this.sweep();
        return;
      }
      // Only an explicit clear takes the files and the transcript with it.
      const mode = drop.cause === "clear" ? "delete" : "archive";
      const live = this.live.get(drop.channelId);
      if (!live) {
        if (this.sessions.retire(drop.channelId, mode)) void this.sweep();
        return;
      }
      if (mode === "delete" || !live.dropped) live.dropped = mode;
      if (mode === "delete") live.cancel.abort(new Error("Conversation cleared"));
    } catch (error) {
      this.deps.report(error);
    }
  }

  /**
   * One pass over what turns left behind: sessions whose spending ceiling was
   * never lowered again (a turn that threw, a process that died) are
   * interrupted and lowered, and sessions that no channel uses any more are
   * removed. Run once before the bot resumes anything, and then every minute
   * for as long as something is left. Never rejects.
   */
  sweep(): Promise<void> {
    // One pass at a time; a call made during a pass shares the next one.
    return (this.queued ??= this.sweeps.run(async () => {
      this.queued = undefined;
      await this.pass().catch(this.deps.report);
    }));
  }
  private arm() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sweep();
    }, SWEEP_MS);
    // A pending sweep must not keep a stopping process alive.
    (this.timer as { unref?: () => void }).unref?.();
  }
  private async pass() {
    const { shutdown } = this.deps;
    if (this.closed || shutdown.aborted) return;
    let client: Anthropic;
    try {
      client = this.client();
    } catch {
      // Without the key nothing can be asked; the rows wait for it.
      return;
    }
    const first = !this.swept;
    this.swept = true;
    const bounded = () => AbortSignal.any([shutdown, AbortSignal.timeout(SWEEP_SESSION_MS)]);
    for (const row of this.sessions.leased()) {
      if (shutdown.aborted) return;
      if (this.live.has(row.channelId)) continue;
      // A turn that starts on this channel meanwhile waits for this.
      const work = this.rest(client, row, bounded()).catch(this.deps.report)
        .finally(() => this.settling.delete(row.channelId));
      this.settling.set(row.channelId, work);
      await work;
    }
    let waiting = false;
    for (const disposal of this.sessions.disposals()) {
      if (shutdown.aborted) return;
      if (!first && disposal.attempts >= REMOVAL_ATTEMPTS) continue;
      if (!await this.remove(client, disposal, bounded())) waiting ||= disposal.attempts + 1 < REMOVAL_ATTEMPTS;
    }
    if (waiting || this.sessions.leased().some((row) => !this.live.has(row.channelId))) this.arm();
  }

  /** Takes back the allowance a turn left on its session, and counts what
   *  the session used meanwhile. */
  private async rest(client: Anthropic, row: SessionRow, signal: AbortSignal) {
    const settled = await quiesce(client, row.sessionId, { interrupt: true, signal, log: this.deps.log });
    // The conversation may have ended meanwhile. The session then waits to
    // be removed with the totals the row had, and its removal counts the
    // rest: counting it here too would add the same usage twice.
    if (this.sessions.get(row.channelId)?.sessionId !== row.sessionId) return;
    const patch: SessionPatch = {};
    if (settled.totals) {
      const delta = totalsDelta(settled.totals, row.totals);
      if (some(delta)) {
        this.usage.record({
          model: modelOf(row.key), ultra: row.variant === "ultra", delta, cost_reported: !!settled.costReported, turn: false,
        });
        patch.totals = totalsMax(settled.totals, row.totals);
      }
    }
    if (settled.lowered) patch.lease = null;
    if (patch.totals || settled.lowered) this.sessions.touch(row.channelId, row.sessionId, patch);
  }

  /** Removes one session no channel uses any more. Whatever state it is in,
   *  its budget is lowered first: an idle session with a paused run can still
   *  start work by itself. True when the session is gone or archived; false
   *  leaves it queued for the next pass. */
  private async remove(client: Anthropic, disposal: Disposal, signal: AbortSignal): Promise<boolean> {
    const { sessionId, mode } = disposal;
    const settled = await quiesce(client, sessionId, { signal, log: this.deps.log });
    let done = settled.status === "deleted";
    if (!done && settled.status !== "unknown") {
      try {
        if (mode === "delete") await client.beta.sessions.delete(sessionId, {}, { signal });
        // A terminated session has nothing left to stop.
        else if (settled.status !== "terminated") await client.beta.sessions.archive(sessionId, {}, { signal });
        done = true;
      } catch (error) {
        const status = apiErrorInfo(error).status;
        // Gone already, or archived already, which the API may refuse to repeat.
        done = status === 404 || (mode === "archive" &&
          await client.beta.sessions.retrieve(sessionId, {}, { signal }).then((session) => !!session.archived_at, () => false));
        if (!done)
          this.deps.log.warn({ session: sessionId, mode, status, attempts: disposal.attempts + 1 }, "Workspace session could not be removed");
      }
    }
    if (!done) {
      this.sessions.failed(sessionId);
      return false;
    }
    // Counted only now, together with leaving the queue: a removal that is
    // tried again must not count the same usage again.
    const delta = settled.totals ? totalsDelta(settled.totals, disposal.totals) : nothing();
    if (some(delta))
      this.usage.record({
        model: modelOf(disposal.key), ultra: disposal.variant === "ultra", delta, cost_reported: !!settled.costReported, turn: false,
      });
    this.sessions.disposed(sessionId);
    this.deps.log.info({ session: sessionId, mode }, "Workspace session removed");
    return true;
  }

  /** What `/context` shows of a channel's session, if it has one. */
  info(channelId: string): { variant: WorkspaceVariant; created_at: string; container_until: string } | undefined {
    const row = this.sessions.get(channelId);
    if (!row) return undefined;
    const iso = (at: number) => new Date(at).toISOString();
    return {
      variant: row.variant,
      created_at: iso(row.createdAt),
      container_until: iso(row.createdAt + CONTAINER_DAYS * 86_400_000),
    };
  }

  /** The lines `/usage` shows above the request ledger's estimate. */
  usageLine(): string | undefined {
    return this.usage.line();
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    // A pass under way ends with the shutdown signal.
    await this.sweeps.run(async () => {});
    // Without a store the rows end with this process, and nothing would ever
    // remove their sessions.
    if (!this.deps.store.opened && this.sdk) {
      const client = this.sdk, signal = AbortSignal.timeout(CLOSE_MS);
      this.sessions.retireGuild(undefined, "archive");
      await Promise.allSettled(this.sessions.disposals().map((disposal) => this.remove(client, disposal, signal)));
    }
    await this.usage.flush();
  }
}
