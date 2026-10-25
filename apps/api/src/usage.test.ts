// Usage on the dashboard (#110): turns, distinct Discord users and published
// sites per billing month, recorded from the turns the bot already posts to
// /internal/logs and shown to Administrators only.
import { describe, expect, test } from "bun:test";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";
import {
  hashUser,
  usageHashKey,
  usageTurn,
  USAGE_RETENTION_DAYS,
} from "./usage";
import { parseLogEntry } from "./audit";

const NOW = Date.parse("2026-10-20T03:00:00Z");
const DAY = 86_400_000;
const INTERNAL = { authorization: "Bearer test-internal" };

async function setup(now = NOW) {
  const env = loadTestEnv({ adminIds: ["admin-1"] });
  const store = new MemoryStore();
  await store.migrate();
  for (const [id, role] of [
    ["admin-1", null],
    ["mod-1", "moderator"],
    ["premium-1", "premium"],
    ["free-1", "free"],
  ] as const) {
    await store.upsertUser({ discord_id: id, username: id, avatar: null });
    if (role) await store.setUserRole(id, role);
    await store.putSession(`sess-${id}`, id, `tok-${id}`, Date.now() + 60_000);
  }
  let clock = now;
  const app = createApp(env, store, {
    guildAccess: async () => true,
    listGuilds: async () => [],
    now: () => clock,
  });
  const call = (
    path: string,
    init: {
      session?: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.handle(
      new Request(`http://127.0.0.1${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.session
            ? { cookie: `__Host-hibana_session=sess-${init.session}` }
            : {}),
          origin: "http://127.0.0.1:5173",
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  /** Posts turns the way the bot does at the end of each one. */
  const turns = (
    list: {
      at: number;
      user: string;
      model?: string;
      provider?: string;
      failed?: boolean;
    }[],
    headers: Record<string, string> = INTERNAL,
  ) =>
    call("/internal/logs", {
      method: "POST",
      headers,
      body: {
        entries: list.map((t) => ({
          at: t.at,
          guild_id: "g1",
          channel_id: "c1",
          user_id: t.user,
          username: t.user,
          prompt: "secret prompt",
          reply: t.failed ? null : "reply",
          provider: t.provider ?? "anthropic",
          model: t.model ?? "claude-opus-5-5",
          error: t.failed ? "provider_error" : null,
          failure_phase: t.failed ? "provider" : null,
          failure_code: t.failed ? "provider_http" : null,
          http_status: null,
          has_checkpoint: null,
          latency_ms: 1000,
        })),
      },
    });
  const usage = async (month?: string, session = "admin-1") => {
    const res = await call(
      `/api/analytics/usage${month ? `?month=${month}` : ""}`,
      { session },
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  return { call, turns, usage, store, env, advance };
}

describe("hashUser", () => {
  test("is stable for one key, differs between keys, and does not contain the ID", () => {
    const a = usageHashKey("session-secret-a");
    const b = usageHashKey("session-secret-b");
    expect(hashUser(a, "123456789012345678")).toBe(
      hashUser(a, "123456789012345678"),
    );
    expect(hashUser(a, "123456789012345678")).not.toBe(
      hashUser(b, "123456789012345678"),
    );
    expect(hashUser(a, "123456789012345678")).not.toBe(
      hashUser(a, "123456789012345679"),
    );
    expect(hashUser(a, "123456789012345678")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(hashUser(a, "123456789012345678")).not.toContain("1234567890");
  });

  test("the key is not the session secret itself", () => {
    expect(usageHashKey("session-secret-a").toString("utf8")).not.toContain(
      "session-secret-a",
    );
  });
});

describe("usageTurn", () => {
  const key = usageHashKey("k");
  const entry = (over: Record<string, unknown>) =>
    parseLogEntry({
      at: Date.parse("2026-10-05T00:00:00Z"),
      channel_id: "c1",
      user_id: "u1",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      error: null,
      ...over,
    })!;

  test("a turn the bot answered counts as one, on its UTC day", () => {
    expect(usageTurn(entry({}), key)).toEqual({
      day: Date.parse("2026-10-05T00:00:00Z") / DAY,
      user_hash: hashUser(key, "u1"),
      provider: "anthropic",
      model: "claude-haiku-5-5",
      failed: false,
    });
  });

  test("a turn that failed counts as one, marked failed", () => {
    expect(usageTurn(entry({ error: "timeout" }), key).failed).toBe(true);
    expect(
      usageTurn(entry({ failure_code: "provider_http" }), key).failed,
    ).toBe(true);
  });

  test("the last millisecond of the 4th is still the 4th", () => {
    const day = usageTurn(
      entry({ at: Date.parse("2026-10-05T00:00:00Z") - 1 }),
      key,
    ).day;
    expect(day).toBe(Date.parse("2026-10-04T00:00:00Z") / DAY);
  });

  test("a turn with no provider or model is kept with empty names", () => {
    const t = usageTurn(entry({ provider: null, model: null }), key);
    expect([t.provider, t.model]).toEqual(["", ""]);
  });
});

describe("POST /internal/logs records usage", () => {
  test("even while the conversation log is switched off, and keeps no text", async () => {
    const { turns, usage, store, env } = await setup();
    expect(env.logsEnabled).toBe(false);
    const res = await turns([
      { at: NOW - DAY, user: "u2" },
      { at: NOW - DAY, user: "u2", failed: true },
      { at: NOW, user: "u3", model: "claude-haiku-5-5" },
    ]);
    expect(res.status).toBe(200);
    // The answer is the same as before (#110): the bot does not read it.
    expect(await res.json()).toEqual({ ok: true, n: 0, enabled: false });
    // The conversation log stays empty: only the usage counts are kept.
    expect(
      await store.listLogs({
        before: null,
        guild_id: null,
        user_id: null,
        scope: "all",
        q: null,
        limit: 10,
      } as never),
    ).toEqual([]);
    const { body } = await usage();
    expect(body.totals).toEqual({
      turns: 3,
      failed: 1,
      users: 2,
      users_excluding_admins: 2,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("u2");
    expect(text).not.toContain("secret prompt");
  });

  test("a caller without the internal token records nothing", async () => {
    const { turns, usage } = await setup();
    const res = await turns([{ at: NOW, user: "u2" }], {
      authorization: "Bearer wrong",
    });
    expect(res.status).toBe(401);
    expect((await usage()).body.totals.turns).toBe(0);
  });

  test("an entry without a user is not counted", async () => {
    const { call, usage } = await setup();
    await call("/internal/logs", {
      method: "POST",
      headers: INTERNAL,
      body: { entries: [{ at: NOW, channel_id: "c1" }, "junk", null] },
    });
    expect((await usage()).body.totals.turns).toBe(0);
  });
});

describe("GET /api/analytics/usage", () => {
  test("is for Administrators only", async () => {
    const { usage, call } = await setup();
    expect((await call("/api/analytics/usage")).status).toBe(401);
    for (const session of ["mod-1", "premium-1", "free-1"])
      expect((await usage(undefined, session)).status).toBe(403);
    expect((await usage(undefined, "admin-1")).status).toBe(200);
  });

  test("/api/me tells the page whether to show it", async () => {
    const { call } = await setup();
    const me = async (session: string) =>
      (await (await call("/api/me", { session })).json()) as {
        can_view_usage: boolean;
      };
    expect((await me("admin-1")).can_view_usage).toBe(true);
    for (const session of ["mod-1", "premium-1", "free-1"])
      expect((await me(session)).can_view_usage).toBe(false);
  });

  test("counts turns per day, distinct users, and users other than Administrators", async () => {
    const { turns, usage } = await setup();
    const d18 = Date.parse("2026-10-18T10:00:00Z");
    const d19 = Date.parse("2026-10-19T23:59:59Z");
    await turns([
      { at: d18, user: "admin-1" },
      { at: d18, user: "admin-1", model: "claude-haiku-5-5" },
      { at: d18, user: "u2" },
      { at: d19, user: "u2", failed: true },
      { at: d19, user: "u3", provider: "refuseless", model: "glm-5.3" },
    ]);
    const { status, body } = await usage();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      month: "2026-10",
      current: true,
      start: "2026-10-05",
      end: "2026-11-05",
      first_day: "2026-10-18",
      retention_days: USAGE_RETENTION_DAYS,
    });
    expect(body.days).toEqual([
      {
        date: "2026-10-18",
        turns: 3,
        failed: 0,
        users: 2,
        users_excluding_admins: 1,
      },
      {
        date: "2026-10-19",
        turns: 2,
        failed: 1,
        users: 2,
        users_excluding_admins: 2,
      },
    ]);
    // A person on two days is one user in the month.
    expect(body.totals).toEqual({
      turns: 5,
      failed: 1,
      users: 3,
      users_excluding_admins: 2,
    });
    expect(body.models).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5", turns: 3 },
      { provider: "anthropic", model: "claude-haiku-5-5", turns: 1 },
      { provider: "refuseless", model: "glm-5.3", turns: 1 },
    ]);
  });

  test("a billing month runs from the 5th to the 4th, in UTC", async () => {
    const { turns, usage } = await setup();
    await turns([
      { at: Date.parse("2026-10-05T00:00:00Z") - 1, user: "u2" },
      { at: Date.parse("2026-10-05T00:00:00Z"), user: "u3" },
    ]);
    const september = (await usage("2026-09")).body;
    expect(september).toMatchObject({
      month: "2026-09",
      current: false,
      start: "2026-09-05",
      end: "2026-10-05",
    });
    expect(september.days.map((d: { date: string }) => d.date)).toEqual([
      "2026-10-04",
    ]);
    expect(september.totals.turns).toBe(1);
    const october = (await usage("2026-10")).body;
    expect(october.days.map((d: { date: string }) => d.date)).toEqual([
      "2026-10-05",
    ]);
    expect(october.totals.turns).toBe(1);
  });

  test("refuses a month that is malformed or in the future", async () => {
    const { usage } = await setup();
    expect((await usage("2026-11")).status).toBe(400);
    expect((await usage("2026-13")).status).toBe(400);
    expect((await usage("october")).status).toBe(400);
  });

  test("an empty month has zero counts and no first day", async () => {
    const { usage } = await setup();
    const { body } = await usage();
    expect(body.days).toEqual([]);
    expect(body.models).toEqual([]);
    expect(body.first_day).toBeNull();
    expect(body.totals).toEqual({
      turns: 0,
      failed: 0,
      users: 0,
      users_excluding_admins: 0,
    });
    expect(body.sites).toEqual({ published: 0, created: 0 });
  });

  test(`drops days older than ${USAGE_RETENTION_DAYS} days`, async () => {
    const { turns, usage, advance } = await setup();
    const old = NOW - (USAGE_RETENTION_DAYS + 1) * DAY;
    await turns([{ at: old, user: "u2" }]);
    // The prune runs at most once an hour, so a turn an hour later triggers it.
    advance(3_600_001);
    await turns([{ at: NOW, user: "u3" }]);
    const oldMonth = new Date(old).toISOString().slice(0, 7);
    expect((await usage(oldMonth)).body.totals.turns).toBe(0);
    expect((await usage()).body.first_day).toBe("2026-10-20");
  });
});

describe("published sites", () => {
  const nowUnix = Math.floor(NOW / 1000);
  const site = (token: string, createdUnix: number, over: object = {}) => ({
    token,
    channel_id: "c1",
    url: `https://${token}.example`,
    created_at_unix: createdUnix,
    expires_at_unix: nowUnix + 3600,
    retention: "ttl",
    ...over,
  });
  const post = (
    call: Awaited<ReturnType<typeof setup>>["call"],
    sites: unknown[],
  ) =>
    call("/internal/artifacts", {
      method: "POST",
      headers: INTERNAL,
      body: { sites },
    });

  test("counts the sites published now, as the bot judges them", async () => {
    const { call, usage } = await setup();
    await post(call, [
      site("a1", nowUnix - 60),
      site("a2", nowUnix - 60, { retention: "permanent", expires_at_unix: 1 }),
      site("a3", nowUnix - 60, { expires_at_unix: 0 }),
      site("a4", nowUnix - 60, { expires_at_unix: nowUnix - 1 }),
    ]);
    expect((await usage()).body.sites.published).toBe(3);
  });

  test("counts sites created in the month once, even after they are gone from the list", async () => {
    const { call, usage } = await setup();
    const oct6 = Date.parse("2026-10-06T00:00:00Z") / 1000;
    const oct4 = Date.parse("2026-10-04T23:59:59Z") / 1000;
    await post(call, [site("b1", oct6), site("b2", oct4)]);
    // The bot sends its whole list again; b1 expired and is no longer in it.
    await post(call, [site("b2", oct4), site("b3", oct6 + 10)]);
    await post(call, [site("b2", oct4), site("b3", oct6 + 10)]);
    expect((await usage("2026-10")).body.sites.created).toBe(2);
    expect((await usage("2026-09")).body.sites.created).toBe(1);
  });
});
