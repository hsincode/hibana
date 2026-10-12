import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { roleAllowsTool } from "../agent-roles";
import { namespaced } from "../harness";
import { quote, type Sandbox } from "../tools/sandbox";
import { ToolOutput, type Context, type Json, type ToolDef } from "../types";
import definitions from "./definitions.json";

// The tool surface of the Claude harness (#66): the tools Claude Code offers
// for files and the shell, under the same names and input shapes, running on
// Hibana's own sandbox. Descriptions are written here from the public tools
// reference (docs/harness.md); none of Claude Code's text is copied.

export const CLAUDE_TOOLS = definitions as ToolDef[];
export type AgentCall = { description: string; prompt: string; subagent_type: string };

/** What a Claude tool name means to the role and permission checks, which are
 *  written against the names the integration tools already have. */
const INTERNAL: Record<string, string> = {
  Bash: "bash", Read: "read_file", Edit: "edit_file", Write: "write_file",
  Glob: "list_files", Grep: "grep_files", AskUserQuestion: "request_user_input",
  Skill: "use_skill", Agent: "agents__spawn_agent",
};
export const isClaudeTool = (name: string) => name in INTERNAL;
export const internalName = (name: string) =>
  INTERNAL[name] ?? name.replace(/^mcp__[a-z]+__/, "");

const NEEDS_SANDBOX = new Set(["Bash", "Read", "Edit", "Write", "Glob", "Grep"]);
// Integration tools the surface replaces: the file and shell tools above, and
// Jev's action-selection loop, which rewrites the tool list from a setting and
// so cannot coexist with a tool list that stays fixed for the conversation.
const REPLACED = new Set([
  "bash", "read_file", "write_file", "write_files", "edit_file", "list_files", "grep_files",
  "use_skill", "run_jev_task",
]);
// Delivery and the two reads most turns start with stay loaded; a tool that
// has to be searched for first costs a round trip.
const ALWAYS_LOADED = new Set(["send_file", "publish_site", "download_attachment", "read_messages"]);

// definitions.json is shared with the frozen harness and must not change
// (#67). Where its text is wrong for this harness, the description is
// replaced here instead.
const DESCRIPTIONS: Record<string, string> = {
  send_file:
    "Posts a file from the workspace to Discord as an attachment, in the current channel unless another is given. The file is posted when this is called, not with the reply, and the result is the message Discord created. Files above Discord's attachment limit (about 25 MiB) are published as a link instead when hosting is enabled. Nothing in the workspace reaches Discord without this call. HTML pages are published as a site rather than attached.",
  set_bot_model:
    "Changes the model this server uses. Give a preset id from the model catalog; the Anthropic presets are anthropic-auto (the bot picks the model and effort per conversation), anthropic-haiku-5-5, anthropic-sonnet-5-5 and anthropic-opus-5-5. Presets of other providers are deprecated and can no longer be newly selected. The change applies from the next turn and starts a new conversation history for the server. Requires the Premium role or higher for Anthropic presets.",
};

/** The tools shown to the model. `defer` marks the ones that are found through
 *  tool search instead of being loaded up front. */
export function claudeSurface(base: ToolDef[], options: {
  sandbox: boolean; root: boolean; agents: boolean; role?: string;
}): ToolDef[] {
  const has = (name: string) => base.some((t) => t.function.name === name);
  const core = CLAUDE_TOOLS.filter(({ function: { name } }) =>
    (!NEEDS_SANDBOX.has(name) || options.sandbox) &&
    (name !== "AskUserQuestion" || options.root) &&
    (name !== "Skill" || has("use_skill")) &&
    (name !== "Agent" || (options.agents && options.root)));
  const integrations = base
    .filter((t) => !REPLACED.has(t.function.name))
    .map((t) => ({
      ...namespaced(t),
      function: {
        ...namespaced(t).function,
        description: DESCRIPTIONS[t.function.name] ?? t.function.description,
      },
      ...(!ALWAYS_LOADED.has(t.function.name) && { defer: true }),
    }));
  return [...core, ...integrations].filter((t) => roleAllowsTool(options.role, internalName(t.function.name)));
}

