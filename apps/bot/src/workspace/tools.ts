import { createHash } from "node:crypto";
import { posix } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsCustomToolInputSchema,
  BetaManagedAgentsCustomToolParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { BetaFileMetadata } from "@anthropic-ai/sdk/resources/beta/files";
import { CLAUDE_TOOLS, resultText } from "../claude/tools";
import { sleep } from "../io";
import { MAX_PARALLEL_TOOLS } from "../tool-concurrency";
import { ATTACHMENT_LIMIT, id, type DiscordTools } from "../tools/discord";
import { contextTask, scopedContext, ToolOutput, type Context, type Json, type ToolDef } from "../types";
import type { WorkspaceCall, WorkspaceResult } from "./types";

// The custom tools of an Anthropic Workspace session (#76). The session's
// container has Managed Agents' own shell, file and web tools; what is listed
// here is what only the bot can do: Discord, the bot's settings, published
// sites, Jev, and handing a file from the container to the channel. The bot
// runs these when the session calls them, under their own names (a custom
// tool's name may not start with `mcp__`).
//
// Tools that need the bot's own sandbox are left out; none of them is made to
// work here by other means. Descriptions that had to change are written here
// from the public documentation (docs/harness.md).

/** The one directory of the container whose files the Files API hands out. */
export const WORKSPACE_OUTPUTS = "/mnt/session/outputs/";

// Reading Discord; the last seven need a permission on the server.
const DISCORD_READS = [
  "read_messages", "get_message", "search_messages", "list_pins", "list_channels", "get_channel", "get_guild",
  "get_guild_preview", "list_members", "search_members", "get_user", "get_member", "list_roles", "get_role",
  "list_emojis", "list_stickers", "list_active_threads", "list_public_archived_threads", "list_voice_regions",
  "list_bans", "get_ban", "list_invites", "list_channel_invites", "list_webhooks", "list_guild_webhooks", "get_audit_log",
];
const READS = new Set([
  ...DISCORD_READS, "mcp_list_tools", "list_sites",
  "get_bot_settings", "get_user_context", "get_triggers", "get_bot_profile", "get_bot_member",
]);
// Calls that change nothing run side by side; everything else waits its turn.
// Jev only judges what it is handed, under a limit of its own, and is
// parallel in the other harnesses too (tool-concurrency.ts).
const PARALLEL = new Set([...READS, "run_jev"]);
const WRITES = [
  "add_reaction", "remove_reaction", "send_message", "edit_message", "delete_message", "create_thread",
  "create_thread_without_message", "bulk_delete_messages", "pin_message", "unpin_message", "edit_guild",
  "create_emoji", "delete_emoji", "create_sticker", "delete_sticker", "edit_channel", "create_channel",
  "delete_channel", "create_role", "edit_role", "delete_role", "add_role", "remove_role", "set_nickname",
  "timeout_member", "remove_timeout", "kick_member", "ban_member", "unban_member", "create_invite", "delete_invite",
  "mcp_call_tool", "set_thread_history", "set_bot_model", "set_user_context", "set_triggers", "set_bot_username",
  "set_bot_avatar", "unpublish_site", "extend_site",
];
// The integration tools a session is offered, out of the bot's 113.
const INTEGRATIONS = new Set([...READS, ...WRITES, "run_jev"]);

export const isWorkspaceTool = (name: string) =>
  name === "send_file" || name === "AskUserQuestion" || INTEGRATIONS.has(name);

// These tools run in the bot, which cannot see the container's files. The
// argument that named a sandbox file is neither offered nor accepted.
const FILE_ARGUMENTS: Record<string, { argument: string; instead: string }> = {
  edit_guild: { argument: "icon_path", instead: "icon_url" },
  create_emoji: { argument: "path", instead: "image_url" },
  create_sticker: { argument: "path", instead: "image_url" },
  set_bot_avatar: { argument: "path", instead: "image_url" },
};
const FROM_CONTAINER =
  "A file in the container cannot be passed directly: deliver it with send_file first and use the url of the attachment in that result.";

/** Throws when a call passes one of the file path arguments above. */
export function refuseFileArguments(name: string, args: Json): void {
  const file = FILE_ARGUMENTS[name];
  if (!file || args[file.argument] === undefined) return;
  throw new Error(
    `${file.argument} is not supported in the cloud workspace: this tool runs outside the container and cannot read its files. ` +
      `Pass a public https URL in ${file.instead}. For a file in the container, deliver it with send_file first and use the url of the attachment in its result.`,
  );
}

