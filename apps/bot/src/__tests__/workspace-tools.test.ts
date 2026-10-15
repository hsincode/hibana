import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaFileMetadata } from "@anthropic-ai/sdk/resources/beta/files";
import { emptyUserOverride } from "@hibana/shared/settings";
import { Client } from "discord.js";
import { Agent } from "../agent";
import { loadConfig } from "../config";
import { LlmClient } from "../llm";
import { Runtime } from "../runtime";
import { ToolRegistry } from "../tools";
import definitions from "../tools/definitions.json";
import { ToolOutput, type Context, type Json } from "../types";
import {
  WORKSPACE_OUTPUTS, WorkspaceCalls, bindWorkspaceTurn, isWorkspaceTool, outputFiles, pickOutput, refuseFileArguments,
  toolFailure, toolResult, toolsFingerprint, workspaceToolParams,
} from "../workspace/tools";
import type { WorkspaceCall, WorkspaceResult } from "../workspace/types";
import { offline } from "./workspace-offline";

// Decision record: #76. The custom tools of an Anthropic Workspace session:
// which ones the session is given, who may run one when it is called, and how
// a file leaves the container. No request leaves the process.
// Should the client ever turn to the global `fetch`, that reaches no host.
offline();

const dir = await mkdtemp(join(tmpdir(), "hibana-workspace-tools-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PROVIDER: "anthropic_workspace", LLM_MODEL: "claude-haiku-5-5", ANTHROPIC_WORKSPACE_API_KEY: "fixture",
  SANDBOX_ENABLED: "false", SKILLS_ENABLED: "false", RUNTIME_STATE_PATH: "", LOG_DIR: "",
  HIBANA_DATA_DIR: dir, ...extra,
});
/** Every optional group of tools switched on: Jev and published sites. */
const full = { JEV_API_KEY: "fixture", STATIC_SITE_ENABLED: "true" };
const context = (extra: Partial<Context> = {}): Context => ({
  guildId: "1", channelId: "10", userId: "20", botId: "30", thread: false, depth: 0, delivered: false,
  harness: "workspace", ...extra,
});

type Posted = { path: string; body: Json; files?: { data: Buffer; name: string }[] };
type Fake = {
  /** Channels the person cannot read, and channels of another server. */
  hidden?: string[]; foreign?: string[];
  /** The person has no Discord permission beyond reading. */
  unprivileged?: boolean;
  get?: (path: string) => unknown;
  post?: (path: string) => unknown;
};
/** A registry on a Discord client that answers from memory. */
function registry(extra: NodeJS.ProcessEnv = {}, fake: Fake = {}) {
  const runtime = new Runtime(loadConfig(env(extra)));
  const discord = new Client({ intents: [] });
  const tools = new ToolRegistry(runtime, discord, new Agent(new LlmClient(runtime.config)));
  const posted: Posted[] = [], fetched: string[] = [], gets: string[] = [], asked: string[] = [];
  const member = (userId: string) => ({ id: userId, permissions: { has: () => !fake.unprivileged } });
  discord.channels.fetch = (async (id: string) => {
    fetched.push(id);
    return {
      id, guildId: fake.foreign?.includes(id) ? "2" : "1", isSendable: () => true,
      guild: { members: { fetch: async (userId: string) => member(userId) } },
      permissionsFor: () => ({ has: (flags: unknown) => (Array.isArray(flags) ? !fake.hidden?.includes(id) : !fake.unprivileged) }),
      send: async (message: { content: string }) => { asked.push(message.content); return { edit: async () => {} }; },
    };
  }) as never;
  discord.guilds.fetch = (async () => ({ ownerId: "1", members: { fetch: async (userId: string) => member(userId) } })) as never;
  discord.rest.get = (async (path: string) => { gets.push(path); return fake.get?.(path) ?? []; }) as never;
  discord.rest.post = (async (path: string, request: { body: Json; files?: Posted["files"] }) => {
    if (fake.post) return fake.post(path);
    posted.push({ path, body: request.body, files: request.files });
    return {
      id: "900", channel_id: path.split("/")[2],
      attachments: (request.files ?? []).map((f, i) => ({ id: String(i), filename: f.name, url: `https://cdn.example/${f.name}`, size: f.data.length, proxy_url: "x" })),
    };
  }) as never;
  // The external MCP server is a network call; nothing here may make one.
  tools.web.remote = (async () => ({ tools: [] })) as never;
  return { runtime, discord, tools, posted, fetched, gets, asked, close: async () => { await tools.close(); discord.destroy(); } };
}
const names = (tools: ToolRegistry, ctx: Context = context()) => tools.tools(ctx).map((t) => t.function.name);
const text = (result: WorkspaceResult) => result.content[0].text;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The turn's queue in front of a real registry, as the turn wires it.
 *  `owners` says who started which workflow run. */
function queued(tools: ToolRegistry, owners: Record<string, string> = {}) {
  const seen: Context[] = [];
  const queue = new WorkspaceCalls({
    execute: (name, args, ctx) => { seen.push(ctx); return tools.execute(name, args, ctx); },
    runOwner: (runId) => owners[runId],
  });
  let count = 0;
  const call = (name: string, input: unknown = {}, ctx: Context = context(), from: Partial<WorkspaceCall> = {}) =>
    queue.run({ id: `sevt_${++count}`, name, input, ...from }, ctx);
  return { queue, call, seen };
}

describe("the sandbox's send_file, which the other harnesses keep", () => {
  test("posts the file with its caption and no mentions, under the name asked for", async () => {
    const { tools, posted, close } = registry();
    try {
      const ctx = context({ harness: undefined });
      await tools.sandbox.write(ctx, "out/report.txt", "hello");
      const result = await tools.discord.sendFile(ctx, { path: "out/report.txt", content: "the report", filename: "dir/renamed.txt" });
      expect(posted).toEqual([{
        path: "/channels/10/messages",
        body: { content: "the report", allowed_mentions: { parse: [] } },
        files: [{ data: Buffer.from("hello"), name: "renamed.txt" }],
      }]);
      // What Discord answered is the result, and the turn knows it delivered.
      expect(result).toMatchObject({ id: "900", channel_id: "10" });
      expect(ctx.delivered).toBe(true);
    } finally { await close(); }
  });

  test("names the file after its path, sends no empty caption, and replies only when told to", async () => {
    const { tools, posted, close } = registry();
    try {
      const ctx = context({ harness: undefined });
      await tools.sandbox.write(ctx, "plot.png", "png");
      await tools.discord.sendFile(ctx, { path: "/workspace/plot.png", content: "", channel_id: "11" });
      await tools.discord.sendFile(ctx, { path: "plot.png" }, "555");
      expect(posted.map((p) => p.path)).toEqual(["/channels/11/messages", "/channels/10/messages"]);
      expect(JSON.parse(JSON.stringify(posted[0]!.body))).toEqual({ allowed_mentions: { parse: [] } });
      expect(posted[0]!.files).toEqual([{ data: Buffer.from("png"), name: "plot.png" }]);
      expect(JSON.parse(JSON.stringify(posted[1]!.body))).toEqual({
        allowed_mentions: { parse: [] },
        message_reference: { message_id: "555", fail_if_not_exists: false },
      });
    } finally { await close(); }
  });

  test("refuses a directory, a file over 25 MiB and a channel the person cannot read, and posts nothing", async () => {
    const { runtime, tools, posted, close } = registry({}, { hidden: ["12"] });
    try {
      const ctx = context({ harness: undefined });
      await tools.sandbox.write(ctx, "small.txt", "x");
      const root = join(runtime.config.workspaceRoot, "guilds/1");
      await mkdir(join(root, "folder"));
      await writeFile(join(root, "big.bin"), "");
      await truncate(join(root, "big.bin"), 25 * 1024 * 1024 + 1);
      await expect(tools.discord.sendFile(ctx, { path: "folder" })).rejects.toThrow("Attachment must be a regular file under 25 MiB");
      await expect(tools.discord.sendFile(ctx, { path: "big.bin" })).rejects.toThrow("Attachment must be a regular file under 25 MiB");
      await expect(tools.discord.sendFile(ctx, { path: "small.txt", channel_id: "12" })).rejects.toThrow("You cannot read this channel");
      expect(posted).toEqual([]);
      expect(ctx.delivered).toBe(false);
    } finally { await close(); }
  });
});

