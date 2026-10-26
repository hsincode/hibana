import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Selection } from "./config";
import type { Message, Usage } from "./types";
import type { Disposal, SessionRow } from "./workspace/sessions";
import type { WorkspaceState, WorkspaceTotals } from "./workspace/types";

export type SavedTurn = {
  seq: number;
  at: number;
  tokens: number;
  summary: boolean;
  messages: Message[];
};
export type SavedChannel = {
  guildId?: string;
  key: string;
  usage?: Usage;
  turns: SavedTurn[];
};
export type SavedRoute = { selection: Selection; at: number };
/** A turn on its way in. `json` is its messages, already serialized. */
export type NewTurn = {
  seq: number;
  at: number;
  tokens: number;
  summary?: boolean;
  json: string;
};

// Additive only, like the API's migrations (ADR-0006, ADR-0008): a deploy that
// fails is rolled back to the previous commit, which then opens this file as
// the newer version left it. Tables and indexes are created if missing and
// nothing is renamed, retyped or dropped here.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS history_channels (
     channel_id TEXT PRIMARY KEY, guild_id TEXT, key TEXT NOT NULL, usage TEXT)`,
  `CREATE INDEX IF NOT EXISTS history_channels_guild ON history_channels (guild_id)`,
  // `seq` orders a channel's turns. A summary takes the slot just before the
  // oldest turn it leaves in place, so order never depends on insertion time.
  `CREATE TABLE IF NOT EXISTS history_turns (
     channel_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, tokens INTEGER NOT NULL,
     summary INTEGER NOT NULL DEFAULT 0, messages TEXT NOT NULL, PRIMARY KEY (channel_id, seq))`,
  `CREATE TABLE IF NOT EXISTS routes (
     channel_id TEXT PRIMARY KEY, selection TEXT NOT NULL, at INTEGER NOT NULL)`,
  // Anthropic Workspace (#76): the cloud session each channel talks to. The
  // conversation is on Anthropic's side, so the row is all that finds it
  // again after a restart. `usage` holds the session's cumulative totals as
  // last added to the usage ledger. The lease columns are set while a turn's
  // raised spending ceiling has not been lowered again (one more of them is
  // in `ADDED_COLUMNS`).
  `CREATE TABLE IF NOT EXISTS workspace_sessions (
     channel_id TEXT PRIMARY KEY, guild_id TEXT, key TEXT NOT NULL, session_id TEXT NOT NULL, variant TEXT NOT NULL,
     created_at INTEGER NOT NULL, used_at INTEGER NOT NULL, usage TEXT, state TEXT,
     lease_ceiling_cents INTEGER, lease_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS workspace_sessions_guild ON workspace_sessions (guild_id)`,
  // Sessions no channel uses any more, until they are deleted or archived on
  // Anthropic's side. One whose removal failed stays for the next attempt.
  `CREATE TABLE IF NOT EXISTS workspace_disposals (
     session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, channel_id TEXT NOT NULL, guild_id TEXT, key TEXT NOT NULL,
     variant TEXT NOT NULL, usage TEXT, queued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`,
];
// Columns a table gained after it was first created. `CREATE TABLE IF NOT
// EXISTS` leaves a table that exists as it is, so each of these is added
// when it is missing, to a new file as to an older one. Additive as well:
// they may be empty, and the version before names the columns it writes.
// `lease_settled` says why a lease stays on its row, and `allowed_cents`
// what a retired session's lease still owed (workspace/sessions.ts).
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["workspace_sessions", "lease_settled", "TEXT"],
  ["workspace_disposals", "allowed_cents", "INTEGER"],
];

type ChannelRow = {
  guild_id: string | null;
  key: string;
  usage: string | null;
};
type TurnRow = {
  seq: number;
  at: number;
  tokens: number;
  summary: number;
  messages: string;
};
// Columns are always named, never `*`: a newer version may have added some.
const SESSION_COLUMNS =
  "channel_id, guild_id, key, session_id, variant, created_at, used_at, usage, state, lease_ceiling_cents, lease_at, lease_settled";
type SessionRecord = {
  channel_id: string;
  guild_id: string | null;
  key: string;
  session_id: string;
  variant: string;
  created_at: number;
  used_at: number;
  usage: string | null;
  state: string | null;
  lease_ceiling_cents: number | null;
  lease_at: number | null;
  lease_settled: string | null;
};
const DISPOSAL_COLUMNS =
  "session_id, mode, channel_id, guild_id, key, variant, usage, queued_at, attempts, allowed_cents";
type DisposalRecord = {
  session_id: string;
  mode: string;
  channel_id: string;
  guild_id: string | null;
  key: string;
  variant: string;
  usage: string | null;
  queued_at: number;
  attempts: number;
  allowed_cents: number | null;
};

/**
 * Conversation history and auto routes on disk (decision record: #59), so a
 * restart, which every deploy is, does not end the conversations in progress.
 * For Anthropic Workspace it also keeps which cloud session each channel uses
 * (decision record: #76).
 *
 * `History`, `RouteMemory` and `SessionTable` stay the working copy and write
 * each change through. Until `open` succeeds, and after any failure, every
 * call here is a no-op that reports the error: the bot then runs from memory
 * alone, as it did before, instead of failing turns over a disk problem.
 */
export class ConversationStore {
  private db?: Database;
  constructor(
    private path: string,
    private onError: (error: unknown) => void = () => {},
  ) {}
  get opened() {
    return this.db !== undefined;
  }
  /** An empty path keeps everything in process memory. A file that cannot be
   *  opened is left untouched for inspection, and the bot runs without it. */
  open() {
    if (!this.path || this.db) return;
    let db: Database | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      db = new Database(this.path, { create: true });
      // Conversations are private, like the JSON state next to this file.
      // SQLite gives the -wal and -shm files the mode of the database.
      chmodSync(this.path, 0o600);
      // WAL with NORMAL: a process crash loses nothing, and losing power can
      // drop the last turns but never leaves the file inconsistent.
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      for (const statement of SCHEMA) db.exec(statement);
      for (const [table, column, type] of ADDED_COLUMNS) {
        const columns = db.query(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[];
        if (!columns.some((known) => known.name === column))
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
      this.db = db;
    } catch (error) {
      try {
        db?.close();
      } catch {}
      this.onError(error);
    }
  }
  close() {
    this.guard((db) => db.close());
    this.db = undefined;
  }
  private guard<T>(work: (db: Database) => T): T | undefined {
    if (!this.db) return undefined;
    try {
      return work(this.db);
    } catch (error) {
      this.onError(error);
      return undefined;
    }
  }
  stats() {
    return this.guard((db) => ({
      channels: (
        db.query("SELECT COUNT(*) AS n FROM history_channels").get() as {
          n: number;
        }
      ).n,
      turns: (
        db.query("SELECT COUNT(*) AS n FROM history_turns").get() as {
          n: number;
        }
      ).n,
      routes: (
        db.query("SELECT COUNT(*) AS n FROM routes").get() as { n: number }
      ).n,
    }));
  }

  /** Undefined when the channel was never stored, or when a row is unreadable:
   *  a damaged conversation is started over, not replayed in part. */
  loadChannel(channelId: string): SavedChannel | undefined {
    return this.guard((db) => {
      const row = db
        .query(
          "SELECT guild_id, key, usage FROM history_channels WHERE channel_id = ?",
        )
        .get(channelId) as ChannelRow | null;
      if (!row) return undefined;
      const turns = db
        .query(
          "SELECT seq, at, tokens, summary, messages FROM history_turns WHERE channel_id = ? ORDER BY seq",
        )
        .all(channelId) as TurnRow[];
      return {
        guildId: row.guild_id ?? undefined,
        key: row.key,
        usage: row.usage ? (JSON.parse(row.usage) as Usage) : undefined,
        turns: turns.map((t) => ({
          seq: t.seq,
          at: t.at,
          tokens: t.tokens,
          summary: t.summary === 1,
          messages: JSON.parse(t.messages) as Message[],
        })),
      };
    });
  }
  private insertTurn(db: Database, channelId: string, turn: NewTurn) {
    db.query(
      "INSERT OR REPLACE INTO history_turns (channel_id, seq, at, tokens, summary, messages) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      channelId,
      turn.seq,
      turn.at,
      turn.tokens,
      turn.summary ? 1 : 0,
      turn.json,
    );
  }
  appendTurn(
    channelId: string,
    channel: { guildId?: string; key: string; usage?: Usage },
    turn: NewTurn,
  ) {
    this.guard((db) =>
      db.transaction(() => {
        db.query(
          `INSERT INTO history_channels (channel_id, guild_id, key, usage) VALUES (?, ?, ?, ?)
        ON CONFLICT (channel_id) DO UPDATE SET guild_id = excluded.guild_id, key = excluded.key, usage = excluded.usage`,
        ).run(
          channelId,
          channel.guildId ?? null,
          channel.key,
          channel.usage ? JSON.stringify(channel.usage) : null,
        );
        this.insertTurn(db, channelId, turn);
      })(),
    );
  }
  /** Trimming and shrinking drop a channel's oldest turns. */
  dropTurnsBefore(channelId: string, seq: number) {
    this.guard((db) =>
      db
        .query("DELETE FROM history_turns WHERE channel_id = ? AND seq < ?")
        .run(channelId, seq),
    );
  }
  /** Compaction: everything older than the summary's slot becomes the
   *  summary. `usage` replaces the channel's figure when given. */
  replaceHead(channelId: string, summary: NewTurn, usage?: Usage) {
    this.guard((db) =>
      db.transaction(() => {
        db.query(
          "DELETE FROM history_turns WHERE channel_id = ? AND seq <= ?",
        ).run(channelId, summary.seq);
        this.insertTurn(db, channelId, summary);
        if (usage)
          db.query(
            "UPDATE history_channels SET usage = ? WHERE channel_id = ?",
          ).run(JSON.stringify(usage), channelId);
      })(),
    );
  }
  deleteChannel(channelId: string) {
    this.guard((db) =>
      db.transaction(() => {
        db.query("DELETE FROM history_turns WHERE channel_id = ?").run(
          channelId,
        );
        db.query("DELETE FROM history_channels WHERE channel_id = ?").run(
          channelId,
        );
      })(),
    );
  }
  /** Without a guild, every channel: the same reach as `History.clearGuild`. */
  deleteGuild(guildId?: string) {
    this.guard((db) =>
      db.transaction(() => {
        if (!guildId) {
          db.exec("DELETE FROM history_turns");
          db.exec("DELETE FROM history_channels");
          return;
        }
        db.query(
          "DELETE FROM history_turns WHERE channel_id IN (SELECT channel_id FROM history_channels WHERE guild_id = ?)",
        ).run(guildId);
        db.query("DELETE FROM history_channels WHERE guild_id = ?").run(
          guildId,
        );
      })(),
    );
  }

  loadRoute(channelId: string): SavedRoute | undefined {
    return this.guard((db) => {
      const row = db
        .query("SELECT selection, at FROM routes WHERE channel_id = ?")
        .get(channelId) as { selection: string; at: number } | null;
      return row
        ? { selection: JSON.parse(row.selection) as Selection, at: row.at }
        : undefined;
    });
  }
  saveRoute(channelId: string, route: SavedRoute) {
    this.guard((db) =>
      db
        .query(
          `INSERT INTO routes (channel_id, selection, at) VALUES (?, ?, ?)
      ON CONFLICT (channel_id) DO UPDATE SET selection = excluded.selection, at = excluded.at`,
        )
        .run(channelId, JSON.stringify(route.selection), route.at),
    );
  }
  deleteRoute(channelId: string) {
    this.guard((db) =>
      db.query("DELETE FROM routes WHERE channel_id = ?").run(channelId),
    );
  }
  /** Routes last used at or before `at` can no longer be kept (the same edge
   *  as `RouteMemory.live`); nothing reads them again. */
  pruneRoutes(at: number) {
    this.guard((db) => db.query("DELETE FROM routes WHERE at <= ?").run(at));
  }

  /** A JSON column of a workspace row. One that cannot be read is reported
   *  and counts as absent, unlike a damaged conversation: the session id next
   *  to it must still be found, or nothing would lower that session's
   *  spending ceiling or remove it. */
  private column<T>(text: string | null): T | undefined {
    if (!text) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as T)
        : undefined;
    } catch (error) {
      this.onError(error);
      return undefined;
    }
  }
  private session(row: SessionRecord): SessionRow {
    return {
      channelId: row.channel_id,
      guildId: row.guild_id ?? undefined,
      key: row.key,
      sessionId: row.session_id,
      variant: row.variant === "ultra" ? "ultra" : "plain",
      createdAt: row.created_at,
      usedAt: row.used_at,
      totals: this.column<WorkspaceTotals>(row.usage),
      state: this.column<WorkspaceState>(row.state),
      lease:
        typeof row.lease_ceiling_cents === "number"
          ? {
              ceilingCents: row.lease_ceiling_cents,
              at: row.lease_at ?? row.used_at,
              // A row written before this was kept, or a value this version does
              // not know, reads as a lease like any other.
              ...((row.lease_settled === "counted" ||
                row.lease_settled === "lowered") && {
                settled: row.lease_settled,
              }),
            }
          : undefined,
    };
  }
  loadSession(channelId: string): SessionRow | undefined {
    return this.guard((db) => {
      const row = db
        .query(
          `SELECT ${SESSION_COLUMNS} FROM workspace_sessions WHERE channel_id = ?`,
        )
        .get(channelId) as SessionRecord | null;
      return row ? this.session(row) : undefined;
    });
  }
  saveSession(row: SessionRow) {
    this.guard((db) =>
      db
        .query(
          `INSERT INTO workspace_sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (channel_id) DO UPDATE SET guild_id = excluded.guild_id, key = excluded.key,
        session_id = excluded.session_id, variant = excluded.variant, created_at = excluded.created_at,
        used_at = excluded.used_at, usage = excluded.usage, state = excluded.state,
        lease_ceiling_cents = excluded.lease_ceiling_cents, lease_at = excluded.lease_at,
        lease_settled = excluded.lease_settled`,
        )
        .run(
          row.channelId,
          row.guildId ?? null,
          row.key,
          row.sessionId,
          row.variant,
          row.createdAt,
          row.usedAt,
          row.totals ? JSON.stringify(row.totals) : null,
          row.state ? JSON.stringify(row.state) : null,
          row.lease?.ceilingCents ?? null,
          row.lease?.at ?? null,
          row.lease?.settled ?? null,
        ),
    );
  }
  /** Sessions whose spending ceiling was raised for a turn and not lowered
   *  since, whichever process raised it. */
  leasedSessions(): SessionRow[] {
    return (
      this.guard((db) =>
        (
          db
            .query(
              `SELECT ${SESSION_COLUMNS} FROM workspace_sessions WHERE lease_ceiling_cents IS NOT NULL`,
            )
            .all() as SessionRecord[]
        ).map((row) => this.session(row)),
      ) ?? []
    );
  }
  /** Without a guild, every session: the same reach as `deleteGuild`. */
  guildSessions(guildId?: string): SessionRow[] {
    return (
      this.guard((db) =>
        (
          (guildId
            ? db
                .query(
                  `SELECT ${SESSION_COLUMNS} FROM workspace_sessions WHERE guild_id = ?`,
                )
                .all(guildId)
            : db
                .query(`SELECT ${SESSION_COLUMNS} FROM workspace_sessions`)
                .all()) as SessionRecord[]
        ).map((row) => this.session(row)),
      ) ?? []
    );
  }
  /** Moves sessions from their channels to the removal queue. One
   *  transaction: a session id is on disk in exactly one of the two tables
   *  whenever the process stops, so it is neither forgotten nor used again. */
  retireSessions(disposals: Disposal[]) {
    this.guard((db) =>
      db.transaction(() => {
        for (const d of disposals) {
          db.query(
            "DELETE FROM workspace_sessions WHERE channel_id = ? AND session_id = ?",
          ).run(d.channelId, d.sessionId);
          db.query(
            `INSERT OR REPLACE INTO workspace_disposals (${DISPOSAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            d.sessionId,
            d.mode,
            d.channelId,
            d.guildId ?? null,
            d.key,
            d.variant,
            d.totals ? JSON.stringify(d.totals) : null,
            d.queuedAt,
            d.attempts,
            d.allowedCents ?? null,
          );
        }
      })(),
    );
  }
  /** Oldest first. */
  loadDisposals(): Disposal[] {
    return (
      this.guard((db) =>
        (
          db
            .query(
              `SELECT ${DISPOSAL_COLUMNS} FROM workspace_disposals ORDER BY queued_at, session_id`,
            )
            .all() as DisposalRecord[]
        ).map((row): Disposal => ({
          sessionId: row.session_id,
          // Removing files and transcript is only ever done on an explicit request.
          mode: row.mode === "delete" ? "delete" : "archive",
          channelId: row.channel_id,
          guildId: row.guild_id ?? undefined,
          key: row.key,
          variant: row.variant === "ultra" ? "ultra" : "plain",
          totals: this.column<WorkspaceTotals>(row.usage),
          ...(typeof row.allowed_cents === "number" &&
            row.allowed_cents > 0 && { allowedCents: row.allowed_cents }),
          queuedAt: row.queued_at,
          attempts: row.attempts,
        })),
      ) ?? []
    );
  }
  failDisposal(sessionId: string) {
    this.guard((db) =>
      db
        .query(
          "UPDATE workspace_disposals SET attempts = attempts + 1 WHERE session_id = ?",
        )
        .run(sessionId),
    );
  }
  deleteDisposal(sessionId: string) {
    this.guard((db) =>
      db
        .query("DELETE FROM workspace_disposals WHERE session_id = ?")
        .run(sessionId),
    );
  }
}
