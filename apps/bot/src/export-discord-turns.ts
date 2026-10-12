// Manual export of the questions behind the turns in the bot's log, for the
// harness comparison (#69). The bot's log has no message text and the stored
// conversations hold only what is still in progress, so the text is read back
// from Discord. It runs where the bot's log is:
//   (umask 077; ssh "$TARGET" 'PATH="$PATH:$HOME/.bun/bin" bun run -' \
//     < apps/bot/src/export-discord-turns.ts > .local/harness-eval/candidates.jsonl.new \
//     && mv .local/harness-eval/candidates.jsonl.new .local/harness-eval/candidates.jsonl)
// Optional argument: <log directory>. Without it the path comes from the
// service: LOG_DIR or HIBANA_DATA_DIR in /etc/hibana/bot.env, else ./data
// under the running bot.
//
// It only reads. Discord is called with GET requests alone, with the bot's own
// token, which is taken from the service's environment file (or DISCORD_TOKEN),
// used in this process and neither printed nor written anywhere. One JSON line
// per turn that used Anthropic's API or a Claude model goes to stdout, and
// only when every read succeeded; counts go to stderr, and an error is
// reported there by its kind alone, never with the address that was read.
//
// The output is people's messages, DMs included. Keep it under .local/
// (gitignored); it must not reach the repository, an Issue or a log. The
// channel's id is written as a short hash, and the ids in the line the bot
// appends to a message and in its attachments as zeros. The text itself is
// kept as it is, with any mention, link or id that it contains, and so is the
// author's display name.
// This file imports nothing from the repository: it is piped to a machine
// that runs another commit.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

/** One turn as the bot's log saw it. The log holds no message text. */
export type Turn = {
  channel: string; message_id: string; started: number;
  provider?: string; model?: string; effort?: string | null;
  route?: { model?: string; effort?: string | null };
  completed?: { at: number; provider?: string; model?: string; latency_ms?: number };
  /** Model requests the turn's own agent made: more than one means it called
   *  tools. Null for a turn older than the log's first request line: the bot
   *  did not log requests before then. */
  requests: number | null;
  /** When the last of them finished. The reply is posted after it. */
  last_request?: number;
  /** Another turn in the log started from the same message (a message sent
   *  into the end of a turn, or a turn resumed after a restart). */
  shared?: boolean;
};
type Attachment = { id?: string; filename?: string; size?: number };
type Message = {
  id: string; content?: string; edited_timestamp?: string | null;
  author?: { id?: string; bot?: boolean; global_name?: string | null; username?: string };
  attachments?: Attachment[];
  message_reference?: unknown; referenced_message?: { attachments?: Attachment[] } | null;
};
/** GET one Discord API path. Undefined when Discord says it is not there or
 *  not readable (404, 403); a read that fails any other way throws. */
export type Read = (path: string) => Promise<unknown | undefined>;

const CLAUDE = new Set(["anthropic", "claude_max", "claude_kiro"]);
const MINUTE = 60_000;
const tag = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);
/** When a Discord id was made: its top bits are milliseconds since 2015. */
const madeAt = (id: string) => Number(BigInt(id) >> 22n) + 1_420_070_400_000;

/** The turns in the log, in order. A channel runs one turn at a time, so the
 *  lines of a turn follow its start. */
