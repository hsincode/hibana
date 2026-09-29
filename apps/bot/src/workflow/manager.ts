import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import Ajv from "ajv";
import type { Logger } from "pino";
import type { Agent, AgentOptions as LoopOptions } from "../agent";
import { AGENT_ROLES, isAgentRole, type AgentRole } from "../agent-roles";
import type { Selection } from "../config";
import { nativeSearchFor } from "../llm";
import { ProviderError } from "../llm-errors";
import { selectChild } from "../multi-agent-policy";
import type { Runtime } from "../runtime";
import type { Sandbox } from "../tools/sandbox";
import type { Context, Json, Message, ToolDef, Usage } from "../types";
import { renderProgress, WorkflowRun, type AgentRequest, type Journal } from "./engine";
import {
  launchText,
  RESULT_EXCERPT,
  RUN_SCRIPT_DIR,
  SAVED_WORKFLOW_DIR,
  sizeGuidelineAgents,
  STRUCTURED_OUTPUT_ATTEMPTS,
  STRUCTURED_OUTPUT_NUDGE,
  STRUCTURED_OUTPUT_TOOL,
  SYSTEM_NOTIFICATION,
  WORKFLOW_ROLE_NOTE,
  WORKFLOW_ROLE_SCHEMA_NOTE,
  WORKFLOW_SUBAGENT_PROMPT,
  WORKFLOW_SUBAGENT_SCHEMA_PROMPT,
} from "./prompts";
import { compileWorkflow, MAX_SCRIPT_CHARS, WorkflowScriptError, type CompiledWorkflow } from "./script";
import { checkWorkflowSyntax } from "./vm";

/** Workspace access for scripts. Writes skip the shell lock: a launch must
 *  not wait behind a long bash command, and every run owns its file name. */
export type WorkflowFiles = {
  read(ctx: Context, path: string): Promise<string>;
  write(ctx: Context, path: string, content: string): Promise<string>;
  list(ctx: Context, dir: string): Promise<string[]>;
};

