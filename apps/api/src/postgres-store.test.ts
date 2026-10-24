import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { LogEntry } from "./audit";
import { emptyGuild, emptyUserOverride } from "./settings";
import {
  assertPostgresUrl,
  isStaleConnection,
  PostgresStore,
  type SqlClient,
} from "./store";

describe("assertPostgresUrl", () => {
  test("accepts a local URL without TLS and a remote one with sslmode", () => {
    for (const url of [
      "postgres://u:p@127.0.0.1:5432/db",
      "postgres://u:p@localhost/db",
      "postgresql://u:p@pooler.example.com:6543/postgres?sslmode=require",
      "postgres://u:p@db.example.com/postgres?sslmode=verify-full",
    ])
      expect(assertPostgresUrl(url)).toBe(url);
  });

  test("rejects a remote URL that would send the password in plain text, without echoing it", () => {
    for (const url of [
      "postgres://u:SECRET@pooler.example.com:6543/postgres",
      "postgres://u:SECRET@pooler.example.com:6543/postgres?sslmode=prefer",
      "postgres://u:SECRET@pooler.example.com:6543/postgres?sslmode=disable",
    ]) {
      expect(() => assertPostgresUrl(url)).toThrow(/sslmode=require/);
      try {
        assertPostgresUrl(url);
      } catch (e) {
        expect(String(e)).not.toContain("SECRET");
      }
    }
  });

  test("rejects garbage and other schemes", () => {
    expect(() => assertPostgresUrl("not a url SECRET")).toThrow(
      "DATABASE_URL is not a valid URL",
    );
    expect(() => assertPostgresUrl("mysql://u:p@127.0.0.1/db")).toThrow(
      "must be a postgres URL",
    );
  });
});

describe("isStaleConnection", () => {
  test("matches the errors Bun raises on a connection closed while the instance slept", () => {
    // Shapes measured with Bun 1.4.3 against Postgres 17 (see store.ts).
    expect(
      isStaleConnection({
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "57P01",
        severity: "FATAL",
      }),
    ).toBe(true);
    expect(isStaleConnection({ code: "ERR_POSTGRES_CONNECTION_CLOSED" })).toBe(
      true,
    );
  });

  test("does not match query errors, which must not be retried", () => {
    expect(
      isStaleConnection({
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "22P02",
        severity: "ERROR",
      }),
    ).toBe(false);
    expect(
      isStaleConnection({
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "28P01",
        severity: "FATAL",
      }),
    ).toBe(false);
    expect(isStaleConnection({ code: "ERR_POSTGRES_CONNECTION_TIMEOUT" })).toBe(
      false,
    );
    expect(isStaleConnection(new Error("boom"))).toBe(false);
    expect(isStaleConnection(null)).toBe(false);
  });
});

/** A stand-in pool whose queries answer from a script of results and errors. */
function fakePools(script: unknown[]) {
  const opened: { closed: boolean; calls: number }[] = [];
  const connect = (): SqlClient => {
    const state = { closed: false, calls: 0 };
    opened.push(state);
    const client = (async () => {
      state.calls++;
      const next = script.shift();
      if (
        next instanceof Error ||
        (next && typeof next === "object" && "code" in next)
      )
        throw next;
      return (next as unknown[]) ?? [];
    }) as unknown as SqlClient;
    client.close = async () => {
      state.closed = true;
    };
    return client;
  };
  return { connect, opened };
}

const closed = { code: "ERR_POSTGRES_CONNECTION_CLOSED" };
const fatal = {
  code: "ERR_POSTGRES_SERVER_ERROR",
  errno: "57P01",
  severity: "FATAL",
};

