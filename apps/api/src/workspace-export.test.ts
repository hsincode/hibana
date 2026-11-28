// Guild workspace export endpoints and permissions (decision record #193).
import { describe, expect, test } from "bun:test";
import { WORKSPACE_EXPORT_COOLDOWN_MS } from "@hibana/shared/exports";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";

const G1 = { id: "101", name: "One", icon: null };
const G2 = { id: "202", name: "Two", icon: null };

async function setup() {
  let clock = 1_780_000_000_000;
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

  const member = (token: string, id: string) =>
    (token === "tok-view-1" || token === "tok-mgr-1") &&
    (id === "101" || id === "202");
  const manages = (token: string, id: string) =>
    token === "tok-mgr-1" && id === "101";

  const app = createApp(env, store, {
    now: () => clock,
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

  const call = async (
    user: string | null,
    method: string,
    path: string,
    body?: unknown,
    internal = false,
  ) => {
    const headers = new Headers();
    if (internal) headers.set("authorization", `Bearer ${env.internalToken}`);
    if (user) headers.set("cookie", `__Host-hibana_session=sess-${user}`);
    headers.set("origin", "http://127.0.0.1:5173");
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await app.handle(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return {
      status: res.status,
      headers: res.headers,
      body: (await res.json()) as Record<string, unknown>,
    };
  };

  return {
    app,
    store,
    call,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("workspace export API (#193)", () => {
  test("enforces auth, guild access, and #166 manage permissions", async () => {
    const { call } = await setup();

    expect((await call(null, "GET", "/api/guilds/101/exports")).status).toBe(
      401,
    );
    expect(
      (await call(null, "POST", "/api/guilds/101/exports", {})).status,
    ).toBe(401);

    // Non-member (guild 999) gets 404.
    expect((await call("mgr-1", "GET", "/api/guilds/999/exports")).status).toBe(
      404,
    );
    expect(
      (await call("mgr-1", "POST", "/api/guilds/999/exports", {})).status,
    ).toBe(404);

    // Plain member can open and view, but cannot request export.
    const viewGet = await call("view-1", "GET", "/api/guilds/101/exports");
    expect(viewGet.status).toBe(200);
    expect(viewGet.body.can_edit).toBe(false);

    const viewPost = await call(
      "view-1",
      "POST",
      "/api/guilds/101/exports",
      {},
    );
    expect(viewPost.status).toBe(403);

    // Guild manager of 101 cannot export guild 202 where they are only a member.
    expect(
      (await call("mgr-1", "POST", "/api/guilds/202/exports", {})).status,
    ).toBe(403);

    // Moderator and Administrator can request on any guild.
    const modPost = await call("mod-1", "POST", "/api/guilds/202/exports", {
      include_settings: true,
    });
    expect(modPost.status).toBe(200);
    expect(modPost.body.ok).toBe(true);
  });

  test("enqueues command into snapshot, acks result, and hides download URL from non-managers", async () => {
    const { call } = await setup();

    const created = await call("mgr-1", "POST", "/api/guilds/101/exports", {
      include_settings: true,
    });
    expect(created.status).toBe(200);
    const cmd = created.body.command as {
      id: number;
      include_settings: boolean;
    };
    expect(cmd.include_settings).toBe(true);

    // Pending command appears in /internal/snapshot.
    const snap1 = await call(
      null,
      "GET",
      "/internal/snapshot",
      undefined,
      true,
    );
    expect(snap1.status).toBe(200);
    const pending = snap1.body.workspace_export_commands as {
      id: number;
      guild_id: string;
      include_settings: boolean;
    }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(cmd.id);
    expect(pending[0]?.guild_id).toBe("101");

    // Duplicate request while pending is rejected with 409.
    const dup = await call("mgr-1", "POST", "/api/guilds/101/exports", {});
    expect(dup.status).toBe(409);

    // Ack requires internal token.
    const badAuth = await call("mgr-1", "POST", "/internal/exports/ack", {
      id: cmd.id,
      result: { ok: false, error: "no" },
    });
    expect(badAuth.status).toBe(401);

    // Ack validates download URL scheme.
    const badUrl = await call(
      null,
      "POST",
      "/internal/exports/ack",
      {
        id: cmd.id,
        result: {
          ok: true,
          url: "javascript:alert(1)",
          filename: "hibana-workspace-101.tar.gz",
          bytes: 123,
          file_count: 2,
          expires_at_unix: 1_900_000_000,
          includes_settings: true,
        },
      },
      true,
    );
    expect(badUrl.status).toBe(400);

    // Valid ack completes the command and removes it from snapshot pending list.
    const ack = await call(
      null,
      "POST",
      "/internal/exports/ack",
      {
        id: cmd.id,
        result: {
          ok: true,
          url: "https://abcdef0123456789abcdef0123456789abcdef0123456789.example.com/hibana-workspace-101.tar.gz",
          filename: "hibana-workspace-101.tar.gz",
          bytes: 4096,
          file_count: 3,
          expires_at_unix: 1_900_000_000,
          includes_settings: true,
        },
      },
      true,
    );
    expect(ack.status).toBe(200);

    const snap2 = await call(
      null,
      "GET",
      "/internal/snapshot",
      undefined,
      true,
    );
    expect(snap2.body.workspace_export_commands).toEqual([]);

    // Manager sees download URL; plain member sees status without URL.
    const mgrList = await call("mgr-1", "GET", "/api/guilds/101/exports");
    const mgrExports = mgrList.body.exports as {
      result: { ok: boolean; url?: string; filename?: string };
    }[];
    expect(mgrExports[0]?.result.url).toContain("hibana-workspace-101.tar.gz");

    const viewList = await call("view-1", "GET", "/api/guilds/101/exports");
    const viewExports = viewList.body.exports as {
      result: { ok: boolean; url?: string; filename?: string };
    }[];
    expect(viewExports[0]?.result.ok).toBe(true);
    expect(viewExports[0]?.result.filename).toBe("hibana-workspace-101.tar.gz");
    expect(viewExports[0]?.result.url).toBeUndefined();
  });

  test("enforces per-guild cooldown after completion", async () => {
    const { call, advance } = await setup();

    const first = await call("mgr-1", "POST", "/api/guilds/101/exports", {});
    expect(first.status).toBe(200);
    const id = (first.body.command as { id: number }).id;

    await call(
      null,
      "POST",
      "/internal/exports/ack",
      { id, result: { ok: false, error: "empty" } },
      true,
    );

    // Immediately requesting again triggers 429 with retry-after.
    const tooSoon = await call("mgr-1", "POST", "/api/guilds/101/exports", {});
    expect(tooSoon.status).toBe(429);
    expect(Number(tooSoon.headers.get("retry-after"))).toBeGreaterThan(0);

    // After cooldown expires, a new request succeeds.
    advance(WORKSPACE_EXPORT_COOLDOWN_MS);
    const second = await call("mgr-1", "POST", "/api/guilds/101/exports", {
      include_settings: false,
    });
    expect(second.status).toBe(200);
  });

  test("rejects unknown fields in export request body", async () => {
    const { call } = await setup();
    const res = await call("mgr-1", "POST", "/api/guilds/101/exports", {
      include_settings: false,
      extra: true,
    });
    expect(res.status).toBe(400);
  });
});