export type ClaudeHost = {
  sandbox: Sandbox;
  proxy: (ctx: Context) => Parameters<Sandbox["run"]>[4];
  /** Runs an integration tool by its own name, after the registry's checks. */
  integration: (name: string, args: Json, ctx: Context) => Promise<unknown>;
  ask: (args: Json, ctx: Context) => Promise<unknown>;
  agent: (call: AgentCall, ctx: Context) => Promise<string>;
};

const INLINE_LIMIT = 30_000;
const CAPTURE_LIMIT = 2_000_000;
const EXCERPT = 4_000;
// Exit status 1 from these means "nothing found" or "they differ", not failure.
const BENIGN_EXIT_1 = /^\s*(?:grep|rg|egrep|fgrep|find|diff|test|\[|git\s+(?:diff|grep))\b/;

async function bash(host: ClaudeHost, a: Json, ctx: Context): Promise<ToolOutput> {
  const command = String(a.command);
  const seconds = Math.ceil(Number(a.timeout ?? 120_000) / 1000);
  const result = await host.sandbox.locked(ctx, () =>
    host.sandbox.run(ctx, command, seconds, "/workspace", host.proxy(ctx), CAPTURE_LIMIT));
  const parts = [result.stdout.replace(/\n+$/, "")];
  if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.replace(/\n+$/, "")}`);
  let text = parts.filter(Boolean).join("\n");
  const notes: string[] = [];
  // processRun reports a killed process as 124: the timeout, or the turn being stopped.
  if (result.exit_code === 124) notes.push(`The command did not finish within ${Math.max(1, Math.min(360, seconds))} seconds and was stopped.`);
  else if (result.exit_code === 125) notes.push("The sandbox container could not start. This is a host problem; another command will fail the same way.");
  else if (result.exit_code !== 0) notes.push(`Exit code: ${result.exit_code}`);
  if (result.truncated) notes.push(`Output beyond ${CAPTURE_LIMIT.toLocaleString("en-US")} characters per stream was discarded.`);
  if (text.length > INLINE_LIMIT) {
    const path = `.hibana/tool-output/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.txt`;
    let saved = "";
    try {
      await host.sandbox.write(ctx, path, text);
      saved = ` The full output is in /workspace/${path}.`;
    } catch (error) {
      saved = ` The full output could not be saved (${error instanceof Error ? error.message : String(error)}).`;
    }
    notes.unshift(`Output was ${text.length.toLocaleString("en-US")} characters; only its first and last ${EXCERPT.toLocaleString("en-US")} are shown.${saved}`);
    text = `${text.slice(0, EXCERPT)}\n[...]\n${text.slice(-EXCERPT)}`;
  }
  const failed = result.exit_code !== 0 && !(result.exit_code === 1 && BENIGN_EXIT_1.test(command));
  return new ToolOutput([text, ...notes].filter(Boolean).join("\n") || "(no output)", { isError: failed });
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MAX_LINES = 2000, MAX_READ = 60_000, MAX_LINE = 2000;

async function read(host: ClaudeHost, a: Json, ctx: Context): Promise<ToolOutput> {
  const path = String(a.file_path);
  const full = await host.sandbox.path(ctx, path);
  const stat = await lstat(full).catch(() => undefined);
  if (!stat) throw new Error(`No such file: ${path}`);
  if (stat.isDirectory()) throw new Error(`${path} is a directory. List its files by pattern instead.`);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  if (stat.size > 8 * 1024 * 1024) throw new Error(`${path} is ${stat.size} bytes; files over 8 MiB are not read. Search it or read part of it with a shell command.`);
  const bytes = await readFile(full);
  if (IMAGE.test(path))
    return new ToolOutput(`Image ${path} (${stat.size} bytes)`, {
      images: [`data:${Bun.file(full).type};base64,${bytes.toString("base64")}`],
    });
  if (!stat.size) return new ToolOutput(`${path} exists and is empty.`);
  const text = bytes.toString("utf8");
  if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${path} is a binary file. Convert it with a shell command first.`);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = Math.max(1, Number(a.offset ?? 1));
  if (first > lines.length) return new ToolOutput(`${path} has ${lines.length} lines; line ${first} is past its end.`);
  const wanted = Math.min(MAX_LINES, Number(a.limit ?? MAX_LINES));
  const out: string[] = [];
  let size = 0, next = first;
  for (; next < first + wanted && next <= lines.length; next++) {
    const raw = lines[next - 1]!;
    const line = `${String(next).padStart(6)}\t${raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)} [line cut at ${MAX_LINE} characters]` : raw}`;
    if (out.length && size + line.length > MAX_READ) break;
    out.push(line);
    size += line.length + 1;
  }
  if (next <= lines.length)
    out.push(`[Showing lines ${first}-${next - 1} of ${lines.length}. Continue with offset ${next}.]`);
  return new ToolOutput(out.join("\n"));
}

async function edit(host: ClaudeHost, a: Json, ctx: Context): Promise<ToolOutput> {
  const path = String(a.file_path), before = String(a.old_string), after = String(a.new_string);
  if (before === after) throw new Error("old_string and new_string are the same; nothing would change.");
  const bytes = await readFile(await host.sandbox.path(ctx, path)).catch(() => {
    throw new Error(`No such file: ${path}. Create it by writing the whole file.`);
  });
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // The file is saved back as UTF-8; undecodable bytes would be replaced.
    throw new Error(`${path} is not valid UTF-8, so editing it here would damage it. Change it with a shell command that keeps its encoding.`);
  }
  const count = bytes.toString("utf8").split(before).length - 1;
  if (!count) throw new Error(`old_string was not found in ${path}. It must match the file exactly, including whitespace; read the file again and copy the text from it.`);
  if (count > 1 && !a.replace_all)
    throw new Error(`old_string appears ${count} times in ${path}. Include more of the surrounding text to single out one place, or set replace_all.`);
  const result = await host.sandbox.edit(ctx, path, before, after, Boolean(a.replace_all));
  return new ToolOutput(`Edited ${path}: ${result.replacements} replacement${result.replacements === 1 ? "" : "s"}.`);
}

async function write(host: ClaudeHost, a: Json, ctx: Context): Promise<ToolOutput> {
  const result = await host.sandbox.write(ctx, String(a.file_path), String(a.content));
  return new ToolOutput(`Wrote ${result.bytes} bytes to ${result.path}.`);
}

const MAX_GLOB = 200, MAX_WALK = 50_000;

async function glob(host: ClaudeHost, a: Json, ctx: Context): Promise<ToolOutput> {
  const root = await host.sandbox.path(ctx, String(a.path ?? "."), true);
  const pattern = new Bun.Glob(String(a.pattern));
  const found: { path: string; mtime: number }[] = [];
  let visited = 0, cut = false;
  // Not `filesUnder`: that throws past its cap, and a workspace with
  // node_modules passes it. A bounded walk reports what it left out instead.
  const pending = [root];
  while (pending.length && !cut) {
    const dir = pending.pop()!;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        if (++visited > MAX_WALK) { cut = true; break; }
        const rel = relative(root, path);
        if (pattern.match(rel)) found.push({ path: rel, mtime: (await lstat(path)).mtimeMs });
      }
    }
  }
  if (!found.length && !cut) return new ToolOutput("No files matched.");
  found.sort((x, y) => y.mtime - x.mtime);
  const lines = found.slice(0, MAX_GLOB).map((f) => f.path);
  if (found.length > MAX_GLOB) lines.push(`[${found.length - MAX_GLOB} more files matched and are not listed. Narrow the pattern.]`);
  if (cut) lines.push(`[The search stopped after ${MAX_WALK.toLocaleString("en-US")} files; matches may be missing. Search a subdirectory.]`);
  return new ToolOutput(lines.join("\n"));
}

async function grep(host: ClaudeHost, a: Json, ctx: Context): Promise<ToolOutput> {
  const target = String(a.path ?? ".");
  const root = await host.sandbox.root(ctx);
  // The container sees the workspace at /workspace and starts there.
  const shown = relative(root, await host.sandbox.path(ctx, target, true)) || ".";
  const mode = String(a.output_mode ?? "files_with_matches");
  const context = mode === "content"
    ? (["-A", "-B", "-C"] as const).flatMap((flag) => (a[flag] === undefined ? [] : [flag, String(Number(a[flag]))]))
    : [];
  const flags = [
    "--color", "never",
    ...(mode === "files_with_matches" ? ["-l"] : mode === "count" ? ["-c"] : ["-n", "--no-heading", ...context]),
    ...(a["-i"] ? ["-i"] : []),
    ...(a.multiline ? ["-U", "--multiline-dotall"] : []),
    ...(a.glob ? ["--glob", String(a.glob)] : []),
    ...(a.type ? ["--type", String(a.type)] : []),
    "-e", String(a.pattern), "--", shown,
  ];
  const result = await host.sandbox.run(ctx, `rg ${flags.map(quote).join(" ")}`, 20, "/workspace", undefined, CAPTURE_LIMIT);
  if (result.exit_code === 1) return new ToolOutput("No matches found.");
  if (result.exit_code === 124) throw new Error("The search did not finish within 20 seconds. Narrow the path or the pattern.");
  if (result.exit_code !== 0) throw new Error(result.stderr.trim() || `ripgrep exited with ${result.exit_code}`);
  const lines = result.stdout.replace(/\n+$/, "").split("\n");
  const limit = Math.min(1000, Number(a.head_limit ?? 250));
  const kept = lines.slice(0, limit).map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} [line cut]` : line));
  if (lines.length > limit) kept.push(`[${lines.length - limit} more lines not shown. Narrow the search or raise head_limit.]`);
  return new ToolOutput(kept.join("\n"));
}