const DISCORD_READS = [
  "read_messages", "get_message", "search_messages", "list_pins", "list_channels", "get_channel", "get_guild",
  "get_guild_preview", "list_members", "search_members", "get_user", "get_member", "list_roles", "get_role",
  "list_emojis", "list_stickers", "list_active_threads", "list_public_archived_threads", "list_voice_regions",
];
/** What an agent of a workflow run can reach: reading only. */
const WORKER_TOOLS = [
  ...DISCORD_READS, "mcp_list_tools", "list_sites",
  "get_bot_settings", "get_user_context", "get_triggers", "get_bot_profile", "get_bot_member",
];
const BUILT_IN = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"];
const custom = (tools: ToolRegistry, ctx: Context = context()) =>
  workspaceToolParams(tools.tools(ctx), { web: true }).flatMap((t) => (t.type === "custom" ? [t] : []));

describe("the tool list", () => {
  test("has the 76 custom tools under their own names and none of the sandbox-bound ones", async () => {
    const { tools, close } = registry(full);
    try {
      const list = names(tools);
      expect(list).toHaveLength(76);
      // Delivery and the question come first; the rest keeps the registry's order.
      expect(list.slice(0, 3)).toEqual(["send_file", "AskUserQuestion", "run_jev"]);
      for (const name of [...DISCORD_READS, "ban_member", "send_message", "mcp_call_tool", "set_bot_model", "extend_site"])
        expect(list).toContain(name);
      for (const name of [
        "bash", "write_file", "write_files", "edit_file", "grep_files", "read_file", "list_files", "download_file",
        "download_attachment", "download_media", "playwright_cli", "video_edit", "generate_image", "edit_image",
        "image_generation_status", "publish_site", "use_skill", "list_skills", "websearch", "web_fetch_exa",
        "web_search_advanced_exa", "run_jev_task", "gh_status", "vpn_status", "home_vpn_status", "Bash", "Agent", "Skill",
      ]) expect(list).not.toContain(name);
      // With the built-in toolset the session's agent stays far below the API's 256.
      expect(workspaceToolParams(tools.tools(context()), { web: true })).toHaveLength(77);
    } finally { await close(); }
  });

  test("shrinks with the server's settings and is empty when tools are off", async () => {
    const { runtime, tools, close } = registry(full);
    try {
      // No server: the 31 tools that act on one are gone.
      expect(names(tools, context({ guildId: undefined }))).toHaveLength(45);
      runtime.snapshot.guilds["1"] = { ...runtime.guild("1"), mcp_enabled: false };
      expect(names(tools)).toHaveLength(74);
      runtime.snapshot.guilds["1"] = { ...runtime.guild("1"), server_tools: false };
      expect(names(tools)).toHaveLength(43);
    } finally { await close(); }
    // Neither Jev nor published sites configured.
    const plain = registry();
    try {
      expect(names(plain.tools)).toHaveLength(72);
      for (const name of ["run_jev", "list_sites", "unpublish_site", "extend_site"]) expect(names(plain.tools)).not.toContain(name);
    } finally { await plain.close(); }
    const off = registry({ ...full, TOOLS_ENABLED: "false" });
    try {
      expect(off.tools.tools(context())).toEqual([]);
      expect(off.tools.workspaceWeb(context())).toBe(false);
      // Not even the container's built-in tools.
      expect(workspaceToolParams(off.tools.workspaceTools(context()), { web: off.tools.workspaceWeb(context()) })).toEqual([]);
    } finally { await off.close(); }
  });

  test("every name is a valid custom tool name", async () => {
    const { tools, close } = registry(full);
    try {
      const list = names(tools);
      expect(new Set(list).size).toBe(list.length);
      for (const name of list) {
        expect(name).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
        expect(name).not.toMatch(/^(mcp__|ant__)/);
        expect(BUILT_IN).not.toContain(name);
        expect(isWorkspaceTool(name)).toBe(true);
      }
    } finally { await close(); }
  });

  test("no schema has a combinator at its top level, and the nested ones are the three known tools", async () => {
    const { tools, close } = registry(full);
    try {
      const nested: string[] = [];
      for (const tool of custom(tools)) {
        expect(tool.input_schema.type).toBe("object");
        for (const key of ["anyOf", "oneOf", "allOf", "not", "$ref", "if", "then", "else"]) expect(tool.input_schema).not.toHaveProperty(key);
        if (/"(anyOf|oneOf|allOf|not|minProperties|maxProperties)":/.test(JSON.stringify(tool.input_schema.properties ?? {}))) nested.push(tool.name);
        expect(tool.description).not.toBe("");
      }
      // Whether the API accepts these three is unconfirmed; the smoke run shows it.
      expect(nested.sort()).toEqual(["run_jev", "search_messages", "set_bot_model"]);
    } finally { await close(); }
  });

  test("is the same for every speaker, and Jev follows the server's switch", async () => {
    const { runtime, tools, close } = registry(full);
    try {
      runtime.snapshot.user_roles.admin = "administrator";
      runtime.snapshot.user_overrides["21"] = { ...emptyUserOverride(), jev_enabled: false };
      const params = (extra: Partial<Context>) => workspaceToolParams(tools.tools(context(extra)), { web: true });
      const expected = toolsFingerprint(params({}));
      // One person switched Jev off for themselves, one administers the bot,
      // and one call comes from an agent of a workflow run.
      for (const extra of [{ userId: "21" }, { userId: "admin" }, { depth: 1, agentRole: "worker" }])
        expect(toolsFingerprint(params(extra))).toBe(expected);
      expect(names(tools, context({ userId: "21" }))).toContain("run_jev");
      // Listed for everyone, but that person's own call is refused.
      const { call } = queued(tools);
      const refused = await call("run_jev", { state: "x", questions: { q: { type: "noul", instructions: "?" } } }, context({ userId: "21" }));
      expect(refused).toEqual({ content: [{ type: "text", text: "run_jev is not available to you in this conversation." }], is_error: true });
      runtime.snapshot.guilds["1"] = { ...runtime.guild("1"), jev_enabled: false };
      expect(names(tools)).not.toContain("run_jev");
      expect(names(tools, context({ userId: "21" }))).toEqual(names(tools));
    } finally { await close(); }
  });

  test("keeps send_file on a host without Docker", async () => {
    const { tools, close } = registry(full);
    try {
      expect(tools.sandbox.available).toBe(false);
      const without = names(tools);
      expect(without).toContain("send_file");
      // Nor does a host with Docker add the sandbox's tools to a session.
      tools.sandbox.available = true;
      expect(names(tools)).toEqual(without);
    } finally { await close(); }
  });

  test("does not offer file path arguments, or text about tools a session does not have", async () => {
    const { tools, close } = registry(full);
    try {
      const list = custom(tools);
      const properties = (name: string) => Object.keys(list.find((t) => t.name === name)!.input_schema.properties ?? {});
      expect(properties("edit_guild")).toEqual(["guild_id", "name", "description", "icon_url", "clear_icon"]);
      expect(properties("create_emoji")).toEqual(["guild_id", "name", "image_url"]);
      expect(properties("create_sticker")).toEqual(["guild_id", "name", "description", "tags", "image_url"]);
      expect(properties("set_bot_avatar")).toEqual(["image_url", "clear"]);
      expect(list.find((t) => t.name === "create_emoji")!.input_schema.required).toEqual(["name", "image_url"]);
      expect(properties("send_file")).toEqual(["path", "channel_id", "content", "filename"]);
      // The frozen descriptions speak of the bot's sandbox and of tools that
      // are not in a session's list. None of that reaches a session.
      const present = new Set(list.map((t) => t.name));
      const absent = (definitions as { function: { name: string } }[]).map((d) => d.function.name).filter((name) => !present.has(name));
      // 113 definitions, 75 of them listed; `send_file` is listed with a definition of its own.
      expect(absent).toHaveLength(38);
      for (const tool of list) {
        const shown = JSON.stringify({ description: tool.description, input_schema: tool.input_schema });
        expect(shown).not.toMatch(new RegExp(`\\b(${absent.join("|")})\\b`));
        expect(shown).not.toMatch(/sandbox|\/workspace|workspace-relative|workspace file/i);
      }
      // The registry still validates against the frozen schema, which has the argument.
      expect((definitions as { function: { name: string; parameters: Json } }[]).find((d) => d.function.name === "edit_guild")!.function.parameters)
        .toHaveProperty("properties.icon_path");
    } finally { await close(); }
  });

  test("turns web search and fetch off with the setting", async () => {
    const on = registry(full);
    try {
      expect(on.tools.workspaceWeb(context())).toBe(true);
      const list = on.tools.workspaceTools(context());
      expect(workspaceToolParams(list, { web: true })[0]).toEqual({
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      });
      const without = workspaceToolParams(list, { web: false });
      expect(without[0]).toEqual({
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
        configs: [{ name: "web_search", enabled: false }, { name: "web_fetch", enabled: false }],
      });
      // A different list is a different fingerprint.
      expect(toolsFingerprint(without)).not.toBe(toolsFingerprint(workspaceToolParams(list, { web: true })));
      // The server's `exa_mode: off` switches every web tool off (#46).
      on.runtime.snapshot.guilds["1"] = { ...on.runtime.guild("1"), exa_mode: "off" };
      expect(on.tools.workspaceWeb(context())).toBe(false);
      expect(on.tools.workspaceWeb(context({ guildId: "2" }))).toBe(true);
    } finally { await on.close(); }
    for (const extra of [{ ANTHROPIC_WORKSPACE_WEB_ENABLED: "false" }, { WEB_SEARCH_ENABLED: "false" }]) {
      const off = registry({ ...full, ...extra });
      try { expect(off.tools.workspaceWeb(context())).toBe(false); } finally { await off.close(); }
    }
  });

  test("leaves the list of the other providers' turns as it was", async () => {
    const { tools, close } = registry(full);
    try {
      const codex = names(tools, context({ harness: undefined }));
      expect(codex).toContain("mcp__discord__read_messages");
      expect(codex).not.toContain("read_messages");
      expect(codex).not.toContain("AskUserQuestion");
      expect(tools.jevTaskMode(context())).toBe(false);
    } finally { await close(); }
  });
});