const SEND_FILE: ToolDef = {
  type: "function",
  function: {
    name: "send_file",
    description:
      `Posts one file from this session's container to Discord as an attachment, in the current channel unless channel_id names another channel of the same server that the requester can read. Only files under ${WORKSPACE_OUTPUTS} can be sent: write or copy the finished file there and pass its absolute path. The file is posted when this is called, not with the reply, and the result lists the attachment with its url. A file written a moment ago can take a few seconds to become available; the call waits for it. Files over 25 MiB cannot be sent. To send a changed version of a file that was already sent, save it under a new name first.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: { type: "string", minLength: 1, description: `Absolute path of the file, under ${WORKSPACE_OUTPUTS}.` },
        channel_id: { type: "string", description: "Another channel of this server to post in. Omit for the current channel." },
        content: { type: "string", maxLength: 2000, description: "Text posted together with the file." },
        filename: { type: "string", description: "Name the attachment is given. Defaults to the file's own name." },
      },
    },
  },
};
/** The tools a session defines itself. The rest of its list is the registry's
 *  integration tools and the Claude harness's question tool, as they are. */
export const WORKSPACE_TOOLS: ToolDef[] = [SEND_FILE];
const ASK = CLAUDE_TOOLS.find((t) => t.function.name === "AskUserQuestion")!;

// definitions.json is shared with the frozen harness and must not change
// (#67). Its text speaks of the bot's sandbox and of tools a session does not
// have, so for these the description is replaced, along with the argument
// descriptions listed under `properties` and the arguments now required.
type Rewrite = { description: string; properties?: Record<string, string>; required?: string[] };
const REWRITES: Record<string, Rewrite> = {
  set_bot_model: {
    description:
      "Changes the model this server uses, from the next message on. Give a preset id. The Anthropic Workspace presets are anthropic-workspace-haiku-5-5, anthropic-workspace-sonnet-5-5 and anthropic-workspace-opus-5-5: turns run as cloud sessions like this one. The Anthropic presets are anthropic-auto (the bot picks the model and effort for each conversation), anthropic-haiku-5-5, anthropic-sonnet-5-5 and anthropic-opus-5-5: the same models, working on the bot's host instead of in a cloud container. Presets of other providers are deprecated and can no longer be newly selected. Changing the model, the effort or Ultra starts a new conversation, and a new cloud session has a new container: files in this one are not carried over, so deliver what must be kept first. Not available in DMs. Selecting these presets requires the Premium role or higher.",
    properties: {
      preset: "Preset id, for example anthropic-workspace-sonnet-5-5.",
      provider: "Provider id (anthropic_workspace or anthropic), given with model instead of preset.",
      model: "Model id (claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5; auto on anthropic), given with provider instead of preset.",
      effort: "none, low, medium, high, xhigh or max, or default for the model's recommended effort.",
      ultra_mode:
        "true stores Ultra, false turns it off, null writes the default. On anthropic-workspace-haiku-5-5 Ultra lets the session plan and run workflows of parallel agents; on the other Workspace presets it has no effect, and on the Anthropic presets it counts as ordinary subagents.",
      multi_agent:
        "Multi-Agent mode, which only the deprecated providers have. Leave it out: none of the presets above uses it, and true keeps Ultra from taking effect on a Workspace preset.",
      reset: "true restores the bot's default model for this server and ignores the other fields.",
    },
  },
  read_messages: {
    description:
      "Reads the most recent messages of a channel, newest first, as Discord returns them: author, content, timestamp, attachments, embeds and reactions. The current channel unless channel_id names another one the requester can read. A long result is cut in the middle, so ask for fewer messages when that happens. An attachment is listed with its url; nothing is downloaded for you, so to work with the file fetch that url from inside the container.",
    properties: {
      channel_id: "Omit for the current channel.",
      limit: "1 to 100, default 20.",
      before: "Message id: only messages older than it.",
      after: "Message id: only messages newer than it.",
    },
  },
  edit_guild: {
    description:
      `Edits this server's name, description or icon. The requester needs the Manage Server permission. For the icon give icon_url, a public https URL of an image of at most 8 MiB, or clear_icon=true to remove it. ${FROM_CONTAINER}`,
    properties: { icon_url: "Public https URL of the new icon.", clear_icon: "true removes the server icon." },
  },
  create_emoji: {
    description:
      `Uploads a custom emoji to this server. The requester needs the permission to manage expressions. name is 2 to 32 letters, digits or underscores. image_url is a public https URL of a PNG, JPEG or GIF; Discord accepts about 256 KB. ${FROM_CONTAINER}`,
    properties: { name: "Emoji name, for example cool_cat.", image_url: "Public https URL of the image." },
    required: ["name", "image_url"],
  },
  create_sticker: {
    description:
      `Uploads a sticker to this server. The requester needs the permission to manage expressions. name is 2 to 30 characters, description is empty or 2 to 100 characters, and tags is the name of a unicode emoji such as smile. image_url is a public https URL of a PNG or APNG; Discord accepts about 500 KB. ${FROM_CONTAINER}`,
    properties: { image_url: "Public https URL of the sticker image." },
    required: ["name", "image_url"],
  },
  set_bot_avatar: {
    description:
      `Changes this bot's avatar, which is the same on every server. Only an administrator of the bot can do this, and only when the user asked for it. Give image_url, a public https URL of the image (a square PNG of 512 by 512 works best, at most 8 MiB), or clear=true to go back to the default avatar. ${FROM_CONTAINER}`,
    properties: { image_url: "Public https URL of the new avatar.", clear: "true resets the avatar to Discord's default and ignores image_url." },
  },
  unpublish_site: {
    description:
      "Takes down a site published from this server or DM, by its token. list_sites shows the sites that are online with their tokens. Use it when the user asks to take a site down.",
    properties: { token: "Token from list_sites: the path segment after /s/." },
  },
  extend_site: {
    description:
      "Keeps a published site online longer. mode=month adds 30 days and can be repeated; mode=permanent keeps the site until it is unpublished or set to unpermanent; mode=unpermanent ends that and leaves 30 days. Only sites of this server or DM, by the token list_sites shows.",
    properties: { token: "Token from list_sites: the path segment after /s/." },
  },
};

