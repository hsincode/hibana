// Turns from before the usage count started (#116), added to it once.
//
// The API counts a turn when the bot posts it to /internal/logs (#110). That
// began with the API deploy of #112 at 2026-10-24 16:16:30 UTC. This script
// finds the turns before it and posts them the same way, so the API hashes
// the user IDs with the same key and adds them to usage_daily:
//
// - From the first log file on (2026-10-11), each "Turn started" in the bot's
//   log files is one turn. The log has the channel and the message, not the
//   user, so the user is the author of that message on Discord.
// - Before the logs, Discord's history is all there is. A person's message
//   that the bot's own rule would answer (triggers.ts), followed by a message
//   from the bot, is one turn. The model and whether it failed are unknown.
//   The same rule is checked against the logs where both exist.
//
// Run on the VPS, where the logs, the settings snapshot and the token are:
//
//   cd /opt/hibana/apps/bot
//   bun --env-file=/etc/hibana/bot.env src/usage-backfill.ts plan
//   bun --env-file=/etc/hibana/bot.env src/usage-backfill.ts send
//
// `plan` only reads. It writes the turns it found to the plan file (mode
// 600; it holds Discord IDs) and prints counts, never an ID. `send` posts the
// plan file and records each batch it sent in a marker beside it. Sending
// again is refused: usage_daily cannot tell a turn sent twice from two turns.
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { billingMonth } from "@hibana/shared/billing";
import {
  emptyGuild,
  normalizeGuild,
  type GuildRow,
} from "@hibana/shared/settings";
import { imagePrompt, shouldRespond } from "./triggers";

/** When the API began counting turns: the production deploy of #112. */
export const COUNT_STARTED = Date.parse("2026-10-24T16:16:30Z");
/** A reply later than this after a message is not taken as its answer. */
export const REPLY_WINDOW_MS = 30 * 60_000;
const DISCORD_EPOCH = 1_420_070_400_000n;

/** The time a Discord ID was made, in Unix milliseconds. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** One JSON line of the bot's log, with only the fields read here. */
export type LogLine = {
  time: number;
  pid: number;
  msg: string;
  channel?: string;
  message_id?: string;
  provider?: string;
  model?: string;
  failure_code?: string;
};

/** A turn as the bot would have posted it. */
export type LogTurn = {
  channel: string;
  messageId: string | null;
  started: number;
  /** What the bot sends as `at`: when a success ended, when a failure began. */
  at: number;
  provider: string;
  model: string;
  failed: boolean;
};

export type LogTurns = {
  turns: LogTurn[];
  /** Ended by a stop or a crash: the bot posts nothing for these. */
  aborted: number;
  /** Failures with more than one turn running in the process. */
  ambiguous: number;
  /** Still running at the end of the logs. */
  open: number;
};

export function parseLogLine(line: string): LogLine | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.time !== "number" || typeof r.msg !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    time: r.time,
    pid: typeof r.pid === "number" ? r.pid : 0,
    msg: r.msg,
    channel: str(r.channel),
    message_id: str(r.message_id),
    provider: str(r.provider),
    model: str(r.model),
    failure_code: str(r.failure_code),
  };
}

type Open = Omit<LogTurn, "at" | "failed">;

/**
 * Turns from log lines in the order they were written. Each process (pid)
 * runs its turns apart: a channel's "Turn completed" ends the oldest turn
 * still open in that channel. A turn's failure is logged without the
 * channel, so it ends the oldest open turn of the process.
 */
