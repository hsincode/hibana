import {
  FAILURE_CODES,
  FAILURE_PHASES,
  type FailureCode,
  type FailurePhase,
} from "@hibana/shared/audit";

export { FAILURE_CODES, FAILURE_PHASES };
export type { FailureCode, FailurePhase };

/**
 * Conversation audit log — every turn the bot actually answered, in guilds
 * **and** DMs, plus the kill-switch list that decides who never gets a turn.
 *
 * Only triggered turns land here (not every message the bot can see): the
 * dashboard needs "what did the bot do", and mirroring idle #general chatter
 * would multiply Neon writes by two orders of magnitude for no moderation value.
 *
 * Ingest is off unless `WEB_LOGS_ENABLED=true`. Default off because each turn
 * is a Neon INSERT (and an hourly prune DELETE) on the serverless driver.
 */

/** How long a turn stays readable. Rows older than this are pruned on write. */
export const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Hard caps so one runaway turn cannot blow up a row (and the log page). */
export const PROMPT_MAX = 4000;
export const REPLY_MAX = 8000;
export type LogEntry = {
  /** Unix ms of the user message that started the turn. */
  at: number;
  /** `null` = DM. The dashboard's DM filter is exactly `guild_id IS NULL`. */
  guild_id: string | null;
  guild_name: string | null;
  channel_id: string;
  channel_name: string | null;
  user_id: string;
  username: string;
  /** Why the bot woke: mention / keyword / dm / thread-title … */
  trigger: string | null;
  prompt: string;
  reply: string | null;
  provider: string | null;
  model: string | null;
  /** Set when the turn failed; `reply` is then null. */
  error: string | null;
  /** Stable phase used to aggregate failures without parsing error text. */
  failure_phase: FailurePhase | null;
  /** Stable category; never store the provider's raw error body here. */
  failure_code: FailureCode | null;
  /** HTTP status when the provider/API exposed one; otherwise null. */
  http_status: number | null;
  /** Whether a retry checkpoint existed when the failure was reported. */
  has_checkpoint: boolean | null;
  latency_ms: number | null;
};

export type LogRow = LogEntry & { id: number };

export type LogQuery = {
  limit: number;
  /** Keyset cursor: return rows with `id <` this. Newest page omits it. */
  before: number | null;
  guild_id: string | null;
  user_id: string | null;
  /** `dm` = DM turns only, `guild` = server turns only. */
  scope: "all" | "dm" | "guild";
  /** Substring match over prompt / reply / username. */
  q: string | null;
};

export type BlockedRow = {
  discord_id: string;
  /** Best-effort display name; blocking by raw id is allowed, so may be null. */
  username: string | null;
  reason: string | null;
  blocked_by: string;
  blocked_at: number;
};

const clamp = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/** Normalize one untrusted `/internal/logs` item. Returns null when unusable. */
export function parseLogEntry(raw: unknown): LogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const phase: FailurePhase | null =
    typeof r.failure_phase === "string" &&
    (FAILURE_PHASES as readonly string[]).includes(r.failure_phase)
      ? (r.failure_phase as FailurePhase)
      : null;
  const code: FailureCode | null =
    typeof r.failure_code === "string" &&
    (FAILURE_CODES as readonly string[]).includes(r.failure_code)
      ? (r.failure_code as FailureCode)
      : null;
  const status = Number(r.http_status);
  const hasCheckpoint =
    typeof r.has_checkpoint === "boolean" ? r.has_checkpoint : null;
  const channel_id = str(r.channel_id);
  const user_id = str(r.user_id);
  if (!channel_id || !user_id) return null;
  const at = Number(r.at);
  return {
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    guild_id: str(r.guild_id),
    guild_name: str(r.guild_name),
    channel_id,
    channel_name: str(r.channel_name),
    user_id,
    username: str(r.username) ?? user_id,
    trigger: str(r.trigger),
    prompt: clamp(typeof r.prompt === "string" ? r.prompt : "", PROMPT_MAX),
    reply: r.reply == null ? null : clamp(String(r.reply), REPLY_MAX),
    provider: str(r.provider),
    model: str(r.model),
    error: r.error == null ? null : clamp(String(r.error), 500),
    failure_phase: phase,
    failure_code: code,
    http_status: Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null,
    has_checkpoint: hasCheckpoint,
    latency_ms: Number.isFinite(Number(r.latency_ms))
      ? Number(r.latency_ms)
      : null,
  };
}

export function parseLogQuery(q: Record<string, string | undefined>): LogQuery {
  const n = Number(q.limit);
  const before = Number(q.before);
  const scope = q.scope === "dm" || q.scope === "guild" ? q.scope : "all";
  return {
    limit: Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 200) : 50,
    before: Number.isFinite(before) && before > 0 ? Math.trunc(before) : null,
    guild_id: q.guild_id?.trim() || null,
    user_id: q.user_id?.trim() || null,
    scope,
    q: q.q?.trim() || null,
  };
}
