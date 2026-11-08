// Who may change a server's settings (decision record #166): members may
// open and look; only those who manage the server change it — Discord's
// Manage Server or Administrator there, its owner, or a hibana Administrator /
// Moderator. Stopping the bot for a server stays a moderation power (#64).
import { describe, expect, test } from "bun:test";
import { createApp } from "./create-app";
import { canManageGuild } from "./discord";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";

const G1 = { id: "101", name: "One", icon: null };
const G2 = { id: "202", name: "Two", icon: null };

async function setup() {
  const env = loadTestEnv({ adminIds: ["admin-1"] });
  const store = new MemoryStore();
  await store.migrate();
  const users = [
    ["admin-1", "administrator"],
    ["mod-1", "moderator"],
    ["view-1", "premium"],
    ["mgr-1", "free"],
  ] as const;
  for (const [id, role] of users) {
    await store.upsertUser({ discord_id: id, username: id, avatar: null });
    if (id !== "admin-1") await store.setUserRole(id, role);
    await store.putSession(`sess-${id}`, id, `tok-${id}`, Date.now() + 60_000);
  }
  // view-1 is in both servers without permissions; mgr-1 manages 101 only and
  // is a plain member of 202. Staff are members of neither.
  const member = (token: string, id: string) =>
    (token === "tok-view-1" || token === "tok-mgr-1") &&
    (id === "101" || id === "202");
  const manages = (token: string, id: string) =>
    token === "tok-mgr-1" && id === "101";
  const app = createApp(env, store, {
    guildAccess: async (token, id) => member(token, id),
    guildManage: async (token, id) => manages(token, id),
    listGuilds: async (token) =>
      [G1, G2]
        .filter((g) => member(token, g.id))
        .map((g) => ({
          ...g,
          permissions: manages(token, g.id) ? "32" : "0",
        })),
    listBotGuilds: async () => [G1, G2],
  });
  await app.handle(
    req("/internal/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${env.internalToken}` },
      body: JSON.stringify({
        sites: [
          {
            token: "deadbeef",
            guild_id: "101",
            channel_id: "c1",
            url: "https://artifacts.example/s/deadbeef/",
            source_path: "site",
            created_at_unix: 1_700_000_000,
            expires_at_unix: 1_800_000_000,
            retention: "ttl",
            bytes: 12,
            file_count: 1,
          },
        ],
      }),
    }),
  );
  await store.replaceSkills([
    {
      guild_id: "202",
      name: "shared-skill",
      description: "Shared",
      builtin: false,
      enabled: true,
      files: {
        "SKILL.md": Buffer.from(
          "---\nname: shared-skill\ndescription: Shared\n---\nBody",
        ).toString("base64"),
      },
    },
  ]);
  const call = async (
    user: string,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const res = await app.handle(
      req(path, {
        method,
        cookie: `sess-${user}`,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: res.status, body: (await res.json()) as Json };
  };
  return { app, store, call };
}

type Json = Record<string, unknown>;

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie)
    headers.set("cookie", `__Host-hibana_session=${init.cookie}`);
  if (!headers.has("origin")) headers.set("origin", "http://127.0.0.1:5173");
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

describe("a member who does not manage the server", () => {
  test("opens every page and is told it may only look", async () => {
    const { call } = await setup();
    for (const path of [
      "/api/guilds/101/settings",
      "/api/guilds/101/skills",
      "/api/guilds/101/artifacts",
    ]) {
      const res = await call("view-1", "GET", path);
      expect(res.status).toBe(200);
      expect(res.body.can_edit).toBe(false);
    }
  });

  test("cannot change settings, skills or sites, and nothing is saved", async () => {
    const { call, store } = await setup();
    const settings = await call("view-1", "PATCH", "/api/guilds/101/settings", {
      thread_only: true,
    });
    expect(settings).toEqual({
      status: 403,
      body: { error: "Manage Server permission required" },
    });
    expect((await store.getGuild("101")).thread_only).toBe(false);

    const skill = await call("view-1", "POST", "/api/guilds/101/skills", {
      action: "enabled",
      name: "shared-skill",
      enabled: false,
    });
    expect(skill.status).toBe(403);
    const pin = await call(
      "view-1",
      "PATCH",
      "/api/guilds/101/artifacts/deadbeef",
      { action: "permanent" },
    );
    expect(pin.status).toBe(403);
    expect(await store.listSkillCommands()).toEqual([]);
    expect(await store.listArtifactCommands()).toEqual([]);
  });

  test("still gets 404 for a server it cannot open", async () => {
    const { call } = await setup();
    const res = await call("view-1", "PATCH", "/api/guilds/909/settings", {
      thread_only: true,
    });
    expect(res.status).toBe(404);
  });
});