async function ask(host: ClaudeHost, a: Json, ctx: Context): Promise<ToolOutput> {
  // The Discord prompt keys answers by an id; Claude Code's shape has none.
  const questions = (a.questions as Json[]).map((q, i): Json & { id: string } => ({ ...q, id: `q${i + 1}` }));
  const result = await host.ask({ questions }, ctx) as { answers: Record<string, { answers: string[] }>; cancelled?: boolean; reason?: string };
  const lines = questions.map((q) => {
    const answer = result.answers[q.id]?.answers.join(", ");
    return `${String(q.question)}\n${answer ? `Answer: ${answer}` : "Not answered."}`;
  });
  if (result.cancelled) lines.push(`The wait ended (${result.reason ?? "cancelled"}) before every question was answered. An unanswered question is not agreement.`);
  return new ToolOutput(lines.join("\n\n"));
}

async function skill(host: ClaudeHost, a: Json, ctx: Context): Promise<ToolOutput> {
  const loaded = await host.integration("use_skill", { name: String(a.skill) }, ctx) as { name: string; content: string; files?: string[]; base?: string };
  const files = loaded.files?.length
    ? `\n\nFiles of this skill, under ${loaded.base?.startsWith("/") ? loaded.base : `/workspace/${loaded.base ?? `.skills/${loaded.name}`}`}/:\n${loaded.files.map((f) => `- ${f}`).join("\n")}`
    : "";
  return new ToolOutput(`${loaded.content}${files}`);
}