export function sandboxFiles(sandbox: Sandbox): WorkflowFiles {
  return {
    async read(ctx, path) {
      const full = await sandbox.path(ctx, path);
      const st = await lstat(full);
      if (!st.isFile() || st.size > MAX_SCRIPT_CHARS * 4) throw new Error(`${path} is not a readable script file`);
      return readFile(full, "utf8");
    },
    async write(ctx, path, content) {
      const full = await sandbox.path(ctx, path);
      await sandbox.quota(await sandbox.root(ctx), Buffer.byteLength(content));
      await mkdir(dirname(full), { recursive: true });
      await sandbox.path(ctx, path);
      await writeFile(full, content, { mode: 0o600 });
      return `/workspace/${path}`;
    },
    async list(ctx, dir) {
      const full = await sandbox.path(ctx, dir, true);
      return (await readdir(full, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => e.name.slice(0, -3)).sort();
    },
  };
}

type SavedRun = { scope: string; journal: Journal; at: number; running: boolean };

/** Completed agent results for resumeFromRunId. Claude Code keeps them for
 *  the session; a Discord turn is shorter, so runs stay resumable for the same
 *  user in the same channel for two hours across later messages. */
export class WorkflowJournals {
  private runs = new Map<string, SavedRun>();
  constructor(private readonly ttlMs = 2 * 3600_000, private readonly max = 32) {}
  save(id: string, scope: string, journal: Journal, running: boolean) {
    this.runs.delete(id);
    this.runs.set(id, { scope, journal, at: Date.now(), running });
    for (const [key, run] of this.runs)
      if (this.runs.size > this.max || Date.now() - run.at > this.ttlMs) this.runs.delete(key);
      else break;
  }
  get(id: string, scope: string): SavedRun | undefined {
    const run = this.runs.get(id);
    if (!run || run.scope !== scope || Date.now() - run.at > this.ttlMs) return undefined;
    return run;
  }
}

export const workflowScope = (ctx: Pick<Context, "guildId" | "channelId" | "userId">) =>
  `${ctx.guildId ?? "dm"}/${ctx.channelId}/${ctx.userId}`;

export type WorkflowServices = {
  runtime: Runtime;
  agent: Agent;
  tools: (ctx: Context) => ToolDef[];
  journals: WorkflowJournals;
  files?: WorkflowFiles;
  log?: Logger;
};

/** What a workflow needs from the Discord task tree it runs in. */
export type WorkflowSessionPort = {
  root(): { context: Context; selection: Selection; messages: Message[] };
  options(): LoopOptions;
  /** Deliver a <task-notification> to root at its next message boundary. */
  notify(content: string): void;
  /** Wake root if it is waiting for workflows (a TaskStop sends no notice). */
  wake(): void;
  recordUsage(usage: Usage): void;
  /** Output tokens spent this turn by root, children and workflows. */
  spent(): number;
};

const random = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

/** opts.agentType: Hibana's registry is the fixed Multi-Agent role set. */
function agentTypeRole(agentType: string | undefined): AgentRole | undefined {
  if (!agentType || ["general-purpose", "workflow-subagent"].includes(agentType)) return undefined;
  const role = agentType === "Explore" ? "explorer" : agentType;
  if (isAgentRole(role)) return role;
  throw new TypeError(`Unknown agentType '${agentType}'. Available: general-purpose, explorer, worker, reviewer`);
}

/** StructuredOutput validation with Claude Code's retry budget. */
class StructuredOutput {
  private readonly validate;
  private attempts = 0;
  private nudges = 0;
  private done = false;
  private value: unknown;
  private fatal?: Error;
  readonly tool: ToolDef;
  constructor(schema: Json) {
    try {
      this.validate = new Ajv({ strict: false, allowUnionTypes: true }).compile(schema);
    } catch (error) {
      throw new TypeError(`agent() schema is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.tool = {
      type: "function",
      function: {
        name: STRUCTURED_OUTPUT_TOOL,
        description: "Return your final answer to the workflow script that spawned you. Call exactly once; the input must match this schema.",
        parameters: schema,
      },
    };
  }
  get finished() { return this.done || !!this.fatal; }
  submit(args: Json) {
    if (this.done) return { ok: true, note: "Already recorded. End your turn." };
    if (this.validate(args)) {
      this.done = true;
      this.value = args;
      return { ok: true, note: "Recorded. End your turn." };
    }
    const error = (this.validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    if (++this.attempts >= STRUCTURED_OUTPUT_ATTEMPTS)
      this.fatal = new Error(`agent() structured output failed schema validation after ${STRUCTURED_OUTPUT_ATTEMPTS} attempts: ${error}`);
    return { ok: false, error: `Output does not match the schema: ${error}. Call ${STRUCTURED_OUTPUT_TOOL} again with a corrected shape.` };
  }
  nudge(): Message[] {
    if (this.finished) return [];
    if (this.nudges++ < 2) return [{ role: "user", internal: true, content: STRUCTURED_OUTPUT_NUDGE }];
    this.fatal = new Error(`agent() completed without structured output: the agent never called the ${STRUCTURED_OUTPUT_TOOL} tool.`);
    return [];
  }
  result() {
    if (this.done) return this.value;
    throw this.fatal ?? new Error(`agent() completed without structured output: the agent never called the ${STRUCTURED_OUTPUT_TOOL} tool.`);
  }
}

/** delivering stays true until the notification is in root's mailbox: the
 *  run reports "completed" a few microtasks earlier, and root must not take
 *  that gap as "nothing left to wait for". */
type Task = { id: string; run: WorkflowRun; done: Promise<void>; delivering: boolean };

export class WorkflowManager {
  private tasks = new Map<string, Task>();
  private closed = false;
  constructor(private readonly session: WorkflowSessionPort, private readonly services: WorkflowServices) {}

  running() {
    return [...this.tasks.values()].filter((t) => t.delivering).length;
  }

  private config() { return this.services.runtime.config; }

  private async source(input: Json, ctx: Context): Promise<{ text: string; scriptPath?: string }> {
    const files = this.services.files;
    if (typeof input.scriptPath === "string" && input.scriptPath.trim()) {
      if (!files) throw new Error("scriptPath needs the workspace, which is unavailable here");
      const path = input.scriptPath.trim();
      return { text: await files.read(ctx, path), scriptPath: path.startsWith("/workspace/") ? path : `/workspace/${path.replace(/^\.?\//, "")}` };
    }
    if (typeof input.script === "string" && input.script.trim()) return { text: input.script };
    if (typeof input.name === "string" && input.name.trim()) return { text: await this.saved(input.name.trim(), ctx) };
    throw new Error("Must provide script, name, or scriptPath");
  }

  private async saved(name: string, ctx: Context): Promise<string> {
    const files = this.services.files;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`Workflow "${name}" not found`);
    if (!files) throw new Error("Saved workflows need the workspace, which is unavailable here");
    try {
      return await files.read(ctx, `${SAVED_WORKFLOW_DIR}/${name}.js`);
    } catch {
      const available = await files.list(ctx, SAVED_WORKFLOW_DIR).catch(() => []);
      throw new Error(`Workflow "${name}" not found. Available: (${available.join(", ") || "none"})`);
    }
  }

  private async compile(text: string): Promise<CompiledWorkflow> {
    const compiled = compileWorkflow(text);
    const syntax = await checkWorkflowSyntax(compiled.body);
    if (syntax) throw new WorkflowScriptError(syntax);
    return compiled;
  }

  async launch(input: Json, ctx: Context): Promise<unknown> {
    if (this.closed) throw new Error("Agent task is no longer active");
    if (ctx.depth !== 0 || ctx.workflowAgent) throw new Error("Only the main agent can run workflows");
    const source = await this.source(input, ctx);
    let compiled: CompiledWorkflow;
    try {
      compiled = await this.compile(source.text);
    } catch (error) {
      if (error instanceof WorkflowScriptError)
        throw new Error(`Workflow script has a syntax error and was not launched:\n${error.message}`);
      throw error;
    }
    const scope = workflowScope(ctx);
    let resume: Journal | undefined;
    if (typeof input.resumeFromRunId === "string") {
      const previous = this.services.journals.get(input.resumeFromRunId, scope);
      if (!previous) throw new Error(`nothing to resume: no saved results for ${input.resumeFromRunId} in this channel (runs stay resumable for 2 hours). Start the workflow over as a new run.`);
      if (previous.running) throw new Error(`Workflow run ${input.resumeFromRunId} is still running; stop it with TaskStop before resuming`);
      resume = previous.journal;
    }
    const runId = `wf_${random(10)}`;
    const taskId = `task_${random(8)}`;
    let scriptPath = source.scriptPath;
    if (!scriptPath && this.services.files)
      scriptPath = await this.services.files.write(ctx, `${RUN_SCRIPT_DIR}/${runId}.js`, compiled.source).catch(() => undefined);
    const settings = this.services.runtime.resolve(ctx.guildId, ctx.userId);
    const guideline = this.config().workflowSizeGuideline;
    // Claude Code shows a "Large workflow" warning past 25 agents (or a
    // user-chosen size guideline) unless ultracode already opted in to scale.
    const largeAt = settings.ultracode
      ? undefined
      : (!this.config().workflowSizeGuidelineDefault && sizeGuidelineAgents(guideline)) || 25;
    const status = ctx.openStatus?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = () => {
      clearTimeout(timer);
      timer = undefined;
      void status?.(renderProgress(run, { largeAt })).catch(() => {});
    };
    const run: WorkflowRun = new WorkflowRun(runId, compiled, input.args, {
      concurrency: this.config().workflowConcurrency,
      runAgent: (request) => this.runAgent(request),
      loadChild: async (ref) => {
        if (typeof ref === "string") return this.compile(await this.saved(ref, ctx));
        if (ref && typeof ref === "object" && typeof (ref as Json).scriptPath === "string") {
          if (!this.services.files) throw new Error("scriptPath needs the workspace, which is unavailable here");
          return this.compile(await this.services.files.read(ctx, (ref as Json).scriptPath as string));
        }
        throw new TypeError("workflow() expects a saved workflow name or {scriptPath}");
      },
      spent: () => this.session.spent(),
      // Discord allows a few edits per second per channel; coalesce agent
      // churn into one edit every 2.5 s and always draw the final state.
      onUpdate: () => { if (status && !timer && run.status === "running") timer = setTimeout(render, 2500); },
      resume,
      scriptPath,
    });
    this.services.journals.save(runId, scope, run.journal, true);
    const started = performance.now();
    const fields = { channel: ctx.channelId, message_id: ctx.messageId, run_id: runId, workflow: compiled.meta.name,
      resumed: !!resume, ultracode: settings.ultracode };
    this.services.log?.info(fields, "Workflow started");
    render();
    const task: Task = { id: taskId, run, done: Promise.resolve(), delivering: true };
    task.done = run.start().then(async () => {
      render();
      this.services.journals.save(runId, scope, run.journal, false);
      const c = run.counts();
      this.services.log?.info({ ...fields, status: run.status, agents: c.count, failed: c.error,
        tokens: run.totalTokens, elapsed_ms: Math.round(performance.now() - started) }, "Workflow finished");
      if (this.closed || run.stoppedByModel) return;
      let resultFile: string | undefined;
      const json = run.result === undefined ? "" : JSON.stringify(run.result);
      if (json.length > RESULT_EXCERPT && this.services.files)
        resultFile = await this.services.files.write(ctx, `${RUN_SCRIPT_DIR}/${runId}.result.json`, json).catch(() => undefined);
      this.session.notify(`<system-reminder>\n${SYSTEM_NOTIFICATION}\n${run.notification(taskId, { resultFile })}\n</system-reminder>`);
    }).finally(() => {
      task.delivering = false;
      this.session.wake();
    });
    this.tasks.set(taskId, task);
    return {
      status: "async_launched",
      taskId,
      workflowName: compiled.meta.name,
      runId,
      summary: compiled.meta.description,
      ...(scriptPath ? { scriptPath } : {}),
      message: launchText({ taskId, runId, summary: compiled.meta.description, scriptPath }),
    };
  }

  stop(input: Json, ctx: Context): unknown {
    if (ctx.depth !== 0 || ctx.workflowAgent) throw new Error("Only the main agent can stop tasks");
    const id = String(input.task_id ?? input.shell_id ?? "");
    const task = this.tasks.get(id) ?? [...this.tasks.values()].find((t) => t.run.id === id);
    if (!task) return { success: false, message: `No task found with ID: ${id}` };
    if (task.run.status !== "running") return { success: false, message: `Task ${id} is not running (status: ${task.run.status})` };
    task.run.stop(true);
    // Worded like interrupt_agent's reason: Jev's Stop check once rejected an
    // answer three times because a deliberate stop read as unfinished work.
    return { success: true, message: `Successfully stopped task: ${task.id} (${task.run.meta.name}). Stopped on purpose by the main agent; the stopped work is not unfinished user work.`, task_id: task.id, run_id: task.run.id };
  }

  async close() {
    this.closed = true;
    for (const task of this.tasks.values()) task.run.stop(false);
    await Promise.allSettled([...this.tasks.values()].map(async (t) => { await t.done; await t.run.settled(); }));
  }

  /** One agent() call: a fresh subagent with the workflow-subagent prompt,
   *  the AGENTS.md instructions and none of the conversation. */
  private async runAgent(request: AgentRequest): Promise<unknown> {
    const { runtime, agent } = this.services;
    const root = this.session.root();
    const settings = runtime.resolve(root.context.guildId, root.context.userId);
    const role = agentTypeRole(request.opts.agentType);
    // Common subagent policies apply; opts.model / opts.effort are the
    // per-call request, like spawn_agent's model / reasoning_effort.
    const selection = selectChild(runtime, root.context, root.selection, {
      ...(request.opts.model ? { model: request.opts.model } : {}),
      ...(request.opts.effort ? { reasoning_effort: request.opts.effort } : {}),
    });
    const structured = request.opts.schema ? new StructuredOutput(request.opts.schema) : undefined;
    const signal = root.context.signal ? AbortSignal.any([root.context.signal, request.signal]) : request.signal;
    const context: Context = {
      guildId: root.context.guildId,
      channelId: root.context.channelId,
      userId: root.context.userId,
      botId: root.context.botId,
      thread: root.context.thread,
      messageId: root.context.messageId,
      depth: 1,
      delivered: false,
      pendingImages: [],
      agentPath: `/root/workflow/${request.index}`,
      agentSelection: selection,
      agentRole: role,
      workflowAgent: true,
      signal,
      progress: async (text) => request.activity(text),
    };
    const system = role
      ? `${AGENT_ROLES[role].instructions}${structured ? WORKFLOW_ROLE_SCHEMA_NOTE : WORKFLOW_ROLE_NOTE}`
      : structured ? WORKFLOW_SUBAGENT_SCHEMA_PROMPT : WORKFLOW_SUBAGENT_PROMPT;
    const instructions = root.messages.filter((m) =>
      m.role === "system" || m.content?.startsWith("# AGENTS.md instructions"));
    const messages: Message[] = [
      ...structuredClone(instructions),
      { role: "developer", internal: true, content: system },
      { role: "user", content: request.prompt, turnStart: true },
    ];
    const tools = (c: Context) => [...this.services.tools(c), ...(structured ? [structured.tool] : [])];
    const loop = this.session.options();
    try {
      const result = await agent.run({
        ...loop,
        selection,
        context,
        messages,
        tools: tools(context),
        getTools: tools,
        jevTaskMode: undefined,
        stopHook: undefined,
        checkpoint: undefined,
        requestSignal: undefined,
        takeSteering: undefined,
        observeMessages: undefined,
        nativeSearch: nativeSearchFor(selection, settings.exa_mode, runtime.config.webSearch),
        execute: async (name, args, c) => {
          if (structured && name === STRUCTURED_OUTPUT_TOOL) return structured.submit(args);
          request.toolCall();
          return loop.execute(name, args, c);
        },
        recordUsage: (usage) => {
          this.session.recordUsage(usage);
          request.usage(usage.completion_tokens, usage.total_tokens);
        },
        beforeFinal: structured ? async () => structured.nudge() : undefined,
        shouldStop: structured ? () => structured.finished : undefined,
      });
      return structured ? structured.result() : result.text;
    } catch (error) {
      if (signal.aborted) return null;
      // Claude Code: agent() resolves to null when the subagent dies on a
      // terminal API error after retries; anything else rejects agent().
      if (error instanceof ProviderError) return null;
      throw error;
    }
  }
}