describe("a call", () => {
  test("reaches the tool with the person's own context and comes back as text", async () => {
    const { tools, gets, close } = registry(full, { get: () => [{ id: "5", content: "hi", attachments: [{ url: "https://cdn.example/a.png" }] }] });
    try {
      const { call, seen } = queued(tools);
      const ctx = context();
      const result = await call("read_messages", { limit: 5 }, ctx);
      expect(result).toEqual({
        content: [{ type: "text", text: JSON.stringify([{ id: "5", content: "hi", attachments: [{ url: "https://cdn.example/a.png" }] }]) }],
        is_error: false,
      });
      expect(gets).toEqual(["/channels/10/messages"]);
      expect(seen[0]).toMatchObject({ userId: "20", depth: 0, harness: "workspace" });
      expect(seen[0]!.agentRole).toBeUndefined();
    } finally { await close(); }
  });

  test("that does not come through the turn's queue is refused", async () => {
    const { tools, gets, posted, close } = registry(full);
    try {
      await expect(tools.execute("read_messages", {}, context())).rejects.toThrow("must come through the turn's call queue");
      // Claiming to be the primary thread does not help, nor does a context
      // that a finished call was run on.
      await expect(tools.execute("send_message", { content: "hi" }, context({ depth: 0, agentRole: undefined }))).rejects.toThrow("must come through");
      const { call, seen } = queued(tools);
      await call("read_messages", {});
      await expect(tools.execute("send_message", { content: "hi" }, seen[0]!)).rejects.toThrow("must come through");
      expect(gets).toHaveLength(1);
      expect(posted).toEqual([]);
    } finally { await close(); }
  });

  test("a blocked user is refused, and so is everyone where the bot is switched off", async () => {
    const { runtime, tools, gets, close } = registry(full);
    try {
      const { call } = queued(tools);
      runtime.snapshot.blocked_users.push("20");
      expect(await call("read_messages", {})).toEqual({ content: [{ type: "text", text: "Bot access disabled" }], is_error: true });
      expect((await call("read_messages", { limit: 2 }, context({ userId: "21" }))).is_error).toBe(false);
      runtime.snapshot.guilds["1"] = { ...runtime.guild("1"), bot_disabled: true };
      expect(text(await call("read_messages", { limit: 3 }, context({ userId: "21" })))).toBe("Bot access disabled");
      expect(gets).toHaveLength(1);
    } finally { await close(); }
  });

  test("a tool the speaker may not run says so", async () => {
    const { tools, posted, close } = registry(full, { unprivileged: true });
    try {
      const { call } = queued(tools);
      // Discord permissions are the requester's own.
      const ban = await call("ban_member", { user_id: "77" });
      expect(ban).toEqual({ content: [{ type: "text", text: "You do not have permission for this operation" }], is_error: true });
      expect(text(await call("set_bot_username", { username: "x" }))).toContain("Administrator role required");
      // A server's tool is listed for a server only.
      expect(text(await call("list_bans", {}, context({ guildId: undefined })))).toBe("list_bans is not available to you in this conversation.");
      expect(posted).toEqual([]);
    } finally { await close(); }
  });

  test("arguments are checked against the schema", async () => {
    const { tools, gets, asked, close } = registry(full);
    try {
      const { call } = queued(tools);
      expect(text(await call("read_messages", { limit: "many" }))).toBe("Invalid arguments for read_messages: /limit must be integer");
      expect(text(await call("send_file", { path: "/mnt/session/outputs/a.txt", mode: "inline" }))).toContain("Invalid arguments for send_file: input must NOT have additional properties");
      expect(text(await call("send_file", {}))).toContain("Invalid arguments for send_file: input must have required property 'path'");
      expect(text(await call("AskUserQuestion", { questions: [] }))).toContain("Invalid arguments for AskUserQuestion");
      for (const input of [null, "limit=5", [1], 5]) expect(await call("read_messages", input)).toEqual(toolFailure("Arguments must be an object"));
      expect(gets).toEqual([]);
      expect(asked).toEqual([]);
    } finally { await close(); }
  });

  test("names the other providers' turns use are not callable", async () => {
    const { tools, close } = registry(full);
    tools.sandbox.available = true;
    try {
      const { call, seen } = queued(tools);
      for (const name of ["Bash", "Read", "shell_command", "mcp__discord__send_message", "mcp__workspace__send_file", "download_file", "publish_site", "run_jev_task", "use_skill", "bash", "web_search"])
        expect(await call(name, { command: "ls" })).toEqual(toolFailure(`${name} is not a tool of this workspace.`));
      // A session's call is a session's call even on a context that lost its
      // mark: it never reaches the sandbox tool of the same name.
      expect(await call("bash", { command: "ls" }, context({ harness: undefined }))).toEqual(toolFailure("bash is not a tool of this workspace."));
      expect(text(await call("send_file", { path: "notes.txt" }, context({ harness: undefined })))).toBe("send_file needs a cloud workspace session.");
      expect(seen.every((ctx) => ctx.harness === "workspace")).toBe(true);
    } finally { await close(); }
  });

  test("a call from a run's thread can read but not post, ask or change settings", async () => {
    const { tools, gets, posted, asked, close } = registry(full);
    try {
      const { call, seen } = queued(tools, { wrun_1: "20" });
      const thread = { threadId: "sthr_1", runId: "wrun_1" };
      const ctx = context({ progress: async () => {}, notify: async () => {}, openStatus: () => async () => {} });
      expect((await call("read_messages", { limit: 5 }, ctx, thread)).is_error).toBe(false);
      // The registry sees a worker one level down, with the person's identity
      // and no way to write the turn's status messages.
      expect(seen[0]).toMatchObject({ userId: "20", guildId: "1", depth: 1, agentRole: "worker", harness: "workspace" });
      expect([seen[0]!.progress, seen[0]!.notify, seen[0]!.openStatus]).toEqual([undefined, undefined, undefined]);
      const refused: [string, Json][] = [
        ["send_message", { content: "hi" }],
        ["send_file", { path: `${WORKSPACE_OUTPUTS}a.txt` }],
        ["AskUserQuestion", { questions: [{ question: "Go?", header: "Go", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }] }],
        ["set_bot_model", { preset: "anthropic-workspace-opus-5-5" }],
        ["set_user_context", { text: "x" }],
        ["mcp_call_tool", { name: "x", arguments: {} }],
        ["ban_member", { user_id: "77" }],
        ["add_reaction", { emoji: "wave" }],
        ["unpublish_site", { token: "abc" }],
      ];
      for (const [name, input] of refused)
        expect(await call(name, input, ctx, thread)).toEqual(toolFailure(`An agent of a workflow run cannot use ${name}. Return what is needed in your result instead.`));
      // Jev is the root's to call.
      expect(text(await call("run_jev", { state: "x", questions: { q: { type: "noul", instructions: "?" } } }, ctx, thread)))
        .toBe("run_jev is not available to you in this conversation.");
      expect(posted).toEqual([]);
      expect(asked).toEqual([]);
      expect(gets).toEqual(["/channels/10/messages"]);
      expect(ctx.delivered).toBe(false);
      // The same call from the primary thread is the person's own.
      expect((await call("send_message", { content: "hi" }, ctx)).is_error).toBe(false);
      expect(posted.map((p) => p.body.content)).toEqual(["hi"]);
    } finally { await close(); }
  });

  test("the tools a run's thread can reach are the 26 that only read", async () => {
    const { tools, posted, close } = registry(full);
    try {
      const { call } = queued(tools, { wrun_1: "20" });
      const reached: string[] = [];
      for (const name of names(tools)) {
        const result = await call(name, {}, context(), { threadId: "sthr_1", runId: "wrun_1" });
        if (!/cannot use|is not available to you/.test(text(result))) reached.push(name);
      }
      expect(reached.sort()).toEqual([...WORKER_TOOLS].sort());
      expect(reached).toHaveLength(26);
      expect(posted).toEqual([]);
    } finally { await close(); }
  });

  test("a run started by another person cannot read with the current speaker's permissions", async () => {
    const { tools, gets, close } = registry(full);
    try {
      // wrun_1 was started in an earlier turn by 99; this turn is 20's.
      const { call, seen } = queued(tools, { wrun_1: "99", wrun_2: "20" });
      const other = await call("read_messages", { limit: 5 }, context(), { threadId: "sthr_1", runId: "wrun_1" });
      expect(other.is_error).toBe(true);
      expect(text(other)).toContain("a workflow run that the person now being answered did not start");
      // A thread whose run is unknown, or a run nobody is recorded to have
      // started, is nobody's. It is refused too, without a claim about who
      // started it: that may well be the person now being answered.
      for (const from of [{ threadId: "sthr_2" }, { threadId: "sthr_3", runId: "wrun_9" }]) {
        const unknown = await call("read_messages", { limit: 5 }, context(), from);
        expect(unknown.is_error).toBe(true);
        expect(text(unknown)).toContain("Who started the workflow run it comes from is not known here");
        expect(text(unknown)).not.toContain("did not start");
      }
      expect(seen).toEqual([]);
      expect(gets).toEqual([]);
      expect((await call("read_messages", { limit: 5 }, context(), { threadId: "sthr_4", runId: "wrun_2" })).is_error).toBe(false);
    } finally { await close(); }
  });

  test("a file path argument is refused with what to do instead", async () => {
    const { tools, close } = registry(full);
    try {
      const { call } = queued(tools);
      const icon = await call("edit_guild", { icon_path: "icon.png" });
      expect(icon.is_error).toBe(true);
      expect(text(icon)).toBe(
        "icon_path is not supported in the cloud workspace: this tool runs outside the container and cannot read its files. Pass a public https URL in icon_url. For a file in the container, deliver it with send_file first and use the url of the attachment in its result.",
      );
      expect(text(await call("create_emoji", { name: "cat", path: "cat.png" }))).toContain("path is not supported in the cloud workspace");
      expect(() => refuseFileArguments("set_bot_avatar", { path: "a.png" })).toThrow("Pass a public https URL in image_url");
      expect(() => refuseFileArguments("create_sticker", { name: "s", image_url: "https://example.com/s.png" })).not.toThrow();
      // Another tool's `path` is its own business.
      expect(() => refuseFileArguments("send_file", { path: "/mnt/session/outputs/a.png" })).not.toThrow();
    } finally { await close(); }
  });

  test("a long result is cut at both ends", async () => {
    const messages = Array.from({ length: 400 }, (_, i) => ({ id: String(i), content: "x".repeat(200) }));
    const { tools, close } = registry(full, { get: () => messages });
    try {
      const { call } = queued(tools);
      const result = await call("read_messages", { limit: 100 });
      const whole = JSON.stringify(messages);
      expect(whole.length).toBeGreaterThan(80_000);
      expect(text(result).length).toBeLessThan(40_100);
      expect(text(result)).toContain(`[... ${whole.length - 40_000} characters left out ...]`);
      expect(text(result).startsWith(whole.slice(0, 1000))).toBe(true);
      expect(text(result).endsWith(whole.slice(-1000))).toBe(true);
    } finally { await close(); }
  });

  test("a thrown error becomes an error result, and a result keeps the tool's own failure flag", async () => {
    const { tools, close } = registry(full, { post: () => { throw new Error("Missing Permissions"); } });
    try {
      const { call } = queued(tools);
      const ctx = context();
      expect(await call("send_message", { content: "hi" }, ctx)).toEqual({ content: [{ type: "text", text: "Missing Permissions" }], is_error: true });
      expect(text(await call("get_user", { user_id: "not-an-id" }, ctx))).toBe("Expected a Discord snowflake string");
      expect(ctx.delivered).toBe(false);
    } finally { await close(); }
    expect(toolResult(new ToolOutput("exit 2", { isError: true }))).toEqual({ content: [{ type: "text", text: "exit 2" }], is_error: true });
    expect(toolResult(new ToolOutput(""))).toEqual({ content: [{ type: "text", text: "(no output)" }], is_error: false });
    expect(toolResult({ ok: true })).toEqual({ content: [{ type: "text", text: '{"ok":true}' }], is_error: false });
    expect(toolFailure("plain")).toEqual({ content: [{ type: "text", text: "plain" }], is_error: true });
  });

  test("asks the person the question and gives the answer back as text", async () => {
    const { tools, asked, close } = registry(full);
    try {
      const { call } = queued(tools);
      const stop = new AbortController();
      const pending = call("AskUserQuestion", {
        questions: [{ question: "Ship it?", header: "Ship", options: [{ label: "Yes", description: "now" }, { label: "No", description: "later" }] }],
      }, context({ signal: stop.signal }));
      while (!asked.length) await tick();
      expect(asked[0]).toContain("Ship it?");
      // Nobody answers; the turn ends instead.
      stop.abort(new Error("User steering"));
      const result = await pending;
      expect(result.is_error).toBe(false);
      expect(text(result)).toContain("Ship it?\nNot answered.");
      expect(text(result)).toContain("The wait ended (cancelled)");
      expect(tools.waiting.size).toBe(0);
    } finally { await close(); }
  });
});

