import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message as DiscordMessage } from "discord.js";
import pino from "pino";
import { Hibana } from "../bot";
import { resumesAtStart, type Checkpoint } from "../checkpoint";
import { conversationKey } from "../claude/select";
import { handleCommand } from "../commands";
import { loadConfig } from "../config";
import { ConversationStore } from "../conversation-store";
import { promptCacheKey } from "../llm";
import type { Context } from "../types";
import { UsageLedger } from "../usage-ledger";
import { workspaceSystem } from "../workspace/prompt";
import { SessionTable } from "../workspace/sessions";
import type { RawEvent } from "../workspace/types";
import { sessionTotals } from "../workspace/usage";

// Decision record: #76. An Anthropic Workspace turn from `Hibana.respond`
// down to the HTTP requests: which session a channel talks to, what the
// session is created with, what the turn may spend, and what happens to the
// session when the conversation ends. The Managed Agents API is a class in
// this file; no request leaves the process.

const dir = await mkdtemp(join(tmpdir(), "hibana-workspace-turn-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

type Json = Record<string, any>;
type Sent = { method: string; path: string; query: URLSearchParams; body?: Json };
const usd = (amount: number) => ({ amount: String(amount), currency: "USD" });
const rejected = (status: number, type = "not_found_error") =>
  Response.json({ type: "error", error: { type, message: "upstream text" } }, { status });
const said = (text: string): Json => ({ type: "agent.message", content: [{ type: "text", text }] });
const idle = (type = "end_turn", more: Json = {}): Json =>
  ({ type: "session.status_idle", stop_reason: { type, ...more }, stop_details: null });
const running = (): Json => ({ type: "session.status_running" });
const reported = (amount: number): Json => ({ type: "session.usage", usage: { list_cost: usd(amount) } });
const calls = (name: string, id: string, input: Json = {}, thread?: string): Json =>
  ({ type: "agent.custom_tool_use", id, name, input, ...(thread && { session_thread_id: thread }) });

/** One session of the fake API: its state, its event list and its open stream. */
class Session {
  history: RawEvent[] = [];
  /** The content of every `user.message` it was sent. */
  messages: Json[][] = [];
  results: Json[] = [];
  interrupts = 0;
  private streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  private n = 0;
  private message?: RawEvent;
  constructor(public state: Json) {}
  get id(): string { return this.state.id; }
  get spent(): number { return Number(this.state.usage.list_cost?.amount ?? 0); }
  /** The text of the n-th message, its blocks joined. */
  text(index: number): string {
    return (this.messages.at(index) ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n---\n");
  }
  private at() { return new Date(Date.UTC(2026, 9, 12, 0, 0, ++this.n)).toISOString(); }
  open(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({ start: (controller) => { this.streams.push(controller); } });
  }
  private write(event: RawEvent) {
    try { this.streams.at(-1)?.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)); } catch {}
  }
  /** Emits events to the list and the open stream, as the session would. */
  emit(...events: Json[]) {
    for (const event of events) {
      if (event.type === "session.status_running") this.state.status = "running";
      if (event.type === "session.status_idle") this.state.status = "idle";
      if (event.type === "session.status_terminated") this.state.status = "terminated";
      const full = { id: `sevt_${this.id}_${this.n + 1}`, processed_at: this.at(), ...event } as RawEvent;
      this.history.push(full);
      this.write(full);
    }
  }
  /** A message arrived: queued first, without `processed_at`. */
  receive(content: Json[]): RawEvent {
    this.messages.push(content);
    this.message = { id: `sevt_${this.id}_msg${this.messages.length}`, type: "user.message", content, processed_at: null };
    this.history.push(this.message);
    this.write(this.message);
    return this.message;
  }
  /** The agent takes the message up: it is echoed again, now processed.
   *  From then on the session reports what it has cost. */
  process() {
    if (!this.message || this.message.processed_at) return;
    this.use(this.spent);
    this.history = this.history.filter((e) => e !== this.message);
    this.message = { ...this.message, processed_at: this.at() };
    this.history.push(this.message);
    this.write(this.message);
  }
  use(amount: number) { this.state.usage = { ...this.state.usage, list_cost: usd(amount) }; }
  /** A whole plain answer that costs `cost` cents. */
  answer(text: string, cost = 17) {
    this.process();
    this.use(this.spent + cost);
    this.emit(running(), said(text), reported(this.spent), idle());
  }
  /** The agent starts on the message and does not finish by itself. */
  work() {
    this.process();
    this.emit(running());
  }
}

/** A Managed Agents API small enough to read. It keeps what is created,
 *  answers from that, and records every request. */
class Cloud {
  sent: Sent[] = [];
  environments: Json[] = [];
  agents: Json[] = [];
  sessions: Session[] = [];
  deleted: string[] = [];
  /** What a session does with a message; by default it answers "ok". */
  onMessage: (session: Session, text: string) => void = (session) => session.answer("ok");
  onInterrupt: (session: Session) => void = (session) => { if (session.state.status === "running") session.emit(idle()); };
  onResult: (session: Session, event: Json) => void = () => {};
  onCreate: (session: Session) => void = () => {};
  private routes = new Map<string, (request: Sent) => Response | Promise<Response> | undefined>();
  private n = 0;
  readonly fetch = ((input: unknown, init?: RequestInit) => this.handle(input, init)) as unknown as typeof fetch;

  on(key: string, reply: (request: Sent) => Response | Promise<Response> | undefined) { this.routes.set(key, reply); }
  off(key: string) { this.routes.delete(key); }
  of(method: string, path: string) { return this.sent.filter((r) => r.method === method && r.path === path); }
  session(id: string) { return this.sessions.find((s) => s.id === id)!; }
  /** Request lines in order, with what was sent for the ones that matter. */
  get log() {
    return this.sent.map((r) => {
      const types = r.body?.events?.map((e: Json) => e.type).join("+");
      const budget = r.body?.budget?.max_list_cost?.amount;
      return `${r.method} ${r.path.replace("/v1", "")}${types ? ` ${types}` : ""}${budget ? ` budget=${budget}` : ""}`;
    });
  }
  /** A session that exists on the API although this fake did not create it. */
  adopt(id: string, state: { status?: string; budget: number; used: number }) {
    const session = new Session({
      id, type: "session", status: state.status ?? "idle", archived_at: null,
      budget: { type: "limit", max_list_cost: usd(state.budget) }, usage: { list_cost: usd(state.used) },
    });
    this.sessions.push(session);
    return session;
  }

  private async handle(input: unknown, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const request: Sent = {
      method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query: url.searchParams,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    this.sent.push(request);
    const key = `${request.method} ${request.path}`, body = request.body ?? {};
    const replaced = await this.routes.get(key)?.(request);
    if (replaced) return replaced;
    const at = "2026-10-12T00:00:00Z";
    if (key === "GET /v1/environments") return Response.json({ data: this.environments, next_page: null });
    if (key === "POST /v1/environments") {
      const environment = {
        id: `env_${++this.n}`, type: "environment", name: body.name, description: body.description ?? null,
        metadata: body.metadata ?? {}, archived_at: null, created_at: at, updated_at: at,
        config: { type: "cloud", networking: body.config.networking, packages: {} },
      };
      this.environments.push(environment);
      return Response.json(environment);
    }
    if (key === "GET /v1/agents") return Response.json({ data: this.agents, next_page: null });
    if (key === "POST /v1/agents") {
      const agent = {
        id: `agent_${++this.n}`, type: "agent", version: 1, name: body.name, description: body.description ?? null,
        metadata: body.metadata ?? {}, archived_at: null, created_at: at, updated_at: at,
        model: { id: body.model }, system: null, tools: [], mcp_servers: [], skills: [],
        multiagent: body.multiagent ? {
          type: "multiagent_20261001", advisor: { type: "disabled" }, subagents: { type: "disabled" },
          workflows: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] },
        } : null,
      };
      this.agents.push(agent);
      return Response.json(agent);
    }
    if (key === "POST /v1/sessions") {
      const agent = this.agents.find((a) => a.id === body.agent.id)!;
      const session = new Session({
        id: `sesn_${++this.n}`, type: "session", status: "idle", archived_at: null, created_at: at, updated_at: at,
        environment_id: body.environment_id, metadata: body.metadata ?? {}, title: body.title ?? null,
        budget: body.budget ?? null, usage: {},
        agent: { ...agent, system: body.agent.system, tools: body.agent.tools, model: { id: body.agent.model.id } },
      });
      this.sessions.push(session);
      this.onCreate(session);
      return Response.json(session.state);
    }
    const [, , kind, id, ...rest] = request.path.split("/");
    const action = rest.join("/");
    const session = kind === "sessions" ? this.sessions.find((s) => s.id === id) : undefined;
    if (!session || this.deleted.includes(session.id)) return rejected(404);
    switch (`${request.method} ${action}`) {
      case "GET ":
        return Response.json(session.state);
      case "POST ":
        if (body.budget) session.state.budget = body.budget;
        return Response.json(session.state);
      case "DELETE ":
        this.deleted.push(session.id);
        return Response.json({ id: session.id, type: "session_deleted" });
      case "POST archive":
        session.state.archived_at = at;
        return Response.json(session.state);
      case "GET events/stream":
        return new Response(session.open(), { headers: { "content-type": "text/event-stream" } });
      case "GET events": {
        const types = request.query.getAll("types[]");
        const data = session.history.filter((e) => !types.length || types.includes(e.type));
        return Response.json({ data: request.query.get("order") === "desc" ? [...data].reverse() : data, next_page: null });
      }
      case "POST events": {
        const event = body.events[0] as Json;
        if (event.type === "user.message") {
          const message = session.receive(event.content);
          this.onMessage(session, session.text(-1));
          return Response.json({ data: [message] });
        }
        if (event.type === "user.interrupt") {
          session.interrupts++;
          this.onInterrupt(session);
        }
        if (event.type === "user.custom_tool_result") {
          session.results.push(event);
          session.history.push({ id: `sevt_${session.id}_r${session.results.length}`, processed_at: at, ...event } as RawEvent);
          this.onResult(session, event);
        }
        return Response.json({ data: [{ id: `sevt_${session.id}_u${this.n++}`, ...event }] });
      }
    }
    return rejected(404);
  }
}

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PROVIDER: "anthropic_workspace", LLM_MODEL: "claude-haiku-5-5", ANTHROPIC_WORKSPACE_API_KEY: "fixture",
  SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", RUNTIME_STATE_PATH: "", LOG_DIR: "",
  PERSONA_FILE: join(dir, "no-persona.md"), ...extra,
});
/** Channels of the one server these tests have; any other channel is a DM. */
const GUILD = "1", CHANNELS = ["11", "12"];
const dm: Context = { channelId: "10", userId: "20", botId: "30", thread: false, depth: 0, delivered: false };
const inGuild = (channelId = "11", userId = "20"): Context => ({ ...dm, guildId: GUILD, channelId, userId });
const today = new Date().toISOString().slice(0, 10);

