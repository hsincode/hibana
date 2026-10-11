// Manual export of the stored conversations for the harness comparison (#69).
// It runs where the bot's data is, only reads, and prints one JSON line per
// turn that used Anthropic's API or a Claude model (counts go to stderr):
//   (umask 077; ssh "$TARGET" 'PATH="$PATH:$HOME/.bun/bin" bun run -' \
//     < apps/bot/src/export-conversations.ts > .local/harness-eval/cases.jsonl)
// Optional arguments: <conversations.db> <log directory>. Without them the
// paths come from the service: HIBANA_DATA_DIR, CONVERSATION_DB_PATH and
// LOG_DIR in /etc/hibana/bot.env, else ./data under the running bot.
//
// The output is people's messages, DMs included. Keep it under .local/
// (gitignored); it must not reach the repository, an Issue or a log. Channel
// ids are written as short hashes and the ids inside a message as zeros; the
// author's display name and the text itself are kept.
// This file imports nothing from the repository: it is piped to a machine
// that runs another commit.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

type Stored = {
  role: string; content?: string | null; internal?: boolean; sticky?: boolean;
  tool_calls?: { function?: { name?: string } }[];
};
type Usage = { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; cache_write_tokens?: number };
/** What the bot's own log says about one turn. It holds no message text. */
type Logged = {
  provider?: string; model?: string; effort?: string | null;
  route?: { model?: string; effort?: string | null };
  completed?: { provider?: string; model?: string; usage?: Usage; latency_ms?: number };
};

function servicePaths() {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync("/etc/hibana/bot.env", "utf8").split("\n")) {
      const match = /^(HIBANA_DATA_DIR|CONVERSATION_DB_PATH|LOG_DIR)=(.*)$/.exec(line.trim());
      if (match) env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
    }
  } catch {}
  let cwd = process.cwd();
  try {
    const pid = Number(Bun.spawnSync(["systemctl", "show", "hibana", "-p", "MainPID", "--value"]).stdout.toString().trim());
    if (pid > 0) cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {}
  const data = resolve(cwd, env.HIBANA_DATA_DIR || "./data");
  return {
    db: env.CONVERSATION_DB_PATH ? resolve(cwd, env.CONVERSATION_DB_PATH) : join(data, "conversations.db"),
    logs: env.LOG_DIR ? resolve(cwd, env.LOG_DIR) : join(data, "logs"),
  };
}

const args = process.argv.slice(2).filter((a) => a !== "-");
const paths = { ...servicePaths(), ...(args[0] && { db: args[0] }), ...(args[1] && { logs: args[1] }) };
if (!existsSync(paths.db)) throw new Error("conversations.db was not found; pass its path as the first argument");

// Turns as the log saw them, by the Discord message that started each one.
// A channel runs one turn at a time, so the lines of a turn follow its start.
const logged = new Map<string, Logged>();
const open = new Map<string, Logged>();
const count = new Map<string, number>();
const bump = (key: string) => count.set(key, (count.get(key) ?? 0) + 1);
let logFiles = 0;
if (existsSync(paths.logs))
  for (const name of readdirSync(paths.logs).filter((n) => /^hibana-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort()) {
    logFiles++;
    for (const line of readFileSync(join(paths.logs, name), "utf8").split("\n")) {
      if (!line.includes('"Turn started"') && !line.includes('"Auto route selected"') && !line.includes('"Turn completed"')) continue;
      let entry: { msg?: string; channel?: string; message_id?: string } & Logged & Logged["completed"];
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry.channel) continue;
      if (entry.msg === "Turn started") {
        const turn: Logged = { provider: entry.provider, model: entry.model, effort: entry.effort };
        open.set(entry.channel, turn);
        if (entry.message_id) logged.set(entry.message_id, turn);
      } else if (entry.msg === "Auto route selected") {
        const turn = open.get(entry.channel);
        if (turn) turn.route = { model: entry.model, effort: entry.effort };
      } else if (entry.msg === "Turn completed") {
        const turn = open.get(entry.channel);
        if (turn && !turn.completed)
          turn.completed = { provider: entry.provider, model: entry.model, usage: entry.usage, latency_ms: entry.latency_ms };
        // How many turns the log covers, whether or not their text is still stored.
        bump(`log: completed turns on ${entry.provider} ${entry.model}`);
        open.delete(entry.channel);
      }
    }
  }

