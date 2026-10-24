// Usage on the dashboard's 利用料 page (#110): turns, distinct Discord users
// and published sites per billing month, for Administrators only.
//
// The bot already posts every finished or failed turn to /internal/logs. The
// API turns each into one count here whether or not the conversation log is
// kept (WEB_LOGS_ENABLED), so no bot change is needed and a bot rolled back
// alone keeps feeding it (docs/adr/0006).
//
// Kept per turn: the UTC day, a keyed hash of the Discord user ID, the
// provider, the model and whether it failed. Not kept: the time of day, the
// server, the channel or any text. Rows are one per day, user and model with
// the turns counted (#111: a month's distinct users from per-turn rows cost a
// sort of every turn; this keeps the month at a few thousand rows).
import { createHash, createHmac } from "node:crypto";
import { billingBounds } from "@hibana/shared/billing";
import type { LogEntry } from "./audit";

/** Days of usage kept, like the bot's Anthropic spend ledger. */
export const USAGE_RETENTION_DAYS = 400;

const DAY_MS = 86_400_000;
/** Longest provider or model name kept; the bot's are well under it. */
const NAME_MAX = 100;

export type UsageTurn = {
  /** UTC day number: Unix milliseconds ÷ 86,400,000, rounded down. */
  day: number;
  user_hash: string;
  provider: string;
  model: string;
  failed: boolean;
};

export type UsageQuery = {
  /** First UTC day number counted, and the one after the last. */
  fromDay: number;
  toDay: number;
  /** User hashes left out of `users_excluding_admins`. */
  exclude: string[];
  /** The same range in Unix seconds, for when a site was created. */
  fromUnix: number;
  toUnix: number;
  /** Sites still published at this Unix second count as published. */
  nowUnix: number;
};

export type UsageCounts = {
  turns: number;
  failed: number;
  users: number;
  users_excluding_admins: number;
};

export type UsageReport = {
  days: ({ day: number } & UsageCounts)[];
  totals: UsageCounts;
  models: { provider: string; model: string; turns: number }[];
  /** Earliest day kept, over every month: when counting started. */
  first_day: number | null;
  sites: { published: number; created: number };
};

/**
 * The key user IDs are hashed with, derived from `WEB_SESSION_SECRET` for this
 * use only (#110). It lives in the API's environment, apart from the database,
 * so a copy of the table alone cannot be matched back to Discord IDs by
 * hashing every plausible one. Changing the session secret changes every
 * hash: a month that spans the change counts a returning person twice.
 */
export function usageHashKey(sessionSecret: string): Buffer {
  return createHmac("sha256", sessionSecret)
    .update("hibana:usage-user:v1")
    .digest();
}

/** 16 bytes of HMAC-SHA256 of the Discord ID, base64url: 22 characters. */
export function hashUser(key: Buffer, discordId: string): string {
  return createHmac("sha256", key)
    .update(discordId)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

/**
 * A site is remembered by a hash of its token, which is part of its address.
 * Tokens are random, so a plain hash cannot be reversed.
 */
export function siteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** One turn the bot posted, as it is counted. */
export function usageTurn(entry: LogEntry, key: Buffer): UsageTurn {
  return {
    day: Math.floor(entry.at / DAY_MS),
    user_hash: hashUser(key, entry.user_id),
    provider: (entry.provider ?? "").slice(0, NAME_MAX),
    model: (entry.model ?? "").slice(0, NAME_MAX),
    failed: entry.error !== null || entry.failure_code !== null,
  };
}

export type UsageRow = {
  day: number;
  user_hash: string;
  provider: string;
  model: string;
  turns: number;
  failed: number;
};

/** Turns that share a day, user and model, summed into the row they add to. */
export function groupTurns(turns: UsageTurn[]): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const t of turns) {
    const key = [t.day, t.user_hash, t.provider, t.model].join("\u0000");
    const row = rows.get(key) ?? {
      day: t.day,
      user_hash: t.user_hash,
      provider: t.provider,
      model: t.model,
      turns: 0,
      failed: 0,
    };
    row.turns++;
    if (t.failed) row.failed++;
    rows.set(key, row);
  }
  return [...rows.values()];
}

/**
 * Whether a site is published now, as the bot judges it
 * (apps/bot/src/tools/sites.ts): kept for good, with no expiry, or not yet expired.
 */
export function sitePublished(
  site: { retention: string; expires_at_unix: number },
  nowUnix: number,
): boolean {
  return (
    site.retention === "permanent" ||
    site.expires_at_unix === 0 ||
    site.expires_at_unix > nowUnix
  );
}

const dateOf = (day: number) =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);
const dayOf = (date: string) =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/** The store query for a `YYYY-MM` billing month (5th to the 4th, UTC; #81). */
export function usageQuery(
  month: string,
  exclude: string[],
  now: number,
): UsageQuery {
  const { start, end } = billingBounds(month);
  const fromDay = dayOf(start);
  const toDay = dayOf(end);
  return {
    fromDay,
    toDay,
    exclude,
    fromUnix: (fromDay * DAY_MS) / 1000,
    toUnix: (toDay * DAY_MS) / 1000,
    nowUnix: Math.floor(now / 1000),
  };
}

/** What GET /api/analytics/usage answers. */
export function usageResponse(
  month: string,
  current: boolean,
  q: UsageQuery,
  report: UsageReport,
) {
  return {
    month,
    current,
    start: dateOf(q.fromDay),
    end: dateOf(q.toDay),
    first_day: report.first_day === null ? null : dateOf(report.first_day),
    retention_days: USAGE_RETENTION_DAYS,
    days: report.days.map(({ day, ...counts }) => ({
      date: dateOf(day),
      ...counts,
    })),
    totals: report.totals,
    models: report.models,
    sites: report.sites,
  };
}

/** Pure: the report from rows held in memory (MemoryStore and tests). */
export function reportFromRows(
  rows: UsageRow[],
  sites: { retention: string; expires_at_unix: number }[],
  created: number[],
  q: UsageQuery,
): UsageReport {
  const exclude = new Set(q.exclude);
  const inRange = rows.filter((r) => r.day >= q.fromDay && r.day < q.toDay);
  const counts = (list: typeof inRange): UsageCounts => {
    const users = new Set(list.map((r) => r.user_hash));
    return {
      turns: list.reduce((n, r) => n + r.turns, 0),
      failed: list.reduce((n, r) => n + r.failed, 0),
      users: users.size,
      users_excluding_admins: [...users].filter((u) => !exclude.has(u)).length,
    };
  };
  const byDay = new Map<number, typeof inRange>();
  for (const r of inRange) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const byModel = new Map<
    string,
    { provider: string; model: string; turns: number }
  >();
  for (const r of inRange) {
    const key = `${r.provider}\u0000${r.model}`;
    const m = byModel.get(key) ?? {
      provider: r.provider,
      model: r.model,
      turns: 0,
    };
    m.turns += r.turns;
    byModel.set(key, m);
  }
  return {
    days: [...byDay.entries()]
      .sort(([a], [b]) => a - b)
      .map(([day, list]) => ({ day, ...counts(list) })),
    totals: counts(inRange),
    models: [...byModel.values()].sort(
      (a, b) =>
        b.turns - a.turns ||
        (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) ||
        (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
    ),
    first_day: rows.length ? Math.min(...rows.map((r) => r.day)) : null,
    sites: {
      published: sites.filter((s) => sitePublished(s, q.nowUnix)).length,
      created: created.filter((c) => c >= q.fromUnix && c < q.toUnix).length,
    },
  };
}