/** A bot whose Workspace client talks to `cloud` and whose Discord client
 *  answers from memory. `open` uses the SQLite store, as a started bot does. */
async function bot(extra: NodeJS.ProcessEnv = {}, options: { data?: string; cloud?: Cloud; open?: boolean; load?: boolean } = {}) {
  const data = options.data ?? await mkdtemp(join(dir, "bot-"));
  const cloud = options.cloud ?? new Cloud();
  const hibana = new Hibana(loadConfig(env({ HIBANA_DATA_DIR: data, ...extra })), pino({ enabled: false }), {
    workspace: { fetch: cloud.fetch, sleep: async () => {}, limits: { graceMs: 30, interruptWaitMs: 100, settleMs: 100 } },
  });
  (hibana.client as { user: { id: string } | null }).user = { id: "30" };
  // Every message as it was first posted, and every text a message ever showed.
  const sent: string[] = [], shown: string[] = [];
  hibana.client.channels.fetch = (async (id: string) => {
    const channel = {
      id, isSendable: () => true, sendTyping: async () => {},
      send: async (value: { content: string }) => {
        sent.push(value.content);
        shown.push(value.content);
        return { id: "40", edit: async (next: { content: string }) => { shown.push(next.content); } };
      },
    };
    return CHANNELS.includes(id)
      ? { ...channel, guildId: GUILD, guild: { members: { fetch: async (userId: string) => ({ id: userId }) } }, permissionsFor: () => ({ has: () => true }) }
      : channel;
  }) as never;
  for (const user of ["20", "21"]) hibana.runtime.snapshot.user_roles[user] = "premium";
  let modelRequests = 0;
  hibana.llm.complete = (async () => {
    modelRequests++;
    throw new Error("a Workspace turn must not use the LLM client");
  }) as typeof hibana.llm.complete;
  if (options.open) hibana.conversations.open();
  if (options.load !== false) await hibana.workspace.load();
  const checkpoints = () => (hibana as unknown as { checkpoints: Record<string, Checkpoint> }).checkpoints;
  return { hibana, cloud, data, sent, shown, checkpoints, modelRequests: () => modelRequests };
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the condition never held");
    await Bun.sleep(1);
  }
}
/** A Discord message from user 20 in the DM channel, with `images` attached
 *  as data, so that nothing has to be downloaded. */
function incoming(content: string, id: string, images = 0): DiscordMessage {
  const attachments = new Map(Array.from({ length: images }, (_, n) => [`${id}${n}`, {
    id: `${id}${n}`, name: `${n}.png`, size: 3, contentType: "image/png", url: `data:image/png;base64,${btoa(`${id}${n}`)}`,
  }]));
  return {
    id, channelId: "10", guildId: null, content,
    author: { id: "20", bot: false, displayName: "Aki" }, member: null,
    mentions: { users: { has: () => false } }, pinned: false, system: false,
    attachments, channel: { isThread: () => false, name: "dm" },
  } as unknown as DiscordMessage;
}
const onMessage = (hibana: Hibana, message: DiscordMessage) =>
  (hibana as unknown as { onMessage(message: DiscordMessage): Promise<void> }).onMessage(message);
/** Runs one slash command; only the fields `handleCommand` reads are faked. */
async function slash(hibana: Hibana, commandName: string, options: Record<string, string> = {}, ctx: Context = dm, usage: unknown = hibana.usage) {
  let text = "";
  const i = {
    commandName, user: { id: ctx.userId }, guildId: ctx.guildId ?? null, channelId: ctx.channelId,
    client: { user: { id: "30" } }, channel: { isThread: () => false },
    options: { getString: (name: string) => options[name] ?? null, getBoolean: () => null },
    deferReply: async () => {}, reply: async () => {}, editReply: async (t: string) => { text = t; },
  };
  await handleCommand(i as never, hibana.runtime, hibana.tools, hibana.history, hibana.voice, (c) => hibana.retry(c), usage as UsageLedger, hibana.workspace);
  return text;
}
const FAILED = "プロバイダとの通信を再試行しましたが、応答を完了できませんでした。";
const KEPT = " 進捗を保存しました。`/retry` または次のメッセージで再開できます。";