export function turnsFromLog(lines: Iterable<string>): Turn[] {
  const turns: Turn[] = [];
  const open = new Map<string, Turn>();
  let firstRequest = Infinity;
  for (const line of lines) {
    if (!line.includes('"Turn started"') && !line.includes('"Auto route selected"') &&
        !line.includes('"Turn completed"') && !line.includes('"LLM request completed"')) continue;
    let entry: { msg?: string; time?: number; channel?: string; message_id?: string; provider?: string; model?: string; effort?: string | null;
      latency_ms?: number; agent?: string; child?: boolean };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.msg === "LLM request completed") firstRequest = Math.min(firstRequest, entry.time ?? Infinity);
    if (!entry.channel) continue;
    const turn = open.get(entry.channel);
    if (entry.msg === "Turn started") {
      // A turn without a message (a slash command, voice, /retry) has no text to read back.
      const next: Turn = { channel: entry.channel, message_id: entry.message_id ?? "", started: entry.time ?? 0,
        provider: entry.provider, model: entry.model, effort: entry.effort, requests: 0 };
      turns.push(next);
      open.set(entry.channel, next);
    } else if (!turn) continue;
    else if (entry.msg === "Auto route selected") turn.route = { model: entry.model, effort: entry.effort };
    // The turn's own requests: not a subagent's, and not the summary a thread is given first.
    else if (entry.msg === "LLM request completed") {
      if (entry.child !== true && entry.agent !== "compaction") { turn.requests = (turn.requests ?? 0) + 1; turn.last_request = entry.time; }
    } else if (entry.msg === "Turn completed") {
      turn.completed = { at: entry.time ?? 0, provider: entry.provider, model: entry.model, latency_ms: entry.latency_ms };
      open.delete(entry.channel);
    }
  }
  const starts = new Map<string, number>();
  for (const t of turns) if (t.message_id) starts.set(t.message_id, (starts.get(t.message_id) ?? 0) + 1);
  for (const t of turns) {
    // Finished before the bot began to log its requests: the count is not known.
    if (!t.requests && (t.completed?.at ?? t.started) < firstRequest) t.requests = null;
    if ((starts.get(t.message_id) ?? 0) > 1) t.shared = true;
  }
  return turns;
}

const provider = (t: Turn) => t.completed?.provider ?? t.provider ?? "";
const model = (t: Turn) => t.completed?.model ?? t.route?.model ?? t.model ?? "";
/** A finished turn on Anthropic's API or a Claude model, started by one message of its own. */
export const usable = (t: Turn) => Boolean(t.completed && t.message_id && !t.shared) && (CLAUDE.has(provider(t)) || model(t).startsWith("claude"));

/** The reply among the messages the bot posted during a turn. It also posts a
 *  route notice and a progress message, which it then edits in place, so that
 *  message's id is from when the work began. The reply is sent after the
 *  turn's last request; where the log does not have that time, it is the last
 *  run of messages with no pause between them, since it is sent in pieces one
 *  right after another. */
export function finalReply(messages: Message[], lastRequest?: number): string | null {
  const posted = messages
    // One version of the bot put the route notice on the reply's first line.
    .map((m) => ({ at: madeAt(m.id), text: (m.content ?? "").replace(/^Auto Routing: \*\*[^\n]*\*\*\n?/, "") }))
    .filter((m) => m.text).sort((a, b) => a.at - b.at);
  if (!posted.length) return null;
  // The log's clock and Discord's are not the same clock: allow a second.
  const after = lastRequest === undefined ? [] : posted.filter((m) => m.at >= lastRequest - 1000);
  if (after.length) return after.map((m) => m.text).join("\n");
  let first = posted.length - 1;
  while (first > 0 && posted[first]!.at - posted[first - 1]!.at <= 3_000) first--;
  return posted.slice(first).map((m) => m.text).join("\n");
}

/** The files the bot told the model about: the message's own and those of
 *  the message it replies to. Null when it replies to a message that cannot
 *  be seen any more, so that what was attached is not known. */
export function attachmentsOf(m: Message): Attachment[] | null {
  if (m.message_reference && !m.referenced_message) return null;
  return [...(m.attachments ?? []), ...(m.referenced_message?.attachments ?? [])];
}

/** The text the bot gave the model for a message, with the ids of the line it
 *  appends left out. In a server the bot used the author's nickname there;
 *  the message read back has only the account's name. */
export function promptOf(m: Message): string {
  const attachments = attachmentsOf(m) ?? [];
  return `${m.content ?? ""}\n\n[author: ${m.author?.global_name ?? m.author?.username ?? "?"}; user_id: 0; channel_id: 0; message_id: 0]` +
    (attachments.length ? "\nAttachments: " + attachments.map((a) => JSON.stringify({ id: "0", filename: a.filename, url: "", bytes: a.size })).join("\n") : "");
}

/** One case per usable turn whose message can still be read.
 *
 *  The conversation given with a case is the exchanges right before it in the
 *  channel: earlier usable turns on the same provider and model, each within
 *  thirty minutes of the next. It is context for the replay, not a record of
 *  what the bot had in memory: the log does not say when a conversation was
 *  cleared, and the bot's rules for keeping one changed during the log's
 *  fourteen days. A turn that comes within thirty minutes of one that cannot
 *  be rebuilt (it failed, had no message, or its message is gone) is marked
 *  `after_unknown`, because it may be a follow-up to something not exported. */
