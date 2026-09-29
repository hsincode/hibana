import { effortSchema } from "@hibana/shared/settings";
import type { Json } from "../types";
import { MAX_WORKFLOW_AGENTS, NESTED_MARK, workflowNotification, type NotificationInput } from "./prompts";
import type { CompiledWorkflow, WorkflowMeta } from "./script";
import { runWorkflowScript, type VmLimits } from "./vm";

export type AgentOptions = {
  label?: string;
  phase?: string;
  schema?: Json;
  model?: string;
  effort?: string;
  agentType?: string;
};
export type AgentRequest = {
  index: number;
  prompt: string;
  opts: AgentOptions;
  label: string;
  group?: string;
  signal: AbortSignal;
  /** Called with each progress line from the running agent. */
  activity(text: string): void;
  /** Called with output tokens as the agent spends them (budget.spent()). */
  usage(outputTokens: number, totalTokens: number): void;
  toolCall(): void;
};
/** value null means Claude Code's "agent() resolves to null": stopped, or a
 *  terminal API error after retries. Other failures reject agent(). */
export type AgentRunner = (request: AgentRequest) => Promise<unknown>;

export class WorkflowAgentCapError extends Error {
  override name = "WorkflowAgentCapError";
  constructor() {
    // Claude Code blames a budget.remaining() loop; Hibana never sets a token
    // budget, so the same backstop only catches unbounded loops.
    super(`Workflow agent() call cap reached (${MAX_WORKFLOW_AGENTS}). This usually means a loop never terminates — budget.remaining() is always Infinity here because no token budget is set. Add a hard iteration cap to the loop.`);
  }
}

export type JournalEntry = { key: string; status: "done" | "failed" | "stopped"; value?: unknown };
export type Journal = JournalEntry[];

type AgentState = {
  index: number;
  label: string;
  group?: string;
  status: "queued" | "running" | "done" | "cached" | "failed" | "stopped";
  tokens: number;
  toolCalls: number;
  empty: boolean;
  activity?: string;
};

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Json)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

const EMPTY_RESULT = /^(\[\s*\]|\{\s*\}|\{\s*"[^"]+"\s*:\s*\[\s*\]\s*\})$/;

function parseOptions(raw: unknown): AgentOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("agent() opts must be an object");
  const o = raw as Json;
  const text = (key: string) => {
    if (o[key] === undefined || o[key] === null) return undefined;
    if (typeof o[key] !== "string") throw new TypeError(`agent() opts.${key} must be a string`);
    return (o[key] as string).trim() || undefined;
  };
  if (o.isolation !== undefined && o.isolation !== null)
    throw new TypeError("agent() opts.isolation is not supported: agents share /workspace, so give parallel writers disjoint paths");
  let schema: Json | undefined;
  if (o.schema !== undefined && o.schema !== null) {
    if (typeof o.schema !== "object" || Array.isArray(o.schema)) throw new TypeError("agent() opts.schema must be a JSON Schema object");
    schema = o.schema as Json;
    // Claude Code rejects schemas it can prove unsatisfiable before starting.
    const properties = schema.properties;
    if (schema.type !== "object" || !properties || typeof properties !== "object" || Array.isArray(properties))
      throw new TypeError("agent() schema needs {type: 'object', properties: {...}} at its root");
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((k) => typeof k !== "string"))
      throw new TypeError("agent() schema.required must be an array of property names");
    const missing = (required as string[]).filter((k) => !Object.hasOwn(properties, k));
    if (missing.length)
      throw new TypeError(`agent() schema is unsatisfiable: required ${missing.map((k) => `'${k}'`).join(", ")} ${missing.length === 1 ? "is" : "are"} not in properties${schema.additionalProperties === false ? " and additionalProperties is false" : ""}`);
  }
  const effort = text("effort");
  if (effort && !effortSchema.safeParse(effort).success)
    throw new TypeError("agent() opts.effort must be 'low' | 'medium' | 'high' | 'xhigh' | 'max'");
  return { label: text("label"), phase: text("phase"), schema, model: text("model"), effort, agentType: text("agentType") };
}

export type RunStatus = "running" | "completed" | "failed" | "killed";

export class WorkflowRun {
  readonly startedAt = Date.now();
  status: RunStatus = "running";
  error?: string;
  result?: unknown;
  readonly controller = new AbortController();
  readonly journal: Journal = [];
  readonly failures: string[] = [];
  readonly logs: string[] = [];
  readonly agents: AgentState[] = [];
  /** Phase groups in first-use order, starting with meta.phases. */
  readonly groups: string[] = [];
  endedAt?: number;
  /** Set by TaskStop: the model asked for it, so no notification follows. */
  stoppedByModel = false;
  private calls = 0;
  private active = 0;
  private waiting: (() => void)[] = [];
  private prefixIntact: boolean;
  private currentGroup?: string;
  private outputTokens = 0;
  /** Runner calls still settling after the script ended or was stopped. */
  private inflight = new Set<Promise<unknown>>();
  totalTokens = 0;
  toolCalls = 0;
  promise!: Promise<void>;

