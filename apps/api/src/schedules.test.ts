import { describe, expect, test } from "bun:test";
import { parseStoredSchedules, type Schedule } from "@hibana/shared/schedules";
import { createApp, type AppHooks } from "./create-app";
import { canManageGuild } from "./discord";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";

const GUILD = "123456789012345678";
const OTHER = "223456789012345678";
const CHANNEL = "323456789012345678";

async function setup(hooks: AppHooks = {}) {
  const env = loadTestEnv({ adminIds: ["admin-1"] });
  const store = new MemoryStore();
  await store.migrate();
  for (const [id, role] of [
    ["admin-1", undefined],
    ["free-1", "free"],
  ] as const) {
    await store.upsertUser({ discord_id: id, username: id, avatar: null });
    if (role) await store.setUserRole(id, role);
  }
  await store.putSession(
    "sess-admin",
    "admin-1",
    "tok-admin",
    Date.now() + 6e4,
  );
  await store.putSession("sess-free", "free-1", "tok-free", Date.now() + 6e4);
  const app = createApp(env, store, {
    guildAccess: async () => true,
    listGuilds: async () => [{ id: GUILD, name: "One", icon: null }],
    listBotGuilds: async () => [{ id: GUILD, name: "One", icon: null }],
    guildManage: async (token) => token === "tok-manager",
    now: () => 1_700_000_000_000,
    ...hooks,
  });
  return { app, store, env };
}

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie)
    headers.set("cookie", `__Host-hibana_session=${init.cookie}`);
  if (!headers.has("origin")) headers.set("origin", "http://127.0.0.1:5173");
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

const nightly = (over: Partial<Schedule> = {}): Schedule => ({
  id: "a1",
  name: "2時",
  enabled: true,
  time: "02:00",
  time_zone: "Asia/Tokyo",
  actions: [
    { type: "post", channel_id: CHANNEL, text: "", file: "ema.png" },
    { type: "voice_clip", audio: "ema.wav" },
  ],
  ...over,
});

const put = (body: unknown, cookie = "sess-free") =>
  req(`/api/guilds/${GUILD}/schedules`, {
    method: "PUT",
    cookie,
    body: JSON.stringify(body),
  });

async function asManager(store: MemoryStore) {
  await store.upsertUser({
    discord_id: "manager-1",
    username: "manager",
    avatar: null,
  });
  await store.setUserRole("manager-1", "free");
  await store.putSession(
    "sess-manager",
    "manager-1",
    "tok-manager",
    Date.now() + 6e4,
  );
}

