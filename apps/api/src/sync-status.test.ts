import { describe, expect, test } from "bun:test";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";

const INTERNAL = { authorization: "Bearer test-internal" };

async function setup(nowValue = { current: 1_763_820_000_000 }) {
  const store = new MemoryStore();
  const env = loadTestEnv({ adminIds: ["admin-1"] });
  await store.migrate();
  for (const [id, role] of [
    ["admin-1", null],
    ["free-1", "free"],
  ] as const) {
    await store.upsertUser({ discord_id: id, username: id, avatar: null });
    if (role) await store.setUserRole(id, role);
    await store.putSession(`sess-${id}`, id, `tok-${id}`, Date.now() + 60_000);
  }
  const app = createApp(env, store, {
    now: () => nowValue.current,
    guildAccess: async () => true,
    guildManage: async () => true,
    listGuilds: async () => [{ id: "g1", name: "One", icon: null }],
  });
  const call = (
    path: string,
    init: { user?: string; method?: string; body?: unknown } & {
      headers?: Record<string, string>;
    } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (init.user)
      headers.set("cookie", `__Host-hibana_session=sess-${init.user}`);
    headers.set("origin", "http://127.0.0.1:5173");
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    return app.handle(
      new Request(`http://127.0.0.1${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
  };
  return { app, store, call, nowValue };
}

describe("bot snapshot sync status (#185)", () => {
  test("requires internal auth for ack and session auth for sync-status", async () => {
    const { call } = await setup();
    expect(
      (
        await call("/internal/snapshot/ack", {
          method: "POST",
          body: { version: 1 },
        })
      ).status,
    ).toBe(401);
    expect((await call("/api/sync-status")).status).toBe(401);
  });

  test("rejects invalid version payloads on /internal/snapshot/ack", async () => {
    const { call } = await setup();
    for (const body of [{}, { version: -1 }, { version: 1.5 }, { version: "1" }]) {
      const res = await call("/internal/snapshot/ack", {
        method: "POST",
        headers: INTERNAL,
        body,
      });
      expect(res.status).toBe(400);
    }
  });

  test("records applied version monotonically without bumping snapshot_version", async () => {
    const { call, store, nowValue } = await setup();
    const initialStatus = await call("/api/sync-status", { user: "free-1" });
    expect(initialStatus.status).toBe(200);
    expect(initialStatus.headers.get("cache-control")).toBe("no-store");
    expect(await initialStatus.json()).toEqual({
      snapshot_version: await store.version(),
      applied_version: null,
      applied_at: null,
    });

    const versionBefore = await store.version();
    const ack5 = await call("/internal/snapshot/ack", {
      method: "POST",
      headers: INTERNAL,
      body: { version: 5 },
    });
    expect(ack5.status).toBe(200);
    expect(await ack5.json()).toEqual({
      ok: true,
      applied_version: 5,
      applied_at: nowValue.current,
    });
    expect(await store.version()).toBe(versionBefore);

    // An older version must never roll applied_version backwards.
    nowValue.current += 10_000;
    const ack3 = await call("/internal/snapshot/ack", {
      method: "POST",
      headers: INTERNAL,
      body: { version: 3 },
    });
    expect(ack3.status).toBe(200);
    expect(await ack3.json()).toEqual({
      ok: true,
      applied_version: 5,
      applied_at: nowValue.current - 10_000,
    });

    const after = await call("/api/sync-status", { user: "free-1" });
    expect(await after.json()).toEqual({
      snapshot_version: versionBefore,
      applied_version: 5,
      applied_at: nowValue.current - 10_000,
    });
  });

  test("all snapshot-mutating dashboard routes return snapshot_version matching store version", async () => {
    const { call, store } = await setup();
    const cases: { path: string; method: string; body: unknown }[] = [
      {
        path: "/api/guilds/g1/settings",
        method: "PATCH",
        body: { effort: "high" },
      },
      {
        path: "/api/me/settings",
        method: "PATCH",
        body: { jev_enabled: false },
      },
      {
        path: "/api/users/free-1/settings",
        method: "PATCH",
        body: { jev_enabled: false },
      },
      {
        path: "/api/app-settings",
        method: "PATCH",
        body: { temperature: 0.9 },
      },
      {
        path: "/api/guilds/g1/schedules",
        method: "PUT",
        body: { schedules: [] },
      },
      {
        path: "/api/catalog/presets/ds-deepseek-flash",
        method: "PATCH",
        body: { published: true },
      },
      {
        path: "/api/users/free-1",
        method: "PATCH",
        body: { role: "premium" },
      },
      {
        path: "/api/budget-fallback",
        method: "PUT",
        body: { preset: "ds-deepseek-flash", effort: "high", threshold_usd: 15 },
      },
    ];

    for (const c of cases) {
      const res = await call(c.path, {
        user: "admin-1",
        method: c.method,
        body: c.body,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        version?: number;
        snapshot_version?: number;
      };
      const expected = await store.version();
      expect(body.version).toBe(expected);
      expect(body.snapshot_version).toBe(expected);
    }
  });
});
