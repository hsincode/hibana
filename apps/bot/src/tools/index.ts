import { evaluateCompletion, withAbort } from "../jev-stop";
import type { StopHookInput, StopDecision } from "../stop-hook";
import type { Logger } from "pino";
import { MODEL_PRESETS } from "@hibana/shared/catalog";
import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Client as DiscordClient } from "discord.js";
import Ajv from "ajv";
import {
  canonicalBuiltin,
  subagentMode,
  triggerNamesEqual,
  triggerWordSchema,
} from "@hibana/shared/settings";
import { roleAllowsTool, workflowAgentAllowsTool } from "../agent-roles";
import { workflowsEnabled } from "../ultracode";
import { sandboxFiles, WorkflowJournals, type WorkflowFiles } from "../workflow/manager";
import {
  TASK_STOP_DESCRIPTION,
  TASK_STOP_PARAMETERS,
  TASK_STOP_TOOL,
  WORKFLOW_AUTHORING_DESCRIPTION,
  WORKFLOW_AUTHORING_SKILL,
  WORKFLOW_PARAMETERS,
  WORKFLOW_TOOL,
  workflowAuthoringReference,
  workflowToolDescription,
  type ReferenceOptions,
} from "../workflow/prompts";
import { evaluateRoute, isAutoRoute, ROUTE_TIMEOUT_MS } from "../auto-route";
type RouteDecision = Awaited<ReturnType<typeof evaluateRoute>>;
import { evaluateTriage, shouldPrestartExplorer, TRIAGE_TIMEOUT_MS, type Triage } from "../jev-triage";
import definitions from "./definitions.json";
import codexDefinitions from "./codex-definitions.json";
import { collaborationNames, collaborationTools, collaborationValidationSchema, teamTools } from "../multi-agent-policy";
import { Runtime } from "../runtime";
import { Agent } from "../agent";
import { nativeSearchFor } from "../llm";
import { JevClient, JEV_NOTICE_HEADER, jevInputSchema } from "../jev";
import { jevTaskSchema, jevTaskTool, jevRequiredActionTools, runJevTask } from "../jev-task";
import { Semaphore } from "../io";
import { triggerWords } from "../triggers";
import type { Context, Json, Message, ToolDef, Usage } from "../types";
import {
  normalizeTool,
  harnessTools,
  namespaced,
  applyPatch,
  assemblePrompt,
} from "../harness";
import { Sandbox, safePath, quote, filesUnder } from "./sandbox";
import { DiscordTools, ADMIN_TOOLS } from "./discord";
import { Skills } from "./skills";
import { Sites } from "./sites";
import { Media } from "./media";
import { Vpn } from "./vpn";
import { WebTools } from "./web";
import { ImageTools } from "./image";
import { askQuestions, questionsSchema } from "./questions";
import { downloadPublic } from "../network";
const sandboxNames = new Set([
  "bash",
  "write_file",
  "write_files",
  "edit_file",
  "grep_files",
  "read_file",
  "list_files",
  "send_file",
  "download_file",
  "download_attachment",
  "video_edit",
  "playwright_cli",
  "download_media",
  "gh_status",
  "gh_login",
  "gh_logout",
]);
export class ToolRegistry {
  readonly sandbox: Sandbox;
  readonly discord: DiscordTools;
  readonly skills: Skills;
  readonly sites: Sites;
  readonly media: Media;
  readonly vpn: Vpn;
  readonly web: WebTools;
  readonly image: ImageTools;
  readonly jev: JevClient;
  private maintenance?: ReturnType<typeof setInterval>;
  private sweeping = false;
  readonly waiting = new Set<string>();
  private subagents: Semaphore;
  private validators = new Map<string, ReturnType<Ajv["compile"]>>();
  /** Workflow resume state survives the Discord turn that produced it. */
  readonly workflowJournals = new WorkflowJournals();
  readonly workflowFiles: WorkflowFiles;
  // A single-use capability belongs to one exact selected operation. Tool
  // arguments cannot fabricate it, and unrelated nested calls cannot reuse it.
  private jevActions = new WeakMap<Context, { name: string; args: Json }>();
  constructor(
    readonly runtime: Runtime,
    readonly client: DiscordClient,
    readonly agent: Agent,
    private log?: Logger,
  ) {
    this.sandbox = new Sandbox(runtime.config);
    this.discord = new DiscordTools(client, runtime, this.sandbox);
    this.skills = new Skills(runtime.config);
    this.sites = new Sites(runtime.config, this.sandbox);
    this.media = new Media(this.sandbox, log);
    this.vpn = new Vpn(runtime.config, this.sandbox);
    this.web = new WebTools(runtime.config, runtime);
    this.image = new ImageTools(runtime.config, this.sandbox);
    this.jev = new JevClient(runtime.config);
    this.subagents = new Semaphore(runtime.config.subagentConcurrency);
    this.workflowFiles = sandboxFiles(this.sandbox);
    const ajv = new Ajv({ strict: false, allowUnionTypes: true });
    this.validators.set(WORKFLOW_TOOL, ajv.compile(WORKFLOW_PARAMETERS));
    this.validators.set(TASK_STOP_TOOL, ajv.compile(TASK_STOP_PARAMETERS));
    for (const d of [...codexDefinitions, ...definitions, jevTaskTool])
      this.validators.set(d.function.name, ajv.compile(d.function.parameters));
    for (const d of collaborationTools)
      this.validators.set(`agents__${d.function.name}`, ajv.compile(collaborationValidationSchema(d)));
  }
  async load() {
    await this.sandbox.probe();
    await this.skills.load();
    await this.sites.load();
    await this.sites.start();
    await this.vpn.load();
    this.maintenance = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = true;
      void Promise.all([this.sandbox.sweep(), this.sites.sweep()])
        .catch((e) =>
          console.error(
            "Maintenance failed:",
            e instanceof Error ? e.message : String(e),
          ),
        )
        .finally(() => {
          this.sweeping = false;
        });
    }, 3600000);
    this.maintenance.unref();
  }
  async checkCompletion(input: StopHookInput): Promise<StopDecision> {
    const ctx = input.context;
    const enabled = () => ctx.depth === 0 && this.runtime.config.toolsEnabled &&
      this.runtime.config.subagentEnabled && !!this.runtime.config.jevApiKey &&
      this.runtime.resolve(ctx.guildId, ctx.userId).jev_enabled &&
      !this.runtime.snapshot.blocked_users.includes(ctx.userId) &&
      !this.runtime.guild(ctx.guildId).bot_disabled;
    if (!enabled()) return { decision: "allow" };
    // Optional evaluation must not hold a response for all HTTP retries or
    // an occupied Jev slot. Timeout/error follows Codex's normal stop path.
    const signal = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      ...(ctx.signal ? [ctx.signal] : []),
      AbortSignal.timeout(20000),
    ]);
    const started = performance.now();
    const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
    const fields = { channel: ctx.channelId, message_id: ctx.messageId,
      settings_version: this.runtime.snapshot.version, ultra_mode: settings.ultra_mode,
      multi_agent: settings.multi_agent, jev_task_enabled: settings.jev_task_enabled,
      stop_hook_active: input.stopHookActive };
    let verdict = "unavailable";
    try {
      const result = await withAbort(this.subagents.run(async () => {
        signal.throwIfAborted();
        if (!enabled()) return undefined;
        // Automatic completion checks stay silent and do not consume the
        // visible invocation count used by explicit Jev tool calls.
        return evaluateCompletion(input, this.jev.decide.bind(this.jev), signal);
      }), signal);
      if (!enabled() || !result) { verdict = "disabled"; return { decision: "allow" }; }
      verdict = result.verdict;
      return result.outcome;
    } catch {
      // User steering is cancellation, not evaluator failure. The agent loop
      // consumes the new input and discards the candidate being checked.
      if (input.signal?.aborted || ctx.signal?.aborted) {
        verdict = "interrupted";
        (input.signal?.aborted ? input.signal : ctx.signal)!.throwIfAborted();
      }
      await ctx.progress?.("Jev の完了チェックを利用できなかったため、通常の応答を返します。").catch(() => {});
      return { decision: "allow" };
    } finally {
      // Never log request text, worker output, candidate answers or API bodies.
      this.log?.info({ ...fields, verdict, elapsed_ms: Math.round(performance.now() - started) }, "Jev completion check finished");
    }
  }
  /** Multi-Agent turn-start classification. Silent like the completion check:
   *  no Discord notice or visible Jev count, and any failure means "no hint". */
  async triage(ctx: Context, messages: readonly Message[]): Promise<{ triage: Triage; usage: Usage } | undefined> {
    const enabled = () => {
      const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
      return ctx.depth === 0 && this.runtime.config.toolsEnabled &&
        this.runtime.config.subagentEnabled && !!this.runtime.config.jevApiKey &&
        settings.jev_enabled && subagentMode(settings) === "multi" &&
        !this.runtime.snapshot.blocked_users.includes(ctx.userId) &&
        !this.runtime.guild(ctx.guildId).bot_disabled;
    };
    if (!enabled()) return undefined;
    // The deadline includes waiting for the shared Jev slot: triage is only
    // worth doing while it is much faster than the orchestrator's first call.
    const signal = AbortSignal.any([
      ...(ctx.signal ? [ctx.signal] : []),
      AbortSignal.timeout(TRIAGE_TIMEOUT_MS),
    ]);
    const started = performance.now();
    let verdict = "unavailable";
    let result: { triage: Triage; usage: Usage } | undefined;
    try {
      result = await withAbort(this.subagents.run(async () => {
        signal.throwIfAborted();
        if (!enabled()) return undefined;
        return evaluateTriage(messages, this.jev.decide.bind(this.jev), signal);
      }), signal);
      verdict = result ? "classified" : "disabled";
      return result && enabled() ? result : undefined;
    } catch {
      ctx.signal?.throwIfAborted();
      return undefined;
    } finally {
      // Probabilities only; never the request text or the API response body.
      const round = (value: number) => Math.round(value * 100) / 100;
      this.log?.info({
        channel: ctx.channelId, message_id: ctx.messageId, verdict,
        ...(result ? {
          needs_research: round(result.triage.needs_research),
          needs_artifact_work: round(result.triage.needs_artifact_work), needs_review: round(result.triage.needs_review),
          prestart_explorer: shouldPrestartExplorer(result.triage),
        } : {}),
        elapsed_ms: Math.round(performance.now() - started),
      }, "Jev triage finished");
    }
  }
  /** Auto routing: Jev scores the request's difficulty once, before the turn.
   *  Silent like the triage. Any failure returns undefined and the caller
   *  uses the fallback model. */
  async route(ctx: Context, messages: readonly Message[]): Promise<RouteDecision | undefined> {
    const enabled = () => {
      const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
      return this.runtime.config.toolsEnabled && this.runtime.config.subagentEnabled &&
        !!this.runtime.config.jevApiKey && settings.jev_enabled && isAutoRoute(settings.selection);
    };
    const started = performance.now();
    let verdict = "disabled";
    let result: RouteDecision | undefined;
    try {
      if (!enabled()) return undefined;
      verdict = "unavailable";
      // The deadline includes waiting for the shared Jev slot.
      const signal = AbortSignal.any([
        ...(ctx.signal ? [ctx.signal] : []),
        AbortSignal.timeout(ROUTE_TIMEOUT_MS),
      ]);
      result = await withAbort(this.subagents.run(async () => {
        signal.throwIfAborted();
        return evaluateRoute(messages, this.jev.decide.bind(this.jev), signal);
      }), signal);
      verdict = "classified";
      return result;
    } catch {
      ctx.signal?.throwIfAborted();
      return undefined;
    } finally {
      // The level only; never the request text or the API response body.
      this.log?.info({
        channel: ctx.channelId, message_id: ctx.messageId, verdict,
        ...(result ? { level: result.level, requested: result.requested ?? null, model: result.selection.model, effort: result.selection.effort } : {}),
        elapsed_ms: Math.round(performance.now() - started),
      }, "Jev route finished");
    }
  }
  base(ctx: Context): ToolDef[] {
    if (!this.runtime.config.toolsEnabled) return [];
    const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
    const native = nativeSearchFor(
      ctx.agentSelection ?? settings.selection,
      settings.exa_mode,
      this.runtime.config.webSearch,
    );
    const available = [...definitions as ToolDef[], jevTaskTool, ...(this.runtime.config.subagentEnabled && settings.subagent_enabled && ctx.team ? teamTools(this.runtime, ctx).map(t => ({
      ...t, function: { ...t.function, name: `agents__${t.function.name}` },
    })) : [])];
    return available.filter((t) => {
      const n = t.function.name;
      if ((n === "generate_image" || n === "edit_image" || n === "image_generation_status") &&
          (!this.runtime.config.imageWorkerUrl || !this.sandbox.available)) return false;
      if (sandboxNames.has(n) && !this.sandbox.available) return false;
      if (ADMIN_TOOLS.has(n) && (!ctx.guildId || !settings.server_tools))
        return false;
      if (
        /^home_vpn_/.test(n) &&
        (!this.runtime.config.browserProxyUrl || !this.sandbox.available || ctx.depth > 0 ||
          this.runtime.role(ctx.userId) !== "administrator")
      ) return false;
      if (
        /^vpn_/.test(n) &&
        (!this.runtime.config.vpnEnabled ||
          this.runtime.role(ctx.userId) !== "administrator" ||
          (n === "vpn_login_code" &&
            this.runtime.config.vpnProvider !== "surfshark"))
      )
        return false;
      if (/skill/.test(n) && !this.runtime.config.skillsEnabled) return false;
      if (
        /^(publish_site|unpublish_site|list_sites|extend_site)$/.test(n) &&
        !this.runtime.config.siteEnabled
      )
        return false;
      // exa off disables every web tool, Jev task mode included (#46).
      if (/^web/.test(n) && (!this.runtime.config.webSearch || settings.exa_mode === "off" ||
          (native && !this.jevTaskMode(ctx))))
        return false;
      if (/^mcp_/.test(n) && settings.mcp_enabled === false) return false;
      if (
        (n === "run_jev" || n === "run_jev_task") &&
        (ctx.depth > 0 ||
          !this.runtime.config.subagentEnabled ||
          !this.runtime.config.jevApiKey ||
          // jevTaskMode() also folds in Multi-Agent, which never uses the loop.
          !(n === "run_jev" ? settings.jev_enabled : this.jevTaskMode(ctx)))
      )
        return false;
      return true;
    });
  }
  /** Claude Code exposes Workflow whenever dynamic workflows are on; its own
   *  description limits use to explicit opt-in (keyword, Ultracode, request).
   *  Multi-Agent keeps its team protocol and offers it on keyword turns only. */
  workflowAvailable(ctx: Context): boolean {
    if (ctx.depth !== 0 || ctx.workflowAgent || !ctx.team) return false;
    const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
    if (!workflowsEnabled(this.runtime.config, settings)) return false;
    const mode = subagentMode(settings);
    return mode === "on" || mode === "ultra" || (mode === "multi" && !!ctx.workflowKeyword);
  }
  private referenceOptions(ctx: Context): ReferenceOptions {
    const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
    return {
      concurrency: this.runtime.config.workflowConcurrency,
      modelOption: settings.subagent_model.mode === "auto",
      presets: MODEL_PRESETS.filter((p) => this.runtime.canSelect(p.id, ctx.userId)).map((p) => p.id),
    };
  }
  /** Claude Code serves the authoring reference as the workflow-authoring
   *  skill when a skill tool exists (use_skill here) and embeds it otherwise. */
  workflowSkillAvailable(): boolean {
    return this.runtime.config.skillsEnabled;
  }
  workflowReference(ctx: Context): string {
    return workflowAuthoringReference(this.referenceOptions(ctx));
  }
  /** ## Skills list, plus the built-in workflow-authoring reference. */
  async skillCatalog(ctx: Context): Promise<string> {
    const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
    const workflow = workflowsEnabled(this.runtime.config, settings) && this.workflowSkillAvailable()
      ? `- ${WORKFLOW_AUTHORING_SKILL}: ${WORKFLOW_AUTHORING_DESCRIPTION}` : "";
    return [await this.skills.catalog(ctx), workflow].filter(Boolean).join("\n");
  }
  private workflowTools(ctx: Context): ToolDef[] {
    const config = this.runtime.config;
    return [
      {
        type: "function",
        function: {
          name: WORKFLOW_TOOL,
          description: workflowToolDescription({
            ...this.referenceOptions(ctx),
            size: config.workflowSizeGuideline,
            sizeIsDefault: config.workflowSizeGuidelineDefault,
            skill: this.workflowSkillAvailable(),
          }),
          parameters: WORKFLOW_PARAMETERS,
        },
      },
      { type: "function", function: { name: TASK_STOP_TOOL, description: TASK_STOP_DESCRIPTION, parameters: TASK_STOP_PARAMETERS } },
    ];
  }
  tools(ctx: Context) {
    if (!this.runtime.config.toolsEnabled) return [];
    const base = this.base(ctx);
    // Filter the final surface, not base(): harness-native aliases such as
    // shell_command/apply_patch are added later and must obey the role too.
    const tools = harnessTools(base, this.sandbox.available)
      .filter((t) => roleAllowsTool(ctx.agentRole, normalizeTool(t.function.name, {}).name))
      .filter((t) => !ctx.workflowAgent || workflowAgentAllowsTool(normalizeTool(t.function.name, {}).name));
    if (this.workflowAvailable(ctx)) tools.push(...this.workflowTools(ctx));
    // The Codex harness reads files through shell_command and hides the file
    // tools. A role without a shell (explorer) gets the read-only ones back,
    // or it could not inspect the workspace it is meant to research.
    if (ctx.agentRole && !roleAllowsTool(ctx.agentRole, "bash"))
      tools.push(...base.filter((t) =>
        ["read_file", "list_files", "grep_files"].includes(t.function.name) &&
        roleAllowsTool(ctx.agentRole, t.function.name)).map(namespaced));
    if (!this.jevTaskMode(ctx)) return tools;
    const actions = this.taskActionDefinitions(ctx).filter(t => jevRequiredActionTools.has(t.function.name));
    // Only hidden operations need embedded schemas. Repeating every directly
    // exposed integration doubled production tool context and buried delegation.
    return tools.filter((t) => !jevRequiredActionTools.has(normalizeTool(t.function.name, {}).name))
      .map((t) => t.function.name === "mcp__agent__run_jev_task" ? {
        ...t, function: {
          ...t.function,
          description: t.function.description + "\nRequired action schemas (use these names inside actions only; other eligible candidates use their directly exposed schemas):\n" + JSON.stringify(actions.map((a) => ({
            name: a.function.name, description: a.function.description, parameters: a.function.parameters,
          }))),
        },
      } : t);
  }
  jevTaskMode(ctx: Context): boolean {
    const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
    // Multi-Agent parallelizes through role workers; a Jev decision before
    // every root operation serialized exactly the work it is meant to speed up.
    return ctx.depth === 0 && this.runtime.config.toolsEnabled &&
      settings.jev_task_enabled && !(
        this.runtime.config.subagentEnabled && subagentMode(settings) === "multi"
      );
  }
  private taskActionDefinitions(ctx: Context): ToolDef[] {
    // Derive candidates from the parent's live tool surface, not a second
    // permission list that drifts as integrations are added. Canonical base
    // schemas take precedence over harness aliases with different arguments.
    const base = this.base(ctx);
    const actions = new Map<string, ToolDef>();
    for (const tool of [...base, ...harnessTools(base, this.sandbox.available)]) {
      const name = normalizeTool(tool.function.name, {}).name;
      // Coordination stays with the chat agent under the Codex mode policy.
      // Gating spawn/wait on Jev delays workers and can consume a whole plan
      // budget waiting for a mailbox. Recursive Jev also risks semaphore deadlock.
      if (name === "run_jev" || name === "run_jev_task" ||
          (name.startsWith("agents__") && collaborationNames.has(name.slice(8))) || actions.has(name)) continue;
      actions.set(name, { ...tool, function: { ...tool.function, name } });
    }
    return [...actions.values()];
  }
  async execute(
    rawName: string,
    rawArgs: Json,
    ctx: Context,
  ): Promise<unknown> {
    if (
      this.runtime.snapshot.blocked_users.includes(ctx.userId) ||
      this.runtime.guild(ctx.guildId).bot_disabled
    )
      throw new Error("Bot access disabled");
    const { name, args: a } = normalizeTool(rawName, rawArgs);
    // Checked after normalization so use_tool wrappers and aliases cannot
    // reach a tool that the role's tool list does not expose.
    if (!roleAllowsTool(ctx.agentRole, name))
      throw new Error(`The ${ctx.agentRole} role cannot use ${name}; report what is needed to the orchestrator instead`);
    if (ctx.workflowAgent && !workflowAgentAllowsTool(name))
      throw new Error(`Workflow agents cannot use ${name}; return what is needed to the script instead`);
    const selected = this.jevActions.get(ctx);
    this.jevActions.delete(ctx);
    if (this.jevTaskMode(ctx) && jevRequiredActionTools.has(name) &&
        !(selected?.name === name && JSON.stringify(selected.args) === JSON.stringify(a)))
      throw new Error("Jev action-selection mode requires run_jev_task; submit an objective and candidate actions instead of executing directly");
    const validator = this.validators.get(name);
    const workflowTool = name === WORKFLOW_TOOL || name === TASK_STOP_TOOL;
    if (workflowTool ? !this.workflowAvailable(ctx)
      : validator && !this.base(ctx).some((t) => t.function.name === name) &&
        !harnessTools(this.base(ctx), this.sandbox.available).some((t) => t.function.name === name))
      throw new Error("Tool disabled for this context");
    if (validator && !validator(a))
      throw new Error(
        `Invalid arguments for ${name}: ${validator.errors?.map((e) => e.message).join("; ")}`,
      );
    if (sandboxNames.has(name) && !this.sandbox.available)
      throw new Error("Sandbox unavailable");
    const finishHomeWork =
      name === "home_vpn_status" ? () => {} : this.media.beginHomeWork(ctx);
    try {
      return await this.runTool(name, a, ctx);
    } finally {
      finishHomeWork();
    }
  }
  private async runTool(name: string, a: Json, ctx: Context): Promise<unknown> {
    if (name === "image_generation_status") return this.image.status(ctx);
    if (name === "edit_image") return this.image.edit(a, ctx);
    if (name === "generate_image") return this.image.generate(a, ctx);
    if (/^home_vpn_/.test(name)) {
      if (ctx.depth > 0 || this.runtime.role(ctx.userId) !== "administrator") throw new Error("Administrator task required");
      return this.media.homeCommand(name, ctx);
    }
    if (/^vpn_/.test(name)) {
      if (this.runtime.role(ctx.userId) !== "administrator")
        throw new Error("Administrator required");
      return this.vpn.execute(name, a, ctx);
    }
    if (name === "gh_login" || name === "gh_logout" || name === "gh_status") {
      if (ctx.guildId) {
        const member = await this.client.guilds
          .fetch(ctx.guildId)
          .then((g) => g.members.fetch(ctx.userId));
        if (!member.permissions.has("ManageGuild"))
          throw new Error("Manage Server permission required");
      }
      return this.media.github(name, ctx);
    }
    if (name === "run_jev" || name === "run_jev_task") {
      // Parse and validate every candidate before notifying or executing any
      // action. The evaluator may select a prepared action, never invent one.
      const task = name === "run_jev_task" ? jevTaskSchema.parse(a) : null;
      const input = task ? null : jevInputSchema.parse(a);
      const validateAction = (tool: string, args: Json) => {
        const normalized = normalizeTool(tool, args);
        const definition = this.taskActionDefinitions(ctx).find((t) => t.function.name === normalized.name);
        if (!definition)
          throw new Error(`Jev task tool unavailable: ${normalized.name}`);
        const validate = new Ajv({ strict: false, allowUnionTypes: true }).compile(definition.function.parameters);
        if (!validate(normalized.args))
          throw new Error(`Invalid Jev action arguments: ${normalized.name}`);
        return normalized;
      };
      if (task)
        for (const action of task.actions) {
          const normalized = validateAction(action.tool, action.arguments);
          action.tool = normalized.name;
          action.arguments = normalized.args;
        }
      const assertEnabled = () => {
        if (
          this.runtime.snapshot.blocked_users.includes(ctx.userId) ||
          this.runtime.guild(ctx.guildId).bot_disabled ||
          !this.base(ctx).some((t) => t.function.name === name)
        ) throw new Error("Jev is disabled for this context");
      };
      return this.subagents.run(async () => {
        ctx.signal?.throwIfAborted();
        // Recheck after queueing: disabling Jev must also stop waiting calls.
        assertEnabled();
        if (task) {
          if (!ctx.jevTaskProgress && !ctx.notify)
            throw new Error("Jev requires a Discord notification channel");
          // One editable message per turn. Replans and each selected action
          // update it; parent progress edits a different message.
          return runJevTask(task, {
            context: ctx,
            log: this.log,
            decide: this.jev.decide.bind(this.jev),
            assertEnabled,
            report: ctx.jevTaskProgress,
            execute: async (tool, args, actionCtx) => {
              actionCtx.signal?.throwIfAborted();
              assertEnabled();
              validateAction(tool, args);
              this.jevActions.set(actionCtx, { name: tool, args });
              try { return await this.execute(tool, args, actionCtx); }
              finally { this.jevActions.delete(actionCtx); }
            },
          });
        }
        if (!ctx.notify)
          throw new Error("Jev requires a Discord notification channel");
        // Persistent evaluation notices survive parent progress edits.
        const executions = ctx.jevExecutions ??= { count: 0 };
        await ctx.notify(`${JEV_NOTICE_HEADER}(${++executions.count}回目)`);
        const result = await this.jev.decide(input!, ctx.signal);
        ctx.recordToolUsage?.(result.usage);
        return result;
      });
    }
    if (name === WORKFLOW_TOOL || name === TASK_STOP_TOOL) {
      if (!ctx.team) throw new Error("No active multi-agent session");
      return name === WORKFLOW_TOOL ? ctx.team.launchWorkflow(a, ctx) : ctx.team.stopTask(a, ctx);
    }
    if (name.startsWith("agents__") && collaborationNames.has(name.slice(8))) {
      if (!this.runtime.config.subagentEnabled ||
          !this.runtime.resolve(ctx.guildId, ctx.userId).subagent_enabled || !ctx.team)
        throw new Error("No active multi-agent session");
      // Log control flow without task names, messages or tool arguments so
      // production can distinguish absent delegation from hidden progress edits.
      const started = performance.now();
      const fields = { operation_id: crypto.randomUUID(), channel: ctx.channelId,
        message_id: ctx.messageId, tool: name, agent_depth: ctx.depth,
        ultra_mode: this.runtime.resolve(ctx.guildId, ctx.userId).ultra_mode,
        multi_agent: this.runtime.resolve(ctx.guildId, ctx.userId).multi_agent,
        agent_role: ctx.agentRole ?? null };
      this.log?.info(fields, "Agent collaboration started");
      let ok = false;
      try {
        const result = await ctx.team.execute(name.slice(8), a, ctx);
        ok = true;
        return result;
      } finally {
        this.log?.info({ ...fields, ok, elapsed_ms: Math.round(performance.now() - started) }, "Agent collaboration finished");
      }
    }
    if (
      name === "tool_search" ||
      name === "ToolSearch" ||
      name === "search_tool"
    ) {
      const words = String(a.query ?? "")
        .replace(/^select:/, "")
        .toLowerCase()
        .split(/[\s,+]+/)
        .filter(Boolean);
      const list = this.tools(ctx).map((t) => ({
        tool: t,
        score: words.reduce(
          (n, w) =>
            n + (JSON.stringify(t.function).toLowerCase().includes(w) ? 1 : 0),
          0,
        ),
      }));
      return {
        tools: list
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(20, Number(a.limit ?? a.max_results ?? 8)))
          .map((x) => x.tool),
      };
    }
    if (
      ["request_user_input", "UserAskQuestion", "AskUserQuestion", "ask_user_question"].includes(
        name,
      )
    )
      return this.ask(a, ctx);
    if (["update_plan", "todo_write", "TodoWrite"].includes(name))
      return { ok: true, plan: a.plan ?? a.todos };
    if (name === "apply_patch")
      return applyPatch(this.sandbox, ctx, String(a.patch));
    if (name === "web_fetch") return this.web.fetch(String(a.url), ctx);
    if (name === "view_image" || name === "Read") {
      const path = String(a.path ?? a.file_path);
      const full = await this.sandbox.path(ctx, path);
      if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
        if ((await lstat(full)).size > 8 * 1024 * 1024)
          throw new Error("Image too large");
        const data = await readFile(full);
        (ctx.pendingImages ??= []).push(
          `data:${Bun.file(full).type};base64,${data.toString("base64")}`,
        );
        return { ok: true, image_attached: true };
      }
      const content = (
          await this.sandbox.read(ctx, path, 0, 80000)
        ).content.split("\n"),
        offset = Math.max(0, Number(a.offset ?? 1) - 1);
      return {
        content: content
          .slice(offset, offset + Math.min(2000, Number(a.limit ?? 2000)))
          .map((l, i) => `${offset + i + 1}\t${l}`)
          .join("\n"),
      };
    }
    if (name === "Glob") {
      const root = await this.sandbox.path(ctx, String(a.path ?? "."), true);
      const glob = new Bun.Glob(String(a.pattern));
      const files = await filesUnder(root, 10000);
      return {
        files: files
          .filter((f) => glob.match(f.path))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 200)
          .map((f) => f.path),
      };
    }
    if (name === "Grep")
      return this.grep(
        { ...a, case_insensitive: a["-i"], max_matches: a.head_limit ?? 100 },
        ctx,
      );
    if (/^mcp_/.test(name)) return this.web.remote(name, a, ctx);
    if (
      ["websearch", "web_fetch_exa", "web_search_advanced_exa"].includes(name)
    )
      return this.web.search(name, a, ctx);
    if (/skill/.test(name)) {
      if (!this.runtime.config.skillsEnabled)
        throw new Error("Skills disabled");
      const workflowSkill = workflowsEnabled(this.runtime.config, this.runtime.resolve(ctx.guildId, ctx.userId));
      if (a.name === WORKFLOW_AUTHORING_SKILL && (name === "use_skill" || name === "read_skill_file")) {
        if (!workflowSkill) throw new Error("Skill not found or disabled");
        if (name === "read_skill_file") throw new Error(`${WORKFLOW_AUTHORING_SKILL} has no supporting files`);
        await ctx.progress?.(`Skill: ${WORKFLOW_AUTHORING_SKILL}`);
        return { name: WORKFLOW_AUTHORING_SKILL, description: WORKFLOW_AUTHORING_DESCRIPTION, content: this.workflowReference(ctx), files: [] };
      }
      if (name === "list_skills" && workflowSkill)
        return [...(await this.skills.execute(name, a, ctx) as Json[]),
          { name: WORKFLOW_AUTHORING_SKILL, description: WORKFLOW_AUTHORING_DESCRIPTION, builtin: true, enabled: true }];
      if (name === "import_skill") {
        const guild = await this.client.guilds.fetch(String(a.source_guild_id));
        await guild.members.fetch(ctx.userId);
      }
      const result = await this.skills.execute(name, a, ctx);
      if (name === "use_skill" && this.sandbox.available)
        await this.skills.materialize(ctx, await this.sandbox.root(ctx));
      return result;
    }
    if (name === "publish_site")
      return this.sites.publish(
        ctx,
        String(a.path),
        a.token as string | undefined,
      );
    if (name === "list_sites") return this.sites.list(ctx);
    if (name === "unpublish_site" || name === "extend_site")
      return this.sites.mutate(
        ctx,
        String(a.token),
        name === "unpublish_site" ? "delete" : String(a.mode),
      );
    if (name === "get_bot_settings")
      return {
        ...this.runtime.resolve(ctx.guildId, ctx.userId),
        available_presets: this.runtime.available(),
      };
    if (name === "get_user_context")
      return this.runtime.resolve(ctx.guildId, ctx.userId).context;
    if (name === "set_user_context") {
      const current = this.runtime.resolve(ctx.guildId, ctx.userId).context;
      await this.runtime.setContext(ctx.guildId, ctx.userId, {
        text:
          a.mode === "append"
            ? [current?.text, String(a.text ?? "")].filter(Boolean).join("\n\n")
            : (a.text as string | undefined),
        persona_override: a.persona_override as boolean | undefined,
        clear: a.clear as boolean | undefined,
      });
      return { ok: true };
    }
    if (name === "get_triggers")
      return {
        words: triggerWords(
          this.runtime.guild(ctx.guildId),
          this.runtime.config.extraTriggers,
        ),
      };
    if (
      ["set_bot_model", "set_thread_history", "set_triggers"].includes(name)
    ) {
      if (!ctx.guildId) throw new Error("Settings changes require a guild");
      let patch: Json = {};
      if (name === "set_bot_model") {
        const preset =
          a.preset ??
          MODEL_PRESETS.find(
            (p) => p.model === a.model && p.provider === a.provider,
          )?.id;
        if (!a.reset && !preset && (a.preset || a.model || a.provider)) throw new Error("Unknown preset");
        patch = a.reset ? { preset: "reset", ultra_mode: null, multi_agent: null } : {
          ...(preset ? { preset } : {}),
          ...(a.ultra_mode === undefined ? {} : { ultra_mode: a.ultra_mode }),
          ...(a.multi_agent === undefined ? {} : { multi_agent: a.multi_agent }),
          ...(a.effort === undefined
            ? {}
            : { effort: a.effort === "default" ? null : a.effort }),
        };
      }
      if (name === "set_thread_history")
        patch = {
          thread_history_max_age_secs: a.reset
            ? null
            : Number(a.seconds ?? Number(a.hours) * 3600),
        };
      if (name === "set_triggers") {
        const guild = this.runtime.guild(ctx.guildId);
        const words = (value: unknown) =>
          (Array.isArray(value)
            ? value
            : typeof value === "string"
              ? value.split(",")
              : []
          ).map((w) => triggerWordSchema.parse(w));
        let extra =
            a.extra === undefined
              ? [...(guild.extra_triggers ?? this.runtime.config.extraTriggers)]
              : words(a.extra),
          disabled = [...guild.disabled_triggers];
        for (const w of words(a.add)) {
          if (canonicalBuiltin(w))
            disabled = disabled.filter((d) => !triggerNamesEqual(d, w));
          else if (!extra.some((e) => triggerNamesEqual(e, w))) extra.push(w);
        }
        for (const w of words(a.remove)) {
          extra = extra.filter((e) => !triggerNamesEqual(e, w));
          const builtin = canonicalBuiltin(w);
          if (builtin && !disabled.includes(builtin)) disabled.push(builtin);
        }
        patch = a.reset
          ? { extra_triggers: null, disabled_triggers: [] }
          : { extra_triggers: extra, disabled_triggers: disabled };
      }
      return this.runtime.patch(ctx.guildId, patch, ctx.userId);
    }
    switch (name) {
      case "bash":
        return this.sandbox.locked(ctx, () =>
          this.sandbox.run(
            ctx,
            String(a.command),
            Number(a.timeout_secs ?? 120),
            String(a.workdir ?? "/workspace"),
            this.media.homeRoute(ctx),
          ),
        );
      case "read_file":
        return this.sandbox.read(
          ctx,
          String(a.path),
          Number(a.offset ?? 0),
          Number(a.limit ?? 40000),
        );
      case "list_files":
        return this.sandbox.list(ctx, String(a.path ?? "."));
      case "write_file":
        if (
          a.overwrite === false &&
          (await Bun.file(
            await this.sandbox.path(ctx, String(a.path)),
          ).exists())
        )
          throw new Error("File exists");
        return this.sandbox.write(ctx, String(a.path), String(a.content));
      case "write_files": {
        const results: unknown[] = [];
        for (const f of a.files as Json[]) {
          // Decompose the selected batch while preserving the usual access,
          // schema and overwrite checks for every file, including revocations.
          ctx.signal?.throwIfAborted();
          const args = { ...f, overwrite: a.overwrite };
          this.jevActions.set(ctx, { name: "write_file", args });
          try { results.push(await this.execute("write_file", args, ctx)); }
          finally { this.jevActions.delete(ctx); }
        }
        return { ok: true, files: results };
      }
      case "edit_file":
        return this.sandbox.edit(
          ctx,
          String(a.path),
          String(a.old_str),
          String(a.new_str),
          Boolean(a.replace_all),
        );
      case "grep_files":
        return this.grep(a, ctx);
      case "send_file":
        return this.discord.sendFile(ctx, a);
      case "download_file":
        return this.download(a, ctx);
      case "download_attachment": {
        const message = (await this.discord.execute(
          "get_message",
          {
            channel_id: a.channel_id,
            message_id: a.message_id ?? ctx.messageId,
          },
          ctx,
        )) as { attachments: Json[] };
        const attachment = a.attachment_id
          ? message.attachments.find((x) => x.id === a.attachment_id)
          : a.filename
            ? message.attachments.find(
                (x) =>
                  String(x.filename).toLowerCase() ===
                  String(a.filename).toLowerCase(),
              )
            : message.attachments[Number(a.index ?? 0)];
        if (!attachment) throw new Error("Attachment not found");
        // Discord CDN stays on the VPS. Home lanes are for blocked public sites.
        return this.download(
          {
            url: attachment.url,
            path: a.path ?? attachment.filename,
            overwrite: a.overwrite,
          },
          ctx,
          false,
        );
      }
      case "download_media": {
        const url = new URL(String(a.url));
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error("Invalid media URL");
        const path = String(a.path);
        await this.sandbox.path(ctx, path);
        const flags =
          a.format === "audio"
            ? "-x --audio-format mp3"
            : a.format === "small"
              ? '-f "bv*[height<=480]+ba/b[height<=480]"'
              : '-f "bv*+ba/b"';
        return this.sandbox.run(
          ctx,
          `yt-dlp --no-playlist --max-filesize 100M ${flags} -o ${quote(path)} -- ${quote(url.href)}`,
          Number(a.timeout_secs ?? 180),
          "/workspace",
          this.media.homeRoute(ctx),
        );
      }
      case "playwright_cli":
        return this.media.browserCommand(ctx, a);
      case "video_edit":
        return this.media.video(ctx, a);
      default:
        return this.discord.execute(name, a, ctx);
    }
  }
  private async download(a: Json, ctx: Context, viaHome = true) {
    const path = await this.sandbox.path(ctx, String(a.path));
    if (a.overwrite === false && (await Bun.file(path).exists()))
      throw new Error("File exists");
    const response = await downloadPublic(
      String(a.url),
      ctx.signal,
      32 * 1024 * 1024,
      viaHome ? this.media.homeEgress(ctx) : undefined,
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    await this.sandbox.quota(await this.sandbox.root(ctx), bytes.length);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    return { ok: true, path: a.path, bytes: bytes.length };
  }
  private async grep(a: Json, ctx: Context) {
    // Run regex evaluation under the container timeout; pathological expressions cannot block the bot event loop.
    const root = String(a.path ?? ".");
    await this.sandbox.path(ctx, root, true);
    const flags = [
      "--json",
      ...(a.case_insensitive ? ["-i"] : []),
      ...(a.multiline ? ["-U"] : []),
      ...(a.glob ? ["--glob", String(a.glob)] : []),
      ...(a.type ? ["--type", String(a.type)] : []),
      "-e",
      String(a.pattern),
      "--",
      root,
    ];
    const result = await this.sandbox.run(
      ctx,
      `rg ${flags.map(quote).join(" ")}`,
      20,
    );
    if (result.exit_code > 1) throw new Error(result.stderr);
    const matches = result.stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const e = JSON.parse(line);
          return e.type === "match" ? [e.data] : [];
        } catch {
          return [];
        }
      })
      .slice(0, Math.min(200, Number(a.max_matches ?? 40)));
    return a.output_mode === "files_with_matches"
      ? { files: [...new Set(matches.map((m) => m.path.text))] }
      : a.output_mode === "count"
        ? { count: matches.length }
        : { matches };
  }
  private async ask(a: Json, ctx: Context) {
    if (!this.runtime.config.toolsEnabled || ctx.depth > 0)
      throw new Error("User questions require an enabled root task");
    const input = questionsSchema.parse(a);
    const channel = await this.discord.authorizeChannel(ctx, ctx.channelId);
    if (!channel.isSendable()) throw new Error("Cannot ask in this channel");
    const key = `${ctx.channelId}/${ctx.userId}`;
    if (this.waiting.has(key)) throw new Error("A question is already pending");
    this.waiting.add(key);
    try {
      return await askQuestions(this.client, channel, input, ctx);
    } finally {
      this.waiting.delete(key);
    }
  }
  async close() {
    clearInterval(this.maintenance);
    await this.media.close();
    await this.sandbox.close();
    this.sites.stop();
  }
}