function rewritten(tool: ToolDef): ToolDef {
  const name = tool.function.name, rewrite = REWRITES[name], dropped = FILE_ARGUMENTS[name]?.argument;
  if (!rewrite) return tool;
  const properties = Object.fromEntries(
    Object.entries((tool.function.parameters.properties ?? {}) as Record<string, Json>)
      .filter(([key]) => key !== dropped)
      .map(([key, schema]) => [key, rewrite.properties?.[key] ? { ...schema, description: rewrite.properties[key] } : schema]),
  );
  return {
    type: "function",
    function: {
      name,
      description: rewrite.description,
      parameters: { ...tool.function.parameters, properties, ...(rewrite.required && { required: rewrite.required }) },
    },
  };
}

/** The custom tools of a session, out of the registry's listing. The order is
 *  fixed (delivery and the question first, then the registry's own order), so
 *  the same settings always give the same list. */
export function workspaceSurface(base: ToolDef[]): ToolDef[] {
  return [...WORKSPACE_TOOLS, ASK, ...base.filter((t) => INTEGRATIONS.has(t.function.name)).map(rewritten)];
}

export type WorkspaceToolParam = BetaManagedAgentsAgentToolset20260401Params | BetaManagedAgentsCustomToolParams;

/** `tools` of a session's agent: the built-in toolset, then the custom tools.
 *  An empty list means tools are switched off for the whole bot
 *  (`TOOLS_ENABLED=false`); the session then gets no built-in tools either.
 *  `web: false` leaves out the container's own web search and fetch. */
export function workspaceToolParams(tools: ToolDef[], options: { web: boolean }): WorkspaceToolParam[] {
  if (!tools.length) return [];
  return [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      ...(!options.web && { configs: [{ name: "web_search", enabled: false }, { name: "web_fetch", enabled: false }] }),
    },
    ...tools.map((t): BetaManagedAgentsCustomToolParams => ({
      type: "custom",
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as BetaManagedAgentsCustomToolInputSchema,
    })),
  ];
}

/** Names one tool list. A session keeps the list it was created with, so a
 *  different fingerprint later says its list is no longer the current one. */
export const toolsFingerprint = (params: WorkspaceToolParam[]) =>
  createHash("sha256").update(JSON.stringify(params)).digest("hex");

/** How `send_file` reaches a session's output files. */
export type OutputFiles = {
  list(sessionId: string, signal?: AbortSignal): AsyncIterable<BetaFileMetadata>;
  download(fileId: string, signal?: AbortSignal): Promise<Response>;
};

