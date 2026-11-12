// Decision record #175: an Administrator or Moderator reads and changes the
// personal settings of a user of a weaker role, through the rows
// `/api/me/settings` reads and writes.
import { describe, expect, test } from "bun:test";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import type { Role } from "./roles";
import { MemoryStore } from "./store";

const USERS: [id: string, role: Role][] = [
  ["admin-1", "free"], // Administrator through WEB_ADMIN_IDS, not the stored role
  ["mod-1", "moderator"],
  ["mod-2", "moderator"],
  ["premium-1", "premium"],
  ["free-1", "free"],
];

async function setup() {
  const env = loadTestEnv({ adminIds: ["admin-1"] });
  const store = new MemoryStore();
  await store.migrate();
  for (const [id, role] of USERS) {
    await store.upsertUser({ discord_id: id, username: id, avatar: null });
    await store.setUserRole(id, role);
    await store.putSession(`sess-${id}`, id, `tok-${id}`, Date.now() + 60_000);
  }
  const app = createApp(env, store, {
    guildAccess: async () => true,
    guildManage: async () => true,
    listGuilds: async () => [],
  });
  const call = (
    as: string | null,
    path: string,
    body?: Record<string, unknown>,
  ) =>
    app.handle(
      new Request(`http://127.0.0.1${path}`, {
        method: body ? "PATCH" : "GET",
        headers: {
          ...(as ? { cookie: `__Host-hibana_session=sess-${as}` } : {}),
          // Mutations are taken only from the dashboard (cross-site.test.ts).
          origin: "http://127.0.0.1:5173",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  return { app, store, env, call };
}

const settingsOf = (id: string) => `/api/users/${id}/settings`;

describe("another user's personal settings (#175)", () => {
  test("an Administrator reads and changes the row of a user below them", async () => {
    const { store, call } = await setup();
    await store.putUserOverride("free-1", {
      ...(await store.getUserOverride("free-1")),
      context: { text: "タメ口で", persona_override: false },
    });

    const read = await call("admin-1", settingsOf("free-1"));
    expect(read.status).toBe(200);
    const got = (await read.json()) as {
      user: { discord_id: string; username: string; role: string };
      settings: { context: { text: string } | null };
    };
    expect(got.user).toEqual({
      discord_id: "free-1",
      username: "free-1",
      role: "free",
    });
    expect(got.settings.context?.text).toBe("タメ口で");

    const write = await call("admin-1", settingsOf("free-1"), {
      preset: "sol",
      effort: "low",
    });
    expect(write.status).toBe(200);
    const row = await store.getUserOverride("free-1");
    expect(row.selection?.model).toBeTruthy();
    expect(row.effort).toBe("low");
    // The fields the patch did not name stay, and the actor's own row is not
    // the one that was written.
    expect(row.context?.text).toBe("タメ口で");
    expect((await store.getUserOverride("admin-1")).selection).toBeNull();
  });

  test("the change reaches the bot's snapshot under the target's ID", async () => {
    const { app, env, store, call } = await setup();
    const before = await store.version();
    expect(
      (await call("mod-1", settingsOf("free-1"), { jev_enabled: false }))
        .status,
    ).toBe(200);
    expect(await store.version()).toBeGreaterThan(before);
    const snap = await app.handle(
      new Request("http://127.0.0.1/internal/snapshot", {
        headers: { authorization: `Bearer ${env.internalToken}` },
      }),
    );
    expect(snap.status).toBe(200);
    const { user_overrides } = (await snap.json()) as {
      user_overrides: Record<string, { jev_enabled: boolean | null }>;
    };
    expect(user_overrides["free-1"]?.jev_enabled).toBe(false);
    expect(user_overrides["mod-1"]?.jev_enabled ?? null).toBeNull();
  });

  test("a Moderator reaches users below them, and neither an Administrator, another Moderator nor themselves", async () => {
    const { store, call } = await setup();
    for (const id of ["premium-1", "free-1"]) {
      expect((await call("mod-1", settingsOf(id))).status).toBe(200);
      expect(
        (await call("mod-1", settingsOf(id), { effort: "high" })).status,
      ).toBe(200);
    }
    for (const id of ["admin-1", "mod-2", "mod-1"]) {
      expect((await call("mod-1", settingsOf(id))).status).toBe(403);
      expect(
        (await call("mod-1", settingsOf(id), { effort: "high" })).status,
      ).toBe(403);
      expect((await store.getUserOverride(id)).effort).toBeNull();
    }
  });

  test("an Administrator does not reach their own row this way", async () => {
    const { call } = await setup();
    expect((await call("admin-1", settingsOf("admin-1"))).status).toBe(403);
    expect(
      (await call("admin-1", settingsOf("admin-1"), { effort: "high" })).status,
    ).toBe(403);
    // Their own row is `/api/me/settings`, as before.
    expect(
      (await call("admin-1", "/api/me/settings", { effort: "high" })).status,
    ).toBe(200);
  });

  test("Premium, Standard and Free users reach nobody's row, and no session is 401", async () => {
    const { store, call } = await setup();
    for (const actor of ["premium-1", "free-1"]) {
      for (const id of ["free-1", "premium-1", "mod-1", "nobody"]) {
        expect((await call(actor, settingsOf(id))).status).toBe(403);
        expect(
          (await call(actor, settingsOf(id), { effort: "high" })).status,
        ).toBe(403);
      }
    }
    expect((await call(null, settingsOf("free-1"))).status).toBe(401);
    expect(
      (await call(null, settingsOf("free-1"), { effort: "high" })).status,
    ).toBe(401);
    expect((await store.getUserOverride("free-1")).effort).toBeNull();
  });

  test("an ID that is not in the users list is 404 and gets no row", async () => {
    const { store, call } = await setup();
    expect((await call("admin-1", settingsOf("123456789"))).status).toBe(404);
    expect(
      (await call("admin-1", settingsOf("123456789"), { effort: "high" }))
        .status,
    ).toBe(404);
    expect(Object.keys(await store.allUserOverrides())).not.toContain(
      "123456789",
    );
  });

  test("a Premium preset is held to the target's role, not the actor's", async () => {
    const { store, call } = await setup();
    // `max-opus-5-5` has a Premium floor. The bot drops it from the row of a
    // user without the plan, so an Administrator storing it would do nothing.
    const refused = await call("admin-1", settingsOf("free-1"), {
      preset: "max-opus-5-5",
    });
    expect(refused.status).toBe(403);
    expect((await store.getUserOverride("free-1")).selection).toBeNull();

    const allowed = await call("admin-1", settingsOf("premium-1"), {
      preset: "max-opus-5-5",
    });
    expect(allowed.status).toBe(200);
    expect((await store.getUserOverride("premium-1")).selection).not.toBeNull();
  });

  test("an unpublished preset and an unknown field are refused as on /api/me/settings", async () => {
    const { store, call } = await setup();
    expect(
      (await call("admin-1", settingsOf("free-1"), { preset: "opus-5-1" }))
        .status,
    ).toBe(403);
    expect(
      (await call("admin-1", settingsOf("free-1"), { role: "premium" })).status,
    ).toBe(400);
    expect((await store.getUserOverride("free-1")).selection).toBeNull();
    expect((await store.getUser("free-1"))?.role).toBe("free");
  });

  test("the users list says which rows the session may open", async () => {
    const { call } = await setup();
    const open = async (actor: string) => {
      const res = await call(actor, "/api/users");
      const body = (await res.json()) as {
        users: { discord_id: string; can_edit_settings: boolean }[];
      };
      return body.users
        .filter((u) => u.can_edit_settings)
        .map((u) => u.discord_id)
        .sort();
    };
    expect(await open("admin-1")).toEqual([
      "free-1",
      "mod-1",
      "mod-2",
      "premium-1",
    ]);
    expect(await open("mod-1")).toEqual(["free-1", "premium-1"]);
  });
});