/** An `execute` whose calls stay open until the test lets each one finish. */
function gated() {
  const started: string[] = [], open = new Map<string, () => void>();
  const execute = async (name: string, args: Json) => {
    const key = String(args.n ?? name);
    started.push(key);
    await new Promise<void>((resolve) => open.set(key, resolve));
    return key;
  };
  const finish = async (...keys: string[]) => { for (const key of keys) open.get(key)!(); await tick(); };
  return { started, execute, finish };
}

describe("the queue", () => {
  test("reads overlap up to six; a write waits for them and holds later reads", async () => {
    const { started, execute, finish } = gated();
    const queue = new WorkspaceCalls({ execute, runOwner: () => undefined });
    const ctx = context();
    const results: Promise<WorkspaceResult>[] = [];
    for (let n = 1; n <= 8; n++) results.push(queue.run({ id: `r${n}`, name: "read_messages", input: { n } }, ctx));
    results.push(queue.run({ id: "w", name: "send_message", input: { n: "w" } }, ctx));
    results.push(queue.run({ id: "late", name: "get_guild", input: { n: "late" } }, ctx));
    await tick();
    expect(started).toEqual(["1", "2", "3", "4", "5", "6"]);
    await finish("1", "2");
    expect(started).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    // The write is next in line, so the read behind it does not jump ahead
    // into the free slots.
    await finish("3", "4", "5", "6", "7");
    expect(started).toHaveLength(8);
    await finish("8");
    expect(started.slice(8)).toEqual(["w"]);
    await finish("w");
    expect(started.slice(8)).toEqual(["w", "late"]);
    await finish("late");
    expect((await Promise.all(results)).map(text)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "w", "late"]);
  });

  test("Jev's judgments count as reads, and send_file as a change", async () => {
    const { started, execute, finish } = gated();
    const queue = new WorkspaceCalls({ execute, runOwner: () => undefined });
    const ctx = context();
    void queue.run({ id: "1", name: "run_jev", input: { n: "jev1" } }, ctx);
    void queue.run({ id: "2", name: "run_jev", input: { n: "jev2" } }, ctx);
    void queue.run({ id: "3", name: "send_file", input: { n: "file" } }, ctx);
    void queue.run({ id: "4", name: "list_sites", input: { n: "sites" } }, ctx);
    await tick();
    expect(started).toEqual(["jev1", "jev2"]);
    await finish("jev1", "jev2");
    expect(started).toEqual(["jev1", "jev2", "file"]);
    await finish("file");
    expect(started).toEqual(["jev1", "jev2", "file", "sites"]);
    await finish("sites");
  });

  test("a question does not hold the queue", async () => {
    const { started, execute, finish } = gated();
    const queue = new WorkspaceCalls({ execute, runOwner: () => "20" });
    const ctx = context();
    const question = queue.run({ id: "q", name: "AskUserQuestion", input: { n: "question" } }, ctx);
    const read = queue.run({ id: "r", name: "read_messages", input: { n: "read" }, threadId: "sthr_1", runId: "wrun_1" }, ctx);
    const write = queue.run({ id: "w", name: "send_message", input: { n: "write" } }, ctx);
    await tick();
    expect(started).toEqual(["question", "read"]);
    await finish("read");
    await finish("write");
    expect((await Promise.all([read, write])).map(text)).toEqual(["read", "write"]);
    // A change that came first does not hold a question either.
    const held = queue.run({ id: "w2", name: "send_message", input: { n: "write2" } }, ctx);
    const second = queue.run({ id: "q2", name: "AskUserQuestion", input: { n: "question2" } }, ctx);
    await tick();
    expect(started.slice(-2).sort()).toEqual(["question2", "write2"]);
    await finish("question", "question2", "write2");
    expect((await Promise.all([question, second, held])).map(text)).toEqual(["question", "question2", "write2"]);
  });

  test("closing answers what has not started", async () => {
    const { started, execute, finish } = gated();
    const queue = new WorkspaceCalls({ execute, runOwner: () => undefined });
    const ctx = context();
    const running = queue.run({ id: "a", name: "send_message", input: { n: "a" } }, ctx);
    const waiting = [
      queue.run({ id: "b", name: "send_message", input: { n: "b" } }, ctx),
      queue.run({ id: "c", name: "read_messages", input: { n: "c" } }, ctx),
    ];
    await tick();
    queue.close("The turn ended before this call ran.");
    expect(await Promise.all(waiting)).toEqual([toolFailure("The turn ended before this call ran."), toolFailure("The turn ended before this call ran.")]);
    // What is running finishes and reports what it did.
    await finish("a");
    expect(await running).toEqual({ content: [{ type: "text", text: "a" }], is_error: false });
    expect(await queue.run({ id: "d", name: "read_messages", input: { n: "d" } }, ctx)).toEqual(toolFailure("The turn ended before this call ran."));
    expect(started).toEqual(["a"]);
  });

  test("the same event id runs once", async () => {
    let runs = 0;
    const queue = new WorkspaceCalls({ execute: async () => `run ${++runs}`, runOwner: () => undefined });
    const ctx = context();
    const call = { id: "sevt_1", name: "read_messages", input: { limit: 5 } };
    const first = queue.run(call, ctx);
    // The stream was reopened and the event list replayed the call.
    expect(queue.run({ ...call }, ctx)).toBe(first);
    expect(text(await first)).toBe("run 1");
    expect(queue.run({ ...call }, ctx)).toBe(first);
    queue.close("over");
    expect(text(await queue.run({ ...call }, ctx))).toBe("run 1");
    expect(runs).toBe(1);
  });

  test("a third identical call in a row is refused, counted for each thread on its own", async () => {
    let runs = 0;
    const queue = new WorkspaceCalls({ execute: async () => `run ${++runs}`, runOwner: () => "20" });
    const ctx = context();
    let id = 0;
    const call = (input: Json, threadId?: string) => queue.run({ id: `e${++id}`, name: "read_messages", input, threadId, runId: threadId && "wrun_1" }, ctx);
    const looping = "This exact call was just made twice in a row. Use those results or change the approach.";
    expect(text(await call({ limit: 5 }))).toBe("run 1");
    expect(text(await call({ limit: 5 }))).toBe("run 2");
    expect(await call({ limit: 5 })).toEqual(toolFailure(looping));
    // The same arguments in another order are the same call.
    expect(await call({ channel_id: "10", limit: 5 })).not.toEqual(toolFailure(looping));
    expect(await call({ limit: 5, channel_id: "10" })).not.toEqual(toolFailure(looping));
    expect(await call({ limit: 5, channel_id: "10" })).toEqual(toolFailure(looping));
    // Other work in between ends the streak.
    expect((await call({ limit: 6 })).is_error).toBe(false);
    expect((await call({ limit: 5, channel_id: "10" })).is_error).toBe(false);
    // Two agents of a run making the same call are not one agent looping.
    for (const thread of ["sthr_1", "sthr_2", "sthr_1", "sthr_2"]) expect((await call({ limit: 9 }, thread)).is_error).toBe(false);
    expect(await call({ limit: 9 }, "sthr_1")).toEqual(toolFailure(looping));
  });

  test("a call that had not started when the turn was stopped says so, and one that had reports what it did", async () => {
    const { started, execute, finish } = gated();
    const queue = new WorkspaceCalls({ execute, runOwner: () => undefined });
    const stop = new AbortController();
    const ctx = context({ signal: stop.signal });
    const running = queue.run({ id: "a", name: "send_message", input: { n: "a" } }, ctx);
    const waiting = queue.run({ id: "b", name: "ban_member", input: { n: "b" } }, ctx);
    await tick();
    stop.abort(new Error("User steering"));
    // Answered now, not when the call ahead of it finishes: the runner tells
    // the model that a call still running "may have taken effect", and this
    // one cannot have.
    expect(await waiting).toEqual(toolFailure("The turn was stopped before this call ran."));
    expect(await queue.run({ id: "c", name: "send_message", input: { n: "c" } }, ctx)).toEqual(toolFailure("The turn was stopped before this call ran."));
    expect(await queue.run({ id: "d", name: "AskUserQuestion", input: { n: "d" } }, ctx)).toEqual(toolFailure("The turn was stopped before this call ran."));
    await finish("a");
    expect(await running).toEqual({ content: [{ type: "text", text: "a" }], is_error: false });
    expect(started).toEqual(["a"]);
    // The queue is not left stuck behind the call that was dropped.
    const next = queue.run({ id: "e", name: "send_message", input: { n: "e" } }, context());
    await tick();
    await finish("e");
    expect(text(await next)).toBe("e");
  });
});