describe("a Workspace turn", () => {
  test("Haiku with Ultra creates an ultra session with the Workspace prompt, both kinds of tools and a 300-cent budget, and never asks the Messages API", async () => {
    const { hibana, cloud, sent, modelRequests, checkpoints } = await bot({ ULTRA_MODE: "true", SKILLS_ENABLED: "true" });
    let leases = 0, catalogs = 0;
    const lease = hibana.tools.sandbox.lease.bind(hibana.tools.sandbox);
    hibana.tools.sandbox.lease = (ctx) => { leases++; return lease(ctx); };
    hibana.tools.skillCatalog = (async () => { catalogs++; return ""; }) as typeof hibana.tools.skillCatalog;
    try {
      const text = "こんにちは\n\n[author: Aki; user_id: 20; channel_id: 10; message_id: 1]";
      expect(await hibana.respond(text, { ...dm })).toBe("ok");
      expect(sent).toEqual(["ok"]);

      const [create] = cloud.of("POST", "/v1/sessions");
      expect(cloud.of("POST", "/v1/sessions")).toHaveLength(1);
      const ultra = cloud.agents.find((a) => a.multiagent)!, plain = cloud.agents.find((a) => !a.multiagent);
      // Only the agent this turn needs is created.
      expect(plain).toBeUndefined();
      expect(create!.body!.agent).toMatchObject({
        type: "agent_with_overrides", id: ultra.id, model: { id: "claude-haiku-5-5", effort: "high" },
        system: await workspaceSystem("ultra"),
      });
      const tools = create!.body!.agent.tools as Json[];
      expect(tools[0]).toEqual({ type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: "always_allow" } } });
      const custom = tools.slice(1);
      expect(custom.every((t) => t.type === "custom")).toBe(true);
      expect(custom.map((t) => t.name).slice(0, 2)).toEqual(["send_file", "AskUserQuestion"]);
      expect(custom.map((t) => t.name)).toEqual(expect.arrayContaining(["read_messages", "get_bot_settings", "set_bot_model"]));
      // Nothing that needs the bot's own sandbox or its subagents.
      for (const absent of ["Bash", "Agent", "Workflow", "generate_image", "playwright_cli", "publish_site"])
        expect(custom.map((t) => t.name)).not.toContain(absent);
      expect(create!.body!.budget).toEqual({ type: "limit", max_list_cost: { amount: "300", currency: "USD" } });
      // The channel is named by a digest, never by its Discord id.
      expect(create!.body!.metadata).toEqual({ app: "hibana", variant: "ultra", channel: promptCacheKey("10") });
      expect(JSON.stringify(create!.body!.metadata)).not.toContain('"10"');

      // One message: the context block, then the person's words and the date.
      const [session] = cloud.sessions;
      expect(session!.messages).toHaveLength(1);
      expect(session!.messages[0]!.map((b) => b.type)).toEqual(["text", "text"]);
      expect(session!.messages[0]![0]!.text.startsWith("<hibana_context>")).toBe(true);
      expect(session!.messages[0]![1]!.text).toBe(`${text}\n[date: ${today}]`);

      // The order: resources, the session, its budget, the stream, the
      // message, and the rest of the allowance taken back.
      expect(cloud.log).toEqual([
        "GET /environments", "POST /environments", "GET /agents", "POST /agents",
        "POST /sessions budget=300",
        `GET /sessions/${session!.id}`,
        `GET /sessions/${session!.id}/events`,
        `GET /sessions/${session!.id}/events/stream`,
        `POST /sessions/${session!.id}/events user.message`,
        `GET /sessions/${session!.id}`,
        `POST /sessions/${session!.id} budget=18`,
      ]);
      expect(cloud.sent.some((r) => r.path.endsWith("/messages"))).toBe(false);
      expect(modelRequests()).toBe(0);
      expect(leases).toBe(0);
      expect(catalogs).toBe(0);

      // Locally: the message and the reply as a record, and no checkpoint.
      expect(hibana.history.info("10")).toMatchObject({ turns: 1, usage: { context_tokens: 0 } });
      expect(checkpoints()).toEqual({});
      expect(hibana.workspace.sessions.get("10")).toMatchObject({
        sessionId: session!.id, variant: "ultra", key: conversationKey(hibana.config.selection, "workspace", "ultra"),
        totals: { list_cost_cents: 17 }, state: { turns: 1, openRuns: [], runOwners: {} },
      });
      // The allowance was taken back, so nothing holds a lease.
      expect(hibana.workspace.sessions.get("10")!.lease).toBeUndefined();
    } finally { await hibana.close(); }
  });

  test("Sonnet with Ultra stored runs as a plain session with a 100-cent budget", async () => {
    const { hibana, cloud } = await bot({ LLM_MODEL: "claude-sonnet-5-5", ULTRA_MODE: "true", ANTHROPIC_WORKSPACE_WEB_ENABLED: "false" });
    try {
      await hibana.respond("こんにちは", { ...dm });
      const [create] = cloud.of("POST", "/v1/sessions");
      expect(cloud.agents).toHaveLength(1);
      expect(cloud.agents[0]!.multiagent).toBeNull();
      expect(create!.body!.agent).toMatchObject({
        id: cloud.agents[0]!.id, model: { id: "claude-sonnet-5-5" }, system: await workspaceSystem("plain"),
      });
      expect(create!.body!.budget.max_list_cost.amount).toBe("100");
      expect(create!.body!.metadata.variant).toBe("plain");
      // The container's own web tools follow the bot's switch for them.
      expect(create!.body!.agent.tools[0].configs).toEqual([{ name: "web_search", enabled: false }, { name: "web_fetch", enabled: false }]);
      expect(hibana.workspace.sessions.get("10")!.key).toBe(conversationKey(hibana.config.selection, "workspace", "plain"));
    } finally { await hibana.close(); }
  });

  test("with tools switched off the session gets no tools at all", async () => {
    const { hibana, cloud } = await bot({ TOOLS_ENABLED: "false" });
    try {
      await hibana.respond("こんにちは", { ...dm });
      expect(cloud.of("POST", "/v1/sessions")[0]!.body!.agent.tools).toEqual([]);
    } finally { await hibana.close(); }
    // This bot ran without a store, so its rows ended with it. The session
    // would never be found again: it is archived on the way out.
    expect(cloud.of("POST", `/v1/sessions/${cloud.sessions[0]!.id}/archive`)).toHaveLength(1);
  });

  test("the second turn goes to the same session, with only the new message", async () => {
    const { hibana, cloud, sent } = await bot();
    try {
      await hibana.respond("一つ目の依頼", { ...dm });
      cloud.onMessage = (session) => session.answer("二つ目の返事");
      await hibana.respond("二つ目の依頼", { ...dm });
      expect(cloud.sessions).toHaveLength(1);
      const [session] = cloud.sessions;
      expect(session!.messages).toHaveLength(2);
      // The context block is not repeated, and neither is the first turn.
      expect(session!.messages[1]).toEqual([{ type: "text", text: `二つ目の依頼\n[date: ${today}]` }]);
      expect(sent).toEqual(["ok", "二つ目の返事"]);
      expect(hibana.history.info("10").turns).toBe(2);
      // The budget is raised from what the session has used, per turn.
      expect(cloud.log.filter((line) => line.includes("budget="))).toEqual([
        "POST /sessions budget=100", `POST /sessions/${session!.id} budget=18`,
        `POST /sessions/${session!.id} budget=117`, `POST /sessions/${session!.id} budget=35`,
      ]);
      // A changed context is sent again, at the head of that message.
      await hibana.runtime.setContext(undefined, "20", { text: "Call me Aki." });
      await hibana.respond("三つ目の依頼", { ...dm });
      expect(session!.messages[2]!.map((b) => b.type)).toEqual(["text", "text"]);
      expect(session!.messages[2]![0]!.text).toContain("Call me Aki.");
    } finally { await hibana.close(); }
  });

  test("after the session summarized its conversation, the context block is sent again", async () => {
    const { hibana, cloud } = await bot();
    try {
      cloud.onMessage = (session) => {
        session.process();
        session.use(17);
        session.emit(running(), { type: "agent.thread_context_compacted" }, said("ok"), reported(17), idle());
      };
      await hibana.respond("一つ目", { ...dm });
      expect(hibana.workspace.sessions.get("10")!.state!.contextDigest).toBeUndefined();
      cloud.onMessage = (session) => session.answer("ok");
      await hibana.respond("二つ目", { ...dm });
      expect(cloud.sessions[0]!.messages[1]![0]!.text.startsWith("<hibana_context>")).toBe(true);
      expect(hibana.workspace.sessions.get("10")!.state!.contextDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally { await hibana.close(); }
  });

  test("a custom tool call runs in the registry as the person who asked, and a status line never quotes a command", async () => {
    const { hibana, cloud, sent, shown } = await bot();
    const seen: { name: string; userId: string; channelId: string; harness?: string; depth: number }[] = [];
    const execute = hibana.tools.execute.bind(hibana.tools);
    hibana.tools.execute = (name, args, ctx) => {
      seen.push({ name, userId: ctx.userId, channelId: ctx.channelId, harness: ctx.harness, depth: ctx.depth });
      return execute(name, args, ctx);
    };
    try {
      cloud.onMessage = (session) => {
        session.process();
        session.emit(running(),
          { type: "agent.tool_use", name: "bash", input: { command: "cat /mnt/session/secret.txt" }, evaluated_permission: "allow" },
          calls("get_bot_settings", "call_a"), calls("bash", "call_b", { command: "ls" }),
          idle("requires_action", { event_ids: ["call_a", "call_b"] }));
      };
      cloud.onResult = (session) => { if (session.results.length === 2) session.emit(running(), said("設定を読みました。"), idle()); };
      await hibana.respond("設定を見せて", { ...dm });
      const [session] = cloud.sessions;
      expect(seen).toEqual([
        { name: "get_bot_settings", userId: "20", channelId: "10", harness: "workspace", depth: 0 },
        { name: "bash", userId: "20", channelId: "10", harness: "workspace", depth: 0 },
      ]);
      const result = (id: string) => session!.results.find((r) => r.custom_tool_use_id === id)!;
      expect(result("call_a").is_error).toBe(false);
      expect(result("call_a").content[0].text).toContain('"provider":"anthropic_workspace"');
      // The container's shell is not one of the bot's tools.
      expect(result("call_b")).toMatchObject({ is_error: true, content: [{ type: "text", text: "bash is not a tool of this workspace." }] });
      expect(sent.at(-1)).toBe("設定を読みました。");
      expect(shown).toContain("コマンドを実行しています");
      expect(shown.join("\n")).not.toContain("secret.txt");
    } finally { await hibana.close(); }
  });

  test("a person who is blocked during the turn gets an error for the call and no reply", async () => {
    const { hibana, cloud, sent } = await bot();
    try {
      cloud.onMessage = (session) => {
        session.process();
        hibana.runtime.snapshot.blocked_users.push("20");
        session.emit(running(), said("途中まで"), calls("get_bot_settings", "call_a"), idle("requires_action", { event_ids: ["call_a"] }));
      };
      expect(await hibana.respond("設定を見せて", { ...dm })).toBe("");
      const [session] = cloud.sessions;
      expect(session!.results).toMatchObject([{ custom_tool_use_id: "call_a", is_error: true }]);
      expect(session!.interrupts).toBe(1);
      expect(sent).toEqual([]);
    } finally { await hibana.close(); }
  });

  test("a turn that reaches its budget says so and leaves the session's budget as it is", async () => {
    const { hibana, cloud, sent } = await bot();
    try {
      cloud.onMessage = (session) => {
        session.process();
        session.use(101);
        session.emit(running(), said("ここまで調べました。"), reported(101), idle("budget_reached"));
      };
      await hibana.respond("調べて", { ...dm });
      expect(sent).toEqual(["ここまで調べました。\n\nこのターンの費用の上限（$1.00）に達したため、ここで止めました。続けるには、もう一度メッセージを送ってください。"]);
      // Paused at its budget: any change to it would let the session go on.
      expect(cloud.log.filter((line) => line.includes("budget="))).toEqual(["POST /sessions budget=100"]);
      expect(hibana.workspace.sessions.get("10")!.lease).toBeUndefined();
      expect(hibana.workspace.usage.summary().today).toEqual({ cost_usd: 1.01, turns: 1 });
    } finally { await hibana.close(); }
  });

  test("a turn that reaches its time limit is stopped and says so", async () => {
    const { hibana, cloud, sent } = await bot({ ANTHROPIC_WORKSPACE_TURN_TIMEOUT_MS: "80" });
    try {
      cloud.onMessage = (session) => session.work();
      await hibana.respond("長い作業", { ...dm });
      // The limit is told in whole minutes, and never as zero.
      expect(sent).toEqual(["このターンの時間の上限（1 分）に達したため、中断しました。続けるには、もう一度メッセージを送ってください。"]);
      expect(cloud.sessions[0]!.state.status).toBe("idle");
    } finally { await hibana.close(); }
  });

  test("a provider failure is told in Japanese, keeps the checkpoint, and /retry continues the message under its first ceiling", async () => {
    const { hibana, cloud, sent, checkpoints } = await bot();
    try {
      cloud.onMessage = (session) => {
        session.process();
        session.use(30);
        session.emit(running(), reported(30), idle("retries_exhausted"));
      };
      expect(await hibana.respond("長い依頼", { ...dm })).toBe("");
      expect(sent).toEqual([`${FAILED}（受信中）${KEPT}`]);
      const [session] = cloud.sessions;
      const saved = checkpoints()["10/20"]!;
      expect(saved.ctx.workspaceMark).toMatchObject({ sessionId: session!.id, eventId: `sevt_${session!.id}_msg1`, ceilingCents: 100, resumes: 0 });
      expect(saved.messages).toEqual([{ role: "user", content: "長い依頼", turnStart: true }]);
      expect(resumesAtStart(saved)).toBe(true);

      // A second failure: the checkpoint now says it was resumed once. The
      // turn's time limit still counts from its first start.
      await hibana.retry({ ...dm });
      expect(checkpoints()["10/20"]!.ctx.workspaceMark).toMatchObject({
        ceilingCents: 100, resumes: 1, startedAt: saved.ctx.workspaceMark!.startedAt,
      });
      expect(resumesAtStart(checkpoints()["10/20"]!)).toBe(false);

      cloud.onMessage = (s) => s.answer("できました。");
      await hibana.retry({ ...dm });
      expect(sent.at(-1)).toBe("できました。");
      expect(cloud.sessions).toHaveLength(1);
      expect(session!.messages).toHaveLength(3);
      // The person's message went once. What follows it picks the work up.
      expect(session!.text(0)).toContain("長い依頼");
      for (const index of [1, 2]) {
        expect(session!.text(index).startsWith("[The bot restarted while you were working on the message above")).toBe(true);
        expect(session!.text(index)).not.toContain("長い依頼");
      }
      // Never "used so far plus a new allowance": the ceiling stays at 100.
      const raised = cloud.log.filter((line) => line.includes("budget=")).map((line) => Number(line.split("budget=")[1]));
      expect(Math.max(...raised)).toBe(100);
      expect(raised.filter((cents) => cents === 100)).toHaveLength(3);
      expect(checkpoints()).toEqual({});
      // The record of the turn holds the person's message once, and the reply.
      expect(hibana.history.info("10").turns).toBe(1);
    } finally { await hibana.close(); }
  });

  test("a new message after a failed turn goes alone when the session has the earlier one, and with it when the session is new", async () => {
    const { hibana, cloud } = await bot();
    const fails = (session: Session) => {
      session.process();
      session.use(session.spent + 30);
      session.emit(running(), reported(session.spent), idle("retries_exhausted"));
    };
    try {
      cloud.onMessage = fails;
      await hibana.respond("一つ目の依頼", { ...dm });
      cloud.onMessage = (session) => session.answer("二つ目の返事");
      await hibana.respond("二つ目の依頼", { ...dm });
      const [first] = cloud.sessions;
      expect(first!.messages).toHaveLength(2);
      expect(first!.messages[1]).toEqual([{ type: "text", text: `二つ目の依頼\n[date: ${today}]` }]);
      // A message a person wrote is a new turn with an allowance of its own.
      expect(cloud.log).toContain(`POST /sessions/${first!.id} budget=130`);
      // Both messages and the reply are one record of the conversation.
      expect(hibana.history.info("10").turns).toBe(1);

      cloud.onMessage = fails;
      await hibana.respond("三つ目の依頼", { ...dm });
      // The session that took the third message is lost before the fourth.
      cloud.deleted.push(first!.id);
      cloud.onMessage = (session) => session.answer("四つ目の返事");
      await hibana.respond("四つ目の依頼", { ...dm });
      expect(cloud.sessions).toHaveLength(2);
      expect(cloud.sessions[1]!.messages).toHaveLength(1);
      expect(cloud.sessions[1]!.messages[0]!.at(-1)!.text).toBe(`三つ目の依頼\n\n四つ目の依頼\n[date: ${today}]`);
    } finally { await hibana.close(); }
  });

  test("a restart continues with the mark and does not send the message again", async () => {
    const data = await mkdtemp(join(dir, "restart-"));
    const cloud = new Cloud();
    const first = await bot({}, { data, cloud, open: true });
    cloud.onMessage = (session) => {
      session.process();
      session.use(30);
      session.emit(running(), reported(30), idle("retries_exhausted"));
    };
    await first.hibana.respond("長い依頼", { ...dm });
    const saved = first.checkpoints();
    await first.hibana.close();

    const second = await bot({}, { data, cloud, open: true });
    try {
      // What `start()` reads from retry_checkpoints.json.
      expect(JSON.parse(await readFile(join(data, "retry_checkpoints.json"), "utf8"))).toEqual(saved);
      (second.hibana as unknown as { checkpoints: unknown }).checkpoints = saved;
      cloud.onMessage = (session) => session.answer("続きです。");
      await second.hibana.retry({ ...saved["10/20"]!.ctx, botId: "30" });
      expect(second.sent).toEqual(["続きです。"]);
      expect(cloud.sessions).toHaveLength(1);
      expect(cloud.sessions[0]!.messages).toHaveLength(2);
      expect(cloud.sessions[0]!.text(1)).not.toContain("長い依頼");
    } finally { await second.hibana.close(); }
  });

  test("a checkpoint of another harness is not resumed, in either direction", async () => {
    const { hibana, cloud, sent } = await bot();
    const codex = await bot({ PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "key", LLM_MODEL: "test" });
    // A retry that finds nothing fails like any other turn.
    const NOTHING_TO_RESUME = "処理に失敗しました。 設定を確認してもう一度送信してください。";
    try {
      const checkpoint = (selectionKey: string, ctx: Partial<Context> = {}): Record<string, Checkpoint> => ({
        "10/20": { ctx: { ...dm, ...ctx }, messages: [{ role: "user", content: "古い依頼", turnStart: true }], at: Date.now(), historyStart: 0, selectionKey },
      });
      // Written by the Codex-style harness, found by a Workspace turn.
      (hibana as unknown as { checkpoints: unknown }).checkpoints =
        checkpoint(conversationKey({ provider: "codex_plus", model: "gpt-6-luna" }, "codex"));
      await hibana.retry({ ...dm });
      expect(sent).toEqual([NOTHING_TO_RESUME]);
      expect(cloud.sent).toEqual([]);
      await hibana.respond("新しい依頼", { ...dm });
      expect(cloud.sessions[0]!.text(0)).not.toContain("古い依頼");
      // Written by a Workspace turn, found by the Codex-style harness.
      (codex.hibana as unknown as { checkpoints: unknown }).checkpoints = checkpoint(
        conversationKey(hibana.config.selection, "workspace", "plain"),
        { harness: "workspace", workspaceMark: { sessionId: "sesn_1", eventId: "sevt_1", ceilingCents: 100, startedAt: Date.now(), resumes: 0 } });
      await codex.hibana.retry({ ...dm });
      expect(codex.sent).toEqual([NOTHING_TO_RESUME]);
      expect(codex.modelRequests()).toBe(0);
    } finally {
      await hibana.close();
      await codex.hibana.close();
    }
  });

  test("the context of a Workspace turn does not leak its harness into a later Codex-style turn", async () => {
    const { hibana } = await bot({ PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "key", LLM_MODEL: "test" });
    const seen: Context[] = [];
    hibana.llm.complete = (async () => ({ message: { role: "assistant" as const, content: "ok" }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cached_tokens: 0 }, incomplete: false })) as typeof hibana.llm.complete;
    const tools = hibana.tools.tools.bind(hibana.tools);
    hibana.tools.tools = (ctx) => { seen.push(ctx); return tools(ctx); };
    try {
      // As a context restored from a Workspace checkpoint would arrive.
      await hibana.respond("こんにちは", {
        ...dm, harness: "workspace",
        workspaceMark: { sessionId: "sesn_1", eventId: "sevt_1", ceilingCents: 100, startedAt: 0, resumes: 0 },
      });
      expect(seen.length).toBeGreaterThan(0);
      for (const ctx of seen) {
        expect(ctx.harness).toBeUndefined();
        expect(ctx.workspaceMark).toBeUndefined();
      }
    } finally { await hibana.close(); }
  });

  test("without the key the turn fails as an authentication error and nothing is requested", async () => {
    const { hibana, cloud, sent } = await bot({ ANTHROPIC_WORKSPACE_API_KEY: "" });
    try {
      await hibana.respond("こんにちは", { ...dm });
      expect(sent).toEqual([`プロバイダの認証・権限エラーです。APIキーと利用権限を確認してください。${KEPT}`]);
      expect(cloud.sent).toEqual([]);
    } finally { await hibana.close(); }
  });
});