describe("PostgresStore query retry", () => {
  const url = "postgres://u:p@127.0.0.1:5432/db";

  test("a stale connection is retried on a fresh pool, and the old pool is closed", async () => {
    const pools = fakePools([fatal, closed, [{ value: "7" }]]);
    const store = new PostgresStore(url, { connect: pools.connect });
    expect(await store.version()).toBe(7);
    // The first failure swaps the pool; the second hits the new pool's first
    // dead connection and swaps again.
    expect(pools.opened.length).toBe(3);
    expect(pools.opened[0]!.closed).toBe(true);
    expect(pools.opened[1]!.closed).toBe(true);
    expect(pools.opened[2]!.closed).toBe(false);
  });

  test("gives up after three attempts", async () => {
    const pools = fakePools([closed, closed, closed, [{ value: "1" }]]);
    const store = new PostgresStore(url, { connect: pools.connect });
    await expect(store.version()).rejects.toMatchObject({
      code: "ERR_POSTGRES_CONNECTION_CLOSED",
    });
  });

  test("a query error is not retried", async () => {
    const bad = {
      code: "ERR_POSTGRES_SERVER_ERROR",
      errno: "22P02",
      severity: "ERROR",
    };
    const pools = fakePools([bad, [{ value: "1" }]]);
    const store = new PostgresStore(url, { connect: pools.connect });
    await expect(store.version()).rejects.toMatchObject({ errno: "22P02" });
    expect(pools.opened.length).toBe(1);
  });
});

/**
 * Runs the store against a real Postgres when HIBANA_TEST_DATABASE_URL points
 * at one, e.g. `docker run --rm -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:17-alpine`
 * and `HIBANA_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
 * It drops the store's tables first, so only a local database is accepted.
 */
const testUrl = process.env.HIBANA_TEST_DATABASE_URL ?? "";
const local = (() => {
  try {
    return ["127.0.0.1", "localhost"].includes(new URL(testUrl).hostname);
  } catch {
    return false;
  }
})();

const TABLES = [
  "meta",
  "skill_commands",
  "guilds",
  "users",
  "sessions",
  "oauth_pending",
  "user_contexts",
  "user_overrides",
  "blocked_users",
  "artifacts",
  "artifact_commands",
  "logs",
  "usage_daily",
  "site_history",
];

function logEntry(over: Partial<LogEntry>): LogEntry {
  return {
    at: Date.now(),
    guild_id: "g1",
    guild_name: "Guild",
    channel_id: "c1",
    channel_name: "general",
    user_id: "u1",
    username: "alice",
    trigger: "mention",
    prompt: "こんにちは",
    reply: "hi",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    error: null,
    failure_phase: null,
    failure_code: null,
    http_status: null,
    has_checkpoint: null,
    failure_stage: null,
    failure_reason: null,
    error_type: null,
    retries: null,
    effort: "high",
    latency_ms: 1234,
    ...over,
  };
}