  constructor(
    readonly id: string,
    readonly compiled: CompiledWorkflow,
    readonly args: unknown,
    private readonly o: {
      concurrency: number;
      runAgent: AgentRunner;
      loadChild: (ref: unknown) => Promise<CompiledWorkflow>;
      /** Output tokens spent this turn by the root, its agents and every
       *  workflow: budget.spent() is one shared pool, as in Claude Code. */
      spent: () => number;
      onUpdate: () => void;
      resume?: Journal;
      limits?: Partial<VmLimits>;
      scriptPath?: string;
    },
  ) {
    this.prefixIntact = !!o.resume;
    for (const phase of compiled.meta.phases) this.group(phase.title);
  }

  get meta(): WorkflowMeta { return this.compiled.meta; }
  get scriptPath() { return this.o.scriptPath; }
  get spent() { return this.outputTokens; }

  private group(title: string | undefined) {
    if (title && !this.groups.includes(title)) this.groups.push(title);
    return title;
  }
  private log(line: string) {
    this.logs.push(line.replace(/\s+/g, " ").trim().slice(0, 300));
    if (this.logs.length > 50) this.logs.shift();
    this.o.onUpdate();
  }

  start(): Promise<void> {
    this.promise = runWorkflowScript({
      body: this.compiled.body,
      args: this.args,
      signal: this.controller.signal,
      limits: this.o.limits,
      hooks: {
        agent: (prompt, opts, phase, child) => this.agent(prompt, opts, phase, child),
        log: (message, child) => this.log(child ? `[${child}] ${message}` : message),
        phase: (title, child) => {
          if (!child) this.currentGroup = title;
          this.group(child ? `${NESTED_MARK} ${child} › ${title}` : title);
          this.o.onUpdate();
        },
        failure: (message) => {
          this.failures.push(message);
          this.log(message);
        },
        checkCaps: () => { if (this.calls >= MAX_WORKFLOW_AGENTS) throw new WorkflowAgentCapError(); },
        spent: () => this.o.spent(),
        loadChild: async (ref) => {
          const child = await this.o.loadChild(ref);
          return { name: child.meta.name, body: child.body };
        },
      },
    }).then(
      (result) => { this.finish("completed", result); },
      (error) => {
        if (this.controller.signal.aborted) this.finish("killed");
        else this.finish("failed", undefined, error instanceof Error ? error.message : String(error));
      },
    );
    return this.promise;
  }

  private finish(status: RunStatus, result?: unknown, error?: string) {
    this.status = status;
    this.result = result;
    this.error = error;
    this.endedAt = Date.now();
    // Agents still running when the run ends were stopped, not failed: a
    // resumed run restarts them without discarding the completed agents after them.
    for (const agent of this.agents) if (agent.status === "running" || agent.status === "queued") agent.status = "stopped";
    this.o.onUpdate();
  }

  stop(byModel: boolean) {
    this.stoppedByModel ||= byModel;
    this.controller.abort(new Error("Workflow stopped"));
  }