/** Runs one of the Claude tools. The caller has validated the arguments
 *  against the tool's schema and checked that the context may use the tool. */
export async function runClaudeTool(host: ClaudeHost, name: string, args: Json, ctx: Context): Promise<ToolOutput> {
  switch (name) {
    case "Bash": return bash(host, args, ctx);
    case "Read": return read(host, args, ctx);
    case "Edit": return edit(host, args, ctx);
    case "Write": return write(host, args, ctx);
    case "Glob": return glob(host, args, ctx);
    case "Grep": return grep(host, args, ctx);
    case "AskUserQuestion": return ask(host, args, ctx);
    case "Skill": return skill(host, args, ctx);
    case "Agent": return new ToolOutput(await host.agent(args as AgentCall, ctx));
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const RESULT_LIMIT = 40_000;
/** The text of a tool result. A cut keeps both ends and says so: the end of an
 *  output is where errors are, and a silent cut reads as the whole result. */
export function resultText(result: unknown): string {
  const text = result instanceof ToolOutput ? result.text
    : typeof result === "string" ? result : JSON.stringify(result ?? null);
  if (text.length <= RESULT_LIMIT) return text;
  return `${text.slice(0, RESULT_LIMIT - 10_000)}\n[... ${text.length - RESULT_LIMIT} characters left out ...]\n${text.slice(-10_000)}`;
}