export function logTurns(lines: LogLine[]): LogTurns {
  const open = new Map<number, Open[]>();
  const result: LogTurns = { turns: [], aborted: 0, ambiguous: 0, open: 0 };
  const take = (pid: number, i: number) => open.get(pid)!.splice(i, 1)[0];
  for (const l of lines) {
    const list = open.get(l.pid) ?? [];
    open.set(l.pid, list);
    if (l.msg === "Turn started" && l.channel) {
      list.push({
        channel: l.channel,
        messageId: l.message_id ?? null,
        started: l.time,
        provider: l.provider ?? "",
        model: l.model ?? "",
      });
    } else if (l.msg === "Auto route selected" && l.channel && l.model) {
      let t: Open | undefined;
      for (const o of list)
        if (o.channel === l.channel && o.messageId === (l.message_id ?? null))
          t = o;
      if (t) t.model = l.model;
    } else if (l.msg === "Turn completed" && l.channel) {
      const i = list.findIndex((t) => t.channel === l.channel);
      if (i < 0) continue;
      const t = take(l.pid, i);
      result.turns.push({
        ...t,
        provider: l.provider ?? t.provider,
        model: l.model ?? t.model,
        at: l.time,
        failed: false,
      });
    } else if (l.msg === "Hibana operation failed" && l.failure_code) {
      if (!list.length) continue;
      if (list.length > 1) result.ambiguous++;
      const t = take(l.pid, 0);
      result.turns.push({ ...t, at: t.started, failed: true });
    } else if (l.msg === "Stopping Hibana") {
      result.aborted += list.length;
      list.length = 0;
    } else if (l.msg === "Hibana ready") {
      // A new process: anything a crashed one left open never finished.
      for (const [pid, other] of open)
        if (pid !== l.pid) {
          result.aborted += other.length;
          other.length = 0;
        }
    }
  }
  for (const list of open.values()) result.open += list.length;
  result.turns.sort((a, b) => a.started - b.started);
  return result;
}

/** A Discord message, reduced to what the turn rule needs. */
export type HistoryMessage = {
  id: string;
  at: number;
  authorId: string;
  /** Sent by this bot. */
  ours: boolean;
  /** Sent by a person, and the bot's rule would answer it. */
  trigger: boolean;
  /** When the message was last edited, or `at`. The bot edits its progress
   *  message until the turn ends. */
  until: number;
};

export type HistoryTurn = { messageId: string; userId: string; at: number };

/**
 * Turns in one channel's messages, oldest first. A message that would start
 * a turn waits for the bot's next message within the reply window; that
 * answers every person still waiting, once each. A person's further message
 * while their turn is still being edited steers it rather than starting a
 * new one (bot.ts onMessage).
 */
export function historyTurns(
  messages: HistoryMessage[],
  windowMs = REPLY_WINDOW_MS,
): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  const waiting = new Map<string, HistoryMessage>();
  const busyUntil = new Map<string, number>();
  for (const m of messages) {
    if (m.ours) {
      for (const [user, w] of waiting) {
        if (m.at - w.at > windowMs) continue;
        turns.push({ messageId: w.id, userId: user, at: w.at });
        busyUntil.set(user, m.until);
      }
      waiting.clear();
    } else if (m.trigger) {
      if (m.at <= (busyUntil.get(m.authorId) ?? -Infinity)) continue;
      const w = waiting.get(m.authorId);
      if (!w || m.at - w.at > windowMs) waiting.set(m.authorId, m);
    }
  }
  return turns;
}

/** What /internal/logs takes for one turn; the API keeps only the count. */
export type Entry = {
  at: number;
  guild_id: string | null;
  channel_id: string;
  user_id: string;
  username: string;
  prompt: string;
  reply: null;
  provider: string | null;
  model: string | null;
  error: string | null;
  failure_code: null;
};

export type Source = "logs" | "history";
export type PlannedTurn = Entry & { source: Source };

export function entry(
  t: {
    at: number;
    guildId: string | null;
    channelId: string;
    userId: string;
    provider?: string;
    model?: string;
    failed?: boolean;
  },
  source: Source,
): PlannedTurn {
  return {
    at: t.at,
    guild_id: t.guildId,
    channel_id: t.channelId,
    user_id: t.userId,
    username: t.userId,
    prompt: "",
    reply: null,
    provider: t.provider || null,
    model: t.model || null,
    error: t.failed ? "failed" : null,
    failure_code: null,
    source,
  };
}

export type Calibration = {
  logged: number;
  found: number;
  matched: number;
  /** Logged turns on days where the count differs, summed as absolute errors. */
  dayError: number;
  usersLogged: number;
  usersFound: number;
  usersShared: number;
};

/** The history rule against the logged turns of the same period. */
export function calibrate(
  logged: { messageId: string | null; userId: string; at: number }[],
  found: HistoryTurn[],
): Calibration {
  const ids = new Set(logged.map((t) => t.messageId));
  const day = (at: number) => Math.floor(at / 86_400_000);
  const perDay = new Map<number, number>();
  for (const t of logged)
    perDay.set(day(t.at), (perDay.get(day(t.at)) ?? 0) + 1);
  for (const t of found)
    perDay.set(day(t.at), (perDay.get(day(t.at)) ?? 0) - 1);
  const a = new Set(logged.map((t) => t.userId));
  const b = new Set(found.map((t) => t.userId));
  return {
    logged: logged.length,
    found: found.length,
    matched: found.filter((t) => ids.has(t.messageId)).length,
    dayError: [...perDay.values()].reduce((n, d) => n + Math.abs(d), 0),
    usersLogged: a.size,
    usersFound: b.size,
    usersShared: [...a].filter((u) => b.has(u)).length,
  };
}