describe("those who manage the server", () => {
  test("Manage Server on Discord: edits that server, and only looks at the other", async () => {
    const { call, store } = await setup();
    const got = await call("mgr-1", "GET", "/api/guilds/101/settings");
    expect(got.body.can_edit).toBe(true);
    const saved = await call("mgr-1", "PATCH", "/api/guilds/101/settings", {
      thread_only: true,
    });
    expect(saved.status).toBe(200);
    expect((await store.getGuild("101")).thread_only).toBe(true);
    const pin = await call(
      "mgr-1",
      "PATCH",
      "/api/guilds/101/artifacts/deadbeef",
      { action: "permanent" },
    );
    expect(pin.status).toBe(200);

    expect(
      (await call("mgr-1", "GET", "/api/guilds/202/settings")).body.can_edit,
    ).toBe(false);
    expect(
      (
        await call("mgr-1", "PATCH", "/api/guilds/202/settings", {
          thread_only: true,
        })
      ).status,
    ).toBe(403);
  });

  test("an import needs the destination managed; the source only has to open", async () => {
    const { call, store } = await setup();
    const imported = await call("mgr-1", "POST", "/api/guilds/101/skills", {
      action: "import",
      name: "shared-skill",
      source_guild_id: "202",
    });
    expect(imported.status).toBe(200);
    expect((await store.listSkillCommands()).map((c) => c.guild_id)).toEqual([
      "101",
    ]);
  });

  test("Administrators and Moderators edit any server the bot is in", async () => {
    const { call, store } = await setup();
    for (const user of ["admin-1", "mod-1"]) {
      const got = await call(user, "GET", "/api/guilds/202/settings");
      expect(got.body.can_edit).toBe(true);
      const saved = await call(user, "PATCH", "/api/guilds/202/settings", {
        thread_only: user === "admin-1",
      });
      expect(saved.status).toBe(200);
    }
    expect((await store.getGuild("202")).thread_only).toBe(false);
  });
});

describe("stopping the bot for a server (#64)", () => {
  test("only a Moderator or an Administrator, and a refused request saves nothing", async () => {
    const { call, store } = await setup();
    const refused = await call("mgr-1", "PATCH", "/api/guilds/101/settings", {
      bot_disabled: true,
      thread_only: true,
    });
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toMatch(/moderator/i);
    const row = await store.getGuild("101");
    expect([row.bot_disabled, row.thread_only]).toEqual([false, false]);

    for (const user of ["mod-1", "admin-1"]) {
      const stopped = await call(user, "PATCH", "/api/guilds/101/settings", {
        bot_disabled: true,
      });
      expect(stopped.status).toBe(200);
      expect((await store.getGuild("101")).bot_disabled).toBe(true);
      // Resuming is the same power.
      expect(
        (
          await call("mgr-1", "PATCH", "/api/guilds/101/settings", {
            bot_disabled: false,
          })
        ).status,
      ).toBe(403);
      await call(user, "PATCH", "/api/guilds/101/settings", {
        bot_disabled: false,
      });
      expect((await store.getGuild("101")).bot_disabled).toBe(false);
    }
  });
});

test("the server list says which servers the user manages", async () => {
  const { call } = await setup();
  const list = async (user: string) =>
    Object.fromEntries(
      ((await call(user, "GET", "/api/guilds")).body.guilds as Json[]).map(
        (g) => [g.id, g.can_manage],
      ),
    );
  expect(await list("view-1")).toEqual({ 101: false, 202: false });
  expect(await list("mgr-1")).toEqual({ 101: true, 202: false });
  expect(await list("mod-1")).toEqual({ 101: true, 202: true });
});

test("canManageGuild reads the owner flag and the Manage Server or Administrator bit", () => {
  const g = (extra: Json) => ({ ...G1, ...extra });
  expect(canManageGuild(g({ owner: true, permissions: "0" }))).toBe(true);
  expect(canManageGuild(g({ permissions: String(0x20) }))).toBe(true);
  expect(canManageGuild(g({ permissions: String(0x8) }))).toBe(true);
  // Every other bit, as Discord sends it: a decimal string past 2^53.
  const others = (1n << 60n) - 1n - 0x20n - 0x8n;
  expect(canManageGuild(g({ permissions: others.toString() }))).toBe(false);
  expect(canManageGuild(g({ permissions: "not a number" }))).toBe(false);
  expect(canManageGuild(G1)).toBe(false);
});