describe("scheduled actions API", () => {
  test("a member without Manage Server reads the list but cannot save it", async () => {
    const { app } = await setup();
    const got = await app.handle(
      req(`/api/guilds/${GUILD}/schedules`, { cookie: "sess-free" }),
    );
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      schedules: [],
      assets: [],
      assets_reported_at: null,
      can_edit: false,
    });
    const saved = await app.handle(put({ schedules: [nightly()] }));
    expect(saved.status).toBe(403);
  });

  test("Manage Server saves the list, and the bot's snapshot carries it", async () => {
    const { app, store, env } = await setup();
    await asManager(store);
    const before = await store.version();
    const saved = await app.handle(
      put({ schedules: [nightly()] }, "sess-manager"),
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).schedules).toEqual([nightly()]);
    expect(await store.version()).toBeGreaterThan(before);

    const got = await app.handle(
      req(`/api/guilds/${GUILD}/schedules`, { cookie: "sess-manager" }),
    );
    expect(await got.json()).toMatchObject({
      schedules: [nightly()],
      can_edit: true,
    });

    const snapshot = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: `Bearer ${env.internalToken}` },
      }),
    );
    expect((await snapshot.json()).schedules).toEqual({ [GUILD]: [nightly()] });

    // An empty list removes the server from the snapshot.
    expect(
      (await app.handle(put({ schedules: [] }, "sess-manager"))).status,
    ).toBe(200);
    const after = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: `Bearer ${env.internalToken}` },
      }),
    );
    expect((await after.json()).schedules).toEqual({});
  });

  test("a post may attach a video", async () => {
    const { app, store } = await setup();
    await asManager(store);
    const video = nightly({
      actions: [
        { type: "post", channel_id: CHANNEL, text: "", file: "ema.mp4" },
      ],
    });
    const saved = await app.handle(put({ schedules: [video] }, "sess-manager"));
    expect(saved.status).toBe(200);
  });

  test("an Administrator of the dashboard may edit any server the bot is in", async () => {
    const { app } = await setup();
    const saved = await app.handle(
      put({ schedules: [nightly()] }, "sess-admin"),
    );
    expect(saved.status).toBe(200);
  });

  test("a server the user cannot open answers 404", async () => {
    const { app, store } = await setup({ guildAccess: async () => false });
    await asManager(store);
    const got = await app.handle(
      req(`/api/guilds/${GUILD}/schedules`, { cookie: "sess-manager" }),
    );
    expect(got.status).toBe(404);
    expect(
      (await app.handle(put({ schedules: [nightly()] }, "sess-manager")))
        .status,
    ).toBe(404);
  });

  test.each([
    ["a time past 23:59", [nightly({ time: "24:00" })]],
    ["a time without a leading zero", [nightly({ time: "2:00" })]],
    ["an unknown time zone", [nightly({ time_zone: "Mars/Olympus" })]],
    [
      "an attachment that is neither an image nor a video",
      [
        nightly({
          actions: [
            { type: "post", channel_id: CHANNEL, text: "", file: "ema.wav" },
          ],
        }),
      ],
    ],
    [
      "a clip that is not an audio file",
      [nightly({ actions: [{ type: "voice_clip", audio: "ema.png" }] })],
    ],
    [
      "a post with neither text nor an image",
      [
        nightly({
          actions: [
            { type: "post", channel_id: CHANNEL, text: " ", file: null },
          ],
        }),
      ],
    ],
    [
      "a file name that leaves the asset directory",
      [nightly({ actions: [{ type: "voice_clip", audio: "../ema.wav" }] })],
    ],
    ["no actions", [nightly({ actions: [] })]],
    ["the same id twice", [nightly(), nightly()]],
    [
      "more than ten",
      Array.from({ length: 11 }, (_, i) => nightly({ id: `a${i}` })),
    ],
    ["a field the schema does not know", [{ ...nightly(), cron: "* * * * *" }]],
  ])("refuses %s", async (_, schedules) => {
    const { app, store } = await setup();
    await asManager(store);
    const res = await app.handle(put({ schedules }, "sess-manager"));
    expect(res.status).toBe(400);
    expect(await store.getSchedules(GUILD)).toEqual([]);
  });

  test("the bot's asset report reaches the dashboard, one server at a time", async () => {
    const { app, env } = await setup();
    const report = (body: unknown, auth = `Bearer ${env.internalToken}`) =>
      app.handle(
        req("/internal/schedule-assets", {
          method: "PUT",
          headers: { authorization: auth },
          body: JSON.stringify(body),
        }),
      );
    const assets = {
      [GUILD]: [
        { name: "ema.png", kind: "image", size: 1000 },
        { name: "ema.wav", kind: "audio", size: 782020 },
      ],
      [OTHER]: [{ name: "secret.png", kind: "image", size: 1 }],
    };
    expect((await report({ guilds: assets }, "Bearer wrong")).status).toBe(401);
    expect(
      (
        await report({
          guilds: { [GUILD]: [{ name: "../x.png", kind: "image", size: 1 }] },
        })
      ).status,
    ).toBe(400);
    expect((await report({ guilds: assets })).status).toBe(200);
    const got = await app.handle(
      req(`/api/guilds/${GUILD}/schedules`, { cookie: "sess-free" }),
    );
    expect(await got.json()).toMatchObject({
      assets: assets[GUILD],
      assets_reported_at: 1_700_000_000_000,
    });
  });

  test("lists the server's text channels", async () => {
    const channels = [{ id: CHANNEL, name: "general", category: null }];
    const { app } = await setup({ listChannels: async () => channels });
    const res = await app.handle(
      req(`/api/guilds/${GUILD}/channels`, { cookie: "sess-free" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ channels });

    const failing = await setup({
      listChannels: async () => {
        throw new Error("discord down");
      },
    });
    const bad = await failing.app.handle(
      req(`/api/guilds/${GUILD}/channels`, { cookie: "sess-free" }),
    );
    expect(bad.status).toBe(502);
  });
});

describe("canManageGuild", () => {
  test.each([
    [{ owner: true, permissions: "0" }, true],
    [{ permissions: "32" }, true], // Manage Server
    [{ permissions: "8" }, true], // Administrator
    [{ permissions: String((1n << 40n) | 32n) }, true],
    [{ permissions: "2048" }, false], // Send Messages only
    [{ permissions: "not a number" }, false],
    [{}, false],
  ])("%j → %p", (extra, expected) => {
    expect(
      canManageGuild({ id: GUILD, name: "One", icon: null, ...extra }),
    ).toBe(expected);
  });
});

describe("parseStoredSchedules", () => {
  test("drops rows that no longer parse and keeps the rest", () => {
    expect(
      parseStoredSchedules([
        nightly(),
        { ...nightly({ id: "b" }), time: "25:00" },
      ]),
    ).toEqual([nightly()]);
    expect(parseStoredSchedules(null)).toEqual([]);
  });
});
