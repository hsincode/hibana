import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Selection } from "./config";
import type { Message, Usage } from "./types";

export type SavedTurn = { seq: number; at: number; tokens: number; summary: boolean; messages: Message[] };
export type SavedChannel = { guildId?: string; key: string; usage?: Usage; turns: SavedTurn[] };
export type SavedRoute = { selection: Selection; at: number };
/** A turn on its way in. `json` is its messages, already serialized. */
export type NewTurn = { seq: number; at: number; tokens: number; summary?: boolean; json: string };

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
];

type ChannelRow = { guild_id: string | null; key: string; usage: string | null };
type TurnRow = { seq: number; at: number; tokens: number; summary: number; messages: string };

/**
 * Conversation history and auto routes on disk (decision record: #59), so a
 * restart, which every deploy is, does not end the conversations in progress.
 *
 * `History` and `RouteMemory` stay the working copy and write each change
 * through. Until `open` succeeds, and after any failure, every call here is a
 * no-op that reports the error: the bot then runs from memory alone, as it did
 * before, instead of failing turns over a disk problem.
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
      this.db = db;
    } catch (error) {
      try { db?.close(); } catch {}
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
      channels: (db.query("SELECT COUNT(*) AS n FROM history_channels").get() as { n: number }).n,
      turns: (db.query("SELECT COUNT(*) AS n FROM history_turns").get() as { n: number }).n,
      routes: (db.query("SELECT COUNT(*) AS n FROM routes").get() as { n: number }).n,
    }));
  }

  /** Undefined when the channel was never stored, or when a row is unreadable:
   *  a damaged conversation is started over, not replayed in part. */
  loadChannel(channelId: string): SavedChannel | undefined {
    return this.guard((db) => {
      const row = db.query("SELECT guild_id, key, usage FROM history_channels WHERE channel_id = ?")
        .get(channelId) as ChannelRow | null;
      if (!row) return undefined;
      const turns = db.query("SELECT seq, at, tokens, summary, messages FROM history_turns WHERE channel_id = ? ORDER BY seq")
        .all(channelId) as TurnRow[];
      return {
        guildId: row.guild_id ?? undefined,
        key: row.key,
        usage: row.usage ? (JSON.parse(row.usage) as Usage) : undefined,
        turns: turns.map((t) => ({
          seq: t.seq, at: t.at, tokens: t.tokens, summary: t.summary === 1,
          messages: JSON.parse(t.messages) as Message[],
        })),
      };
    });
  }
  private insertTurn(db: Database, channelId: string, turn: NewTurn) {
    db.query("INSERT OR REPLACE INTO history_turns (channel_id, seq, at, tokens, summary, messages) VALUES (?, ?, ?, ?, ?, ?)")
      .run(channelId, turn.seq, turn.at, turn.tokens, turn.summary ? 1 : 0, turn.json);
  }
  appendTurn(channelId: string, channel: { guildId?: string; key: string; usage?: Usage }, turn: NewTurn) {
    this.guard((db) => db.transaction(() => {
      db.query(`INSERT INTO history_channels (channel_id, guild_id, key, usage) VALUES (?, ?, ?, ?)
        ON CONFLICT (channel_id) DO UPDATE SET guild_id = excluded.guild_id, key = excluded.key, usage = excluded.usage`)
        .run(channelId, channel.guildId ?? null, channel.key, channel.usage ? JSON.stringify(channel.usage) : null);
      this.insertTurn(db, channelId, turn);
    })());
  }
  /** Trimming and shrinking drop a channel's oldest turns. */
  dropTurnsBefore(channelId: string, seq: number) {
    this.guard((db) => db.query("DELETE FROM history_turns WHERE channel_id = ? AND seq < ?").run(channelId, seq));
  }
  /** Compaction: everything older than the summary's slot becomes the summary. */
  replaceHead(channelId: string, summary: NewTurn) {
    this.guard((db) => db.transaction(() => {
      db.query("DELETE FROM history_turns WHERE channel_id = ? AND seq <= ?").run(channelId, summary.seq);
      this.insertTurn(db, channelId, summary);
    })());
  }
  deleteChannel(channelId: string) {
    this.guard((db) => db.transaction(() => {
      db.query("DELETE FROM history_turns WHERE channel_id = ?").run(channelId);
      db.query("DELETE FROM history_channels WHERE channel_id = ?").run(channelId);
    })());
  }
  /** Without a guild, every channel: the same reach as `History.clearGuild`. */
  deleteGuild(guildId?: string) {
    this.guard((db) => db.transaction(() => {
      if (!guildId) {
        db.exec("DELETE FROM history_turns");
        db.exec("DELETE FROM history_channels");
        return;
      }
      db.query("DELETE FROM history_turns WHERE channel_id IN (SELECT channel_id FROM history_channels WHERE guild_id = ?)")
        .run(guildId);
      db.query("DELETE FROM history_channels WHERE guild_id = ?").run(guildId);
    })());
  }

  loadRoute(channelId: string): SavedRoute | undefined {
    return this.guard((db) => {
      const row = db.query("SELECT selection, at FROM routes WHERE channel_id = ?")
        .get(channelId) as { selection: string; at: number } | null;
      return row ? { selection: JSON.parse(row.selection) as Selection, at: row.at } : undefined;
    });
  }
  saveRoute(channelId: string, route: SavedRoute) {
    this.guard((db) => db.query(`INSERT INTO routes (channel_id, selection, at) VALUES (?, ?, ?)
      ON CONFLICT (channel_id) DO UPDATE SET selection = excluded.selection, at = excluded.at`)
      .run(channelId, JSON.stringify(route.selection), route.at));
  }
  deleteRoute(channelId: string) {
    this.guard((db) => db.query("DELETE FROM routes WHERE channel_id = ?").run(channelId));
  }
  /** Routes last used at or before `at` can no longer be kept (the same edge
   *  as `RouteMemory.live`); nothing reads them again. */
  pruneRoutes(at: number) {
    this.guard((db) => db.query("DELETE FROM routes WHERE at <= ?").run(at));
  }
}
