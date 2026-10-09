import { neon } from "@neondatabase/serverless";
import type { SkillRow, SkillCommand } from "./skills";
import type { BlockedRow, LogEntry, LogQuery, LogRow } from "./audit";
import { DEFAULT_ROLE, parseRole, type Role } from "./roles";
import {
  normalizeGuild,
  normalizeUserOverride,
  emptyGuild,
  emptyUserOverride,
  settingsDefaults,
  type GuildRow,
  type UserOverrideRow,
} from "./settings";

export type UserContextEntry = {
  text: string;
  persona_override: boolean;
};

export type UserRow = {
  discord_id: string;
  role: Role;
  username: string;
  avatar: string | null;
};

export type SessionRow = {
  discord_id: string;
  access_token: string;
  expires_at: number;
};

export type ArtifactRetention = "ttl" | "month" | "permanent";

export type ArtifactRow = {
  token: string;
  guild_id: string | null;
  channel_id: string;
  url: string;
  source_path: string;
  created_at_unix: number;
  updated_at_unix: number | null;
  expires_at_unix: number;
  retention: ArtifactRetention;
  bytes: number;
  file_count: number;
};

export type ArtifactCommandRow = {
  id: number;
  token: string;
  guild_id: string | null;
  action: string;
  created_at: number;
};

export const ARTIFACT_ACTIONS = ["month", "permanent", "unpermanent"] as const;
export type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];

export function isArtifactAction(raw: string): raw is ArtifactAction {
  return (ARTIFACT_ACTIONS as readonly string[]).includes(raw);
}

export interface Store {
  readonly defaults: GuildRow;
  replaceSkills(rows: SkillRow[]): Promise<void>;
  listSkills(): Promise<SkillRow[]>;
  enqueueSkillCommand(
    guildId: string,
    action: string,
    args: Record<string, unknown>,
  ): Promise<SkillCommand>;
  listSkillCommands(): Promise<SkillCommand[]>;
  ackSkillCommand(id: number, result: Record<string, unknown>): Promise<void>;
  migrate(): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  compareMeta(key: string, expected: string | null, value: string): Promise<boolean>;
  bumpVersion(): Promise<number>;
  version(): Promise<number>;
  getGuild(id: string): Promise<GuildRow>;
  putGuild(id: string, settings: GuildRow): Promise<void>;
  allGuilds(): Promise<Record<string, GuildRow>>;
  allUserContexts(): Promise<Record<string, UserContextEntry>>;
  getUserOverride(id: string): Promise<UserOverrideRow>;
  putUserOverride(id: string, settings: UserOverrideRow): Promise<void>;
  allUserOverrides(): Promise<Record<string, UserOverrideRow>>;
  /** Replace the whole snapshot (guilds + DM contexts). One version bump. */
  replaceSnapshot(
    guilds: Record<string, GuildRow>,
    userContexts: Record<string, UserContextEntry>,
  ): Promise<void>;
  upsertUser(u: {
    discord_id: string;
    username: string;
    avatar: string | null;
    role?: Role;
  }): Promise<void>;
  getUser(id: string): Promise<UserRow | null>;
  listUsers(): Promise<UserRow[]>;
  setUserRole(id: string, role: Role): Promise<void>;
  putSession(
    id: string,
    discordId: string,
    accessToken: string,
    expiresAt: number,
  ): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  deleteSession(id: string): Promise<void>;
  putPending(state: string, verifier: string): Promise<void>;
  takePending(state: string): Promise<string | null>;
  /** Kill switch: users the bot ignores everywhere (all guilds **and** DMs). */
  listBlocked(): Promise<BlockedRow[]>;
  setBlocked(row: BlockedRow): Promise<void>;
  unblock(discordId: string): Promise<void>;
  appendLogs(entries: LogEntry[]): Promise<number>;
  listLogs(q: LogQuery): Promise<LogRow[]>;
  /** Drop rows whose `at` is older than the cutoff. Called on ingest. */
  pruneLogs(cutoff: number): Promise<number>;
  /** Bot is the writer: full replace of live published sites. Does not bump snapshot. */
  replaceArtifacts(sites: ArtifactRow[]): Promise<void>;
  listArtifacts(guildId?: string): Promise<ArtifactRow[]>;
  getArtifact(token: string): Promise<ArtifactRow | null>;
  /** Dashboard → bot. Bumps snapshot so SSE wakes the bot. */
  enqueueArtifactCommand(
    token: string,
    guildId: string | null,
    action: ArtifactAction,
  ): Promise<ArtifactCommandRow>;
  listArtifactCommands(): Promise<ArtifactCommandRow[]>;
  ackArtifactCommands(ids: number[]): Promise<number>;
}