const OUT = WORKSPACE_OUTPUTS;
const listed = (id: string, filename: string, extra: Partial<BetaFileMetadata> = {}): BetaFileMetadata => ({
  id, type: "file", filename, mime_type: "text/plain", size_bytes: 5, created_at: "2026-10-12T00:00:00Z",
  downloadable: true, scope: { type: "session", id: "sesn_1" }, ...extra,
});
type Request = { method: string; path: string; query: Record<string, string | undefined>; headers: Record<string, string> };
/** The official SDK on a fetch that serves the Files API from memory. Each
 *  listing request gets the next entry of `listings`, the last one repeating;
 *  an entry that is a list of lists is served as pages. */
function filesApi(listings: (BetaFileMetadata[] | BetaFileMetadata[][])[], bodies: Record<string, string | Uint8Array> = {}) {
  const requests: Request[] = [];
  let listing = -1;
  const client = new Anthropic({
    apiKey: "fixture", authToken: null, baseURL: "https://api.anthropic.test", maxRetries: 0, logLevel: "off",
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({
        method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(new Headers(init?.headers as HeadersInit)),
      });
      if (url.pathname === "/v1/files") {
        const page = url.searchParams.get("page");
        if (!page) listing = Math.min(listing + 1, listings.length - 1);
        const entry = listings[listing]!;
        const pages = (Array.isArray(entry[0]) ? entry : [entry]) as BetaFileMetadata[][];
        const index = page ? Number(page.slice(5)) : 0;
        return Response.json({ data: pages[index] ?? [], next_page: index + 1 < pages.length ? `page_${index + 1}` : null });
      }
      const content = /^\/v1\/files\/([^/]+)\/content$/.exec(url.pathname);
      if (content && bodies[content[1]!] !== undefined) return new Response(bodies[content[1]!] as BodyInit, { headers: { "content-type": "application/octet-stream" } });
      return Response.json({ type: "error", error: { type: "not_found_error", message: "File not found" } }, { status: 404 });
    },
  });
  return { client, requests, lists: () => requests.filter((r) => r.path === "/v1/files").length };
}
/** A turn bound to session sesn_1, whose waits are recorded instead of slept. */
function bound(client: Anthropic, extra: Partial<Context> = {}) {
  const ctx = context(extra), sleeps: number[] = [];
  bindWorkspaceTurn(ctx, { sessionId: "sesn_1", files: outputFiles(client), sleep: async (ms) => { sleeps.push(ms); } });
  return { ctx, sleeps };
}