/** Per billing month (#81): turns, failures and distinct users, by source. */
export function summarize(turns: PlannedTurn[]) {
  const months = new Map<
    string,
    { turns: number; failed: number; users: Set<string>; logs: number }
  >();
  for (const t of turns) {
    const key = billingMonth(new Date(t.at).toISOString().slice(0, 10));
    const m = months.get(key) ?? {
      turns: 0,
      failed: 0,
      users: new Set<string>(),
      logs: 0,
    };
    m.turns++;
    if (t.error) m.failed++;
    if (t.source === "logs") m.logs++;
    m.users.add(t.user_id);
    months.set(key, m);
  }
  return [...months.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, m]) => ({
      month,
      turns: m.turns,
      from_logs: m.logs,
      failed: m.failed,
      users: m.users.size,
    }));
}

// ---- Discord ----

export type RawMessage = {
  id: string;
  type: number;
  content: string;
  pinned: boolean;
  edited_timestamp: string | null;
  author: { id: string; bot?: boolean };
  mentions?: { id: string }[];
};
type RawChannel = {
  id: string;
  type: number;
  guild_id?: string;
  name?: string;
  parent_id?: string | null;
};

const DM = 1;
const THREADS = new Set([10, 11, 12]);
const FORUM = 15;

class Discord {
  constructor(private token: string) {}
  async get<T>(path: string): Promise<{ status: number; body: T }> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://discord.com/api/v10${path}`, {
        headers: {
          Authorization: `Bot ${this.token}`,
          "User-Agent": "DiscordBot (https://github.com/hsincode/hibana, 1)",
        },
      });
      const body = (await res.json().catch(() => null)) as T & {
        retry_after?: number;
      };
      // 202: the search index is still being built for this guild.
      if (res.status === 429 || res.status === 202) {
        await Bun.sleep(Math.ceil((body?.retry_after ?? 1) * 1000) + 100);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await Bun.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.headers.get("x-ratelimit-remaining") === "0")
        await Bun.sleep(
          Number(res.headers.get("x-ratelimit-reset-after") ?? 1) * 1000,
        );
      return { status: res.status, body };
    }
  }
}

/** Every channel and thread in a guild where the bot has written. */
async function channelsWithBot(d: Discord, guildId: string, botId: string) {
  const channels = new Set<string>();
  for (let offset = 0; offset <= 9975; offset += 25) {
    const r = await d.get<{
      total_results?: number;
      messages?: { channel_id: string }[][];
    }>(
      `/guilds/${guildId}/messages/search?author_id=${botId}&limit=25&offset=${offset}&sort_by=timestamp&sort_order=asc`,
    );
    if (r.status !== 200) throw new Error(`search: HTTP ${r.status}`);
    const page = r.body.messages ?? [];
    for (const hit of page) if (hit[0]) channels.add(hit[0].channel_id);
    if (page.length < 25 || offset + 25 >= (r.body.total_results ?? 0)) break;
  }
  return channels;
}

/** A channel's messages since `floor`, oldest first. */
async function history(d: Discord, channelId: string, floor: number) {
  const out: RawMessage[] = [];
  let before = "";
  for (;;) {
    const r = await d.get<RawMessage[]>(
      `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`,
    );
    if (r.status !== 200) return { status: r.status, messages: out.reverse() };
    out.push(...r.body);
    const last = r.body.at(-1);
    if (r.body.length < 100 || !last || snowflakeTime(last.id) < floor) break;
    before = last.id;
  }
  return { status: 200, messages: out.reverse() };
}

// Message types a person writes: default and reply (discord.js `system`).
const PERSON_TYPES = new Set([0, 19]);

export function reduceMessage(
  m: RawMessage,
  botId: string,
  channel: {
    dm: boolean;
    thread: boolean;
    title?: string;
    forumTitle?: string;
  },
  guild: GuildRow,
  extra: string[],
): HistoryMessage {
  const at = snowflakeTime(m.id);
  const ours = m.author.id === botId;
  const trigger =
    !ours &&
    !m.author.bot &&
    PERSON_TYPES.has(m.type) &&
    imagePrompt(m.content, botId) === null &&
    shouldRespond(
      {
        content: m.content,
        bot: false,
        pinned: m.pinned,
        system: false,
        mention: (m.mentions ?? []).some((u) => u.id === botId),
        ...channel,
      },
      guild,
      extra,
    );
  const edited = m.edited_timestamp ? Date.parse(m.edited_timestamp) : at;
  return { id: m.id, at, authorId: m.author.id, ours, trigger, until: edited };
}

