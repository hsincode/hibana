import { describe, expect, test } from "bun:test";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { emptyGuild } from "./settings";
import {
  APP_SETTINGS_META,
  loadAppSettings,
  MemoryStore,
  patchAppSettings,
} from "./store";

const INTERNAL = { authorization: "Bearer test-internal" };

async function setup(store = new MemoryStore()) {
  const env = loadTestEnv({ adminIds: ["admin-1"] });
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
  const app = createApp(env, store, {
    guildAccess: async () => true,
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
  return { app, store, call };
}

describe("app settings (#161)", () => {
  test("everyone signed in reads them; only Moderators and Administrators change them", async () => {
    const { call } = await setup();
    expect((await call("/api/app-settings")).status).toBe(401);
    for (const [user, edit] of [
      ["free-1", false],
      ["premium-1", false],
      ["mod-1", true],
      ["admin-1", true],
    ] as const) {
      const res = await call("/api/app-settings", { user });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.can_edit).toBe(edit);
      expect(body.settings.thread_compaction).toBe("cache");
      expect(body.defaults.temperature).toBe(0.7);
      const me = await (await call("/api/me", { user })).json();
      expect(me.can_manage_app_settings).toBe(edit);
      const patch = await call("/api/app-settings", {
        user,
        method: "PATCH",
        body: { temperature: 1.1 },
      });
      expect(patch.status).toBe(edit ? 200 : 403);
    }
    expect(
      (
        await call("/api/app-settings", {
          method: "PATCH",
          body: { temperature: 1 },
        })
      ).status,
    ).toBe(401);
  });

  test("a change reaches every server row and the bot's snapshot, and null returns a field to its default", async () => {
    const { call, store } = await setup();
    await store.putGuild("g1", { ...emptyGuild(), thread_only: true });
    const before = await store.version();
    const saved = await call("/api/app-settings", {
      user: "mod-1",
      method: "PATCH",
      body: {
        temperature: 1.25,
        exa_mode: "off",
        thread_history_max_age_secs: 600,
        thread_compaction: "transcript",
        thread_compaction_tokens: 50_000,
        voice_mode: "s2s",
        filler_removal: false,
      },
    });
    expect(saved.status).toBe(200);
    const { settings } = await saved.json();
    expect(settings).toMatchObject({
      temperature: 1.25,
      exa_mode: "off",
      voice_mode: "s2s",
      filler_removal: false,
    });
    // The bot is told: the version moved, so it is not answered 304.
    expect(await store.version()).toBeGreaterThan(before);
    const snapshot = await (
      await call("/internal/snapshot", { headers: INTERNAL })
    ).json();
    expect(snapshot.app_settings).toEqual(settings);
    // The previous bot reads them from the server rows (docs/adr/0006).
    expect(snapshot.guilds.g1).toMatchObject({
      ...settings,
      thread_only: true,
    });
    const page = await (
      await call("/api/guilds/g1/settings", { user: "mod-1" })
    ).json();
    expect(page.settings).toMatchObject(settings);

    const reset = await call("/api/app-settings", {
      user: "admin-1",
      method: "PATCH",
      body: { temperature: null, thread_compaction: null },
    });
    const after = (await reset.json()).settings;
    expect(after.temperature).toBe(0.7);
    expect(after.thread_compaction).toBe("cache");
    expect(after.exa_mode).toBe("off");
  });

  test("a server's PATCH of an app setting is accepted and changes nothing", async () => {
    const { call, store } = await setup();
    const res = await call("/api/guilds/g1/settings", {
      user: "free-1",
      method: "PATCH",
      body: { temperature: 0.2, voice_mode: "s2s", thread_only: true },
    });
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(settings.temperature).toBe(0.7);
    expect(settings.voice_mode).toBe("stt");
    expect(settings.thread_only).toBe(true);
    expect((await loadAppSettings(store)).temperature).toBe(0.7);
    const internal = await call("/internal/guilds/g1", {
      method: "PATCH",
      headers: INTERNAL,
      body: { temperature: 0.2 },
    });
    expect(internal.status).toBe(200);
    expect((await loadAppSettings(store)).temperature).toBe(0.7);
  });

  test("bad values and unknown fields are refused", async () => {
    const { call, store } = await setup();
    for (const body of [
      { temperature: 3 },
      { exa_mode: "always" },
      { thread_compaction_tokens: 10 },
      { voice_mode: null },
      { mcp_url: "http://example.com/mcp" },
      { thread_only: true },
    ]) {
      const res = await call("/api/app-settings", {
        user: "admin-1",
        method: "PATCH",
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(JSON.parse((await store.getMeta(APP_SETTINGS_META))!)).toEqual(
      await loadAppSettings(store),
    );
    expect((await loadAppSettings(store)).temperature).toBe(0.7);
  });

  test("the bot's commands change them through the internal route, with the internal token only", async () => {
    const { call, store } = await setup();
    expect(
      (
        await call("/internal/app-settings", {
          method: "PATCH",
          body: { filler_removal: false },
        })
      ).status,
    ).toBe(401);
    const res = await call("/internal/app-settings", {
      method: "PATCH",
      headers: INTERNAL,
      body: { filler_removal: false },
    });
    expect(res.status).toBe(200);
    expect((await loadAppSettings(store)).filler_removal).toBe(false);
  });

  test("two saves at once keep each other's fields", async () => {
    const { store } = await setup();
    await Promise.all([
      patchAppSettings(store, { temperature: 1.5 }),
      patchAppSettings(store, { exa_mode: "off" }),
      patchAppSettings(store, { voice_mode: "s2s" }),
    ]);
    expect(await loadAppSettings(store)).toMatchObject({
      temperature: 1.5,
      exa_mode: "off",
      voice_mode: "s2s",
    });
  });

  test("they start once from what most servers had, and a later start keeps a change", async () => {
    const store = new MemoryStore();
    for (const [id, temperature, exa_mode] of [
      ["a", 1, "on"],
      ["b", 0.7, "on"],
      ["c", 0.7, "auto"],
    ] as const)
      await store.putGuild(id, { ...emptyGuild(), temperature, exa_mode });
    await store.migrate();
    const first = await loadAppSettings(store);
    expect(first.temperature).toBe(0.7);
    expect(first.exa_mode).toBe("on");
    await patchAppSettings(store, { temperature: 1.9 });
    await store.migrate();
    expect((await loadAppSettings(store)).temperature).toBe(1.9);
  });
});