describe("steering", () => {
  test("a message written before the first one was sent does not keep it from the session, and what was added becomes one turn", async () => {
    const { hibana, cloud, sent } = await bot();
    try {
      // The session is being created while the person writes twice more.
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      cloud.on("POST /v1/sessions", () => held.then(() => undefined) as never);
      cloud.onMessage = (session, text) => (text.includes("最初の依頼") ? session.work() : session.answer("まとめて答えます。"));
      const first = onMessage(hibana, incoming("最初の依頼", "1"));
      await until(() => cloud.of("POST", "/v1/sessions").length === 1);
      await onMessage(hibana, incoming("追加その一", "2", 3));
      await onMessage(hibana, incoming("追加その二", "3", 3));
      cloud.off("POST /v1/sessions");
      release();
      await first;
      await until(() => sent.includes("まとめて答えます。"));
      const [session] = cloud.sessions;
      // The first message reached the session and was interrupted there.
      expect(session!.messages).toHaveLength(2);
      expect(session!.text(0)).toContain("最初の依頼");
      expect(session!.interrupts).toBe(1);
      // One turn for both, not one each, with the first four of their images.
      expect(session!.messages[1]!.map((b) => b.type)).toEqual(["text", "image", "image", "image", "image"]);
      expect(session!.messages[1]!.slice(1).map((b) => atob(b.source.data))).toEqual(["20", "21", "22", "30"]);
      const second = session!.text(1);
      expect(second).toContain("追加その一");
      expect(second).toContain("追加その二");
      expect(second.indexOf("追加その一")).toBeLessThan(second.indexOf("追加その二"));
      expect(sent).toEqual(["まとめて答えます。"]);
    } finally { await hibana.close(); }
  });
});