// ---- plan and send ----

type Env = {
  DISCORD_TOKEN?: string;
  WEB_API_URL?: string;
  WEB_INTERNAL_TOKEN?: string;
  EXTRA_TRIGGERS?: string;
  HIBANA_DATA_DIR?: string;
};

const dataDir = (env: Env) => env.HIBANA_DATA_DIR || "/var/lib/hibana";
const workDir = (env: Env) => join(dataDir(env), "usage-backfill");

async function readLogs(dir: string) {
  const names = (await readdir(dir))
    .filter((n) => /^hibana-\d{4}-\d{2}-\d{2}\.log$/.test(n))
    .sort();
  if (!names.length) throw new Error(`no log files in ${dir}`);
  const lines: LogLine[] = [];
  for (const n of names)
    for (const line of (await readFile(join(dir, n), "utf8")).split("\n")) {
      const l = parseLogLine(line);
      if (l) lines.push(l);
    }
  return { lines, start: Date.parse(`${names[0].slice(7, 17)}T00:00:00Z`) };
}

async function plan(env: Env) {
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is required");
  const d = new Discord(token);
  const extra = (env.EXTRA_TRIGGERS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const snapshot = JSON.parse(
    await readFile(join(dataDir(env), "runtime_state.json"), "utf8"),
  ) as {
    guilds?: Record<string, Partial<GuildRow>>;
    defaults?: Partial<GuildRow>;
  };
  const base = normalizeGuild(snapshot.defaults, {
    ...emptyGuild(),
    extra_triggers: extra,
  });
  // The bot's answers are what the rule looks for, so a guild that has
  // stopped the bot since, or allows it only in threads, is not held to that.
  const guildRow = (id: string | null) => ({
    ...normalizeGuild(id ? snapshot.guilds?.[id] : null, base),
    bot_disabled: false,
    thread_only: false,
  });

  const logs = await readLogs(join(workDir(env), "logs"));
  const parsed = logTurns(logs.lines);
  const logged = parsed.turns.filter(
    (t) => t.started >= logs.start && t.at < COUNT_STARTED,
  );

  const me = (await d.get<{ id: string }>("/users/@me")).body;
  const floor = snowflakeTime(me.id);
  const guilds = (await d.get<{ id: string }[]>("/users/@me/guilds?limit=200"))
    .body;
  const channelIds = new Set<string>();
  for (const g of guilds)
    for (const c of await channelsWithBot(d, g.id, me.id)) channelIds.add(c);
  // Direct messages are not searchable; those in the logs are read whole.
  for (const t of logged) channelIds.add(t.channel);

  const channels = new Map<string, RawChannel>();
  const info = async (id: string) => {
    if (!channels.has(id)) {
      const r = await d.get<RawChannel>(`/channels/${id}`);
      if (r.status === 200) channels.set(id, r.body);
    }
    return channels.get(id);
  };
  const authors = new Map<string, string>();
  const found: (HistoryTurn & { guildId: string | null; channelId: string })[] =
    [];
  const unreadable: Record<string, number> = {};
  let messageCount = 0;
  for (const id of channelIds) {
    const c = await info(id);
    if (!c) {
      unreadable.channel = (unreadable.channel ?? 0) + 1;
      continue;
    }
    const thread = THREADS.has(c.type);
    const parent = thread && c.parent_id ? await info(c.parent_id) : undefined;
    const where = {
      dm: c.type === DM,
      thread,
      title: thread ? c.name : undefined,
      forumTitle: parent?.type === FORUM ? parent.name : undefined,
    };
    const h = await history(d, id, floor);
    if (h.status !== 200)
      unreadable[h.status] = (unreadable[h.status] ?? 0) + 1;
    messageCount += h.messages.length;
    const guild = guildRow(c.guild_id ?? null);
    const reduced = h.messages.map((m) => {
      authors.set(m.id, m.author.id);
      return reduceMessage(m, me.id, where, guild, extra);
    });
    for (const t of historyTurns(reduced))
      found.push({ ...t, guildId: c.guild_id ?? null, channelId: id });
  }

  // A message the history did not include (older than a page, or in a
  // channel not read) is looked up on its own.
  let deleted = 0;
  const loggedWithUser: (LogTurn & {
    userId: string;
    guildId: string | null;
  })[] = [];
  for (const t of logged) {
    let user = t.messageId ? authors.get(t.messageId) : undefined;
    if (!user && t.messageId) {
      const r = await d.get<RawMessage>(
        `/channels/${t.channel}/messages/${t.messageId}`,
      );
      if (r.status === 200) user = r.body.author.id;
    }
    if (!user) {
      deleted++;
      continue;
    }
    const c = channels.get(t.channel);
    loggedWithUser.push({ ...t, userId: user, guildId: c?.guild_id ?? null });
  }

  const overlap = found.filter(
    (t) => t.at >= logs.start && t.at < COUNT_STARTED,
  );
  const calibration = calibrate(loggedWithUser, overlap);
  const turns: PlannedTurn[] = [
    ...found.filter((t) => t.at < logs.start).map((t) => entry(t, "history")),
    ...loggedWithUser.map((t) => entry({ ...t, channelId: t.channel }, "logs")),
  ].sort((a, b) => a.at - b.at);

  const out = join(workDir(env), "plan.json");
  await writeFile(
    out,
    JSON.stringify({
      made_at: new Date().toISOString(),
      logs_start: new Date(logs.start).toISOString(),
      count_started: new Date(COUNT_STARTED).toISOString(),
      turns,
    }),
    { mode: 0o600 },
  );
  // Counts only: the plan file holds the IDs.
  console.log(
    JSON.stringify(
      {
        plan: out,
        bot_since: new Date(floor).toISOString().slice(0, 10),
        logs_start: new Date(logs.start).toISOString().slice(0, 10),
        guilds: guilds.length,
        channels: channelIds.size,
        messages_read: messageCount,
        unreadable,
        log_turns: {
          before_count_started: logged.length,
          after_count_started: parsed.turns.filter(
            (t) => t.started >= logs.start && t.at >= COUNT_STARTED,
          ).length,
          aborted: parsed.aborted,
          ambiguous_failures: parsed.ambiguous,
          still_open: parsed.open,
          message_not_found: deleted,
        },
        history_turns_before_logs: turns.filter((t) => t.source === "history")
          .length,
        calibration,
        months: summarize(turns),
        total: {
          turns: turns.length,
          users: new Set(turns.map((t) => t.user_id)).size,
        },
      },
      null,
      2,
    ),
  );
}

async function send(env: Env) {
  const api = env.WEB_API_URL?.replace(/\/$/, "");
  if (!api || !env.WEB_INTERNAL_TOKEN)
    throw new Error("WEB_API_URL and WEB_INTERNAL_TOKEN are required");
  const file = join(workDir(env), "plan.json");
  const marker = `${file}.sent`;
  const done = (await readFile(marker, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { from: number; to: number });
  const { turns } = JSON.parse(await readFile(file, "utf8")) as {
    turns: PlannedTurn[];
  };
  // A marker that covers the whole plan means it was sent; a partial one
  // (a send that stopped) resumes after the last batch it records.
  const from = done.length ? Math.max(...done.map((b) => b.to)) : 0;
  if (from >= turns.length) throw new Error(`already sent: ${marker}`);
  await mkdir(dirname(marker), { recursive: true });
  const BATCH = 200;
  for (let i = from; i < turns.length; i += BATCH) {
    const batch = turns.slice(i, i + BATCH).map(({ source: _, ...e }) => e);
    const res = await fetch(`${api}/internal/logs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WEB_INTERNAL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries: batch }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      enabled?: boolean;
    } | null;
    if (!res.ok || !body?.ok) throw new Error(`HTTP ${res.status} at ${i}`);
    await appendFile(
      marker,
      `${JSON.stringify({ from: i, to: i + batch.length, at: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    // With conversation logs kept, the entries would be stored as logs too.
    if (body.enabled !== false)
      throw new Error(
        "the API keeps conversation logs; stopped after one batch",
      );
  }
  console.log(JSON.stringify({ sent: turns.length - from, marker }));
}

if (import.meta.main) {
  const command = process.argv[2];
  const env = process.env as Env;
  if (command === "plan") await plan(env);
  else if (command === "send") await send(env);
  else {
    console.error("usage: bun src/usage-backfill.ts plan|send");
    process.exit(2);
  }
}