export async function collect(turns: Turn[], read: Read, count: (key: string) => void = () => {}) {
  const me = (await read("/users/@me")) as { id?: string } | undefined;
  if (!me?.id) throw new Error("Discord did not return the bot's own account");
  const byChannel = new Map<string, Turn[]>();
  for (const t of turns) byChannel.set(t.channel, [...(byChannel.get(t.channel) ?? []), t]);
  const cases: Record<string, unknown>[] = [];
  for (const [channelId, list] of byChannel) {
    if (!list.some(usable)) continue;
    const channel = (await read(`/channels/${channelId}`)) as { guild_id?: string; type?: number } | undefined;
    if (!channel) { count("channels that can no longer be read"); continue; }
    const seen: ({ turn: Turn; prompt: string; reply: string | null } | undefined)[] = [];
    for (const [index, turn] of list.entries()) {
      seen.push(undefined);
      if (!usable(turn)) { if (turn.shared) count("turns that share their message with another turn"); continue; }
      const message = (await read(`/channels/${channelId}/messages/${turn.message_id}`)) as Message | undefined;
      if (!message?.id) { count("turns whose message is gone"); continue; }
      const after = ((await read(`/channels/${channelId}/messages?after=${turn.message_id}&limit=100`)) as Message[] | undefined) ?? [];
      // What was posted while this turn ran. A channel runs one turn at a
      // time, so the bot's messages in that span are this turn's, even when
      // the next question arrived before the reply did.
      const during = after.filter((m) => madeAt(m.id) >= turn.started - 1500 && madeAt(m.id) <= turn.completed!.at + 1500);
      const entry = { turn, prompt: promptOf(message), reply: finalReply(during.filter((m) => m.author?.id === me.id), turn.last_request) };
      seen[index] = entry;
      const history: { role: "user" | "assistant"; content: string }[] = [];
      let earlierTools = false, afterUnknown = false, trimmed = false;
      for (let back = index - 1, later = turn; back >= 0; later = list[back]!, back--) {
        const earlier = list[back]!;
        if (later.started - (earlier.completed?.at ?? earlier.started) > 30 * MINUTE) break;
        const before = seen[back];
        if (!before) { afterUnknown = true; break; }
        // The bot starts a conversation over when the model changes.
        if (provider(earlier) !== provider(turn) || model(earlier) !== model(turn)) break;
        if (history.length >= 20) { trimmed = true; break; }
        history.unshift({ role: "user", content: before.prompt }, ...(before.reply ? [{ role: "assistant" as const, content: before.reply }] : []));
        // Not known for a turn older than the log's request lines: taken as yes.
        if (earlier.requests === null || earlier.requests > 1) earlierTools = true;
      }
      const attachments = attachmentsOf(message);
      cases.push({
        id: `${tag(channelId)}-${tag(turn.message_id)}`, at: turn.started, scope: channel.guild_id ? "guild" : "dm", channel: tag(channelId),
        provider: provider(turn), model: model(turn), effort: turn.route?.effort ?? turn.effort ?? null,
        source: "discord", history, summarized: false, trimmed, earlier_tools: earlierTools, after_unknown: afterUnknown,
        prompt: entry.prompt,
        // Messages the same person sent while the turn ran: the bot took them into the turn.
        extra_messages: during.filter((m) => !m.author?.bot && m.author?.id === message.author?.id).length,
        attachments_unknown: attachments === null, edited: Boolean(message.edited_timestamp),
        reply: entry.reply,
        // The log counts a turn's requests but does not name its tools.
        tools: [], requests: turn.requests, production: { latency_ms: turn.completed!.latency_ms ?? null },
      });
      count(`turns: ${model(turn)} ${turn.route?.effort ?? turn.effort ?? "-"}`);
      if (turn.requests !== null && turn.requests > 1) count("turns that made more than one request (tools)");
      if (turn.requests === null) count("turns older than the log's request lines (tool use unknown)");
      if (attachments === null || attachments.length) count("turns with attachments, their own or of the message they reply to");
    }
  }
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) throw new Error("Two exported turns have the same id");
  return cases;
}