describe("sessions and channels", () => {
  test("each channel and each DM has its own session, and a turn never uses another channel's", async () => {
    const { hibana, cloud } = await bot();
    try {
      await hibana.respond("サーバーのチャンネル A", inGuild("11"));
      await hibana.respond("サーバーのチャンネル B", inGuild("12"));
      await hibana.respond("DM", { ...dm });
      await hibana.respond("もう一度 A", inGuild("11"));
      expect(cloud.sessions).toHaveLength(3);
      const [a, b, direct] = cloud.sessions;
      expect(a!.messages.map((_, i) => a!.text(i).includes("A"))).toEqual([true, true]);
      expect(b!.messages).toHaveLength(1);
      expect(b!.text(0)).toContain("サーバーのチャンネル B");
      expect(direct!.messages).toHaveLength(1);
      expect(direct!.text(0)).toContain("DM");
      // A DM is not "a channel of a server".
      expect(a!.text(0)).toContain("in a channel of a Discord server");
      expect(direct!.text(0)).toContain("in direct messages");
      expect(hibana.workspace.sessions.get("11")).toMatchObject({ sessionId: a!.id, guildId: GUILD });
      expect(hibana.workspace.sessions.get("10")!.guildId).toBeUndefined();
      // Every event of a turn went to the session of its own channel.
      for (const session of cloud.sessions)
        expect(cloud.of("POST", `/v1/sessions/${session.id}/events`)).toHaveLength(session.messages.length);
    } finally { await hibana.close(); }
  });

  test("a session row survives a restart; another model archives it and starts a new one", async () => {
    const data = await mkdtemp(join(dir, "rows-"));
    const cloud = new Cloud();
    const first = await bot({}, { data, cloud, open: true });
    await first.hibana.respond("一つ目", { ...dm });
    await first.hibana.close();
    // With a store the sessions outlive the process: nothing is archived.
    expect(cloud.sent.some((r) => r.path.endsWith("/archive"))).toBe(false);

    const second = await bot({}, { data, cloud, open: true });
    await second.hibana.respond("二つ目", { ...dm });
    expect(cloud.sessions).toHaveLength(1);
    expect(cloud.sessions[0]!.messages).toHaveLength(2);
    expect(cloud.of("POST", "/v1/environments")).toHaveLength(1);
    await second.hibana.close();

    const sonnet = await bot({ LLM_MODEL: "claude-sonnet-5-5" }, { data, cloud, open: true });
    try {
      await sonnet.hibana.respond("三つ目", { ...dm });
      expect(cloud.sessions).toHaveLength(2);
      expect(cloud.sessions[1]!.text(0)).toContain("三つ目");
      await until(() => cloud.of("POST", `/v1/sessions/${cloud.sessions[0]!.id}/archive`).length === 1);
      // Archived, not deleted: only an explicit clear removes the files.
      expect(cloud.deleted).toEqual([]);
      expect(sonnet.hibana.workspace.sessions.get("10")!.sessionId).toBe(cloud.sessions[1]!.id);
      await until(() => sonnet.hibana.workspace.sessions.disposals().length === 0);
    } finally { await sonnet.hibana.close(); }
  });

  test("a row is compared with the turn's server and key even when History holds no conversation", async () => {
    const { hibana, cloud } = await bot();
    try {
      await hibana.respond("サーバーで", inGuild("11"));
      const [first] = cloud.sessions;
      // As after a first turn that failed: the session exists, History has
      // nothing, so its hook does not fire. Here the row names another server.
      const hook = hibana.history.onDrop;
      hibana.history.onDrop = undefined;
      hibana.history.clear("11");
      hibana.history.onDrop = hook;
      hibana.workspace.sessions.save({ ...hibana.workspace.sessions.get("11")!, guildId: "2" });
      await hibana.respond("同じチャンネル", inGuild("11"));
      expect(cloud.sessions).toHaveLength(2);
      expect(first!.messages).toHaveLength(1);
      expect(cloud.sessions[1]!.text(0)).toContain("同じチャンネル");
      await until(() => cloud.of("POST", `/v1/sessions/${first!.id}/archive`).length === 1);
      // The same for a row of another model.
      hibana.history.onDrop = undefined;
      hibana.history.clear("11");
      hibana.history.onDrop = hook;
      const row = hibana.workspace.sessions.get("11")!;
      hibana.workspace.sessions.save({ ...row, key: conversationKey({ provider: "anthropic_workspace", model: "claude-opus-5-5" }, "workspace", "plain") });
      await hibana.respond("もう一度", inGuild("11"));
      expect(cloud.sessions).toHaveLength(3);
      expect(cloud.sessions[1]!.messages).toHaveLength(1);
    } finally { await hibana.close(); }
  });

  test("a changed server setting archives that server's sessions and leaves the others", async () => {
    const { hibana, cloud } = await bot();
    try {
      await hibana.respond("サーバー", inGuild("11"));
      await hibana.respond("DM", { ...dm });
      await hibana.runtime.patch(GUILD, { effort: "low" }, "20");
      const [server, direct] = cloud.sessions;
      await until(() => cloud.of("POST", `/v1/sessions/${server!.id}/archive`).length === 1);
      expect(hibana.workspace.info("11")).toBeUndefined();
      expect(hibana.workspace.sessions.get("10")!.sessionId).toBe(direct!.id);
      expect(cloud.of("POST", `/v1/sessions/${direct!.id}/archive`)).toHaveLength(0);
    } finally { await hibana.close(); }
  });

  test("a session that is gone before the message is replaced once, and the person is told", async () => {
    const { hibana, cloud, sent } = await bot();
    try {
      await hibana.respond("一つ目", { ...dm });
      const [first] = cloud.sessions;
      cloud.deleted.push(first!.id);
      cloud.onMessage = (session) => session.answer("二つ目の返事");
      await hibana.respond("二つ目", { ...dm });
      expect(sent).toEqual([
        "ok",
        "クラウドのセッションが無くなっていたため、新しい会話として始めます。以前の作業ファイルは引き継がれません。",
        "二つ目の返事",
      ]);
      expect(cloud.sessions).toHaveLength(2);
      expect(cloud.sessions[1]!.text(0)).toContain("二つ目");
      // A new session starts with the context block again.
      expect(cloud.sessions[1]!.messages[0]![0]!.text.startsWith("<hibana_context>")).toBe(true);
      expect(hibana.workspace.sessions.get("10")!.sessionId).toBe(cloud.sessions[1]!.id);

      // Once: when the replacement is gone too, the turn fails.
      cloud.onCreate = (session) => { cloud.deleted.push(session.id); };
      cloud.deleted.push(cloud.sessions[1]!.id);
      await hibana.respond("三つ目", { ...dm });
      expect(cloud.sessions).toHaveLength(3);
      expect(cloud.sessions[2]!.messages).toHaveLength(0);
      expect(sent.at(-1)).toBe(`${FAILED}（session_not_found）${KEPT}`);
      expect(hibana.workspace.info("10")).toBeUndefined();
    } finally { await hibana.close(); }
  });

  test("a session that ends after it took the message is not replaced: the turn is not run twice", async () => {
    const { hibana, cloud, sent } = await bot();
    try {
      cloud.onMessage = (session) => {
        session.process();
        session.emit(running(), { type: "session.status_terminated" });
      };
      await hibana.respond("依頼", { ...dm });
      expect(cloud.sessions).toHaveLength(1);
      expect(cloud.sessions[0]!.messages).toHaveLength(1);
      expect(sent).toEqual([`${FAILED}（session_terminated）${KEPT}`]);
      // The channel no longer points at it, and it leaves the queue.
      expect(hibana.workspace.info("10")).toBeUndefined();
      await until(() => hibana.workspace.sessions.disposals().length === 0);
    } finally { await hibana.close(); }
  });
});