  /** The script and every agent it started have stopped using the workspace. */
  async settled() {
    await this.promise;
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private async acquire(signal: AbortSignal) {
    if (this.active < this.o.concurrency) { this.active++; return; }
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        const i = this.waiting.indexOf(ready);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal.reason);
      };
      this.waiting.push(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  private async agent(rawPrompt: unknown, rawOpts: unknown, phase: string | undefined, child: string | undefined): Promise<unknown> {
    if (typeof rawPrompt !== "string" || !rawPrompt.trim()) throw new TypeError("agent() expects a non-empty prompt string");
    const opts = parseOptions(rawOpts);
    if (this.calls >= MAX_WORKFLOW_AGENTS) throw new WorkflowAgentCapError();
    const index = this.calls++;
    const title = opts.phase ?? phase ?? (child ? undefined : this.currentGroup);
    const group = this.group(child ? `${NESTED_MARK} ${child}${title ? ` › ${title}` : ""}` : title);
    const label = opts.label ?? rawPrompt.replace(/\s+/g, " ").trim().slice(0, 60);
    const key = stable({ prompt: rawPrompt, opts, child: child ?? null });
    const state: AgentState = { index, label, group, status: "queued", tokens: 0, toolCalls: 0, empty: false };
    this.agents.push(state);
    const previous = this.o.resume?.[index];
    if (this.prefixIntact && previous?.key === key && previous.status === "done") {
      state.status = "cached";
      this.journal[index] = previous;
      this.o.onUpdate();
      return previous.value;
    }
    // Claude Code replays the longest unchanged prefix: an edited, new or
    // failed call runs live and so does every later call. An agent that was
    // merely running when the run stopped restarts without breaking it.
    if (!(previous?.key === key && previous.status === "stopped")) this.prefixIntact = false;
    this.o.onUpdate();
    const signal = this.controller.signal;
    try {
      await this.acquire(signal);
    } catch {
      state.status = "stopped";
      this.journal[index] = { key, status: "stopped" };
      return null;
    }
    state.status = "running";
    this.o.onUpdate();
    let running: Promise<unknown> | undefined;
    try {
      running = this.o.runAgent({
        index, prompt: rawPrompt, opts, label, group, signal,
        activity: (text) => { state.activity = text.replace(/\s+/g, " ").trim().slice(0, 80); },
        usage: (output, total) => {
          this.outputTokens += output;
          this.totalTokens += total;
          state.tokens += total;
        },
        toolCall: () => { state.toolCalls++; this.toolCalls++; },
      });
      this.inflight.add(running);
      const value = await running;
      if (value === null) {
        state.status = signal.aborted ? "stopped" : "failed";
        this.journal[index] = { key, status: state.status };
        if (!signal.aborted) this.failures.push(`[${label}] returned null (terminal API error after retries)`);
        return null;
      }
      state.status = "done";
      state.empty = typeof value === "string" ? !value.trim() || EMPTY_RESULT.test(value.trim()) : EMPTY_RESULT.test(JSON.stringify(value));
      this.journal[index] = { key, status: "done", value };
      return value;
    } catch (error) {
      state.status = signal.aborted ? "stopped" : "failed";
      this.journal[index] = { key, status: state.status };
      if (signal.aborted) return null;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[${label}] failed: ${message}`);
      throw error;
    } finally {
      if (running) this.inflight.delete(running);
      this.release();
      this.o.onUpdate();
    }
  }

  counts() {
    const count = (...s: AgentState["status"][]) => this.agents.filter((a) => s.includes(a.status)).length;
    return {
      count: this.agents.length,
      done: count("done", "cached"),
      error: count("failed"),
      skipped: count("stopped"),
      empty: this.agents.filter((a) => (a.status === "done" || a.status === "cached") && a.empty).length,
      running: count("running"),
      queued: count("queued"),
    };
  }

  notification(taskId: string, extra: { resultFile?: string } = {}): string {
    const c = this.counts();
    const input: NotificationInput = {
      taskId,
      runId: this.id,
      name: this.meta.name,
      status: this.status === "running" ? "killed" : this.status,
      error: this.error,
      result: this.result,
      resultFile: extra.resultFile,
      failures: this.failures.slice(0, 50),
      scriptPath: this.o.scriptPath,
      args: this.args,
      agents: { count: c.count, done: c.done, error: c.error, skipped: c.skipped, empty: c.empty },
      tokens: this.totalTokens,
      toolUses: this.toolCalls,
      durationMs: (this.endedAt ?? Date.now()) - this.startedAt,
    };
    return workflowNotification(input);
  }
}

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60 ? `${s % 60}秒` : ""}`;
};

/** One Discord status message per run: Claude Code's /workflows phase view
 *  (agent counts per phase, tokens, elapsed) plus the latest log lines. */
export function renderProgress(run: WorkflowRun, options: { largeAt?: number } = {}): string {
  const c = run.counts();
  const state = run.status === "running" ? "実行中"
    : run.status === "completed" ? "完了"
    : run.status === "failed" ? "失敗"
    : "停止";
  const lines = [
    `ワークフロー: ${run.meta.name}（${state}・エージェント ${c.count}・${Math.round(run.totalTokens / 1000)}k tokens・${duration((run.endedAt ?? Date.now()) - run.startedAt)}）`,
    run.meta.description,
  ];
  if (options.largeAt !== undefined && c.count > options.largeAt && run.status === "running")
    lines.push(`⚠ Large workflow: ${c.count} agents`);
  const groups: (string | undefined)[] = [...run.groups];
  if (run.agents.some((a) => a.group === undefined)) groups.push(undefined);
  for (const group of groups) {
    const members = run.agents.filter((a) => a.group === group);
    const detail = run.meta.phases.find((p) => p.title === group)?.detail;
    if (!members.length && run.status !== "running") continue;
    const count = (...s: AgentState["status"][]) => members.filter((a) => s.includes(a.status)).length;
    if (!members.length) {
      lines.push(`▸ ${group}${detail ? `（${detail}）` : ""} — 未開始`);
      continue;
    }
    const parts = [
      `${count("done", "cached")}/${members.length} 完了`,
      ...(count("cached") ? [`${count("cached")} 再利用`] : []),
      ...(count("running") ? [`${count("running")} 実行中`] : []),
      ...(count("queued") ? [`${count("queued")} 待機`] : []),
      ...(count("failed") ? [`${count("failed")} 失敗`] : []),
      ...(count("stopped") ? [`${count("stopped")} 停止`] : []),
    ];
    lines.push(`▸ ${group ?? "（フェーズなし）"}${detail ? `（${detail}）` : ""} — ${parts.join("・")}`);
    for (const agent of members.filter((a) => a.status === "running").slice(0, 3))
      lines.push(`　・${agent.label}${agent.activity ? `: ${agent.activity}` : ""}`);
  }
  if (run.error) lines.push(`エラー: ${run.error}`);
  for (const log of run.logs.slice(-3)) lines.push(`> ${log}`);
  const text = lines.join("\n");
  return text.length > 1900 ? `${text.slice(0, 1899)}…` : text;
}