describe.skipIf(!local)("PostgresStore against Postgres", () => {
  let admin: SQL;
  let store: PostgresStore;

  beforeAll(async () => {
    admin = new SQL(testUrl);
    for (const t of TABLES) await admin.unsafe(`DROP TABLE IF EXISTS ${t}`);
    store = new PostgresStore(testUrl, { logs: true });
    await store.migrate();
  });

  afterAll(async () => {
    await store?.close();
    await admin?.close();
  });

  test("migrate is idempotent and starts the version at 0", async () => {
    await store.migrate();
    expect(await store.version()).toBe(0);
    expect(await store.getMeta("personal_inherit_v1")).toBe("1");
  });

  test("every table has row level security on, so Supabase's Data API cannot read it", async () => {
    const rows = (await admin`
      SELECT relname, relrowsecurity FROM pg_class
      WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
      ORDER BY relname`) as { relname: string; relrowsecurity: boolean }[];
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  test("a role without a policy sees no rows, while the owner still does", async () => {
    await store.setMeta("rls_probe", "secret");
    await admin.unsafe(`DROP ROLE IF EXISTS hibana_anon_probe`);
    await admin.unsafe(`CREATE ROLE hibana_anon_probe`);
    await admin.unsafe(`GRANT SELECT ON meta TO hibana_anon_probe`);
    const seen = await admin.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE hibana_anon_probe`);
      return tx`SELECT value FROM meta WHERE key = 'rls_probe'`;
    });
    expect(seen.length).toBe(0);
    expect(await store.getMeta("rls_probe")).toBe("secret");
    await admin.unsafe(`REVOKE ALL ON meta FROM hibana_anon_probe`);
    await admin.unsafe(`DROP ROLE hibana_anon_probe`);
  });

  test("meta, compareMeta and the version counter", async () => {
    await store.setMeta("k", "a");
    expect(await store.getMeta("k")).toBe("a");
    expect(await store.compareMeta("k", "b", "c")).toBe(false);
    expect(await store.compareMeta("k", "a", "c")).toBe(true);
    expect(await store.compareMeta("fresh", null, "x")).toBe(true);
    expect(await store.compareMeta("fresh", null, "y")).toBe(false);
    const before = await store.version();
    expect(await store.bumpVersion()).toBe(before + 1);
  });

  test("guilds, user contexts and user overrides round-trip JSONB", async () => {
    const guild = {
      ...emptyGuild(),
      mcp_url: "https://例え.jp/mcp",
      thread_only: true,
    };
    await store.putGuild("g1", guild);
    expect(await store.getGuild("g1")).toMatchObject({
      mcp_url: "https://例え.jp/mcp",
      thread_only: true,
    });
    expect(Object.keys(await store.allGuilds())).toEqual(["g1"]);
    await store.replaceSnapshot(
      { g2: emptyGuild() },
      { u1: { text: "context", persona_override: true } },
    );
    expect(Object.keys(await store.allGuilds())).toEqual(["g2"]);
    expect(await store.allUserContexts()).toEqual({
      u1: { text: "context", persona_override: true },
    });
    await store.putUserOverride("u1", emptyUserOverride());
    expect(await store.getUserOverride("u1")).toEqual(emptyUserOverride());
    expect(Object.keys(await store.allUserOverrides())).toContain("u1");
  });

  test("users, sessions, OAuth state and the block list", async () => {
    await store.upsertUser({
      discord_id: "u1",
      username: "alice",
      avatar: null,
    });
    await store.setUserRole("u1", "moderator");
    await store.upsertUser({
      discord_id: "u1",
      username: "alice2",
      avatar: "a",
    });
    expect(await store.getUser("u1")).toEqual({
      discord_id: "u1",
      role: "moderator",
      username: "alice2",
      avatar: "a",
    });
    expect((await store.listUsers()).map((u) => u.discord_id)).toEqual(["u1"]);

    const expires = Date.now() + 60_000;
    await store.putSession("s1", "u1", "tok", expires);
    expect(await store.getSession("s1")).toEqual({
      discord_id: "u1",
      access_token: "tok",
      expires_at: expires,
    });
    await store.deleteSession("s1");
    expect(await store.getSession("s1")).toBeNull();

    await store.putPending("st", "verifier");
    expect(await store.takePending("st")).toBe("verifier");
    expect(await store.takePending("st")).toBeNull();

    const at = Date.now();
    await store.setBlocked({
      discord_id: "b1",
      username: null,
      reason: "spam",
      blocked_by: "u1",
      blocked_at: at,
    });
    expect(await store.listBlocked()).toEqual([
      {
        discord_id: "b1",
        username: null,
        reason: "spam",
        blocked_by: "u1",
        blocked_at: at,
      },
    ]);
    await store.unblock("b1");
    expect(await store.listBlocked()).toEqual([]);
  });

  test("logs: append, filter, page and prune", async () => {
    const old = Date.now() - 40 * 24 * 3600_000;
    await store.appendLogs([
      logEntry({ at: old, prompt: "old one" }),
      logEntry({ guild_id: null, guild_name: null, prompt: "DM message" }),
      logEntry({ user_id: "u2", username: "bob", prompt: "from bob" }),
    ]);
    const all = await store.listLogs({
      limit: 10,
      before: null,
      guild_id: null,
      user_id: null,
      scope: "all",
      q: null,
    });
    expect(all.map((r) => r.prompt)).toEqual([
      "from bob",
      "DM message",
      "old one",
    ]);
    expect(typeof all[0]!.id).toBe("number");
    expect(typeof all[0]!.at).toBe("number");
    const dm = await store.listLogs({
      limit: 10,
      before: null,
      guild_id: null,
      user_id: null,
      scope: "dm",
      q: null,
    });
    expect(dm.map((r) => r.prompt)).toEqual(["DM message"]);
    const bob = await store.listLogs({
      limit: 10,
      before: null,
      guild_id: null,
      user_id: "u2",
      scope: "all",
      q: null,
    });
    expect(bob.map((r) => r.prompt)).toEqual(["from bob"]);
    const page = await store.listLogs({
      limit: 1,
      before: all[0]!.id,
      guild_id: null,
      user_id: null,
      scope: "all",
      q: null,
    });
    expect(page.map((r) => r.prompt)).toEqual(["DM message"]);
    const search = await store.listLogs({
      limit: 10,
      before: null,
      guild_id: null,
      user_id: null,
      scope: "all",
      q: "BOB",
    });
    expect(search.map((r) => r.prompt)).toEqual(["from bob"]);
    expect(await store.pruneLogs(Date.now() - 30 * 24 * 3600_000)).toBe(1);
  });

  test("artifacts and artifact commands", async () => {
    await store.replaceArtifacts([
      {
        token: "t1",
        guild_id: "g1",
        channel_id: "c1",
        url: "https://example.com",
        source_path: "site",
        created_at_unix: 1,
        updated_at_unix: null,
        expires_at_unix: 2,
        retention: "month",
        bytes: 10,
        file_count: 2,
      },
    ]);
    expect((await store.listArtifacts("g1")).map((a) => a.token)).toEqual([
      "t1",
    ]);
    expect(await store.getArtifact("t1")).toMatchObject({
      bytes: 10,
      file_count: 2,
      updated_at_unix: null,
      retention: "month",
    });
    const cmd = await store.enqueueArtifactCommand("t1", "g1", "permanent");
    expect(typeof cmd.id).toBe("number");
    expect((await store.listArtifactCommands()).map((c) => c.id)).toEqual([
      cmd.id,
    ]);
    expect(await store.ackArtifactCommands([cmd.id])).toBe(1);
    expect(await store.listArtifactCommands()).toEqual([]);
  });

  test("skill commands", async () => {
    const cmd = await store.enqueueSkillCommand("g1", "create", { name: "x" });
    expect(typeof cmd.id).toBe("number");
    expect(cmd.args).toEqual({ name: "x" });
    await store.ackSkillCommand(cmd.id, { ok: true });
    const [row] = await store.listSkillCommands();
    expect(row).toMatchObject({ id: cmd.id, result: { ok: true } });
  });

  test("a query after the server closed every pooled connection still succeeds", async () => {
    // Open more than one pooled connection, then end them all from outside.
    await Promise.all([store.version(), store.version(), store.version()]);
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`;
    expect(typeof (await store.version())).toBe("number");
  });

  // #110, #111: one row per UTC day, user and model, added to by upserts.
  test("usage: upserts add up, and days and months count distinct users", async () => {
    const day = 20_740;
    await store.recordUsage([
      {
        day,
        user_hash: "h-admin",
        provider: "anthropic",
        model: "opus",
        failed: false,
      },
      {
        day,
        user_hash: "h-admin",
        provider: "anthropic",
        model: "opus",
        failed: true,
      },
      {
        day,
        user_hash: "h-2",
        provider: "anthropic",
        model: "opus",
        failed: false,
      },
      {
        day,
        user_hash: "h-2",
        provider: "anthropic",
        model: "haiku",
        failed: false,
      },
    ]);
    await store.recordUsage([
      {
        day: day + 1,
        user_hash: "h-2",
        provider: "anthropic",
        model: "opus",
        failed: false,
      },
      {
        day: day + 1,
        user_hash: "h-3",
        provider: "",
        model: "",
        failed: false,
      },
    ]);
    const rows =
      (await admin`SELECT day, user_hash, provider, model, turns, failed
      FROM usage_daily ORDER BY day, user_hash, model`) as unknown[];
    expect(rows).toEqual([
      {
        day,
        user_hash: "h-2",
        provider: "anthropic",
        model: "haiku",
        turns: 1,
        failed: 0,
      },
      {
        day,
        user_hash: "h-2",
        provider: "anthropic",
        model: "opus",
        turns: 1,
        failed: 0,
      },
      {
        day,
        user_hash: "h-admin",
        provider: "anthropic",
        model: "opus",
        turns: 2,
        failed: 1,
      },
      {
        day: day + 1,
        user_hash: "h-2",
        provider: "anthropic",
        model: "opus",
        turns: 1,
        failed: 0,
      },
      {
        day: day + 1,
        user_hash: "h-3",
        provider: "",
        model: "",
        turns: 1,
        failed: 0,
      },
    ]);
    const report = await store.usageReport({
      fromDay: day,
      toDay: day + 2,
      exclude: ["h-admin"],
      fromUnix: 0,
      toUnix: 0,
      nowUnix: 0,
    });
    expect(report.days).toEqual([
      { day, turns: 4, failed: 1, users: 2, users_excluding_admins: 1 },
      {
        day: day + 1,
        turns: 2,
        failed: 0,
        users: 2,
        users_excluding_admins: 2,
      },
    ]);
    expect(report.totals).toEqual({
      turns: 6,
      failed: 1,
      users: 3,
      users_excluding_admins: 2,
    });
    expect(report.models).toEqual([
      { provider: "anthropic", model: "opus", turns: 4 },
      { provider: "", model: "", turns: 1 },
      { provider: "anthropic", model: "haiku", turns: 1 },
    ]);
    expect(report.first_day).toBe(day);
    // A range with nothing in it.
    const empty = await store.usageReport({
      fromDay: day + 10,
      toDay: day + 20,
      exclude: [],
      fromUnix: 0,
      toUnix: 0,
      nowUnix: 0,
    });
    expect(empty.days).toEqual([]);
    expect(empty.totals).toEqual({
      turns: 0,
      failed: 0,
      users: 0,
      users_excluding_admins: 0,
    });
    expect(await store.pruneUsage(day + 1)).toBe(3);
    expect(
      (
        await store.usageReport({
          fromDay: 0,
          toDay: day + 100,
          exclude: [],
          fromUnix: 0,
          toUnix: 0,
          nowUnix: 0,
        })
      ).first_day,
    ).toBe(day + 1);
  });

  test("usage: the month query reads a range of days through the primary key", async () => {
    await admin`ANALYZE usage_daily`;
    // Too few rows for the planner to prefer the index on its own.
    await admin`SET enable_seqscan = off`;
    try {
      const plan = (await admin.unsafe(
        "EXPLAIN SELECT count(*) FROM usage_daily WHERE day >= 1 AND day < 100",
      )) as { "QUERY PLAN": string }[];
      expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
        "usage_daily_pkey",
      );
    } finally {
      await admin`SET enable_seqscan = on`;
    }
  });

  test("site history: one row per site, counted by when it was created", async () => {
    const site = (token: string, created: number, over: object = {}) => ({
      token,
      guild_id: null,
      channel_id: "c1",
      url: `https://${token}.example`,
      source_path: "",
      created_at_unix: created,
      updated_at_unix: null,
      expires_at_unix: 2_000,
      retention: "ttl" as const,
      bytes: 0,
      file_count: 0,
      ...over,
    });
    await store.replaceArtifacts([
      site("c1", 100),
      site("c2", 200, { retention: "permanent", expires_at_unix: 1 }),
      site("c3", 300, { expires_at_unix: 0 }),
      site("c4", 400, { expires_at_unix: 999 }),
    ]);
    await store.replaceArtifacts([site("c2", 200), site("c5", 500)]);
    const rows = (await admin`SELECT count(*)::int AS n FROM site_history`) as {
      n: number;
    }[];
    expect(rows[0]!.n).toBe(5);
    const tokens = (await admin`SELECT token_hash FROM site_history`) as {
      token_hash: string;
    }[];
    expect(tokens.some((t) => t.token_hash.includes("c1"))).toBe(false);
    const report = await store.usageReport({
      fromDay: 0,
      toDay: 1,
      exclude: [],
      fromUnix: 200,
      toUnix: 500,
      nowUnix: 1_000,
    });
    // c2, c3 and c4 were created in [200, 500); now only c2 (ttl, 2000) and c5 are listed.
    expect(report.sites).toEqual({ published: 2, created: 3 });
  });
});