describe("clearing", () => {
  test("/clear during a turn stops it without a failure notice and deletes the session afterwards", async () => {
    const { hibana, cloud, sent, checkpoints } = await bot();
    try {
      cloud.onMessage = (session) => session.work();
      const turn = hibana.respond("長い作業", { ...dm });
      await until(() => cloud.sessions[0]?.messages.length === 1);
      const text = await slash(hibana, "clear");
      expect(JSON.parse(text.replace(/```json\n|\n```/g, ""))).toEqual({ ok: true, workspace: "クラウドのセッションと作業ファイルの削除を始めました" });
      expect(await turn).toBe("");
      const [session] = cloud.sessions;
      await until(() => cloud.deleted.includes(session!.id));
      expect(session!.interrupts).toBeGreaterThanOrEqual(1);
      expect(sent).toEqual([]);
      expect(checkpoints()).toEqual({});
      expect(hibana.workspace.info("10")).toBeUndefined();
      expect(hibana.history.info("10").turns).toBe(0);
      // The next message starts a new conversation in a new session.
      cloud.onMessage = (s) => s.answer("新しい会話です。");
      await hibana.respond("こんにちは", { ...dm });
      expect(cloud.sessions).toHaveLength(2);
      expect(sent).toEqual(["新しい会話です。"]);
    } finally { await hibana.close(); }
  });

  test("/clear on an idle channel deletes its session; a channel without one answers as before", async () => {
    const { hibana, cloud } = await bot();
    try {
      expect(await slash(hibana, "clear")).toBe('```json\n{\n  "ok": true\n}\n```');
      expect(cloud.sent).toEqual([]);
      await hibana.respond("こんにちは", { ...dm });
      const [session] = cloud.sessions;
      expect(await slash(hibana, "clear")).toContain("クラウドのセッションと作業ファイルの削除を始めました");
      await until(() => cloud.deleted.includes(session!.id));
      // Its budget was already down; nothing is interrupted on the way out.
      expect(session!.interrupts).toBe(0);
      expect(cloud.sent.some((r) => r.path.endsWith("/archive"))).toBe(false);
      await until(() => hibana.workspace.sessions.disposals().length === 0);
    } finally { await hibana.close(); }
  });

  test("a removal that fails stays queued and is tried again by the next sweep", async () => {
    const data = await mkdtemp(join(dir, "queue-"));
    const cloud = new Cloud();
    const first = await bot({}, { data, cloud, open: true });
    await first.hibana.respond("こんにちは", { ...dm });
    const [session] = cloud.sessions;
    cloud.on(`DELETE /v1/sessions/${session!.id}`, () => rejected(400, "invalid_request_error"));
    first.hibana.history.clear("10");
    await until(() => first.hibana.workspace.sessions.disposals()[0]?.attempts === 1);
    await first.hibana.close();

    cloud.off(`DELETE /v1/sessions/${session!.id}`);
    const second = await bot({}, { data, cloud, open: true });
    try {
      expect(second.hibana.workspace.sessions.disposals()).toMatchObject([{ sessionId: session!.id, mode: "delete", attempts: 1 }]);
      await second.hibana.workspace.sweep();
      expect(cloud.deleted).toEqual([session!.id]);
      expect(second.hibana.workspace.sessions.disposals()).toEqual([]);
    } finally { await second.hibana.close(); }
  });

  test("the /image shortcut keeps a Workspace conversation", async () => {
    const { hibana, cloud } = await bot({ IMAGE_WORKER_URL: "http://127.0.0.1:18190", IMAGE_WORKER_TOKEN: "test-secret-".repeat(4) });
    hibana.tools.sandbox.available = true;
    hibana.tools.image.generate = (async () => ({ ok: true, path: "generated/cat.png", bytes: 12, model: "test", next: "" })) as never;
    hibana.tools.discord.sendFile = (async () => ({ id: "file" })) as never;
    try {
      await hibana.respond("こんにちは", { ...dm });
      const [session] = cloud.sessions;
      await onMessage(hibana, incoming("/image 猫", "5"));
      expect(hibana.history.info("10").turns).toBe(2);
      expect(hibana.workspace.sessions.get("10")!.sessionId).toBe(session!.id);
      expect(hibana.workspace.sessions.disposals()).toEqual([]);
      await hibana.respond("続き", { ...dm });
      expect(cloud.sessions).toHaveLength(1);
    } finally { await hibana.close(); }
  });
});

describe("limits", () => {
  test("turns beyond the concurrency limit wait and say so; a shutdown while waiting leaves the message unsent", async () => {
    const { hibana, cloud, sent, checkpoints } = await bot({ ANTHROPIC_WORKSPACE_MAX_CONCURRENT: "1" });
    cloud.onMessage = (session) => session.work();
    const first = hibana.respond("一つ目", inGuild("11"));
    await until(() => cloud.sessions[0]?.messages.length === 1);
    const second = hibana.respond("二つ目", inGuild("12"));
    await until(() => sent.length === 1);
    expect(sent).toEqual(["ほかの作業が終わるのを待っています（Anthropic Workspace の同時実行の上限）。"]);
    await Bun.sleep(20);
    // Nothing was created or sent for the turn that waits.
    expect(cloud.sessions).toHaveLength(1);
    await hibana.close();
    expect(await first).toBe("");
    expect(await second).toBe("");
    expect(cloud.sessions).toHaveLength(1);
    // Both can be picked up: one continues its message, the other sends it.
    expect(checkpoints()["11/20"]!.ctx.workspaceMark).toMatchObject({ sessionId: cloud.sessions[0]!.id, resumes: 0 });
    expect(checkpoints()["12/20"]!.ctx.workspaceMark).toBeUndefined();
    expect(checkpoints()["12/20"]!.messages).toEqual([{ role: "user", content: "二つ目", turnStart: true }]);
    // No failure notice on the way down.
    expect(sent).toHaveLength(1);
  });

  test("a waiting turn runs once the slot is free", async () => {
    const { hibana, cloud, sent } = await bot({ ANTHROPIC_WORKSPACE_MAX_CONCURRENT: "1" });
    try {
      cloud.onMessage = (session) => session.work();
      const first = hibana.respond("一つ目", inGuild("11"));
      await until(() => cloud.sessions[0]?.messages.length === 1);
      const second = hibana.respond("二つ目", inGuild("12"));
      await until(() => sent.length === 1);
      cloud.onMessage = (session) => session.answer("二つ目の返事");
      cloud.sessions[0]!.emit(said("一つ目の返事"), idle());
      expect(await first).toBe("一つ目の返事");
      expect(await second).toBe("二つ目の返事");
      expect(cloud.sessions).toHaveLength(2);
    } finally { await hibana.close(); }
  });

  test("the time a turn waits for a slot is not taken from its time limit", async () => {
    const { hibana, cloud, sent } = await bot({ ANTHROPIC_WORKSPACE_MAX_CONCURRENT: "1", ANTHROPIC_WORKSPACE_TURN_TIMEOUT_MS: "300" });
    try {
      // The first turn never finishes and is stopped at its limit. The second
      // waited all that time, and still has its own.
      cloud.onMessage = (session, text) => (text.includes("一つ目") ? session.work() : session.answer("二つ目の返事"));
      const first = hibana.respond("一つ目", inGuild("11"));
      await until(() => cloud.sessions[0]?.messages.length === 1);
      const second = hibana.respond("二つ目", inGuild("12"));
      expect(await first).toContain("時間の上限");
      expect(await second).toBe("二つ目の返事");
      expect(sent.at(-1)).toBe("二つ目の返事");
    } finally { await hibana.close(); }
  });

  test("a message over the input limit is answered locally and never sent", async () => {
    const { hibana, cloud, sent, checkpoints } = await bot({ ANTHROPIC_WORKSPACE_INPUT_MAX_CHARS: "50" });
    try {
      await hibana.respond("あ".repeat(51), { ...dm });
      expect(sent).toEqual(["メッセージが長すぎます（51 文字）。Anthropic Workspace に送れるのは 50 文字までです。短くして送り直してください。"]);
      expect(cloud.sent).toEqual([]);
      // It is not kept to be sent with the next message.
      expect(checkpoints()).toEqual({});
      await hibana.respond("あ".repeat(50), { ...dm });
      expect(cloud.sessions[0]!.messages).toHaveLength(1);
    } finally { await hibana.close(); }
  });

  test("the day's limit bounds a turn's allowance, counts what running turns may still spend, and then refuses", async () => {
    const { hibana, cloud, sent } = await bot({ ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD: "1.3" });
    try {
      // The first turn may take its whole 100 cents; while it runs, only 30
      // of the day's 130 are left for a second one.
      cloud.onMessage = (session) => session.work();
      const first = hibana.respond("一つ目", inGuild("11"));
      await until(() => cloud.sessions[0]?.messages.length === 1);
      cloud.onMessage = (session) => session.answer("二つ目の返事", 20);
      await hibana.respond("二つ目", inGuild("12"));
      expect(cloud.of("POST", "/v1/sessions").map((r) => r.body!.budget.max_list_cost.amount)).toEqual(["100", "30"]);
      const [a] = cloud.sessions;
      a!.use(90);
      a!.emit(said("一つ目の返事"), reported(90), idle());
      await first;
      // 110 of 130 cents are spent: the next turn gets the 20 that are left.
      cloud.onMessage = (session) => session.answer("三つ目の返事", 17);
      await hibana.respond("三つ目", inGuild("12"));
      expect(cloud.log.filter((line) => line.includes("budget=")).at(-2)).toBe(`POST /sessions/${cloud.sessions[1]!.id} budget=40`);
      // 127 are spent, and the 3 left are less than a turn is started for.
      cloud.onMessage = () => { throw new Error("nothing may be sent"); };
      const before = cloud.sent.length;
      await hibana.respond("四つ目", inGuild("11"));
      expect(sent.at(-1)).toBe("Anthropic Workspace の 1 日の利用額の上限に達しているため、実行しませんでした。上限は UTC の 0 時に戻ります。");
      expect(cloud.sent).toHaveLength(before);
    } finally { await hibana.close(); }
  });

  test("an allowance is held from the moment it is granted, before its session exists", async () => {
    const { hibana, cloud } = await bot({ ANTHROPIC_WORKSPACE_DAILY_BUDGET_USD: "1.3" });
    try {
      // The first turn's session is still being created when the second starts.
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      let creates = 0;
      cloud.on("POST /v1/sessions", () => (++creates === 1 ? held.then(() => undefined) as never : undefined));
      const first = hibana.respond("一つ目", inGuild("11"));
      await until(() => creates === 1);
      await hibana.respond("二つ目", inGuild("12"));
      release();
      await first;
      expect(cloud.of("POST", "/v1/sessions").map((r) => r.body!.budget.max_list_cost.amount)).toEqual(["100", "30"]);
    } finally { await hibana.close(); }
  });

  test("the month's limit refuses with its own words, and an unread ledger refuses every turn", async () => {
    const month = await bot({ ANTHROPIC_WORKSPACE_MONTHLY_BUDGET_USD: "0.2" });
    const unread = await bot({}, { load: false });
    try {
      await month.hibana.respond("一つ目", { ...dm });
      expect(month.cloud.of("POST", "/v1/sessions")[0]!.body!.budget.max_list_cost.amount).toBe("20");
      await month.hibana.respond("二つ目", { ...dm });
      expect(month.sent.at(-1)).toBe("Anthropic Workspace の今月の利用額の上限に達しているため、実行しませんでした。");
      await unread.hibana.respond("こんにちは", { ...dm });
      expect(unread.sent).toEqual(["Anthropic Workspace の利用額の記録を読み込めていないため、実行しませんでした。管理者に連絡してください。"]);
      expect(unread.cloud.sent).toEqual([]);
    } finally {
      await month.hibana.close();
      await unread.hibana.close();
    }
  });
});

