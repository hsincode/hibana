import { StopHookExhaustedError } from "./stop-hook";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  Routes,
  type Message as DiscordMessage,
  type SendableChannels,
} from "discord.js";
import { join } from "node:path";
import type { Logger } from "pino";
import { MODEL_PRESETS } from "@hibana/shared/catalog";
import type { Config, Selection } from "./config";
import { Runtime } from "./runtime";
import { LlmClient, nativeSearchFor } from "./llm";
import { providerFailureNotice, ProviderError } from "./llm-errors";
import { checkpointSnapshot, checkpointInScope, resumeCheckpoint, type Checkpoint } from "./checkpoint";
import { Agent, type AgentOptions } from "./agent";
import { MultiAgentSession } from "./multi-agent";
import { History } from "./history";
import { ToolRegistry } from "./tools";
import { WebSync } from "./sync";
import { Voice } from "./voice";
import { commands, handleCommand } from "./commands";
import { imagePrompt, shouldRespond, splitMessage } from "./triggers";
import { assemblePrompt } from "./harness";
import { atomicJson, readJson, Serial } from "./io";
import {
  classifyFailure,
  httpStatusOf,
  type FailureCode,
  type FailurePhase,
} from "./failure";
import { addUsage, emptyUsage, type Context, type Message, type Usage } from "./types";
import { isAutoRoute, routeFallback, routeHeader, RouteMemory } from "./auto-route";
import {
  hasUltracodeKeyword,
  systemReminder,
  turnSelection,
  ULTRACODE_ENTER_FULL,
  ultracodeReminder,
  workflowKeywordReminder,
  workflowsEnabled,
} from "./ultracode";
import { workflowAuthoringAutoload } from "./workflow/prompts";
function imageFailureNotice(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/offline|stopped|timed out/i.test(message))
    return "画像生成PCがオフラインか、サービスが停止しています。";
  if (/busy/i.test(message))
    return "画像生成PCが使用中です。しばらくしてからもう一度送ってください。";
  if (/cancelled/i.test(message)) return "画像生成を中断しました。";
  if (/quota/i.test(message)) return "作業領域の容量上限に達しました。";
  return "画像を生成できませんでした。";
}
type Active = {
  userId: string;
  accepting: boolean;
  pending: Message[];
  request: AbortController;
  /** The running turn, so a steering message can opt it into workflows. */
  ctx: Context;
  /** The workflow-authoring reference is already in this conversation. */
  referenceLoaded: boolean;
};
type FailureReport = {
  failure_code: FailureCode;
  failure_phase: FailurePhase;
  http_status: number | null;
  has_checkpoint: boolean;
};
export class Hibana {
  readonly client: Client;
  readonly runtime: Runtime;
  readonly llm: LlmClient;
  readonly agent: Agent;
  readonly history: History;
  routes = new RouteMemory();
  readonly tools: ToolRegistry;
  readonly sync: WebSync;
  readonly voice: Voice;
  private active = new Map<string, Active>();
  /** Steering prompts that carried the "ultracode" keyword. */
  private keywordPrompts = new WeakSet<Message>();
  private queues = new Map<string, Serial>();
  private shutdown = new AbortController();
  private checkpoints: Record<string, Checkpoint> = {};
  private checkpointSerial = new Serial();
  private tasks = new Set<Promise<unknown>>();
  private checkpointPath: string;
  constructor(
    readonly config: Config,
    private log: Logger,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        ...(config.voiceEnabled ? [GatewayIntentBits.GuildVoiceStates] : []),
      ],
      partials: [Partials.Channel],
    });
    this.runtime = new Runtime(config);
    this.llm = new LlmClient(config, fetch, {
      onRetry: notice => this.log.warn(notice, "LLM reconnecting"),
      onCompletion: record => this.log.info(record, "LLM request completed"),
    });
    this.agent = new Agent(this.llm);
    this.history = new History(config);
    this.tools = new ToolRegistry(this.runtime, this.client, this.agent, this.log);
    this.sync = new WebSync(this.runtime, this.tools, (e) => this.report(e));
    this.voice = new Voice(
      this.runtime,
      this.tools,
      this.client,
      (text, ctx) => this.respond(text, ctx),
      (e) => this.report(e),
    );
    this.runtime.onChange = (id) => this.history.clearGuild(id);
    this.checkpointPath = join(config.dataDir, "retry_checkpoints.json");
  }
  private report(error: unknown, failure?: FailureReport) {
    this.log.error(
      {
        error: error instanceof Error ? error.message : String(error),
        provider_diagnostics: error instanceof ProviderError ? error.diagnostics : undefined,
        ...failure,
      },
      "Hibana operation failed",
    );
  }
  private track(p: Promise<unknown>) {
    this.tasks.add(p);
    void p.catch((e) => this.report(e)).finally(() => this.tasks.delete(p));
  }
  async start() {
    if (!this.config.token) throw new Error("DISCORD_TOKEN is required");
    if (!this.config.endpoints[this.config.selection.provider]?.apiKey)
      throw new Error(`API key missing for ${this.config.selection.provider}`);
    await this.runtime.load();
    await this.tools.load();
    await this.sync.start();
    this.checkpoints = await readJson(this.checkpointPath, {});
    this.client.on(Events.Error, (e) => this.report(e));
    this.client.on(Events.GuildCreate, (guild) => this.track(this.runtime.initializeGuild(guild.id)));
    this.client.on(Events.MessageCreate, (m) => this.track(this.onMessage(m)));
    this.client.on(Events.InteractionCreate, (i) => {
      if (i.isAutocomplete()) {
        const query = String(i.options.getFocused()).toLowerCase();
        this.track(
          i.respond(
            MODEL_PRESETS.filter(
              (p) =>
                this.runtime.canSelect(p.id, i.user.id) &&
                (p.id.toLowerCase().includes(query) ||
                  p.label.toLowerCase().includes(query)),
            )
              .slice(0, 24)
              .map<{ name: string; value: string }>((p) => ({
                name: p.label,
                value: p.id,
              }))
              .concat([{ name: "環境変数の既定に戻す", value: "reset" }]),
          ),
        );
      } else if (i.isChatInputCommand())
        this.track(
          handleCommand(
            i,
            this.runtime,
            this.tools,
            this.history,
            this.voice,
            (ctx) => this.retry(ctx),
          ),
        );
    });
    const cleanup = (channel: { id: string; isThread?: () => boolean }) => {
      this.history.clear(channel.id);
      if (channel.isThread?.())
        this.track(this.tools.sandbox.removeThread(channel.id));
    };
    this.client.on(Events.ChannelDelete, cleanup);
    this.client.on(Events.ThreadDelete, cleanup);
    this.client.once(Events.ClientReady, () => this.track(this.ready()));
    await this.client.login(this.config.token);
  }
  private async ready() {
    for (const id of this.client.guilds.cache.keys()) await this.runtime.initializeGuild(id);
    const applicationId = this.client.application!.id;
    await this.client.rest.put(
      this.config.commandGuildId
        ? Routes.applicationGuildCommands(
            applicationId,
            this.config.commandGuildId,
          )
        : Routes.applicationCommands(applicationId),
      { body: commands(this.runtime) },
    );
    this.log.info(
      { bot: this.client.user?.tag, sandbox: this.tools.sandbox.available },
      "Hibana ready",
    );
    for (const cp of Object.values(this.checkpoints)) {
      if (Date.now() - cp.at > 7200000) continue;
      const ctx = { ...cp.ctx, botId: this.client.user!.id };
      this.track(this.retry(ctx));
    }
  }
  private async onMessage(m: DiscordMessage) {
    if (this.shutdown.signal.aborted || !this.client.user) return;
    const key = `${m.channelId}/${m.author.id}`;
    if (this.tools.waiting.has(key)) return;
    if (this.runtime.snapshot.blocked_users.includes(m.author.id)) return;
    const thread = m.channel.isThread();
    const guild = this.runtime.guild(m.guildId ?? undefined);
    if (
      !shouldRespond(
        {
          content: m.content,
          bot: m.author.bot,
          pinned: m.pinned,
          system: m.system,
          mention: m.mentions.users.has(this.client.user.id),
          dm: !m.guildId,
          thread,
          title: thread ? m.channel.name : undefined,
          forumTitle:
            thread && m.channel.parent?.type === 15
              ? m.channel.parent.name
              : undefined,
        },
        guild,
        this.config.extraTriggers,
      )
    )
      return;
    // `/image ` on a message that already triggers Hibana skips the model.
    // Checked before steering so it does not abort an in-progress turn and
    // hand the prompt to the agent. Attachments are ignored: edits stay on
    // the conversation path, where the user can reply to an image.
    const prompt = imagePrompt(m.content, this.client.user.id);
    if (prompt !== null) {
      const ctx: Context = {
        guildId: m.guildId ?? undefined,
        channelId: m.channelId,
        userId: m.author.id,
        botId: this.client.user.id,
        thread,
        messageId: m.id,
        depth: 0,
        delivered: false,
      };
      await this.queue(m.channelId).run(() =>
        this.postDirectImage(prompt, ctx, m.id),
      );
      return;
    }
    const attachments = [...m.attachments.values()];
    if (m.reference?.messageId) {
      try {
        const referenced = await m.fetchReference();
        attachments.push(...referenced.attachments.values());
      } catch {}
    }
    const images = attachments
      .filter((a) => a.contentType?.startsWith("image/"))
      .slice(0, 4)
      .map((a) => a.url);
    const text = `${m.content}\n\n[author: ${m.member?.displayName ?? m.author.displayName}; user_id: ${m.author.id}; channel_id: ${m.channelId}; message_id: ${m.id}]${attachments.length ? "\nAttachments: " + attachments.map((a) => JSON.stringify({ id: a.id, filename: a.name, url: a.url, bytes: a.size })).join("\n") : ""}`;
    // Claude Code honours "ultracode" only in a prompt a person typed. Bot
    // authors never reach here, and voice transcripts do not use this path.
    const keyword = this.config.ultracodeKeywordTrigger && hasUltracodeKeyword(m.content) &&
      workflowsEnabled(this.config, this.runtime.resolve(m.guildId ?? undefined, m.author.id));
    const current = this.active.get(m.channelId);
    if (current?.accepting && current.userId === m.author.id) {
      const prompt: Message = { role: "user", content: text, images, turnStart: true };
      if (keyword) {
        this.keywordPrompts.add(prompt);
        current.ctx.workflowKeyword = true;
      }
      current.pending.push(prompt);
      current.request.abort(new Error("User steering"));
      return;
    }
    const ctx: Context = {
      guildId: m.guildId ?? undefined,
      channelId: m.channelId,
      userId: m.author.id,
      botId: this.client.user.id,
      thread,
      messageId: m.id,
      images,
      depth: 0,
      delivered: false,
      ...(keyword ? { workflowKeyword: true } : {}),
    };
    await this.respond(text, ctx);
  }
  private async postDirectImage(prompt: string, ctx: Context, replyTo: string) {
    if (
      this.shutdown.signal.aborted ||
      this.runtime.snapshot.blocked_users.includes(ctx.userId) ||
      this.runtime.guild(ctx.guildId).bot_disabled
    )
      return;
    const channel = await this.tools.discord.authorizeChannel(ctx, ctx.channelId);
    if (!channel.isSendable()) throw new Error("Channel is not sendable");
    const suppress = this.runtime.resolve(ctx.guildId, ctx.userId).suppress_embeds
      ? 4
      : undefined;
    const reply = (content: string) =>
      channel.send({
        content,
        allowedMentions: { parse: [], repliedUser: false },
        reply: { messageReference: replyTo, failIfNotExists: false },
        flags: suppress,
      });
    if (!prompt) {
      await reply("画像の説明を `/image ` のあとに書いてください。");
      return;
    }
    // Same cap and availability as generate_image. The shortcut skips the
    // model, not the worker, the workspace, or the length limit.
    if (prompt.length > 8000) {
      await reply("プロンプトは8000文字までです。");
      return;
    }
    if (
      !this.config.toolsEnabled ||
      !this.config.imageWorkerUrl ||
      !this.tools.sandbox.available
    ) {
      await reply("画像生成はいま使えません。");
      return;
    }
    ctx.signal = this.shutdown.signal;
    const typing = () => {
      if ("sendTyping" in channel) void channel.sendTyping().catch(() => {});
    };
    typing();
    const timer = setInterval(typing, 8000);
    const started = Date.now();
    let generated = false;
    try {
      const result = await this.tools.image.generate({ prompt }, ctx);
      generated = true;
      await this.tools.discord.sendFile(ctx, { path: result.path }, replyTo);
      const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
      // History.put overwrites the channel usage figure. This path spent no
      // tokens, so keep the previous figure instead of storing zeros.
      this.history.get(
        ctx.channelId,
        ctx.guildId,
        JSON.stringify(settings.selection),
        ctx.thread,
        settings.thread_history_max_age_secs ?? this.config.threadHistoryAge,
      );
      const usage = this.history.info(ctx.channelId).usage ?? emptyUsage();
      this.history.put(
        ctx.channelId,
        [
          { role: "user", content: `/image ${prompt}`, turnStart: true },
          { role: "assistant", content: `画像を送信しました: ${result.path}` },
        ],
        usage,
      );
      this.log.info(
        {
          channel: ctx.channelId,
          bytes: result.bytes,
          latency_ms: Date.now() - started,
        },
        "Direct image completed",
      );
    } catch (error) {
      if (this.shutdown.signal.aborted) return;
      this.report(error);
      await reply(
        generated
          ? "画像は作れましたが、送信できませんでした。"
          : imageFailureNotice(error),
      );
    } finally {
      clearInterval(timer);
    }
  }
  /** Claude Code autoloads the workflow-authoring skill on a keyword turn
   *  or with the full Ultracode reminder, unless the conversation already
   *  holds it. Without a skill tool the Workflow description embeds it. */
  private authoringReference(ctx: Context, state: Active, messages: Message[] = []): Message[] {
    if (!this.tools.workflowSkillAvailable()) return [];
    const content = workflowAuthoringAutoload(this.tools.workflowReference(ctx));
    if (state.referenceLoaded || messages.some((m) => m.content === content)) return [];
    state.referenceLoaded = true;
    return [{ role: "user", internal: true, content }];
  }
  private queue(channelId: string) {
    let q = this.queues.get(channelId);
    if (!q) {
      q = new Serial();
      this.queues.set(channelId, q);
    }
    return q;
  }
  async respond(text: string, ctx: Context): Promise<string> {
    return this.queue(ctx.channelId).run(() => this.turn(ctx, text));
  }
  async retry(ctx: Context) {
    await this.queue(ctx.channelId).run(async () => {
      const checkpoint = this.checkpoints[`${ctx.channelId}/${ctx.userId}`];
      if (!checkpoint || Date.now() - checkpoint.at > 7200000)
        throw new Error("再開できる作業はありません。");
      await this.turn(ctx, undefined, checkpoint);
    });
  }
  private async saveCheckpoint(
    ctx: Context,
    messages: Message[],
    historyStart: number,
    selectionKey: string,
  ) {
    const snapshot = checkpointSnapshot(ctx, messages, historyStart, selectionKey);
    await this.checkpointSerial.run(async () => {
      const next = { ...this.checkpoints, [`${ctx.channelId}/${ctx.userId}`]: snapshot };
      // Persist the detached snapshot before advertising resumable progress.
      await atomicJson(this.checkpointPath, next);
      this.checkpoints = next;
    });
  }
  private async clearCheckpoint(ctx: Context) {
    await this.checkpointSerial.run(async () => {
      const next = { ...this.checkpoints };
      delete next[`${ctx.channelId}/${ctx.userId}`];
      await atomicJson(this.checkpointPath, next);
      this.checkpoints = next;
    });
  }
  private async turn(
    original: Context,
    text?: string,
    retry?: Checkpoint,
  ): Promise<string> {
    if (this.shutdown.signal.aborted)
      throw new Error("Hibana is shutting down");
    const ctx: Context = {
      ...original,
      signal: this.shutdown.signal,
      pendingImages: [] as string[],
    };
    if (
      this.runtime.snapshot.blocked_users.includes(ctx.userId) ||
      this.runtime.guild(ctx.guildId).bot_disabled
    )
      return "";
    const channel = await this.tools.discord.authorizeChannel(
      ctx,
      ctx.channelId,
    );
    if (!channel.isSendable()) throw new Error("Channel is not sendable");
    const send = async (text: string) => {
      for (const chunk of splitMessage(text)) {
        await channel.send({
          content: chunk,
          allowedMentions: { parse: [] },
          flags: this.runtime.resolve(ctx.guildId, ctx.userId).suppress_embeds
            ? 4
            : undefined,
        });
      }
    };
    ctx.notify = send;
    const suppressEmbeds = this.runtime.resolve(ctx.guildId, ctx.userId)
      .suppress_embeds
      ? 4
      : undefined;
    const discordPosts = new Serial();
    const editable = (holder: { message?: DiscordMessage }) =>
      (text: string) =>
        discordPosts.run(async () => {
          const content = text.slice(0, 1900);
          if (holder.message) {
            await holder.message.edit({
              content,
              allowedMentions: { parse: [] },
            });
            return;
          }
          // Serialize the first send so parallel starts do not each post a copy.
          holder.message = await channel.send({
            content,
            allowedMentions: { parse: [] },
            flags: suppressEmbeds,
          });
        });
    ctx.progress = editable({});
    // Jev task status is its own message so parent thinking edits do not erase
    // it, and later run_jev_task calls in this turn edit instead of stacking.
    ctx.jevTaskProgress = editable({});
    // Each workflow run keeps one status message of its own.
    ctx.openStatus = () => editable({});
    ctx.jevExecutions = { count: 0 };
    const state: Active = {
      userId: ctx.userId,
      accepting: true,
      pending: [],
      request: new AbortController(),
      ctx,
      referenceLoaded: false,
    };
    this.active.set(ctx.channelId, state);
    const typing = () => {
      if ("sendTyping" in channel) void channel.sendTyping().catch(() => {});
    };
    typing();
    const timer = setInterval(typing, 8000);
    const settings = this.runtime.resolve(ctx.guildId, ctx.userId);
    // History keeps the stored selection as its key: turning Ultracode on or
    // off changes the effort sent, not the conversation (Claude Code keeps it).
    const key = JSON.stringify(settings.selection);
    const ultracode = settings.ultracode;
    // An auto preset is replaced below, once the history is known.
    let selection = turnSelection(settings.selection, ultracode);
    const started = Date.now();
    this.log.info({ channel: ctx.channelId, message_id: ctx.messageId,
      settings_version: this.runtime.snapshot.version, provider: selection.provider,
      model: selection.model, effort: selection.effort ?? null, subagent_enabled: settings.subagent_enabled,
      ultra_mode: settings.ultra_mode, multi_agent: settings.multi_agent, ultracode,
      workflow_keyword: !!ctx.workflowKeyword, jev_enabled: settings.jev_enabled,
      jev_task_enabled: settings.jev_task_enabled }, "Turn started");
    const releaseWorkspace = this.tools.sandbox.lease(ctx);
    let failurePhase: FailurePhase = "history_read";
    let checkpointPersisted = false;
    try {
      const candidate = retry ?? this.checkpoints[`${ctx.channelId}/${ctx.userId}`];
      const pending = candidate && checkpointInScope(candidate, ctx) && Date.now() - candidate.at < 7200000
        ? candidate : undefined;
      checkpointPersisted = Boolean(pending);
      if (retry && !pending) throw new Error("再開できる作業はありません。");
      if (pending) ctx.delivered = pending.ctx.delivered;
      let prior = this.history.get(
        ctx.channelId,
        ctx.guildId,
        key,
        ctx.thread,
        settings.thread_history_max_age_secs ?? this.config.threadHistoryAge,
      );
      if (ctx.thread && !pending) {
        failurePhase = "history_compaction";
        await this.history.compact(
          ctx.channelId,
          this.llm,
          settings.selection,
          ctx.signal,
        );
        failurePhase = "history_read";
        prior = this.history.get(
          ctx.channelId,
          ctx.guildId,
          key,
          true,
          settings.thread_history_max_age_secs ?? this.config.threadHistoryAge,
        );
      }
      let routeUsage: Usage | undefined;
      let header: string | undefined;
      if (isAutoRoute(settings.selection)) {
        const route = await this.autoRoute(ctx, text, prior, pending);
        routeUsage = route.usage;
        selection = turnSelection(route.selection, ultracode);
        header = routeHeader(selection);
      }
      failurePhase = "prompt_assembly";
      const prefix = await assemblePrompt(
        this.runtime,
        ctx,
        this.config.skillsEnabled ? await this.tools.skillCatalog(ctx) : "",
      );
      const resumed = pending ? resumeCheckpoint(pending, prefix, settings.selection) : undefined;
      const messages: Message[] = resumed?.messages ?? [...prefix, ...prior];
      const seed = resumed?.historyStart ?? messages.length;
      if (text) {
        // Claude Code attaches these system reminders to a typed prompt only
        // while dynamic workflows are on; /retry resumes add none.
        const workflows = workflowsEnabled(this.config, settings);
        const reminder = workflows ? ultracodeReminder(messages, ultracode) : undefined;
        messages.push({ role: "user", content: text, images: ctx.images, turnStart: true });
        if (workflows && ctx.workflowKeyword) messages.push(workflowKeywordReminder());
        if (reminder) messages.push(reminder);
        const full = reminder?.content === systemReminder(ULTRACODE_ENTER_FULL);
        if (workflows && (ctx.workflowKeyword || full)) messages.push(...this.authoringReference(ctx, state, messages));
      }
      failurePhase = "checkpoint_save";
      await this.saveCheckpoint(ctx, messages, seed, key);
      checkpointPersisted = true;
      failurePhase = "agent";
      const options: AgentOptions = {
        selection,
        messages,
        tools: this.tools.tools(ctx),
        getTools: (c) => this.tools.tools(c),
        jevTaskMode: (c) => this.tools.jevTaskMode(c),
        stopHook: input => this.tools.checkCompletion(input),
        context: ctx,
        maxRounds: this.config.maxRounds,
        serviceTier: settings.service_tier,
        temperature: settings.temperature,
        nativeSearch: nativeSearchFor(
          settings.selection,
          settings.exa_mode,
          this.config.webSearch,
        ),
        execute: (name, args, c) => this.tools.execute(name, args, c),
        checkpoint: (messages) => this.saveCheckpoint(ctx, messages, seed, key),
        takeSteering: () => {
          const pending = state.pending.splice(0).flatMap((m) =>
            this.keywordPrompts.has(m)
              ? [m, workflowKeywordReminder(), ...this.authoringReference(ctx, state)]
              : [m]);
          if (state.request.signal.aborted)
            state.request = new AbortController();
          return pending;
        },
        requestSignal: () =>
          AbortSignal.any([this.shutdown.signal, state.request.signal]),
      };
      const result = this.config.toolsEnabled && this.config.subagentEnabled && settings.subagent_enabled
        ? await new MultiAgentSession(this.runtime, this.agent, c => this.tools.tools(c), {
          // A resumed checkpoint continues earlier work; a fresh triage could
          // pre-start an explorer that repeats research already in the history.
          triage: pending ? undefined : (c, m) => this.tools.triage(c, m),
          log: this.log,
          workflows: { journals: this.tools.workflowJournals, files: this.tools.workflowFiles },
        }).runRoot(options)
        : await this.agent.run(options);
      if (routeUsage) addUsage(result.usage, routeUsage);
      // The turn's last request renewed the cache this route is kept for.
      this.routes.touch(ctx.channelId);
      state.accepting = false;
      for (const pending of state.pending.splice(0))
        this.track(
          this.respond(pending.content ?? "", {
            ...original,
            images: pending.images,
            // The keyword opts in the prompt that carried it, not its turn.
            workflowKeyword: this.keywordPrompts.has(pending) || undefined,
          }),
        );
      failurePhase = "discord_send";
      await send(header ? `${header}\n${result.text}` : result.text);
      failurePhase = "history_store";
      this.history.put(
        ctx.channelId,
        result.messages.slice(Math.min(seed, result.messages.length - 1)),
        result.usage,
      );
      failurePhase = "checkpoint_clear";
      await this.clearCheckpoint(ctx);
      checkpointPersisted = false;
      this.log.info(
        {
          channel: ctx.channelId,
          provider: selection.provider,
          model: selection.model,
          usage: result.usage,
          latency_ms: Date.now() - started,
        },
        "Turn completed",
      );
      if (this.config.webApiUrl) {
        this.track(
          this.runtime.remote("/internal/logs", "POST", {
            entries: [
              {
                at: Date.now(),
                guild_id: ctx.guildId ?? null,
                channel_id: ctx.channelId,
                user_id: ctx.userId,
                username: ctx.userId,
                prompt: text ?? "/retry",
                reply: result.text,
                provider: selection.provider,
                model: selection.model,
                error: null,
                failure_phase: null,
                failure_code: null,
                http_status: null,
                has_checkpoint: null,
                latency_ms: Date.now() - started,
              },
            ],
          }),
        );
        this.track(this.sync.publishAssets());
      }
      return result.text;
    } catch (error) {
      if (!this.shutdown.signal.aborted) {
        const failureCode = classifyFailure(error, failurePhase);
        const httpStatus = httpStatusOf(error);
        if (error instanceof ProviderError && error.kind === "context_length") this.history.shrink(ctx.channelId);
        const failureReport: FailureReport = {
          failure_code: failureCode,
          failure_phase: failurePhase,
          http_status: httpStatus,
          has_checkpoint: checkpointPersisted,
        };
        this.report(error, failureReport);
        if (this.config.webApiUrl) {
          this.track(
            this.runtime.remote("/internal/logs", "POST", {
              entries: [
                {
                  at: started,
                  guild_id: ctx.guildId ?? null,
                  channel_id: ctx.channelId,
                  user_id: ctx.userId,
                  username: ctx.userId,
                  prompt: text ?? "/retry",
                  reply: null,
                  provider: selection.provider,
                  model: selection.model,
                  error: failureCode,
                  failure_phase: failurePhase,
                  failure_code: failureCode,
                  http_status: httpStatus,
                  has_checkpoint: checkpointPersisted,
                  latency_ms: Date.now() - started,
                },
              ],
            }),
          );
        }
        state.accepting = false;
        const reason = error instanceof StopHookExhaustedError
          ? "Jev の完了チェックで不足が残ると判定されたため、完了扱いにせず停止しました。"
          : providerFailureNotice(error) ?? "処理に失敗しました。";
        await send(reason + (
          checkpointPersisted
            ? " 進捗を保存しました。`/retry` または次のメッセージで再開できます。"
            : " 設定を確認してもう一度送信してください。"
        ));
      }
      return "";
    } finally {
      // Cleanup is tied to the turn, including cancellation and tool errors;
      // model instructions alone cannot guarantee disconnection after work.
      await this.tools.media.finishHome(ctx).catch(error => this.report(error));
      releaseWorkspace();
      clearInterval(timer);
      this.active.delete(ctx.channelId);
    }
  }
  /** Auto routing (#35). A route Jev chose stays while the conversation and
   *  its prompt cache can still be continued; the fallback is never kept, so
   *  the next turn asks Jev again. */
  private async autoRoute(ctx: Context, text: string | undefined, prior: Message[], pending?: Checkpoint) {
    const carried = prior.length > 0 || Boolean(pending);
    const kept = carried ? this.routes.live(ctx.channelId) : undefined;
    let usage: Usage | undefined;
    let selection = kept;
    let source = "kept";
    if (!selection) {
      const decided = await this.tools.route(ctx, text
        ? [...prior, { role: "user", content: text, images: ctx.images }]
        : pending?.messages ?? prior);
      usage = decided?.usage;
      source = decided ? "jev" : "fallback";
      selection = decided?.selection ?? routeFallback();
      if (decided) this.routes.set(ctx.channelId, selection);
      else this.routes.clear(ctx.channelId);
    }
    this.log.info({ channel: ctx.channelId, message_id: ctx.messageId, source,
      model: selection.model, effort: selection.effort ?? null }, "Auto route selected");
    return { selection, usage };
  }
  async close() {
    this.shutdown.abort(new Error("Shutdown"));
    this.sync.stop();
    this.voice.close();
    await this.tools.close();
    await Promise.allSettled([...this.tasks]);
    await this.runtime.persist();
    this.client.destroy();
  }
}