describe("send_file", () => {
  test("lists with scope_id and the managed-agents beta header, downloads and posts", async () => {
    const { tools, posted, close } = registry(full);
    const { client, requests } = filesApi([[listed("file_1", "report.txt")]], { file_1: "hello" });
    try {
      const { call } = queued(tools);
      const { ctx, sleeps } = bound(client);
      const result = await call("send_file", { path: `${OUT}report.txt`, content: "the report <@20>" }, ctx);
      expect(result.is_error).toBe(false);
      expect(JSON.parse(text(result))).toEqual({
        ok: true, message_id: "900", channel_id: "10",
        attachments: [{ filename: "report.txt", url: "https://cdn.example/report.txt", size: 5 }],
        file: { filename: "report.txt", size_bytes: 5, created_at: "2026-10-12T00:00:00Z" },
      });
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/files", "GET /v1/files/file_1/content"]);
      expect(requests[0]!.query).toMatchObject({ scope_id: "sesn_1", limit: "100" });
      expect(requests[0]!.headers["anthropic-beta"]).toBe("managed-agents-2026-04-01");
      expect(requests[0]!.headers["x-api-key"]).toBe("fixture");
      expect(requests[0]!.headers.authorization).toBeUndefined();
      expect(posted).toEqual([{
        path: "/channels/10/messages",
        body: { content: "the report <@20>", allowed_mentions: { parse: [] } },
        files: [{ data: Buffer.from("hello"), name: "report.txt" }],
      }]);
      expect(ctx.delivered).toBe(true);
      expect(sleeps).toEqual([]);
    } finally { await close(); }
  });

  test("posts in another channel of the server, under another name, and reads every page of the listing", async () => {
    const { tools, posted, close } = registry(full);
    const pages = [[listed("file_1", "a.txt")], [listed("file_2", "b.txt")], [listed("file_3", "chart.png")]];
    const { client, requests } = filesApi([pages], { file_3: "png" });
    try {
      const { call } = queued(tools);
      const { ctx } = bound(client);
      const result = await call("send_file", { path: `${OUT}./chart.png`, channel_id: "11", filename: "final/figure.png" }, ctx);
      expect(result.is_error).toBe(false);
      expect(requests.filter((r) => r.path === "/v1/files").map((r) => r.query.page)).toEqual([undefined, "page_1", "page_2"]);
      expect(posted.map((p) => [p.path, p.files![0]!.name])).toEqual([["/channels/11/messages", "figure.png"]]);
      expect(JSON.parse(JSON.stringify(posted[0]!.body))).toEqual({ allowed_mentions: { parse: [] } });
    } finally { await close(); }
  });

  test("waits for a file that is not listed yet", async () => {
    const { tools, posted, close } = registry(full);
    const { client, lists } = filesApi([[], [listed("file_0", "other.txt")], [listed("file_1", "report.txt")]], { file_1: "hello" });
    try {
      const { call } = queued(tools);
      const { ctx, sleeps } = bound(client);
      expect((await call("send_file", { path: `${OUT}report.txt` }, ctx)).is_error).toBe(false);
      expect(sleeps).toEqual([1000, 2000]);
      expect(lists()).toBe(3);
      expect(posted).toHaveLength(1);
    } finally { await close(); }
  });

  test("gives up after nine listings", async () => {
    const { tools, posted, close } = registry(full);
    const { client, requests, lists } = filesApi([[listed("file_0", "other.txt")]]);
    try {
      const { call } = queued(tools);
      const { ctx, sleeps } = bound(client);
      expect(await call("send_file", { path: `${OUT}report.txt` }, ctx)).toEqual(toolFailure(
        "report.txt did not appear in the session's output files within 30 seconds. Check it with ls -l and call send_file again.",
      ));
      expect(lists()).toBe(9);
      expect(sleeps).toEqual([1000, 2000, 3000, 4000, 5000, 5000, 5000, 5000]);
      expect(sleeps.reduce((a, b) => a + b)).toBe(30_000);
      expect(requests.every((r) => r.path === "/v1/files")).toBe(true);
      expect(posted).toEqual([]);
      expect(ctx.delivered).toBe(false);
    } finally { await close(); }
  });

  test("refuses a path outside the outputs directory without calling the API", async () => {
    const { tools, posted, fetched, close } = registry(full);
    const { client, requests } = filesApi([[listed("file_1", "report.txt")]], { file_1: "hello" });
    try {
      const { call } = queued(tools);
      const { ctx } = bound(client);
      for (const path of ["report.txt", "/workspace/report.txt", "/mnt/session/uploads/report.txt", `${OUT}../report.txt`, `${OUT}a/../../report.txt`, OUT, "/mnt/session/outputs", `${OUT}reports/`])
        expect(await call("send_file", { path }, ctx)).toEqual(toolFailure(
          "send_file only delivers files under /mnt/session/outputs/. Copy the file there (cp <file> /mnt/session/outputs/) and pass that path.",
        ));
      expect(requests).toEqual([]);
      expect(fetched).toEqual([]);
      expect(posted).toEqual([]);
    } finally { await close(); }
  });

  test("takes the newest of same-named files", async () => {
    const { tools, posted, close } = registry(full);
    const { client, requests } = filesApi([[
      listed("file_old", "report.txt", { created_at: "2026-10-12T00:00:00Z" }),
      listed("file_new", `${OUT}report.txt`, { created_at: "2026-10-12T00:05:00Z" }),
      listed("file_mid", "/report.txt", { created_at: "2026-10-12T00:01:00Z" }),
    ]], { file_old: "old", file_new: "new", file_mid: "mid" });
    try {
      const { call } = queued(tools);
      const { ctx } = bound(client);
      expect((await call("send_file", { path: `${OUT}report.txt` }, ctx)).is_error).toBe(false);
      expect(requests.at(-1)!.path).toBe("/v1/files/file_new/content");
      expect(posted[0]!.files).toEqual([{ data: Buffer.from("new"), name: "report.txt" }]);
    } finally { await close(); }
  });

  test("finds a file in a subdirectory however the listing names it, and refuses an ambiguous base name", async () => {
    const { tools, posted, close } = registry(full);
    try {
      const { call } = queued(tools);
      const send = async (files: BetaFileMetadata[]) => {
        const { client } = filesApi([files], { file_1: "one", file_2: "two" });
        const { ctx } = bound(client);
        return call("send_file", { path: `${OUT}charts/q3.png`, content: String(posted.length) }, ctx);
      };
      // Listed with its directory, or by its bare name: either is the file.
      expect((await send([listed("file_2", "q3.png"), listed("file_1", "charts/q3.png")])).is_error).toBe(false);
      expect((await send([listed("file_2", "q3.png")])).is_error).toBe(false);
      expect(posted.map((p) => p.files![0]!.data.toString())).toEqual(["one", "two"]);
      // Two bare names could be two directories.
      expect(await send([listed("file_1", "q3.png"), listed("file_2", "q3.png")])).toEqual(toolFailure(
        "2 files named q3.png are in this session's outputs and cannot be told apart. Save it as /mnt/session/outputs/<unique name> and send that.",
      ));
      // The same name in another directory is another file.
      expect(text(await send([listed("file_1", "drafts/q3.png")]))).toContain("charts/q3.png did not appear");
      expect(posted).toHaveLength(2);
    } finally { await close(); }
  });

  test("matches a listing the same way for the smoke script, which reports the form the API uses", () => {
    // The script asks the real API how a file in a subdirectory is listed
    // (not documented), with this function and not a copy of it.
    const full = listed("file_1", `${OUT}charts/q3.png`), relative = listed("file_2", "charts/q3.png"), bare = listed("file_3", "q3.png");
    expect(pickOutput([bare, full], "charts/q3.png")).toBe(full);
    expect(pickOutput([bare, relative], "charts/q3.png")).toBe(relative);
    expect(pickOutput([bare], "charts/q3.png")).toBe(bare);
    expect(pickOutput([listed("file_4", "drafts/q3.png")], "charts/q3.png")).toBeUndefined();
    expect(() => pickOutput([bare, listed("file_5", "q3.png")], "charts/q3.png")).toThrow("2 files named q3.png");
    // At the top of the directory the bare name is the path, and the newest version is meant.
    const newer = listed("file_6", "/q3.png", { created_at: "2026-10-12T00:05:00Z" });
    expect(pickOutput([bare, newer], "q3.png")).toBe(newer);
    expect(pickOutput([], "q3.png")).toBeUndefined();
  });

  test("never takes a file scoped to another session", async () => {
    const { tools, posted, close } = registry(full);
    const { client, requests } = filesApi([[
      listed("file_other", "report.txt", { scope: { type: "session", id: "sesn_2" } }),
      listed("file_none", "report.txt", { scope: null }),
      listed("file_absent", "report.txt", { scope: undefined }),
      listed("file_locked", "report.txt", { downloadable: false }),
    ]], { file_other: "another channel's file", file_none: "x", file_absent: "x", file_locked: "x" });
    try {
      const { call } = queued(tools);
      const { ctx } = bound(client);
      const result = await call("send_file", { path: `${OUT}report.txt` }, ctx);
      expect(text(result)).toContain("report.txt did not appear in the session's output files");
      expect(requests.some((r) => r.path.endsWith("/content"))).toBe(false);
      expect(posted).toEqual([]);
    } finally { await close(); }
  });

  test("refuses a file over 25 MiB before downloading, and one that turns out larger while downloading", async () => {
    const { tools, posted, close } = registry(full);
    const limit = 25 * 1024 * 1024;
    const { client, requests } = filesApi(
      [[listed("file_big", "video.mp4", { size_bytes: limit + 1 }), listed("file_edge", "edge.bin", { size_bytes: limit }), listed("file_lying", "small.bin")]],
      { file_big: "never read", file_edge: new Uint8Array(limit), file_lying: new Uint8Array(limit + 1) },
    );
    try {
      const { call } = queued(tools);
      const { ctx } = bound(client);
      expect(await call("send_file", { path: `${OUT}video.mp4` }, ctx)).toEqual(toolFailure(`video.mp4 is ${limit + 1} bytes; attachments are limited to 25 MiB.`));
      expect(requests.some((r) => r.path.endsWith("/content"))).toBe(false);
      expect(await call("send_file", { path: `${OUT}small.bin` }, ctx)).toEqual(toolFailure("small.bin is larger than 25 MiB; attachments are limited to 25 MiB."));
      expect(posted).toEqual([]);
      expect(ctx.delivered).toBe(false);
      // Exactly at the limit is sent.
      expect((await call("send_file", { path: `${OUT}edge.bin` }, ctx)).is_error).toBe(false);
      expect(posted[0]!.files![0]!.data.length).toBe(limit);
    } finally { await close(); }
  });

  test("checks the channel first", async () => {
    const { tools, posted, close } = registry(full, { hidden: ["12"], foreign: ["13"] });
    const { client, requests } = filesApi([[listed("file_1", "report.txt")]], { file_1: "hello" });
    try {
      const { call } = queued(tools);
      const { ctx } = bound(client);
      expect(await call("send_file", { path: `${OUT}report.txt`, channel_id: "12" }, ctx)).toEqual(toolFailure("You cannot read this channel"));
      expect(await call("send_file", { path: `${OUT}report.txt`, channel_id: "13" }, ctx)).toEqual(toolFailure("Cross-guild access denied"));
      expect(await call("send_file", { path: `${OUT}report.txt`, channel_id: "general" }, ctx)).toEqual(toolFailure("Expected a Discord snowflake string"));
      // A session in a DM delivers to that DM only.
      const dm = bound(client, { guildId: undefined });
      expect(await call("send_file", { path: `${OUT}report.txt`, channel_id: "11" }, dm.ctx)).toEqual(toolFailure("Cross-guild access denied"));
      expect(requests).toEqual([]);
      expect(posted).toEqual([]);
    } finally { await close(); }
  });

  test("stops waiting when the turn is stopped, and needs a session to look in", async () => {
    const { tools, posted, close } = registry(full);
    const { client, lists } = filesApi([[]]);
    try {
      const { call } = queued(tools);
      const stop = new AbortController();
      const ctx = context({ signal: stop.signal });
      bindWorkspaceTurn(ctx, {
        sessionId: "sesn_1", files: outputFiles(client),
        sleep: async (_ms, signal) => { stop.abort(new Error("User steering")); throw signal!.reason; },
      });
      expect(await call("send_file", { path: `${OUT}report.txt` }, ctx)).toEqual(toolFailure("The turn was stopped."));
      expect(lists()).toBe(1);
      // A context no turn was bound to has no session.
      expect(await call("send_file", { path: `${OUT}report.txt` }, context())).toEqual(toolFailure("send_file needs a cloud workspace session."));
      expect(posted).toEqual([]);
    } finally { await close(); }
  });

  test("a download or a post that fails is the call's failure, and nothing counts as delivered", async () => {
    const refusing = registry(full, { post: () => { throw new Error("Request entity too large"); } });
    const { client } = filesApi([[listed("file_1", "report.txt"), listed("file_gone", "gone.txt")]], { file_1: "hello" });
    try {
      const { call } = queued(refusing.tools);
      const { ctx } = bound(client);
      expect(await call("send_file", { path: `${OUT}report.txt` }, ctx)).toEqual(toolFailure("Request entity too large"));
      const gone = await call("send_file", { path: `${OUT}gone.txt` }, ctx);
      expect(gone.is_error).toBe(true);
      expect(text(gone)).toContain("404");
      expect(ctx.delivered).toBe(false);
    } finally { await refusing.close(); }
  });
});

describe("run_jev's images in a session (#83)", () => {
  test("a file in the container is refused before anything reaches Jev", async () => {
    const { tools, close } = registry(full);
    let calls = 0, notices = 0;
    tools.jev.decide = async () => { calls++; throw new Error("unreachable"); };
    try {
      const { call } = queued(tools);
      const result = await call("run_jev", {
        state: { screen: "{{image:1}}" }, questions: { q: { type: "noul", instructions: "Is it red?" } }, images: ["outputs/shot.png"],
      }, context({ notify: async () => { notices++; } }));
      expect(result.is_error).toBe(true);
      expect(text(result)).toContain("a file in the container cannot be passed");
      expect(notices).toBe(0);
      expect(calls).toBe(0);
    } finally { await close(); }
  });
});