describe("the usage ledger and the sweep", () => {
  test("each turn adds what its session used since the last one, once, and /usage shows it apart", async () => {
    const { hibana, cloud } = await bot();
    try {
      await hibana.respond("一つ目", { ...dm });
      cloud.onMessage = (session) => session.answer("二つ目の返事", 23);
      await hibana.respond("二つ目", { ...dm });
      await hibana.respond("別のチャンネル", inGuild("11"));
      const summary = hibana.workspace.usage.summary();
      // 17 + 23 on one session, 23 on the other: cumulative figures are not added up.
      expect(summary.today).toEqual({ cost_usd: 0.63, turns: 3 });
      expect(summary.month_by_model["claude-haiku-5-5"]).toMatchObject({ cost_usd: 0.63, turns: 3, sessions: 2, ultra_turns: 0 });
      expect(hibana.workspace.sessions.get("10")!.totals!.list_cost_cents).toBe(40);

      hibana.runtime.snapshot.user_roles["20"] = "administrator";
      const text = await slash(hibana, "usage");
      expect(text.startsWith(
        "Anthropic Workspace（セッションの list_cost の合計。公開単価での額で、請求額とは一致しないことがあります。日付は UTC）\n" +
        "今日: $0.63 / 3 ターン\n")).toBe(true);
      expect(text).toContain("  claude-haiku-5-5: $0.63 / 3 ターン\n```json\n");
      expect(text.length).toBeLessThanOrEqual(2000);
      // The lines take their room from the JSON, so a long summary still
      // fits one Discord message.
      const long = await slash(hibana, "usage", {}, dm, { summary: () => ({ filler: "x".repeat(3000) }) });
      expect(long.startsWith("Anthropic Workspace（")).toBe(true);
      expect(long.endsWith("\n```")).toBe(true);
      expect(long.length).toBe(2000);
      hibana.runtime.snapshot.user_roles["20"] = "premium";
      expect(await slash(hibana, "usage")).toBe("エラー: このコマンドは owner のみ使用できます。");
    } finally { await hibana.close(); }
  });

  test("a turn that failed leaves its lease; the sweep interrupts the session, counts its cost and clears the lease", async () => {
    const { hibana, cloud } = await bot();
    try {
      await hibana.respond("一つ目", { ...dm });
      expect(hibana.workspace.sessions.get("10")!.lease).toBeUndefined();
      cloud.onMessage = (session) => {
        session.process();
        session.use(47);
        session.emit(running(), reported(47), idle("retries_exhausted"));
      };
      await hibana.respond("二つ目", { ...dm });
      const [session] = cloud.sessions;
      // Written when the budget was raised: the 17 cents used plus this turn's 100.
      expect(hibana.workspace.sessions.get("10")!.lease).toMatchObject({ ceilingCents: 117 });
      // The failed turn is not counted yet, and is still held against the day's limit.
      expect(hibana.workspace.usage.summary().today).toEqual({ cost_usd: 0.17, turns: 1 });
      const before = cloud.sent.length;
      await hibana.workspace.sweep();
      expect(cloud.log.slice(before)).toEqual([`GET /sessions/${session!.id}`, `POST /sessions/${session!.id}/events user.interrupt`]);
      expect(hibana.workspace.sessions.get("10")!.lease).toBeUndefined();
      expect(hibana.workspace.sessions.get("10")!.totals!.list_cost_cents).toBe(47);
      // Its cost, but not a turn.
      expect(hibana.workspace.usage.summary().today).toEqual({ cost_usd: 0.47, turns: 1 });
      // A second pass finds nothing to do.
      await hibana.workspace.sweep();
      expect(cloud.sent).toHaveLength(before + 2);
    } finally { await hibana.close(); }
  });

  test("the sweep leaves a session alone while its turn is running", async () => {
    const { hibana, cloud } = await bot();
    try {
      cloud.onMessage = (session) => session.work();
      const turn = hibana.respond("長い作業", { ...dm });
      await until(() => cloud.sessions[0]?.messages.length === 1);
      const [session] = cloud.sessions;
      expect(hibana.workspace.sessions.get("10")!.lease).toMatchObject({ ceilingCents: 100 });
      await hibana.workspace.sweep();
      expect(session!.interrupts).toBe(0);
      session!.use(20);
      session!.emit(said("終わりました。"), reported(20), idle());
      expect(await turn).toBe("終わりました。");
      expect(session!.interrupts).toBe(0);
    } finally { await hibana.close(); }
  });

  test("a turn that starts while the sweep is stopping its session waits for the sweep", async () => {
    const { hibana, cloud } = await bot();
    try {
      cloud.onMessage = (session) => {
        session.process();
        session.use(30);
        session.emit(running(), reported(30), idle("retries_exhausted"));
      };
      await hibana.respond("一つ目", { ...dm });
      const [session] = cloud.sessions;
      // The sweep's interrupt is on its way when the next message arrives.
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      let interrupting = false;
      cloud.on(`POST /v1/sessions/${session!.id}/events`, (request) => {
        if (request.body!.events[0].type !== "user.interrupt" || interrupting) return undefined;
        interrupting = true;
        return held.then(() => undefined) as never;
      });
      const sweep = hibana.workspace.sweep();
      await until(() => interrupting);
      cloud.onMessage = (s) => s.answer("二つ目の返事");
      const turn = hibana.respond("二つ目", { ...dm });
      await Bun.sleep(20);
      // Otherwise that interrupt would land in the middle of the new turn.
      expect(session!.messages).toHaveLength(1);
      release();
      await sweep;
      expect(await turn).toBe("二つ目の返事");
      expect(session!.messages).toHaveLength(2);
      expect(session!.interrupts).toBe(1);
    } finally { await hibana.close(); }
  });

  test("a conversation cleared while the sweep is stopping its session has its usage counted once", async () => {
    const { hibana, cloud } = await bot();
    try {
      cloud.onMessage = (session) => {
        session.process();
        session.use(30);
        session.emit(running(), reported(30), idle("retries_exhausted"));
      };
      await hibana.respond("依頼", { ...dm });
      const [session] = cloud.sessions;
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      let interrupting = false;
      cloud.on(`POST /v1/sessions/${session!.id}/events`, () => {
        if (interrupting) return undefined;
        interrupting = true;
        return held.then(() => undefined) as never;
      });
      const sweep = hibana.workspace.sweep();
      await until(() => interrupting);
      hibana.history.clear("10");
      release();
      await sweep;
      await until(() => cloud.deleted.includes(session!.id));
      await until(() => hibana.workspace.sessions.disposals().length === 0);
      expect(hibana.workspace.usage.summary().today).toEqual({ cost_usd: 0.3, turns: 0 });
    } finally { await hibana.close(); }
  });

  test("a session that a dead process left running under a raised budget is stopped at the next start", async () => {
    const data = await mkdtemp(join(dir, "dead-"));
    const cloud = new Cloud();
    cloud.adopt("sesn_dead", { status: "running", budget: 300, used: 120 });
    const store = new ConversationStore(join(data, "conversations.db"));
    store.open();
    new SessionTable(store).save({
      channelId: "10", key: conversationKey({ provider: "anthropic_workspace", model: "claude-haiku-5-5", effort: "high" }, "workspace", "ultra"),
      sessionId: "sesn_dead", variant: "ultra", totals: sessionTotals({ list_cost: usd(100) }).totals, lease: { ceilingCents: 300, at: Date.now() },
    });
    store.close();
    const { hibana } = await bot({ ULTRA_MODE: "true" }, { data, cloud, open: true });
    try {
      await hibana.workspace.sweep();
      expect(cloud.log).toEqual([
        "GET /sessions/sesn_dead", "POST /sessions/sesn_dead/events user.interrupt", "POST /sessions/sesn_dead budget=121",
      ]);
      expect(hibana.workspace.sessions.get("10")!.lease).toBeUndefined();
      // The 20 cents it used since the row was last counted, as Haiku Ultra.
      expect(hibana.workspace.usage.summary().month_by_model["claude-haiku-5-5"]).toMatchObject({ cost_usd: 0.2, ultra_cost_usd: 0.2, turns: 0 });
    } finally { await hibana.close(); }
  });

  test("at the start the sessions a turn left behind are stopped first, and only a turn not yet resumed is picked up", async () => {
    const data = await mkdtemp(join(dir, "ready-"));
    const cloud = new Cloud();
    const first = await bot({}, { data, cloud, open: true });
    cloud.onMessage = (session) => {
      session.process();
      session.use(30);
      session.emit(running(), reported(30), idle("retries_exhausted"));
    };
    await first.hibana.respond("DM の依頼", { ...dm });
    await first.hibana.respond("サーバーの依頼", inGuild("11"));
    const saved = structuredClone(first.checkpoints());
    await first.hibana.close();
    const [direct, server] = cloud.sessions;
    // The DM's turn was already picked up once by an earlier start.
    saved["10/20"]!.ctx.workspaceMark!.resumes = 1;

    const second = await bot({}, { data, cloud, open: true });
    try {
      (second.hibana as unknown as { checkpoints: unknown }).checkpoints = saved;
      const client = second.hibana.client as unknown as { application: unknown; rest: { put: unknown } };
      client.application = { id: "1" };
      client.rest.put = async () => ({});
      // The sweep's first request is slow to answer.
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      let reading = false;
      cloud.on(`GET /v1/sessions/${direct!.id}`, () => {
        if (reading) return undefined;
        reading = true;
        return held.then(() => undefined) as never;
      });
      const before = cloud.sent.length;
      cloud.onMessage = (session) => session.answer("続きです。");
      await (second.hibana as unknown as { ready(): Promise<void> }).ready();
      await until(() => reading);
      await Bun.sleep(30);
      // The turn to resume is on the other session, and still waits: both
      // sessions held a lease, and both are stopped before it goes on.
      expect(server!.messages).toHaveLength(1);
      release();
      await until(() => second.sent.includes("続きです。"));
      expect(cloud.log.slice(before, before + 4)).toEqual([
        `GET /sessions/${direct!.id}`, `POST /sessions/${direct!.id}/events user.interrupt`,
        `GET /sessions/${server!.id}`, `POST /sessions/${server!.id}/events user.interrupt`,
      ]);
      expect(server!.messages).toHaveLength(2);
      expect(server!.text(1).startsWith("[The bot restarted")).toBe(true);
      expect(second.sent).toEqual(["続きです。"]);
      // The other one waits for `/retry`.
      expect(direct!.messages).toHaveLength(1);
      expect(second.checkpoints()["10/20"]!.ctx.workspaceMark!.resumes).toBe(1);
    } finally { await second.hibana.close(); }
  });

  test("the bot resumes a Workspace turn by itself once, then leaves it to /retry", () => {
    const checkpoint = (resumes?: number, at = Date.now()): Checkpoint => ({
      ctx: { ...dm, ...(resumes !== undefined && { workspaceMark: { sessionId: "sesn_1", eventId: "sevt_1", ceilingCents: 100, startedAt: at, resumes } }) },
      messages: [], at, historyStart: 0, selectionKey: "{}",
    });
    // The other harnesses, and a message the session never took.
    expect(resumesAtStart(checkpoint())).toBe(true);
    expect(resumesAtStart(checkpoint(0))).toBe(true);
    expect(resumesAtStart(checkpoint(1))).toBe(false);
    expect(resumesAtStart(checkpoint(undefined, Date.now() - 7_200_001))).toBe(false);
  });
});