/** The Files API as `send_file` uses it. Filtering by `scope_id` is part of
 *  the Managed Agents beta and needs its header on the list request. */
export function outputFiles(client: Anthropic): OutputFiles {
  return {
    list: (sessionId, signal) =>
      client.beta.files.list({ scope_id: sessionId, limit: 100, betas: ["managed-agents-2026-04-01"] }, { signal }),
    download: (fileId, signal) => client.beta.files.download(fileId, {}, { signal }),
  };
}

/** The session a turn runs in, as its tools need it. */
export type OutputAccess = {
  sessionId: string;
  files: OutputFiles;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};
// Keyed by the turn's own context, like home connections: a scoped copy made
// for one call finds it, an ordinary spread for another turn does not.
const turns = new WeakMap<Context, OutputAccess>();
/** Ties a turn to its session before any of its tools run. */
export function bindWorkspaceTurn(ctx: Context, access: OutputAccess): void {
  turns.set(contextTask(ctx), access);
}

// A file can be listed some seconds after it was written, and sometimes only
// once the session went idle. Nine listings over 30 seconds, each reading at
// most this many entries.
const LISTING_WAITS = [1000, 2000, 3000, 4000, 5000, 5000, 5000, 5000];
const MAX_LISTED = 1000;

/** The listed file that is `rel` (the path below the outputs directory).
 *  Throws when several listed files could be it. */
export function pickOutput(files: BetaFileMetadata[], rel: string): BetaFileMetadata | undefined {
  const base = posix.basename(rel);
  const key = (file: BetaFileMetadata) =>
    file.filename.startsWith(WORKSPACE_OUTPUTS) ? file.filename.slice(WORKSPACE_OUTPUTS.length) : file.filename.replace(/^\/+/, "");
  // Written twice under one name, both versions may be listed: the newest is meant.
  const newest = (found: BetaFileMetadata[]) =>
    found.reduce((a, b) => (Date.parse(b.created_at) > Date.parse(a.created_at) ? b : a));
  const exact = files.filter((f) => key(f) === rel);
  if (exact.length) return newest(exact);
  // Whether a file in a subdirectory is listed with its directory is not
  // documented. When only the bare name is listed, one match is the file and
  // several cannot be told apart.
  const named = rel === base ? [] : files.filter((f) => key(f) === base);
  if (named.length > 1)
    throw new Error(`${named.length} files named ${base} are in this session's outputs and cannot be told apart. Save it as ${WORKSPACE_OUTPUTS}<unique name> and send that.`);
  return named[0];
}

async function findOutput(access: OutputAccess, rel: string, signal?: AbortSignal): Promise<BetaFileMetadata> {
  const pause = access.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    const listed: BetaFileMetadata[] = [];
    let read = 0;
    for await (const file of access.files.list(access.sessionId, signal)) {
      // The request already filters by scope. Checking again here is what
      // keeps another session's file (another channel, server or DM) out even
      // if that filter were ignored.
      if (file.scope?.type === "session" && file.scope.id === access.sessionId && file.downloadable !== false) listed.push(file);
      if (++read >= MAX_LISTED) break;
    }
    const found = pickOutput(listed, rel);
    if (found) return found;
    if (attempt >= LISTING_WAITS.length)
      throw new Error(`${rel} did not appear in the session's output files within 30 seconds. Check it with ls -l and call send_file again.`);
    await pause(LISTING_WAITS[attempt]!, signal);
  }
}

/** The body of a download, refused once it passes the attachment limit
 *  whatever size the listing claimed. */