/** A failed read, named by its kind only: an address read from Discord holds real ids. */
export class Unavailable extends Error {}

/** Reads from Discord, one request at a time. There is no way to pass a
 *  method or a body: it can only GET. It waits when Discord asks it to, and
 *  gives up on the whole run, instead of going on to the next address, when
 *  Discord asks for a long wait or does not accept the token. */
export function discordReader(
  token: string,
  o: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<unknown>; count?: (key: string) => void } = {},
): Read {
  const request = o.fetch ?? fetch, sleep = o.sleep ?? Bun.sleep, count = o.count ?? (() => {});
  return async (path) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(150);
      let response: Response;
      try {
        response = await request(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
      } catch (error) {
        count(`network errors (${String((error as { code?: unknown }).code ?? "unknown")})`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (response.status === 401) throw new Unavailable("Discord did not accept the bot's token (401)");
      if (response.status === 404 || response.status === 403) { count(`Discord answered ${response.status}`); return undefined; }
      if (response.status === 429) {
        const body = (await response.json().catch(() => null)) as { retry_after?: number } | null;
        const wait = Math.max(Number(body?.retry_after ?? 0), Number(response.headers.get("retry-after") ?? 0));
        // No wait named, or a long one: the address or the token is being held back, not one route.
        if (!body || !(wait > 0) || wait > 120) throw new Unavailable("Discord is limiting requests (429) for longer than this run waits");
        count("waits Discord asked for (429)");
        await sleep(wait * 1000 + 250);
        continue;
      }
      if (response.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      if (!response.ok) throw new Unavailable(`Discord answered ${response.status}`);
      // The route's allowance is used up: wait for it instead of asking and being refused.
      if (response.headers.get("x-ratelimit-remaining") === "0")
        await sleep(Math.min(60, Number(response.headers.get("x-ratelimit-reset-after") ?? 1)) * 1000 + 100);
      try { return await response.json(); } catch { count("answers that were not JSON"); }
    }
    throw new Unavailable("Discord could not be read after several attempts");
  };
}

function servicePaths() {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync("/etc/hibana/bot.env", "utf8").split("\n")) {
      const match = /^(HIBANA_DATA_DIR|LOG_DIR|DISCORD_TOKEN)=(.*)$/.exec(line.trim());
      if (match) env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {}
  let cwd = process.cwd();
  try {
    const pid = Number(Bun.spawnSync(["systemctl", "show", "hibana", "-p", "MainPID", "--value"]).stdout.toString().trim());
    if (pid > 0) cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {}
  return {
    logs: env.LOG_DIR ? resolve(cwd, env.LOG_DIR) : join(resolve(cwd, env.HIBANA_DATA_DIR || "./data"), "logs"),
    token: process.env.DISCORD_TOKEN || env.DISCORD_TOKEN || "",
  };
}

if (import.meta.main) {
  // Nothing is written to stdout unless every read succeeded, and an error is
  // reported by its kind: the runtime's own report of a thrown error would
  // print the address that was being read.
  try {
    const paths = servicePaths();
    const logs = process.argv.slice(2).filter((a) => a !== "-")[0] ?? paths.logs;
    if (!existsSync(logs)) throw new Unavailable("The log directory was not found; pass its path as the argument");
    if (!paths.token) throw new Unavailable("The bot's token was not found (DISCORD_TOKEN)");
    const files = readdirSync(logs).filter((n) => /^hibana-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
    // One file in memory at a time.
    const turns = turnsFromLog((function* () { for (const name of files) yield* readFileSync(join(logs, name), "utf8").split("\n"); })());
    const counts = new Map<string, number>();
    const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
    const cases = await collect(turns, discordReader(paths.token, { count }), count);
    process.stdout.write(cases.map((c) => JSON.stringify(c) + "\n").join(""));
    console.error(`${cases.length} turns exported from ${turns.filter(usable).length} in the log (${files.length} log files, ${turns.length} turns of every provider)`);
    for (const [key, n] of [...counts].sort()) console.error(`  ${String(n).padStart(5)}  ${key}`);
  } catch (error) {
    console.error(`Nothing was exported: ${error instanceof Unavailable ? error.message : `an unexpected ${error instanceof Error ? error.name : "error"}`}`);
    process.exitCode = 1;
  }
}