describe("workflow runs", () => {
  test("a run left open is named to the next turn, and only the person who started it has its agents read for them", async () => {
    const { hibana, cloud, sent } = await bot({ ULTRA_MODE: "true" });
    const ran: { name: string; userId: string; depth: number; role?: string }[] = [];
    const execute = hibana.tools.execute.bind(hibana.tools);
    hibana.tools.execute = (name, args, ctx) => {
      ran.push({ name, userId: ctx.userId, depth: ctx.depth, role: ctx.agentRole });
      return execute(name, args, ctx);
    };
    try {
      // Person 20 starts a run; one of its agents reads a setting; the run pauses.
      cloud.onMessage = (session) => {
        session.process();
        session.emit(running(),
          { type: "workflow_run.created", workflow_run_id: "wrun_1", name: "survey", description: null, phases: [] },
          { type: "session.thread_created", session_thread_id: "sthr_1", agent_name: "reader", workflow_run_id: "wrun_1" },
          calls("get_bot_settings", "call_1", {}, "sthr_1"));
      };
      cloud.onResult = (session) => session.emit({ type: "workflow_run.status_idle", workflow_run_id: "wrun_1" }, said("調査を始めました。"), idle());
      await hibana.respond("調べて", inGuild("11", "20"));
      const [session] = cloud.sessions;
      expect(ran).toEqual([{ name: "get_bot_settings", userId: "20", depth: 1, role: "worker" }]);
      expect(session!.results[0]!.is_error).toBe(false);
      expect(sent.at(-1)).toBe("調査を始めました。\n\nバックグラウンドの作業（workflow run）が 1 件、止まったまま残っています。続けるには「続けて」と送ってください。");
      expect(hibana.workspace.sessions.get("11")!.state).toMatchObject({ openRuns: [{ id: "wrun_1", name: "survey" }], runOwners: { wrun_1: "20" } });

      // Person 21 writes next. The run wakes up in their turn.
      const turn = (thread: string, call: string) => (s: Session) => {
        s.process();
        s.emit(running(), { type: "session.thread_created", session_thread_id: thread, agent_name: "reader", workflow_run_id: "wrun_1" },
          calls("get_bot_settings", call, {}, thread));
      };
      cloud.onMessage = turn("sthr_2", "call_2");
      cloud.onResult = (s) => s.emit({ type: "workflow_run.status_idle", workflow_run_id: "wrun_1" }, said("別の人への返事"), idle());
      await hibana.respond("こんにちは", inGuild("11", "21"));
      // The session was stopped before its budget was raised for the new turn.
      expect(session!.interrupts).toBe(1);
      expect(session!.text(1)).toContain('[Workflow runs from an earlier turn are still open: "survey".');
      expect(ran).toHaveLength(1);
      expect(session!.results[1]).toMatchObject({ custom_tool_use_id: "call_2", is_error: true });
      expect(session!.results[1]!.content[0].text).toContain("the person now being answered did not start");
      // Still person 20's run.
      expect(hibana.workspace.sessions.get("11")!.state!.runOwners).toEqual({ wrun_1: "20" });

      cloud.onMessage = turn("sthr_3", "call_3");
      cloud.onResult = (s) => s.emit({ type: "workflow_run.status_ended", workflow_run_id: "wrun_1", result: { type: "completed" } }, running(), said("終わりました。"), idle());
      await hibana.respond("続けて", inGuild("11", "20"));
      expect(ran).toEqual([
        { name: "get_bot_settings", userId: "20", depth: 1, role: "worker" },
        { name: "get_bot_settings", userId: "20", depth: 1, role: "worker" },
      ]);
      expect(sent.at(-1)).toBe("終わりました。");
      expect(hibana.workspace.sessions.get("11")!.state).toMatchObject({ openRuns: [], runOwners: {}, turns: 3 });
    } finally { await hibana.close(); }
  });
});

describe("commands", () => {
  test("/info says where a Workspace conversation lives, and /context names the session", async () => {
    const { hibana } = await bot();
    const codex = await bot({ PROVIDER: "custom", LLM_BASE_URL: "https://example.com/v1", LLM_API_KEY: "key", LLM_MODEL: "test" });
    try {
      expect((await slash(hibana, "info")).split("\n")[0])
        .toBe("Anthropic Workspace: 会話と作業領域は Anthropic のクラウドにあります（チャンネルごと）。");
      // No session yet: the same answer every other provider gets.
      expect(await slash(hibana, "context")).toBe(await slash(codex.hibana, "context"));
      await hibana.respond("こんにちは", { ...dm });
      const context = JSON.parse((await slash(hibana, "context")).replace(/```json\n|\n```/g, ""));
      const row = hibana.workspace.sessions.get("10")!;
      expect(context).toMatchObject({ turns: 1, workspace: { variant: "plain", created_at: new Date(row.createdAt).toISOString() } });
      // The container is kept for 30 days from the session's creation.
      expect(Date.parse(context.workspace.container_until) - row.createdAt).toBe(30 * 86_400_000);
      expect(await slash(codex.hibana, "info")).not.toContain("Anthropic Workspace:");
    } finally {
      await hibana.close();
      await codex.hibana.close();
    }
  });

  test("/switch says when Ultra was stored but will not take effect on Anthropic Workspace", async () => {
    const sonnet = await bot({ LLM_MODEL: "claude-sonnet-5-5" });
    const haiku = await bot();
    try {
      const guild = inGuild("11");
      expect((await slash(sonnet.hibana, "switch", { ultra: "on" }, guild)).split("\n")[0])
        .toBe("Anthropic Workspace の Ultra は Haiku 5.5 だけで働きます。設定は保存しました。");
      expect(sonnet.hibana.runtime.guild(GUILD).ultra_mode).toBe(true);
      // On Haiku it works, and nothing needs saying.
      expect((await slash(haiku.hibana, "switch", { ultra: "on" }, guild)).startsWith("```json\n")).toBe(true);
      expect(haiku.hibana.runtime.resolve(GUILD, "20").workspace_ultra).toBe(true);
      expect((await slash(haiku.hibana, "switch", { multi: "on" }, guild)).split("\n")[0])
        .toBe("Anthropic Workspace の Ultra は、いまの設定では働きません（Multi-Agent が on か、ワークフローが無効です）。設定は保存しました。");
      expect((await slash(haiku.hibana, "switch", { ultra: "off" }, guild)).startsWith("```json\n")).toBe(true);
    } finally {
      await sonnet.hibana.close();
      await haiku.hibana.close();
    }
  });

  test("without a Workspace the commands answer as they did", async () => {
    const { hibana } = await bot();
    try {
      let text = "";
      const i = {
        commandName: "usage", user: { id: "20" }, guildId: null, channelId: "10",
        client: { user: { id: "30" } }, channel: { isThread: () => false },
        options: { getString: () => null, getBoolean: () => null },
        deferReply: async () => {}, reply: async () => {}, editReply: async (t: string) => { text = t; },
      };
      hibana.runtime.snapshot.user_roles["20"] = "administrator";
      const ledger = new UsageLedger(join(dir, "none.json"));
      await handleCommand(i as never, hibana.runtime, hibana.tools, hibana.history, hibana.voice, async () => {}, ledger);
      expect(text.startsWith("```json\n")).toBe(true);
    } finally { await hibana.close(); }
  });
});