async function readBody(response: Response, name: string): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ATTACHMENT_LIMIT) {
      await reader.cancel().catch(() => {});
      throw new Error(`${name} is larger than 25 MiB; attachments are limited to 25 MiB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function sendFile(discord: DiscordTools, a: Json, ctx: Context) {
  const access = turns.get(contextTask(ctx));
  if (!access) throw new Error("send_file needs a cloud workspace session.");
  const path = posix.normalize(String(a.path));
  if (!path.startsWith(WORKSPACE_OUTPUTS) || path.endsWith("/"))
    throw new Error(`send_file only delivers files under ${WORKSPACE_OUTPUTS}. Copy the file there (cp <file> ${WORKSPACE_OUTPUTS}) and pass that path.`);
  const rel = path.slice(WORKSPACE_OUTPUTS.length), base = posix.basename(rel);
  // Before anything is fetched: a channel the requester cannot read gets
  // neither the file nor a hint of whether it exists.
  const channelId = a.channel_id ? id(a.channel_id) : ctx.channelId;
  await discord.authorizeChannel(ctx, channelId);
  let file: BetaFileMetadata, data: Buffer;
  try {
    file = await findOutput(access, rel, ctx.signal);
    if (file.size_bytes > ATTACHMENT_LIMIT)
      throw new Error(`${base} is ${file.size_bytes} bytes; attachments are limited to 25 MiB.`);
    data = await readBody(await access.files.download(file.id, ctx.signal), base);
  } catch (error) {
    // Nothing was posted yet, so a stop here leaves nothing to check.
    if (ctx.signal?.aborted) throw new Error("The turn was stopped.");
    throw error;
  }
  const message = await discord.postFile(ctx, channelId, {
    data, name: posix.basename(String(a.filename || rel)), content: a.content,
  }) as { id?: string; channel_id?: string; attachments?: { filename?: string; url?: string; size?: number }[] };
  return {
    ok: true,
    message_id: message?.id,
    channel_id: message?.channel_id ?? channelId,
    attachments: (message?.attachments ?? []).map(({ filename, url, size }) => ({ filename, url, size })),
    file: { filename: file.filename, size_bytes: data.length, created_at: file.created_at },
  };
}

/** What the registry lends to run a session's tools. */
export type WorkspaceHost = {
  discord: DiscordTools;
  /** Runs an integration tool by its own name, after the registry's checks. */
  integration: (name: string, args: Json, ctx: Context) => Promise<unknown>;
  ask: (args: Json, ctx: Context) => Promise<unknown>;
};

/** Runs one custom tool. The caller has validated the arguments against the
 *  tool's schema and checked that the context may use the tool. */
export function runWorkspaceTool(host: WorkspaceHost, name: string, args: Json, ctx: Context): Promise<unknown> {
  if (name === "send_file") return sendFile(host.discord, args, ctx);
  if (name === "AskUserQuestion") return host.ask(args, ctx);
  return host.integration(name, args, ctx);
}

/** A tool's result as `user.custom_tool_result` carries it: text, cut like
 *  every other tool result of the bot, and whether the call failed. */
export function toolResult(result: unknown): WorkspaceResult {
  return {
    content: [{ type: "text", text: resultText(result) || "(no output)" }],
    is_error: result instanceof ToolOutput && !!result.options.isError,
  };
}
export function toolFailure(error: unknown): WorkspaceResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: resultText(message) || "The call failed." }], is_error: true };
}

// The registry runs a Workspace call only on a context that carries this
// mark, and `WorkspaceCalls` is the one place that sets it, on a context made
// for that one call. A call that reached the registry any other way skipped
// the step that turns a workflow run's thread into a worker.
const admitted = new WeakSet<Context>();
/** Whether `ctx` came through `WorkspaceCalls.run`. Asking spends the mark. */
export const takeWorkspaceCall = (ctx: Context) => admitted.delete(ctx);

// A workflow run's agents work for the run, not for the channel. They get the
// worker role's tools (reading, never posting, asking or changing settings),
// and no way to write status lines into the turn's messages.
const WORKER: Partial<Context> = {
  depth: 1, agentRole: "worker", progress: undefined, notify: undefined, jevTaskProgress: undefined, openStatus: undefined,
};
const FOREIGN_RUN =
  "This call was not run. It comes from a workflow run that the person now being answered did not start, and a run may only use Discord and settings tools on behalf of the person who started it. Finish with what the run already has and say what is missing in its result.";
// The thread's run, or who started that run, could not be told: the row lost
// it with a process that died in the turn, or the session's list was not
// read that far back. Refused all the same, without saying whose run it is.
const UNKNOWN_RUN =
  "This call was not run. Who started the workflow run it comes from is not known here, and a run may only use Discord and settings tools on behalf of the person who started it. Finish with what the run already has and say what is missing in its result.";
const NOT_STARTED = "The turn was stopped before this call ran.";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Every custom tool call of one turn goes through `run`, whichever thread
 *  of the session made it. It decides whose call it is and in what order the
 *  calls run; whether the person may run the tool is the registry's check. */
export class WorkspaceCalls {
  private results = new Map<string, Promise<WorkspaceResult>>();
  private streaks = new Map<string, { key: string; count: number }>();
  private waiting: { parallel: boolean; start: (go: boolean) => void }[] = [];
  private running = 0;
  private exclusive = false;
  private closed?: string;
  constructor(private deps: {
    /** `ToolRegistry.execute`. */
    execute: (name: string, args: Json, ctx: Context) => Promise<unknown>;
    /** The Discord user whose turn started this workflow run, if known. */
    runOwner: (runId: string) => string | undefined;
  }) {}

  /** Answers a call. Never rejects. A call seen again (the stream was
   *  reopened and replayed it) gets the answer of the first time and does not
   *  run twice. `ctx` is the turn's context, with the turn's signal. */
  run(call: WorkspaceCall, ctx: Context): Promise<WorkspaceResult> {
    const known = this.results.get(call.id);
    if (known) return known;
    const result = this.answer(call, ctx).catch(toolFailure);
    this.results.set(call.id, result);
    return result;
  }

  /** Ends the turn's calls: one that has not started is answered with
   *  `reason` instead of running, one that is running finishes. */
  close(reason: string): void {
    this.closed ??= reason;
    for (const entry of this.waiting.splice(0)) entry.start(false);
  }

  private async answer(call: WorkspaceCall, ctx: Context): Promise<WorkspaceResult> {
    if (this.closed !== undefined) return toolFailure(this.closed);
    const { name, input } = call;
    if (!input || typeof input !== "object" || Array.isArray(input)) return toolFailure("Arguments must be an object");
    const args = input as Json, thread = call.threadId || undefined;
    // A run goes on after the turn that started it, and wakes up in whatever
    // turn comes next. Its calls are checked against the permissions of
    // `ctx.userId`, so they run only while that is the person who started it;
    // otherwise someone else's run would read with this person's access.
    if (thread) {
      const owner = call.runId ? this.deps.runOwner(call.runId) : undefined;
      if (owner === undefined) return toolFailure(UNKNOWN_RUN);
      if (owner !== ctx.userId) return toolFailure(FOREIGN_RUN);
    }
    // Only an unbroken run of the same call is a loop, counted per thread:
    // agents working side by side legitimately make the same call once each.
    const key = name + stableJson(args), previous = this.streaks.get(thread ?? "");
    const count = previous?.key === key ? previous.count + 1 : 1;
    this.streaks.set(thread ?? "", { key, count });
    if (count >= 3) return toolFailure("This exact call was just made twice in a row. Use those results or change the approach.");
    // A question waits up to five minutes for a person. It stays out of the
    // queue, where it would hold every read of a run's agents that long.
    if (name === "AskUserQuestion") return this.execute(name, args, ctx, !!thread);
    if (!(await this.admit(PARALLEL.has(name), ctx.signal))) return toolFailure(this.closed ?? NOT_STARTED);
    try {
      return await this.execute(name, args, ctx, !!thread);
    } finally {
      this.running--;
      this.exclusive = false;
      this.pump();
    }
  }

  /** Calls start in the order they arrived. Reads overlap, up to the bot's
   *  usual limit. A change waits for the reads before it and holds everything
   *  after it: later reads must see its result. Resolves false when the turn
   *  was closed or stopped first, so a call that never started is not taken
   *  for one that may have had an effect. */
  private admit(parallel: boolean, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      const entry = {
        parallel,
        start: (go: boolean) => {
          signal?.removeEventListener("abort", leave);
          resolve(go);
        },
      };
      const leave = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.start(false);
        this.pump();
      };
      signal?.addEventListener("abort", leave, { once: true });
      this.waiting.push(entry);
      this.pump();
    });
  }
  private pump() {
    while (this.waiting.length && !this.exclusive) {
      const next = this.waiting[0]!;
      if (next.parallel ? this.running >= MAX_PARALLEL_TOOLS : this.running > 0) return;
      this.waiting.shift();
      this.running++;
      this.exclusive = !next.parallel;
      next.start(true);
    }
  }

  private async execute(name: string, args: Json, ctx: Context, thread: boolean): Promise<WorkspaceResult> {
    if (ctx.signal?.aborted) return toolFailure(NOT_STARTED);
    // The harness is stated here rather than trusted from the caller: under
    // any other, the registry would take a session's `send_file` or a name
    // like `bash` for the sandbox tool of that name.
    const scoped = scopedContext(ctx, { harness: "workspace", ...(thread && WORKER) });
    admitted.add(scoped);
    try {
      return toolResult(await this.deps.execute(name, args, scoped));
    } catch (error) {
      return toolFailure(error);
    } finally {
      admitted.delete(scoped);
      ctx.delivered ||= scoped.delivered;
    }
  }
}