/** In-memory filter, shared by MemoryStore and the tests. */
function matchesLogQuery(r: LogRow, q: LogQuery): boolean {
  if (q.before !== null && r.id >= q.before) return false;
  if (q.guild_id && r.guild_id !== q.guild_id) return false;
  if (q.user_id && r.user_id !== q.user_id) return false;
  if (q.scope === "dm" && r.guild_id !== null) return false;
  if (q.scope === "guild" && r.guild_id === null) return false;
  if (q.q) {
    const needle = q.q.toLowerCase();
    const hay = `${r.prompt}\n${r.reply ?? ""}\n${r.username}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export class MemoryStore implements Store {
  constructor(readonly defaults: GuildRow = emptyGuild()) {}
  private meta = new Map<string, string>();
  private guilds = new Map<string, GuildRow>();
  private userContexts = new Map<string, UserContextEntry>();
  private userOverrides = new Map<string, UserOverrideRow>();
  private users = new Map<string, UserRow>();
  private sessions = new Map<string, SessionRow>();
  private pending = new Map<string, string>();
  private blocked = new Map<string, BlockedRow>();
  private logs: LogRow[] = [];
  private logSeq = 0;
  private artifacts = new Map<string, ArtifactRow>();
  private artifactCommands: ArtifactCommandRow[] = [];
  private artifactCmdSeq = 0;
  private skills: SkillRow[] = [];
  private skillCommands: SkillCommand[] = [];
  private skillSeq = 0;

  async replaceSkills(rows: SkillRow[]) {
    this.skills = structuredClone(rows);
  }
  async listSkills() {
    return structuredClone(this.skills);
  }
  async enqueueSkillCommand(
    guildId: string,
    action: string,
    args: Record<string, unknown>,
  ) {
    const command: SkillCommand = {
      id: ++this.skillSeq,
      guild_id: guildId,
      action,
      args: structuredClone(args),
      result: null,
    };
    this.skillCommands.push(command);
    await this.bumpVersion();
    return structuredClone(command);
  }
  async listSkillCommands() {
    return structuredClone(this.skillCommands);
  }
  async ackSkillCommand(id: number, result: Record<string, unknown>) {
    const command = this.skillCommands.find((c) => c.id === id);
    if (command && command.result === null) {
      command.result = structuredClone(result);
      await this.bumpVersion();
    }
  }

  async migrate() {
    if (!this.meta.has("snapshot_version"))
      this.meta.set("snapshot_version", "0");
    await installPersonalDefaults(this);
  }
  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  async compareMeta(key: string, expected: string | null, value: string) {
    if ((this.meta.get(key) ?? null) !== expected) return false;
    this.meta.set(key, value);
    return true;
  }
  async bumpVersion() {
    const n = Number(this.meta.get("snapshot_version") ?? "0") + 1;
    this.meta.set("snapshot_version", String(n));
    return n;
  }
  async version() {
    return Number(this.meta.get("snapshot_version") ?? "0");
  }
  async getGuild(id: string) {
    const row = normalizeGuild(this.guilds.get(id), this.defaults);
    if (!this.guilds.has(id)) await this.putGuild(id, row);
    return row;
  }
  async putGuild(id: string, settings: GuildRow) {
    this.guilds.set(id, normalizeGuild(settings, this.defaults));
    await this.bumpVersion();
  }
  async allGuilds() {
    return Object.fromEntries(
      [...this.guilds].map(([id, row]) => [id, normalizeGuild(row, this.defaults)]),
    );
  }
  async allUserContexts() {
    return Object.fromEntries(this.userContexts);
  }
  async getUserOverride(id: string) {
    const row = normalizeUserOverride(this.userOverrides.get(id), this.defaults);
    if (!this.userOverrides.has(id)) await this.putUserOverride(id, row);
    return row;
  }
  async putUserOverride(id: string, settings: UserOverrideRow) {
    this.userOverrides.set(id, normalizeUserOverride(settings, this.defaults));
    await this.bumpVersion();
  }
  async allUserOverrides() {
    return Object.fromEntries(
      [...this.userOverrides].map(([id, row]) => [
        id,
        normalizeUserOverride(row, this.defaults),
      ]),
    );
  }
  async replaceSnapshot(
    guilds: Record<string, GuildRow>,
    userContexts: Record<string, UserContextEntry>,
  ) {
    this.guilds = new Map(
      Object.entries(guilds).map(([id, row]) => [id, normalizeGuild(row, this.defaults)]),
    );
    this.userContexts = new Map(Object.entries(userContexts));
    await this.bumpVersion();
  }
  async upsertUser(u: {
    discord_id: string;
    username: string;
    avatar: string | null;
    role?: Role;
  }) {
    const existing = this.users.get(u.discord_id);
    this.users.set(u.discord_id, {
      discord_id: u.discord_id,
      // Explicit role (WEB_ADMIN_IDS → administrator on login) wins so a
      // bootstrap admin is not stuck as Free if they logged in first.
      role: u.role ?? existing?.role ?? DEFAULT_ROLE,
      username: u.username,
      avatar: u.avatar,
    });
  }
  async getUser(id: string) {
    return this.users.get(id) ?? null;
  }
  async listUsers() {
    return [...this.users.values()].sort((a, b) =>
      a.username.localeCompare(b.username),
    );
  }
  async setUserRole(id: string, role: Role) {
    const u = this.users.get(id);
    if (u) this.users.set(id, { ...u, role });
    // Snapshot GET includes user_roles; bump so If-None-Match / SSE
    // cannot 304 a stale Premium gate.
    await this.bumpVersion();
  }
  async putSession(
    id: string,
    discordId: string,
    accessToken: string,
    expiresAt: number,
  ) {
    this.sessions.set(id, {
      discord_id: discordId,
      access_token: accessToken,
      expires_at: expiresAt,
    });
  }
  async getSession(id: string) {
    return this.sessions.get(id) ?? null;
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
  async putPending(state: string, verifier: string) {
    this.pending.set(state, verifier);
  }
  async takePending(state: string) {
    const v = this.pending.get(state) ?? null;
    this.pending.delete(state);
    return v;
  }
  async listBlocked() {
    return [...this.blocked.values()].sort(
      (a, b) => b.blocked_at - a.blocked_at,
    );
  }
  async setBlocked(row: BlockedRow) {
    this.blocked.set(row.discord_id, row);
    // Snapshot GET includes blocked_users; bump so If-None-Match / SSE
    // version cannot 304 a stale allow/deny list.
    await this.bumpVersion();
  }
  async unblock(discordId: string) {
    this.blocked.delete(discordId);
    await this.bumpVersion();
  }
  async appendLogs(entries: LogEntry[]) {
    for (const e of entries) this.logs.push({ ...e, id: ++this.logSeq });
    return entries.length;
  }
  async listLogs(q: LogQuery) {
    return this.logs
      .filter((r) => matchesLogQuery(r, q))
      .sort((a, b) => b.id - a.id)
      .slice(0, q.limit);
  }
  async pruneLogs(cutoff: number) {
    const before = this.logs.length;
    this.logs = this.logs.filter((r) => r.at >= cutoff);
    return before - this.logs.length;
  }
  async replaceArtifacts(sites: ArtifactRow[]) {
    this.artifacts = new Map(sites.map((s) => [s.token, s]));
  }
  async listArtifacts(guildId?: string) {
    const rows = [...this.artifacts.values()];
    return guildId ? rows.filter((r) => r.guild_id === guildId) : rows;
  }
  async getArtifact(token: string) {
    return this.artifacts.get(token) ?? null;
  }
  async enqueueArtifactCommand(
    token: string,
    guildId: string | null,
    action: ArtifactAction,
  ) {
    const row: ArtifactCommandRow = {
      id: ++this.artifactCmdSeq,
      token,
      guild_id: guildId,
      action,
      created_at: Date.now(),
    };
    this.artifactCommands.push(row);
    await this.bumpVersion();
    return row;
  }
  async listArtifactCommands() {
    return [...this.artifactCommands];
  }
  async ackArtifactCommands(ids: number[]) {
    const drop = new Set(ids);
    const before = this.artifactCommands.length;
    this.artifactCommands = this.artifactCommands.filter(
      (c) => !drop.has(c.id),
    );
    const n = before - this.artifactCommands.length;
    if (n) await this.bumpVersion();
    return n;
  }
}

type Sql = ReturnType<typeof neon>;

/** Reject garbage env so `neon()` never echoes the string (it includes it in Error). */
function assertPostgresUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must be a postgres URL");
  }
  return databaseUrl;
}

export class NeonStore implements Store {
  readonly defaults: GuildRow;
  async replaceSkills(rows: SkillRow[]) {
    await this.setMeta("skill_catalog", JSON.stringify(rows));
  }
  async listSkills(): Promise<SkillRow[]> {
    return JSON.parse((await this.getMeta("skill_catalog")) ?? "[]");
  }
  async enqueueSkillCommand(
    guildId: string,
    action: string,
    args: Record<string, unknown>,
  ) {
    const rows = (await this
      .sql`INSERT INTO skill_commands (guild_id,action,args) VALUES (${guildId},${action},${JSON.stringify(args)}::jsonb) RETURNING *`) as SkillCommand[];
    await this.bumpVersion();
    return { ...rows[0], id: Number(rows[0]!.id) } as SkillCommand;
  }
  async listSkillCommands(): Promise<SkillCommand[]> {
    const rows = (await this
      .sql`SELECT * FROM skill_commands WHERE result IS NULL OR created_at > NOW() - INTERVAL '1 day' ORDER BY id`) as SkillCommand[];
    return rows.map((r) => ({ ...r, id: Number(r.id) }) as SkillCommand);
  }
  async ackSkillCommand(id: number, result: Record<string, unknown>) {
    await this
      .sql`UPDATE skill_commands SET result = ${JSON.stringify(result)}::jsonb WHERE id = ${id} AND result IS NULL`;
    await this
      .sql`DELETE FROM skill_commands WHERE result IS NOT NULL AND created_at < NOW() - INTERVAL '1 day'`;
    await this.bumpVersion();
  }
  private sql: Sql;
  /** When false, skip the logs table/indexes so a cold start does not pay for an unused feature. */
  private logs: boolean;
  constructor(databaseUrl: string, opts: { logs?: boolean; defaults?: GuildRow } = {}) {
    this.sql = neon(assertPostgresUrl(databaseUrl));
    this.logs = opts.logs ?? false;
    this.defaults = opts.defaults ?? emptyGuild();
  }

  async migrate() {
    await this
      .sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    await this
      .sql`CREATE TABLE IF NOT EXISTS skill_commands (id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, action TEXT NOT NULL, args JSONB NOT NULL, result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await this
      .sql`CREATE TABLE IF NOT EXISTS guilds (guild_id TEXT PRIMARY KEY, settings JSONB NOT NULL)`;
    await this.sql`CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      avatar TEXT
    )`;
    await this.sql`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    )`;
    await this.sql`CREATE TABLE IF NOT EXISTS oauth_pending (
      state TEXT PRIMARY KEY,
      code_verifier TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`;
    // DM `/user-context` plus the house-rules seed user. Separate from `users`
    // (roles) so a context-only row does not invent a dashboard account.
    await this.sql`CREATE TABLE IF NOT EXISTS user_contexts (
      discord_id TEXT PRIMARY KEY,
      entry JSONB NOT NULL
    )`;
    // Personal overlay (model / context). Separate from
    // `user_contexts` (DM persona text) so a context-only row does not invent
    // an override, and from `users` so a dashboard login is not required to
    // keep a leftover JSON blob. Survives `replaceSnapshot` the same way
    // `blocked_users` does — the bot is not the source of truth here.
    await this.sql`CREATE TABLE IF NOT EXISTS user_overrides (
      discord_id TEXT PRIMARY KEY,
      settings JSONB NOT NULL
    )`;
    // Separate from `users`: a blocked person usually has never logged into the
    // dashboard, so there is no role row to hang a flag off. Also survives the
    // bot's `replaceSnapshot`, which wipes guilds/user_contexts wholesale.
    await this.sql`CREATE TABLE IF NOT EXISTS blocked_users (
      discord_id TEXT PRIMARY KEY,
      username TEXT,
      reason TEXT,
      blocked_by TEXT NOT NULL,
      blocked_at BIGINT NOT NULL
    )`;
    // Bot-owned published sites (dashboard list). Survives replaceSnapshot.
    await this.sql`CREATE TABLE IF NOT EXISTS artifacts (
      token TEXT PRIMARY KEY,
      guild_id TEXT,
      channel_id TEXT NOT NULL,
      url TEXT NOT NULL,
      source_path TEXT NOT NULL DEFAULT '',
      created_at_unix BIGINT NOT NULL,
      updated_at_unix BIGINT,
      expires_at_unix BIGINT NOT NULL,
      retention TEXT NOT NULL,
      bytes BIGINT NOT NULL DEFAULT 0,
      file_count BIGINT NOT NULL DEFAULT 0
    )`;
    await this
      .sql`CREATE INDEX IF NOT EXISTS artifacts_guild ON artifacts (guild_id)`;
    await this.sql`CREATE TABLE IF NOT EXISTS artifact_commands (
      id BIGSERIAL PRIMARY KEY,
      token TEXT NOT NULL,
      guild_id TEXT,
      action TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )`;
    if (this.logs) {
      await this.sql`CREATE TABLE IF NOT EXISTS logs (
        id BIGSERIAL PRIMARY KEY,
        at BIGINT NOT NULL,
        guild_id TEXT,
        guild_name TEXT,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        trigger_reason TEXT,
        prompt TEXT NOT NULL,
        reply TEXT,
        provider TEXT,
        model TEXT,
        error TEXT,
        failure_phase TEXT,
        failure_code TEXT,
        http_status INTEGER,
        has_checkpoint BOOLEAN,
        failure_stage TEXT,
        failure_reason TEXT,
        error_type TEXT,
        retries INTEGER,
        effort TEXT,
        latency_ms INTEGER
      )`;
      // Keep deployments that already have the logs table compatible with the
      // richer failure telemetry without requiring a destructive migration.
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS failure_phase TEXT`;
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS failure_code TEXT`;
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS http_status INTEGER`;
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS has_checkpoint BOOLEAN`;
      // Provider failure detail (#42).
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS failure_stage TEXT`;
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS failure_reason TEXT`;
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS error_type TEXT`;
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS retries INTEGER`;
      await this.sql`ALTER TABLE logs ADD COLUMN IF NOT EXISTS effort TEXT`;
      // The log page always sorts by recency and filters by guild/user, so both
      // indexes are on `id DESC` — a plain `at` index would still need the sort.
      await this.sql`CREATE INDEX IF NOT EXISTS logs_id_desc ON logs (id DESC)`;
      await this
        .sql`CREATE INDEX IF NOT EXISTS logs_guild_id_desc ON logs (guild_id, id DESC)`;
      await this
        .sql`CREATE INDEX IF NOT EXISTS logs_user_id_desc ON logs (user_id, id DESC)`;
      await this.sql`CREATE INDEX IF NOT EXISTS logs_at ON logs (at)`;
    }
    if (!(await this.getMeta("snapshot_version"))) {
      await this.setMeta("snapshot_version", "0");
    }
    // Persist legacy nulls once, before serving snapshots. Later environment
    // edits must not change what a dashboard already displayed as selected.
    await this.allGuilds();
    await this.allUserOverrides();
    // After the shape rewrite above, so the one-shot reset sees real rows and
    // does not leave a concrete personal copy that shadows the server.
    await installPersonalDefaults(this);
  }

  async getMeta(key: string) {
    const rows = (await this
      .sql`SELECT value FROM meta WHERE key = ${key}`) as { value: string }[];
    return rows[0]?.value ?? null;
  }

  async setMeta(key: string, value: string) {
    await this.sql`
      INSERT INTO meta (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  async bumpVersion() {
    const n = (await this.version()) + 1;
    await this.setMeta("snapshot_version", String(n));
    return n;
  }

  async compareMeta(key: string, expected: string | null, value: string) {
    // Atomic across Vercel instances: rotating a refresh token twice can
    // invalidate the account, so an in-process mutex is insufficient.
    const rows = (expected === null
      ? await this.sql`INSERT INTO meta (key,value) VALUES (${key},${value}) ON CONFLICT DO NOTHING RETURNING key`
      : await this.sql`UPDATE meta SET value=${value} WHERE key=${key} AND value=${expected} RETURNING key`) as { key: string }[];
    return rows.length === 1;
  }

  async version() {
    return Number((await this.getMeta("snapshot_version")) ?? "0");
  }

  async getGuild(id: string) {
    const rows = (await this
      .sql`SELECT settings FROM guilds WHERE guild_id = ${id}`) as {
      settings: GuildRow;
    }[];
    const row = normalizeGuild(rows[0]?.settings, this.defaults);
    if (!rows[0] || !sameSettings(row, rows[0].settings))
      await this.putGuild(id, row);
    return row;
  }

  async putGuild(id: string, settings: GuildRow) {
    const payload = JSON.stringify(normalizeGuild(settings, this.defaults));
    await this.sql`
      INSERT INTO guilds (guild_id, settings) VALUES (${id}, ${payload}::jsonb)
      ON CONFLICT (guild_id) DO UPDATE SET settings = EXCLUDED.settings
    `;
    await this.bumpVersion();
  }

  async allGuilds() {
    const rows = (await this.sql`SELECT guild_id, settings FROM guilds`) as {
      guild_id: string;
      settings: GuildRow;
    }[];
    const out: Record<string, GuildRow> = {};
    for (const r of rows) {
      const row = normalizeGuild(r.settings, this.defaults);
      out[r.guild_id] = row;
      if (!sameSettings(row, r.settings)) await this.putGuild(r.guild_id, row);
    }
    return out;
  }

  async allUserContexts() {
    const rows = (await this
      .sql`SELECT discord_id, entry FROM user_contexts`) as {
      discord_id: string;
      entry: UserContextEntry;
    }[];
    const out: Record<string, UserContextEntry> = {};
    for (const r of rows) {
      out[r.discord_id] = {
        text: typeof r.entry?.text === "string" ? r.entry.text : "",
        persona_override: Boolean(r.entry?.persona_override),
      };
    }
    return out;
  }

  async getUserOverride(id: string) {
    const rows = (await this
      .sql`SELECT settings FROM user_overrides WHERE discord_id = ${id}`) as {
      settings: UserOverrideRow;
    }[];
    const row = normalizeUserOverride(rows[0]?.settings, this.defaults);
    if (!rows[0] || !sameSettings(row, rows[0].settings)) await this.putUserOverride(id, row);
    return row;
  }

  async putUserOverride(id: string, settings: UserOverrideRow) {
    const payload = JSON.stringify(normalizeUserOverride(settings, this.defaults));
    await this.sql`
      INSERT INTO user_overrides (discord_id, settings) VALUES (${id}, ${payload}::jsonb)
      ON CONFLICT (discord_id) DO UPDATE SET settings = EXCLUDED.settings
    `;
    await this.bumpVersion();
  }

  async allUserOverrides() {
    const rows = (await this
      .sql`SELECT discord_id, settings FROM user_overrides`) as {
      discord_id: string;
      settings: UserOverrideRow;
    }[];
    const out: Record<string, UserOverrideRow> = {};
    for (const r of rows) {
      const row = normalizeUserOverride(r.settings, this.defaults);
      out[r.discord_id] = row;
      if (!sameSettings(row, r.settings)) await this.putUserOverride(r.discord_id, row);
    }
    return out;
  }

  async replaceSnapshot(
    guilds: Record<string, GuildRow>,
    userContexts: Record<string, UserContextEntry>,
  ) {
    // Full replace so a migrate cannot leave the dummy `guild=1` test row
    // (or a deleted server) as a ghost next to the real snapshot.
    await this.sql`DELETE FROM guilds`;
    await this.sql`DELETE FROM user_contexts`;
    for (const [id, settings] of Object.entries(guilds)) {
      const payload = JSON.stringify(normalizeGuild(settings, this.defaults));
      await this.sql`
        INSERT INTO guilds (guild_id, settings) VALUES (${id}, ${payload}::jsonb)
      `;
    }
    for (const [id, entry] of Object.entries(userContexts)) {
      const payload = JSON.stringify(entry);
      await this.sql`
        INSERT INTO user_contexts (discord_id, entry) VALUES (${id}, ${payload}::jsonb)
      `;
    }
    await this.bumpVersion();
  }

  async upsertUser(u: {
    discord_id: string;
    username: string;
    avatar: string | null;
    role?: Role;
  }) {
    const existing = await this.getUser(u.discord_id);
    // Same precedence as MemoryStore: caller-supplied role wins (admin seed).
    const role = u.role ?? existing?.role ?? DEFAULT_ROLE;
    await this.sql`
      INSERT INTO users (discord_id, role, username, avatar)
      VALUES (${u.discord_id}, ${role}, ${u.username}, ${u.avatar})
      ON CONFLICT (discord_id) DO UPDATE SET
        username = EXCLUDED.username,
        avatar = EXCLUDED.avatar,
        role = EXCLUDED.role
    `;
  }

  async getUser(id: string) {
    const rows = (await this.sql`
      SELECT discord_id, role, username, avatar FROM users WHERE discord_id = ${id}
    `) as UserRow[];
    const row = rows[0];
    if (!row) return null;
    return { ...row, role: parseRole(row.role) ?? DEFAULT_ROLE };
  }

  async listUsers() {
    const rows = (await this.sql`
      SELECT discord_id, role, username, avatar FROM users ORDER BY username
    `) as UserRow[];
    return rows.map((r) => ({ ...r, role: parseRole(r.role) ?? DEFAULT_ROLE }));
  }

  async setUserRole(id: string, role: Role) {
    await this.sql`UPDATE users SET role = ${role} WHERE discord_id = ${id}`;
    await this.bumpVersion();
  }

  async putSession(
    id: string,
    discordId: string,
    accessToken: string,
    expiresAt: number,
  ) {
    await this.sql`
      INSERT INTO sessions (id, discord_id, access_token, expires_at)
      VALUES (${id}, ${discordId}, ${accessToken}, ${expiresAt})
      ON CONFLICT (id) DO UPDATE SET
        discord_id = EXCLUDED.discord_id,
        access_token = EXCLUDED.access_token,
        expires_at = EXCLUDED.expires_at
    `;
  }

  async getSession(id: string) {
    const rows = (await this.sql`
      SELECT discord_id, access_token, expires_at FROM sessions WHERE id = ${id}
    `) as SessionRow[];
    const row = rows[0];
    if (!row) return null;
    return { ...row, expires_at: Number(row.expires_at) };
  }

  async deleteSession(id: string) {
    await this.sql`DELETE FROM sessions WHERE id = ${id}`;
  }

  async putPending(state: string, verifier: string) {
    await this.sql`
      INSERT INTO oauth_pending (state, code_verifier, created_at)
      VALUES (${state}, ${verifier}, ${Date.now()})
      ON CONFLICT (state) DO UPDATE SET
        code_verifier = EXCLUDED.code_verifier,
        created_at = EXCLUDED.created_at
    `;
  }

  async takePending(state: string) {
    const rows = (await this.sql`
      SELECT code_verifier FROM oauth_pending WHERE state = ${state}
    `) as { code_verifier: string }[];
    if (rows[0])
      await this.sql`DELETE FROM oauth_pending WHERE state = ${state}`;
    return rows[0]?.code_verifier ?? null;
  }

  async listBlocked() {
    const rows = (await this.sql`
      SELECT discord_id, username, reason, blocked_by, blocked_at
      FROM blocked_users ORDER BY blocked_at DESC
    `) as BlockedRow[];
    return rows.map((r) => ({ ...r, blocked_at: Number(r.blocked_at) }));
  }

  async setBlocked(row: BlockedRow) {
    await this.sql`
      INSERT INTO blocked_users (discord_id, username, reason, blocked_by, blocked_at)
      VALUES (${row.discord_id}, ${row.username}, ${row.reason}, ${row.blocked_by}, ${row.blocked_at})
      ON CONFLICT (discord_id) DO UPDATE SET
        username = EXCLUDED.username,
        reason = EXCLUDED.reason,
        blocked_by = EXCLUDED.blocked_by,
        blocked_at = EXCLUDED.blocked_at
    `;
    // Same as MemoryStore: blocked_users rides on the snapshot ETag.
    await this.bumpVersion();
  }

  async unblock(discordId: string) {
    await this.sql`DELETE FROM blocked_users WHERE discord_id = ${discordId}`;
    await this.bumpVersion();
  }

  async appendLogs(entries: LogEntry[]) {
    if (!this.logs) return 0;
    // Row-at-a-time: the bot batches at most a handful per flush, and the neon
    // HTTP driver has no multi-row bind that keeps the tagged-template escaping.
    for (const e of entries) {
      await this.sql`
        INSERT INTO logs (
          at, guild_id, guild_name, channel_id, channel_name, user_id, username,
          trigger_reason, prompt, reply, provider, model, error,
          failure_phase, failure_code, http_status, has_checkpoint,
          failure_stage, failure_reason, error_type, retries, effort, latency_ms
        ) VALUES (
          ${e.at}, ${e.guild_id}, ${e.guild_name}, ${e.channel_id}, ${e.channel_name},
          ${e.user_id}, ${e.username}, ${e.trigger}, ${e.prompt}, ${e.reply},
          ${e.provider}, ${e.model}, ${e.error}, ${e.failure_phase},
          ${e.failure_code}, ${e.http_status}, ${e.has_checkpoint},
          ${e.failure_stage}, ${e.failure_reason}, ${e.error_type}, ${e.retries}, ${e.effort},
          ${e.latency_ms}
        )
      `;
    }
    return entries.length;
  }

  async listLogs(q: LogQuery) {
    if (!this.logs) return [];
    // One tagged template with `IS NULL OR` guards: the neon HTTP driver has no
    // safe way to concatenate a WHERE clause, and the planner drops the dead
    // branches once the parameter is bound.
    const like = q.q ? `%${q.q}%` : null;
    const dmOnly = q.scope === "all" ? null : q.scope === "dm";
    const rows = (await this.sql`
      SELECT id, at, guild_id, guild_name, channel_id, channel_name, user_id,
             username, trigger_reason AS trigger, prompt, reply, provider, model,
             error, failure_phase, failure_code, http_status, has_checkpoint,
             failure_stage, failure_reason, error_type, retries, effort, latency_ms
      FROM logs
      WHERE (${q.before}::bigint IS NULL OR id < ${q.before}::bigint)
        AND (${q.guild_id}::text IS NULL OR guild_id = ${q.guild_id}::text)
        AND (${q.user_id}::text IS NULL OR user_id = ${q.user_id}::text)
        AND (${dmOnly}::boolean IS NULL OR (guild_id IS NULL) = ${dmOnly}::boolean)
        AND (${like}::text IS NULL
             OR prompt ILIKE ${like}::text
             OR reply ILIKE ${like}::text
             OR username ILIKE ${like}::text)
      ORDER BY id DESC
      LIMIT ${q.limit}
    `) as LogRow[];
    return rows.map((r) => ({ ...r, id: Number(r.id), at: Number(r.at) }));
  }

  async pruneLogs(cutoff: number) {
    if (!this.logs) return 0;
    const rows = (await this.sql`
      WITH gone AS (DELETE FROM logs WHERE at < ${cutoff} RETURNING 1)
      SELECT count(*)::int AS n FROM gone
    `) as { n: number }[];
    return rows[0]?.n ?? 0;
  }

  async replaceArtifacts(sites: ArtifactRow[]) {
    await this.sql`DELETE FROM artifacts`;
    for (const s of sites) {
      await this.sql`
        INSERT INTO artifacts (
          token, guild_id, channel_id, url, source_path,
          created_at_unix, updated_at_unix, expires_at_unix,
          retention, bytes, file_count
        ) VALUES (
          ${s.token}, ${s.guild_id}, ${s.channel_id}, ${s.url}, ${s.source_path},
          ${s.created_at_unix}, ${s.updated_at_unix}, ${s.expires_at_unix},
          ${s.retention}, ${s.bytes}, ${s.file_count}
        )
      `;
    }
  }

  async listArtifacts(guildId?: string) {
    const rows = guildId
      ? ((await this
          .sql`SELECT * FROM artifacts WHERE guild_id = ${guildId}`) as ArtifactRow[])
      : ((await this.sql`SELECT * FROM artifacts`) as ArtifactRow[]);
    return rows.map(normalizeArtifactRow);
  }

  async getArtifact(token: string) {
    const rows = (await this
      .sql`SELECT * FROM artifacts WHERE token = ${token}`) as ArtifactRow[];
    return rows[0] ? normalizeArtifactRow(rows[0]) : null;
  }

  async enqueueArtifactCommand(
    token: string,
    guildId: string | null,
    action: ArtifactAction,
  ) {
    const created = Date.now();
    const rows = (await this.sql`
      INSERT INTO artifact_commands (token, guild_id, action, created_at)
      VALUES (${token}, ${guildId}, ${action}, ${created})
      RETURNING id, token, guild_id, action, created_at
    `) as ArtifactCommandRow[];
    await this.bumpVersion();
    const row = rows[0];
    return {
      ...row,
      id: Number(row.id),
      created_at: Number(row.created_at),
    };
  }

  async listArtifactCommands() {
    const rows = (await this.sql`
      SELECT id, token, guild_id, action, created_at FROM artifact_commands ORDER BY id
    `) as ArtifactCommandRow[];
    return rows.map((r) => ({
      ...r,
      id: Number(r.id),
      created_at: Number(r.created_at),
    }));
  }

  async ackArtifactCommands(ids: number[]) {
    if (!ids.length) return 0;
    let n = 0;
    for (const id of ids) {
      const rows = (await this.sql`
        WITH gone AS (DELETE FROM artifact_commands WHERE id = ${id} RETURNING 1)
        SELECT count(*)::int AS n FROM gone
      `) as { n: number }[];
      n += rows[0]?.n ?? 0;
    }
    if (n) await this.bumpVersion();
    return n;
  }
}

function normalizeArtifactRow(r: ArtifactRow): ArtifactRow {
  return {
    ...r,
    created_at_unix: Number(r.created_at_unix),
    updated_at_unix:
      r.updated_at_unix == null ? null : Number(r.updated_at_unix),
    expires_at_unix: Number(r.expires_at_unix),
    bytes: Number(r.bytes),
    file_count: Number(r.file_count),
    retention:
      r.retention === "month" || r.retention === "permanent"
        ? r.retention
        : "ttl",
  };
}

/**
 * One shot: personal rows that were saved as a full copy go back to デフォルト
 * (every field null). Accounts with no row get that same empty row, so the
 * default exists before anyone opens マイ設定. A later explicit PATCH is kept
 * because the meta flag stops this from running again.
 */
export async function installPersonalDefaults(store: Store) {
  const key = "personal_inherit_v1";
  if ((await store.getMeta(key)) === "1") return;
  const existing = await store.allUserOverrides();
  for (const id of Object.keys(existing))
    await store.putUserOverride(id, emptyUserOverride());
  for (const user of await store.listUsers())
    if (!existing[user.discord_id])
      await store.putUserOverride(user.discord_id, emptyUserOverride());
  await store.setMeta(key, "1");
}

export async function openStore(
  databaseUrl: string | null,
  opts: { logs?: boolean } = {},
): Promise<Store> {
  if (!databaseUrl) {
    const mem = new MemoryStore(settingsDefaults(process.env));
    await mem.migrate();
    return mem;
  }
  const store = new NeonStore(databaseUrl, { logs: opts.logs ?? false, defaults: settingsDefaults(process.env) });
  await store.migrate();
  return store;
}

// JSONB sorts object keys; compare recursively to avoid writing every read.
function sameSettings(a: unknown, b: unknown): boolean {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