const db = new Database(paths.db, { readonly: true });
const tag = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);
const text = (m: Stored) => (typeof m.content === "string" ? m.content : "");
// The line the bot appends to a message names the author's, the channel's and
// the message's Discord ids. The exported text keeps its shape without them.
const anonymous = (value: string) => value.replace(/user_id: \d+; channel_id: \d+; message_id: \d+\]/g, "user_id: 0; channel_id: 0; message_id: 0]");
const routes = new Map((db.query("SELECT channel_id, selection FROM routes").all() as { channel_id: string; selection: string }[])
  .map((r) => [r.channel_id, r.selection]));
let cases = 0;

for (const channel of db.query("SELECT channel_id, guild_id, key FROM history_channels").all() as { channel_id: string; guild_id: string | null; key: string }[]) {
  let key: { provider?: string; model?: string; effort?: string | null };
  let route: { model?: string; effort?: string | null } = {};
  try { key = JSON.parse(channel.key); } catch { continue; }
  try { route = JSON.parse(routes.get(channel.channel_id) ?? "{}"); } catch {}
  const claude = ["anthropic", "claude_max", "claude_kiro"].includes(key.provider ?? "") || (key.model ?? "").startsWith("claude");
  if (!claude) { bump(`channels skipped: ${key.provider}`); continue; }
  bump(`channels: ${key.provider} ${key.model}`);
  const auto = key.model === "auto";
  // The conversation so far, as text: what each earlier turn asked and answered.
  let history: { role: "user" | "assistant"; content: string }[] = [];
  let summarized = false;
  // An earlier turn that called tools left files and results behind that the
  // text of the conversation does not carry.
  let earlierTools = false;
  const turns = db.query("SELECT seq, at, summary, messages FROM history_turns WHERE channel_id = ? ORDER BY seq")
    .all(channel.channel_id) as { seq: number; at: number; summary: number; messages: string }[];
  for (const [index, turn] of turns.entries()) {
    let messages: Stored[];
    try { messages = JSON.parse(turn.messages); } catch { continue; }
    if (turn.summary) {
      // A thread's older turns were replaced by this summary.
      summarized = true;
      history = messages.filter((m) => text(m)).map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: text(m) }));
      continue;
    }
    const asked = messages.filter((m) => m.role === "user" && !m.internal && text(m));
    const answers = messages.filter((m) => m.role === "assistant" && text(m) && !m.tool_calls?.length);
    const prompt = asked[0] ? text(asked[0]) : "";
    const reply = answers.length ? text(answers.at(-1)!) : null;
    if (prompt) {
      const seen = logged.get(/message_id: (\d+)\]/.exec(prompt)?.[1] ?? "");
      const model = seen?.completed?.model ?? seen?.route?.model ?? (seen?.model !== "auto" ? seen?.model : undefined) ?? (auto ? route.model : key.model) ?? null;
      const effort = seen?.route?.effort ?? seen?.effort ?? (auto ? route.effort : key.effort) ?? null;
      process.stdout.write(JSON.stringify({
        id: `${tag(channel.channel_id)}-${turn.seq}`, at: turn.at, scope: channel.guild_id ? "guild" : "dm", channel: tag(channel.channel_id),
        provider: seen?.completed?.provider ?? seen?.provider ?? key.provider ?? null, model, effort, auto,
        // "log": the bot's log names this turn's model. Otherwise it is the conversation's current one.
        source: seen ? "log" : auto ? "route" : "key",
        history, summarized, trimmed: !summarized && index === 0 && turn.seq > 0, earlier_tools: earlierTools,
        prompt: anonymous(prompt), extra_messages: asked.length - 1, reply,
        tools: [...new Set(messages.flatMap((m) => m.tool_calls ?? []).map((call) => call.function?.name ?? "?"))],
        production: seen?.completed ? { latency_ms: seen.completed.latency_ms ?? null, usage: seen.completed.usage ?? null } : null,
      }) + "\n");
      cases++;
      bump(`turns: ${model ?? "model unknown"} ${effort ?? "-"}`);
      bump(seen?.completed ? "turns whose time is in the log" : seen ? "turns the log saw start but not finish" : "turns not in the log");
    }
    history = [...history, ...asked.map((m) => ({ role: "user" as const, content: anonymous(text(m)) }))];
    if (reply) history = [...history, { role: "assistant", content: reply }];
    if (messages.some((m) => m.tool_calls?.length)) earlierTools = true;
  }
}
console.error(`${cases} turns exported (${logFiles} log files read)`);
for (const [key, n] of [...count].sort()) console.error(`  ${String(n).padStart(5)}  ${key}`);
