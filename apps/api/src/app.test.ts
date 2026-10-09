import { describe, expect, test } from "bun:test";
import { createApp } from "./create-app";
import { loadTestEnv, type WebEnv } from "./env";
import { applyUserOverridePatch, emptyUserOverride, guildPatchSchema, userOverridePatchSchema } from "./settings";
import { installPersonalDefaults, MemoryStore } from "./store";

async function setup(envOverrides: Partial<WebEnv> = {}) {
  const env = loadTestEnv({ adminIds: ["admin-1"], ...envOverrides });
  const store = new MemoryStore();
  await store.migrate();
  await store.upsertUser({
    discord_id: "admin-1",
    username: "admin",
    avatar: null,
  });
  await store.upsertUser({
    discord_id: "mod-1",
    username: "mod",
    avatar: null,
  });
  await store.upsertUser({
    discord_id: "free-1",
    username: "free",
    avatar: null,
  });
  await store.setUserRole("mod-1", "moderator");
  await store.setUserRole("free-1", "free");
  await store.putSession(
    "sess-admin",
    "admin-1",
    "tok-admin",
    Date.now() + 60_000,
  );
  await store.putSession("sess-mod", "mod-1", "tok-mod", Date.now() + 60_000);
  await store.putSession(
    "sess-free",
    "free-1",
    "tok-free",
    Date.now() + 60_000,
  );
  const app = createApp(env, store, {
    guildAccess: async () => true,
    listGuilds: async () => [{ id: "g1", name: "One", icon: null }],
  });
  return { app, store, env };
}

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", `hibana_session=${init.cookie}`);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

describe("version", () => {
  test("reports the commit the deployment was built from", async () => {
    const commit = "c".repeat(40);
    const { app } = await setup({ commit });
    const res = await app.handle(req("/version"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commit });
  });

  test("reports null outside a deploy", async () => {
    const { app } = await setup();
    expect(await (await app.handle(req("/version"))).json()).toEqual({ commit: null });
  });
});

describe("authz", () => {
  test("guild MCP settings survive PATCH and snapshot, reset independently, and require auth", async () => {
    const { app } = await setup();
    const body = JSON.stringify({
      mcp_enabled: false,
      mcp_url: "https://example.com/mcp",
    });
    const denied = await app.handle(
      req("/api/guilds/g1/settings", { method: "PATCH", body }),
    );
    expect(denied.status).toBe(401);
    const saved = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body,
      }),
    );
    expect(saved.status).toBe(200);
    const snapshot = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    const data = (await snapshot.json()) as {
      guilds: Record<string, { mcp_enabled: boolean; mcp_url: string }>;
    };
    expect(data.guilds.g1.mcp_enabled).toBe(false);
    expect(data.guilds.g1.mcp_url).toBe("https://example.com/mcp");
    const reset = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ mcp_url: null }),
      }),
    );
    const restored = (await reset.json()) as {
      settings: { mcp_url: string | null; mcp_enabled: boolean };
    };
    expect(restored.settings.mcp_url).toEqual("https://ww.hsincode.com/api/mcp");
    expect(restored.settings.mcp_enabled).toBe(false);
    for (const mcp_url of [
      "invalid",
      "http://example.com/mcp",
      "https://user:secret@example.com/mcp",
      "https://example.com/mcp?token=secret",
      "https://localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://[::1]/mcp",
    ]) {
      expect(guildPatchSchema.safeParse({ mcp_url }).success).toBe(false);
    }
  });
  test("oauth start redirects to discord with PKCE", async () => {
    const { app } = await setup();
    const res = await app.handle(req("/auth/discord"));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe(
      "https://discord.com/api/oauth2/authorize",
    );
    expect(loc.searchParams.get("client_id")).toBe("cid");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/auth/discord/callback",
    );
    expect(loc.searchParams.get("scope")).toBe("identify guilds");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(
      (loc.searchParams.get("code_challenge") ?? "").length,
    ).toBeGreaterThan(20);
  });

  test("catalog omits grok free presets", async () => {
    const { app } = await setup();
    const res = await app.handle(req("/api/catalog"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { presets: { id: string }[] };
    const ids = body.presets.map((p) => p.id);
    expect(ids).not.toContain("grok-4.5");
    expect(ids).not.toContain("grok-4.6");
    expect(ids).toContain("grok-4.5-heavy");
    expect(ids).toContain("grok-4.6-heavy");
    // Codex Pro is a separate account from Codex Plus, so both pairs ship.
    expect(ids).toContain("sol");
    expect(ids).toContain("plus-luna");
    expect(ids).toContain("pro-sol");
    expect(ids).toContain("pro-luna");
    expect(ids).not.toContain("sale-sol");
    expect(ids).not.toContain("sale-terra");
    expect(ids).not.toContain("go-spark");
    expect(ids).not.toContain("go-spark-1.3");
    expect(ids).not.toContain("deepseek-flash");
    expect(ids).toContain("ds-deepseek-flash");
    expect(ids).not.toContain("go-luna");
    expect(ids).not.toContain("go-ox-alpha");
    expect(ids).not.toContain("or-ox-alpha");
    expect(ids).not.toContain("go-v4-flash");
    expect(ids).not.toContain("ds-v4-flash");
    expect(ids).not.toContain("ds-v4-pro");
    expect(ids).not.toContain("ds-v4.1-flash");
    expect(ids).toContain("fable-5");
    const fable = (body.presets as { id: string; min_role?: string }[]).find(
      (p) => p.id === "fable-5",
    );
    expect(fable?.min_role).toBe("premium");
    const catalogById = Object.fromEntries(
      (body.presets as { id: string; model?: string; min_role?: string }[]).map((p) => [p.id, p]),
    );
    expect(catalogById["fable-5"]?.model).toBe("claude-fable-5-1");
    expect(catalogById["max-opus-5-5"]?.model).toBe("claude-opus-5-5");
    expect(catalogById["max-opus-5-5"]?.min_role).toBe("premium");
    expect(catalogById["sol"]?.model).toBe("gpt-6.1-sol");
    expect(catalogById["plus-luna"]?.model).toBe("gpt-6-luna");
    expect(catalogById["pro-sol"]?.model).toBe("gpt-6.1-sol");
    expect(catalogById["pro-luna"]?.model).toBe("gpt-6-luna");
    expect(ids).not.toContain("plus-6-sol");
    expect(ids).not.toContain("pro-6-luna");
    expect((body as { triggers?: string[] }).triggers).toEqual([
      "hibana",
      "ひばな",
      "ヒバナ",
      "火花",
      "deepseek",
      "ds",
      "ディープシーク",
      "くじら",
      "クジラ",
      "鯨",
    ]);
  });

  test("catalog hides unpublished presets from non-staff", async () => {
    const { app } = await setup();
    const free = await app.handle(req("/api/catalog", { cookie: "sess-free" }));
    expect(free.status).toBe(200);
    const freeIds = (
      (await free.json()) as { presets: { id: string }[] }
    ).presets.map((p) => p.id);
    expect(freeIds).not.toContain("opus-5-1");
    expect(freeIds).not.toContain("opus-5-5");
    expect(freeIds).not.toContain("grok-4.7-heavy");
    expect(freeIds).not.toContain("gemini-3.8-flash");
    expect(freeIds).not.toContain("gemini-4-pro");
    expect(freeIds).not.toContain("gemini-4-flash");
    expect(freeIds).not.toContain("plus-astra");
    expect(freeIds).not.toContain("plus-6-sol");
    expect(freeIds).not.toContain("plus-6-luna");
    expect(freeIds).not.toContain("pro-astra");
    expect(freeIds).not.toContain("pro-6-sol");
    expect(freeIds).not.toContain("pro-6-luna");
    expect(freeIds).toContain("opus-5");
    expect(freeIds).toContain("sonnet-5");
    expect(freeIds).toContain("grok-4.6-heavy");
    expect(freeIds).toContain("gemini-3.7-flash");

    const admin = await app.handle(
      req("/api/catalog", { cookie: "sess-admin" }),
    );
    expect(admin.status).toBe(200);
    const adminPresets = (await admin.json()) as {
      presets: { id: string; model?: string; published?: boolean }[];
    };
    const byId = Object.fromEntries(adminPresets.presets.map((p) => [p.id, p]));
    expect(byId["opus-5-1"]?.published).toBe(false);
    expect(byId["opus-5-5"]?.published).toBe(false);
    expect(byId["sonnet-5-5"]?.published).toBe(false);
    expect(byId["sonnet-5-5"]?.model).toBe("claude-sonnet-5-5");
    expect(byId["grok-4.7-heavy"]?.published).toBe(false);
    expect(byId["gemini-3.8-flash"]?.published).toBe(false);
    expect(byId["gemini-4-pro"]?.published).toBe(false);
    expect(byId["gemini-4-flash"]?.published).toBe(false);
    expect(byId["plus-astra"]?.published).toBe(false);
    expect(byId["pro-astra"]?.published).toBe(false);
    expect(byId["sol"]?.model).toBe("gpt-6.1-sol");
    expect(byId["plus-luna"]?.model).toBe("gpt-6-luna");
    expect(byId["plus-luna"]?.published).toBe(true);
    expect(byId["opus-5"]?.published).toBe(true);
    expect(byId["sonnet-5"]?.published).toBe(true);
  });

  test("admin can publish an unpublished preset; free cannot", async () => {
    const { app } = await setup();
    const denied = await app.handle(
      req("/api/catalog/presets/opus-5-1", {
        cookie: "sess-free",
        method: "PATCH",
        body: JSON.stringify({ published: true }),
      }),
    );
    expect(denied.status).toBe(403);

    const published = await app.handle(
      req("/api/catalog/presets/opus-5-1", {
        cookie: "sess-mod",
        method: "PATCH",
        body: JSON.stringify({ published: true }),
      }),
    );
    expect(published.status).toBe(200);
    expect(((await published.json()) as { published: boolean }).published).toBe(
      true,
    );

    const free = await app.handle(req("/api/catalog", { cookie: "sess-free" }));
    const ids = (
      (await free.json()) as { presets: { id: string }[] }
    ).presets.map((p) => p.id);
    expect(ids).toContain("opus-5-1");
    expect(ids).not.toContain("grok-4.7-heavy");

    const snap = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    expect(snap.status).toBe(200);
    const body = (await snap.json()) as { unpublished_presets: string[] };
    expect(body.unpublished_presets).not.toContain("opus-5-1");
    expect(body.unpublished_presets).toContain("grok-4.7-heavy");
    expect(body.unpublished_presets).toContain("gemini-3.8-flash");
    expect(body.unpublished_presets).toContain("opus-5-5");
    expect(body.unpublished_presets).toContain("sonnet-5-5");
    expect(body.unpublished_presets).toContain("gemini-4-pro");
    expect(body.unpublished_presets).toContain("gemini-4-flash");
    expect(body.unpublished_presets).toContain("plus-astra");
    expect(body.unpublished_presets).toContain("pro-astra");
    expect(body.unpublished_presets).not.toContain("sol");
    expect(body.unpublished_presets).not.toContain("plus-luna");
    expect(body.unpublished_presets).not.toContain("max-opus-5-5");
  });

  test("unpublished preset cannot be selected until published", async () => {
    const { app } = await setup();
    await app
      .handle(
        req("/api/guilds/g1/settings", {
          cookie: "sess-admin",
          method: "PATCH",
          body: JSON.stringify({ preset: "opus-5-1" }),
        }),
      )
      .then(async (res) => {
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toContain(
          "unpublished",
        );
      });

    await app.handle(
      req("/api/catalog/presets/opus-5-1", {
        cookie: "sess-admin",
        method: "PATCH",
        body: JSON.stringify({ published: true }),
      }),
    );
    const ok = await app.handle(
      req("/api/guilds/g1/settings", {
        cookie: "sess-admin",
        method: "PATCH",
        body: JSON.stringify({ preset: "opus-5-1" }),
      }),
    );
    expect(ok.status).toBe(200);
  });

  test("admin can mark a public preset premium; free cannot", async () => {
    const { app } = await setup();
    const snap0 = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    expect(
      ((await snap0.json()) as { premium_presets: string[] }).premium_presets,
    ).toEqual([
      "fable-5", "max-opus-5-5",
      "anthropic-auto", "anthropic-haiku-5-5", "anthropic-sonnet-5-5", "anthropic-opus-5-5",
    ]);

    const denied = await app.handle(
      req("/api/catalog/presets/opus-5", {
        cookie: "sess-free",
        method: "PATCH",
        body: JSON.stringify({ premium: true }),
      }),
    );
    expect(denied.status).toBe(403);

    const marked = await app.handle(
      req("/api/catalog/presets/opus-5", {
        cookie: "sess-mod",
        method: "PATCH",
        body: JSON.stringify({ premium: true }),
      }),
    );
    expect(marked.status).toBe(200);
    const markedBody = (await marked.json()) as {
      min_role: string | null;
      premium_presets: string[];
    };
    expect(markedBody.min_role).toBe("premium");
    expect(markedBody.premium_presets).toContain("opus-5");
    expect(markedBody.premium_presets).toContain("fable-5");

    const catalog = await app.handle(
      req("/api/catalog", { cookie: "sess-free" }),
    );
    const byId = Object.fromEntries(
      (
        (await catalog.json()) as {
          presets: { id: string; min_role?: string }[];
        }
      ).presets.map((p) => [p.id, p]),
    );
    expect(byId["opus-5"]?.min_role).toBe("premium");
    expect(byId["fable-5"]?.min_role).toBe("premium");
    expect(byId["sol"]?.min_role).toBeUndefined();

    const snap = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    const snapBody = (await snap.json()) as { premium_presets: string[] };
    expect(snapBody.premium_presets).toContain("opus-5");
    expect(snapBody.premium_presets).toContain("fable-5");

    const blocked = await app.handle(
      req("/api/guilds/g1/settings", {
        cookie: "sess-free",
        method: "PATCH",
        body: JSON.stringify({ preset: "opus-5" }),
      }),
    );
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toContain(
      "Premium",
    );
  });

  test("admin can clear fable-5 premium floor", async () => {
    const { app } = await setup();
    const cleared = await app.handle(
      req("/api/catalog/presets/fable-5", {
        cookie: "sess-admin",
        method: "PATCH",
        body: JSON.stringify({ premium: false }),
      }),
    );
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { min_role: string | null }).min_role,
    ).toBeNull();

    const ok = await app.handle(
      req("/api/guilds/g1/settings", {
        cookie: "sess-free",
        method: "PATCH",
        body: JSON.stringify({ preset: "fable-5" }),
      }),
    );
    expect(ok.status).toBe(200);

    const catalog = await app.handle(
      req("/api/catalog", { cookie: "sess-free" }),
    );
    const fable = (
      (await catalog.json()) as { presets: { id: string; min_role?: string }[] }
    ).presets.find((p) => p.id === "fable-5");
    expect(fable?.min_role).toBeUndefined();
  });

  test("adminIds overlay stored free as administrator; others stay free", async () => {
    const { app } = await setup();
    const admin = await app.handle(req("/api/me", { cookie: "sess-admin" }));
    expect(admin.status).toBe(200);
    expect(((await admin.json()) as { role: string }).role).toBe(
      "administrator",
    );
    const free = await app.handle(req("/api/me", { cookie: "sess-free" }));
    expect(free.status).toBe(200);
    expect(((await free.json()) as { role: string }).role).toBe("free");
  });

  test("unauthenticated me is 401", async () => {
    const { app } = await setup();
    const res = await app.handle(req("/api/me"));
    expect(res.status).toBe(401);
  });

  test("free cannot list users", async () => {
    const { app } = await setup();
    const res = await app.handle(req("/api/users", { cookie: "sess-free" }));
    expect(res.status).toBe(403);
  });

  test("admin can promote free to premium", async () => {
    const { app } = await setup();
    const res = await app.handle(
      req("/api/users/free-1", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ role: "premium" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("premium");
  });

  test("moderator cannot grant administrator", async () => {
    const { app } = await setup();
    const res = await app.handle(
      req("/api/users/free-1", {
        method: "PATCH",
        cookie: "sess-mod",
        body: JSON.stringify({ role: "administrator" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("moderator cannot demote another moderator", async () => {
    const { app, store } = await setup();
    await store.upsertUser({
      discord_id: "mod-2",
      username: "mod2",
      avatar: null,
    });
    await store.setUserRole("mod-2", "moderator");
    const res = await app.handle(
      req("/api/users/mod-2", {
        method: "PATCH",
        cookie: "sess-mod",
        body: JSON.stringify({ role: "free" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("explicit administrator role on upsert overwrites stored free", async () => {
    const { store } = await setup();
    await store.upsertUser({
      discord_id: "free-1",
      username: "free",
      avatar: null,
      role: "administrator",
    });
    expect((await store.getUser("free-1"))?.role).toBe("administrator");
  });

  test("cannot patch self", async () => {
    const { app } = await setup();
    const res = await app.handle(
      req("/api/users/admin-1", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ role: "free" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("guild settings", () => {
  test("Jev modes persist independently for guilds and users and reach the bot snapshot", async () => {
    const { app, store } = await setup();
    for (const key of ["jev_enabled", "jev_task_enabled"] as const) {
      const other = key === "jev_enabled" ? "jev_task_enabled" : "jev_enabled";
      for (const value of [false, true, null]) {
        const guild = await app.handle(req("/api/guilds/g1/settings", {
          method: "PATCH", cookie: "sess-admin", body: JSON.stringify({ [key]: value }),
        }));
        expect(guild.status).toBe(200);
        expect((await store.getGuild("g1"))[key]).toBe(value ?? store.defaults[key]);
        expect((await store.getGuild("g1"))[other]).toBe(store.defaults[other]);
        expect((await store.getGuild("g2"))[key]).toBe(store.defaults[key]);
        const personal = await app.handle(req("/api/me/settings", {
          method: "PATCH", cookie: "sess-free", body: JSON.stringify({ [key]: value }),
        }));
        expect(personal.status).toBe(200);
        expect((await store.getUserOverride("free-1"))[key]).toBe(value);
        expect((await store.getUserOverride("free-1"))[other]).toBeNull();
        expect((await store.getUserOverride("admin-1"))[key]).toBeNull();
        const snapshot = await app.handle(req("/internal/snapshot", {
          headers: { Authorization: "Bearer test-internal" },
        }));
        expect(snapshot.status).toBe(200);
        const data = await snapshot.json();
        expect(data.guilds.g1[key]).toBe(value ?? store.defaults[key]);
        // null is デフォルト and does not copy the server's concrete value.
        expect(data.user_overrides["free-1"][key]).toBe(value);
      }
    }
    const rejected = await app.handle(req("/api/guilds/g1/settings", {
      method: "PATCH", body: JSON.stringify({ jev_task_enabled: true }),
    }));
    expect(rejected.status).toBe(401);
  });
  test("rejects unknown preset", () => {
    const r = guildPatchSchema.safeParse({ preset: "not-a-model" });
    expect(r.success).toBe(false);
  });

  test("stores a fixed subagent preset and accepts automatic selection", async () => {
    const { app, store } = await setup();
    const fixed = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ subagent_model: { mode: "fixed", preset: "sol" } }),
      }),
    );
    expect(fixed.status).toBe(200);
    expect((await store.getGuild("g1")).subagent_model).toEqual({ mode: "fixed", preset: "sol" });

    const automatic = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ subagent_model: null }),
      }),
    );
    expect(automatic.status).toBe(200);
    expect((await store.getGuild("g1")).subagent_model).toEqual({ mode: "auto" });
  });

  test("stores URL preview suppression per guild and supports default reset", async () => {
    const { app, store } = await setup();
    expect(guildPatchSchema.safeParse({ suppress_embeds: true }).success).toBe(
      true,
    );
    expect(guildPatchSchema.safeParse({ suppress_embeds: false }).success).toBe(
      true,
    );
    expect(guildPatchSchema.safeParse({ suppress_embeds: null }).success).toBe(
      true,
    );

    const on = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ suppress_embeds: true }),
      }),
    );
    expect(on.status).toBe(200);
    expect((await store.getGuild("g1")).suppress_embeds).toBe(true);

    const off = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ suppress_embeds: false }),
      }),
    );
    expect(off.status).toBe(200);
    expect((await store.getGuild("g1")).suppress_embeds).toBe(false);

    const reset = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ suppress_embeds: null }),
      }),
    );
    expect(reset.status).toBe(200);
    expect((await store.getGuild("g1")).suppress_embeds).toEqual(false);
  });

  test("rejects grok free presets", () => {
    expect(guildPatchSchema.safeParse({ preset: "grok-4.5" }).success).toBe(
      false,
    );
    expect(guildPatchSchema.safeParse({ preset: "grok-4.6" }).success).toBe(
      false,
    );
    expect(
      guildPatchSchema.safeParse({ preset: "grok-4.6-heavy" }).success,
    ).toBe(true);
    expect(guildPatchSchema.safeParse({ preset: "fable-5" }).success).toBe(
      true,
    );
  });

  test("fable-5 is premium or stronger", async () => {
    const { app, store } = await setup();
    await store.upsertUser({
      discord_id: "prem-1",
      username: "prem",
      avatar: null,
    });
    await store.setUserRole("prem-1", "premium");
    await store.putSession(
      "sess-prem",
      "prem-1",
      "tok-prem",
      Date.now() + 60_000,
    );

    const denied = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ preset: "fable-5" }),
      }),
    );
    expect(denied.status).toBe(403);

    const okPrem = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-prem",
        body: JSON.stringify({ preset: "fable-5" }),
      }),
    );
    expect(okPrem.status).toBe(200);

    const okAdmin = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ preset: "opus-5" }),
      }),
    );
    expect(okAdmin.status).toBe(200);
  });

  test("trigger words persist including disabled builtins", async () => {
    const { app, store } = await setup();
    const res = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({
          extra_triggers: ["猫", "DS"],
          disabled_triggers: ["くじら", "ds"],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const row = await store.getGuild("g1");
    // `DS` is a builtin, so it re-enables `ds` instead of living in extras.
    expect(row.extra_triggers).toEqual(["猫"]);
    expect(row.disabled_triggers).toEqual(["くじら"]);

    const disableOnly = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ disabled_triggers: ["DS"] }),
      }),
    );
    expect(disableOnly.status).toBe(200);
    const after = await store.getGuild("g1");
    expect(after.extra_triggers).toEqual(["猫"]);
    expect(after.disabled_triggers).toEqual(["ds"]);

    const reset = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ extra_triggers: null, disabled_triggers: [] }),
      }),
    );
    expect(reset.status).toBe(200);
    const cleared = await store.getGuild("g1");
    expect(cleared.extra_triggers).toEqual([]);
    expect(cleared.disabled_triggers).toEqual([]);

    const bad = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-admin",
        body: JSON.stringify({ extra_triggers: ["has,comma"] }),
      }),
    );
    expect(bad.status).toBe(400);
  });

  test("patch is isolated per guild", async () => {
    const { app, store } = await setup();
    const res = await app.handle(
      req("/api/guilds/g1/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ temperature: 0.2 }),
      }),
    );
    expect(res.status).toBe(200);
    const g1 = await store.getGuild("g1");
    expect(g1.temperature).toBe(0.2);
    expect("fast_enabled" in g1).toBe(false);
    expect("verify_enabled" in g1).toBe(false);
    const g2 = await store.getGuild("g2");
    expect(g2.temperature).toEqual(0.7);
  });

  test("internal snapshot PUT leaves personal overrides alone", async () => {
    const { app, store } = await setup();
    await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({
          preset: "sol",
          context_text: "個人用",
          persona_override: true,
        }),
      }),
    );
    const put = await app.handle(
      req("/internal/snapshot", {
        method: "PUT",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ guilds: { "1": { thread_only: true } } }),
      }),
    );
    expect(put.status).toBe(200);
    const mine = await store.getUserOverride("free-1");
    expect(mine.selection?.model).toBe("gpt-6.1-sol");

    expect(mine.context).toEqual({ text: "個人用", persona_override: true });
    const snap = (await (
      await app.handle(
        req("/internal/snapshot", {
          headers: { authorization: "Bearer test-internal" },
        }),
      )
    ).json()) as { user_overrides: Record<string, { selection: unknown }> };
    expect(snap.user_overrides["free-1"].selection).toBeDefined();
  });

  test("internal snapshot requires bearer", async () => {
    const { app } = await setup();
    const denied = await app.handle(req("/internal/snapshot"));
    expect(denied.status).toBe(401);
    const ok = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      version: number;
      user_roles: Record<string, string>;
    };
    expect(typeof body.version).toBe("number");
    expect(body.user_roles["admin-1"]).toBe("administrator");
    expect(body.user_roles["mod-1"]).toBe("moderator");
    expect(body.user_roles["free-1"]).toBe("free");
  });

  test("internal snapshot PUT replaces guilds and user contexts", async () => {
    const { app, store } = await setup();
    await store.putGuild("stale", {
      ...(await store.getGuild("stale")),
      thread_only: true,
    });
    const put = await app.handle(
      req("/internal/snapshot", {
        method: "PUT",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({
          guilds: {
            "99": {
              context: { text: "house rules", persona_override: true },
            },
          },
          user_contexts: {
            "1": { text: "dm seed", persona_override: false },
          },
        }),
      }),
    );
    expect(put.status).toBe(200);
    const snap = (await (
      await app.handle(
        req("/internal/snapshot", {
          headers: { authorization: "Bearer test-internal" },
        }),
      )
    ).json()) as {
      guilds: Record<
        string,
        { context?: { text: string }; thread_only?: boolean }
      >;
      user_contexts: Record<string, { text: string }>;
    };
    expect(Object.keys(snap.guilds).sort()).toEqual(["99"]);
    expect(snap.guilds["99"].context?.text).toBe("house rules");
    expect(snap.guilds.stale).toBeUndefined();
    expect(snap.user_contexts["1"].text).toBe("dm seed");
  });

  test("internal snapshot If-None-Match returns 304 until the version moves", async () => {
    const { app } = await setup();
    const first = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"\d+"$/);
    const cached = await app.handle(
      req("/internal/snapshot", {
        headers: {
          authorization: "Bearer test-internal",
          "if-none-match": etag ?? "",
        },
      }),
    );
    expect(cached.status).toBe(304);
    await app.handle(
      req("/internal/snapshot", {
        method: "PUT",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ guilds: { "1": { thread_only: true } } }),
      }),
    );
    const stale = await app.handle(
      req("/internal/snapshot", {
        headers: {
          authorization: "Bearer test-internal",
          "if-none-match": etag ?? "",
        },
      }),
    );
    expect(stale.status).toBe(200);
    const body = (await stale.json()) as {
      version: number;
      guilds: Record<string, unknown>;
    };
    expect(body.guilds["1"]).toBeDefined();
    expect(stale.headers.get("etag")).not.toBe(etag);
  });

  test("internal events sse hello then update after snapshot PUT", async () => {
    const { app } = await setup();
    const denied = await app.handle(req("/internal/events"));
    expect(denied.status).toBe(401);
    const ac = new AbortController();
    const res = await app.handle(
      req("/internal/events", {
        headers: { authorization: "Bearer test-internal" },
        signal: ac.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let buf = "";
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 2_000;
      while (!buf.includes(needle)) {
        if (Date.now() > deadline)
          throw new Error(`timeout waiting for ${needle}: ${buf}`);
        const next = await reader!.read();
        if (next.done) throw new Error(`closed waiting for ${needle}: ${buf}`);
        buf += decoder.decode(next.value, { stream: true });
      }
    };
    await readUntil("event: hello");
    const put = app.handle(
      req("/internal/snapshot", {
        method: "PUT",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ guilds: { "1": {} } }),
      }),
    );
    await readUntil("event: update");
    ac.abort();
    await reader!.cancel();
    expect((await put).status).toBe(200);
  });
});

describe("user overrides", () => {
  test("rejects unknown personal preset", () => {
    expect(
      userOverridePatchSchema.safeParse({ preset: "not-a-model" }).success,
    ).toBe(false);
    expect(
      userOverridePatchSchema.safeParse({ preset: "grok-4.5" }).success,
    ).toBe(false);
    expect(userOverridePatchSchema.safeParse({ preset: "sol" }).success).toBe(
      true,
    );
  });

  test("personal subagent preset is isolated and can reset to auto", async () => {
    const { app, store } = await setup();
    const fixed = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ subagent_model: { mode: "fixed", preset: "sol" } }),
      }),
    );
    expect(fixed.status).toBe(200);
    expect((await store.getUserOverride("free-1")).subagent_model).toEqual({ mode: "fixed", preset: "sol" });
    expect((await store.getUserOverride("admin-1")).subagent_model).toBeNull();

    const reset = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ subagent_model: null }),
      }),
    );
    expect(reset.status).toBe(200);
    expect((await store.getUserOverride("free-1")).subagent_model).toBeNull();
  });

  test("unauthenticated personal settings are 401", async () => {
    const { app } = await setup();
    expect((await app.handle(req("/api/me/settings"))).status).toBe(401);
    expect(
      (
        await app.handle(
          req("/api/me/settings", {
            method: "PATCH",
            body: JSON.stringify({ preset: "sol" }),
          }),
        )
      ).status,
    ).toBe(401);
  });

  test("personal patch is isolated per user and starts at default", async () => {
    const { app, store } = await setup();
    const empty = await app.handle(
      req("/api/me/settings", { cookie: "sess-free" }),
    );
    expect(empty.status).toBe(200);
    expect(
      ((await empty.json()) as { settings: { selection: unknown } }).settings
        .selection,
    ).toBeNull();

    const res = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({
          preset: "sol",
          effort: "high",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: {
        selection: { model: string; effort: string };
      };
    };
    expect(body.settings.selection.model).toBe("gpt-6.1-sol");
    expect(body.settings.selection.effort).toBe("high");

    const admin = await store.getUserOverride("admin-1");
    expect(admin.selection).toBeNull();
  });

  test("personal fable-5 is premium or stronger", async () => {
    const { app, store } = await setup();
    await store.upsertUser({
      discord_id: "prem-1",
      username: "prem",
      avatar: null,
    });
    await store.setUserRole("prem-1", "premium");
    await store.putSession(
      "sess-prem",
      "prem-1",
      "tok-prem",
      Date.now() + 60_000,
    );

    const denied = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ preset: "fable-5" }),
      }),
    );
    expect(denied.status).toBe(403);

    const okPrem = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-prem",
        body: JSON.stringify({ preset: "fable-5" }),
      }),
    );
    expect(okPrem.status).toBe(200);
  });

  test("reset clears the personal model back to default", async () => {
    const { app, store } = await setup();
    await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ preset: "sol" }),
      }),
    );
    const res = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ preset: "reset" }),
      }),
    );
    expect(res.status).toBe(200);
    const row = await store.getUserOverride("free-1");
    expect(row.selection).toBeNull();
    expect(row.effort).toBeNull();
  });

  test("internal user settings patch writes another user's overlay", async () => {
    const { app, store } = await setup();
    const denied = await app.handle(
      req("/internal/users/1267156634686459907/settings", {
        method: "PATCH",
        body: JSON.stringify({
          context_text: "個人用",
          persona_override: true,
        }),
      }),
    );
    expect(denied.status).toBe(401);

    const badId = await app.handle(
      req("/internal/users/not-a-snowflake/settings", {
        method: "PATCH",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ context_text: "個人用" }),
      }),
    );
    expect(badId.status).toBe(400);

    const res = await app.handle(
      req("/internal/users/1267156634686459907/settings", {
        method: "PATCH",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({
          context_text: "個人用",
          persona_override: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { context: { text: string; persona_override: boolean } | null };
    };
    expect(body.settings.context).toEqual({
      text: "個人用",
      persona_override: true,
    });
    expect(
      (await store.getUserOverride("1267156634686459907")).context,
    ).toEqual({
      text: "個人用",
      persona_override: true,
    });
    expect((await store.getUserOverride("free-1")).context).toBeNull();
  });

  test("personal context overlay is isolated and clears to default", async () => {
    const { app, store } = await setup();
    expect(
      userOverridePatchSchema.safeParse({ context_text: "x".repeat(4001) })
        .success,
    ).toBe(false);
    expect(
      userOverridePatchSchema.safeParse({ context_text: "口調はタメ" }).success,
    ).toBe(true);

    const res = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({
          context_text: "口調はタメ",
          persona_override: true,
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { context: { text: string; persona_override: boolean } | null };
    };
    expect(body.settings.context).toEqual({
      text: "口調はタメ",
      persona_override: true,
    });
    expect((await store.getUserOverride("admin-1")).context).toBeNull();

    const cleared = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ context_clear: true }),
      }),
    );
    expect(cleared.status).toBe(200);
    expect((await store.getUserOverride("free-1")).context).toBeNull();

    // A blank save returns to デフォルト so the server context applies again.
    await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ context_text: "残す", persona_override: true }),
      }),
    );
    const blank = await app.handle(
      req("/api/me/settings", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ context_text: "", persona_override: false }),
      }),
    );
    expect(blank.status).toBe(200);
    expect((await store.getUserOverride("free-1")).context).toBeNull();
  });
});

describe("audit logs", () => {
  const entry = {
    at: Date.now(),
    guild_id: "g1",
    channel_id: "c1",
    user_id: "u1",
    username: "alice",
    prompt: "hello",
    reply: "hi",
  };

  test("POST /internal/logs is a no-op while WEB_LOGS_ENABLED is off", async () => {
    const { app, store } = await setup();
    const res = await app.handle(
      req("/internal/logs", {
        method: "POST",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({
          entries: [
            {
              ...entry,
              failure_phase: "agent",
              failure_code: "provider_http",
              http_status: 503,
              has_checkpoint: false,
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, n: 0, enabled: false });
    expect(
      await store.listLogs({
        limit: 10,
        before: null,
        guild_id: null,
        user_id: null,
        scope: "all",
        q: null,
      }),
    ).toEqual([]);
  });

  test("POST /internal/logs keeps legacy payloads valid", async () => {
    const { app, store } = await setup({ logsEnabled: true });
    const res = await app.handle(
      req("/internal/logs", {
        method: "POST",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ entries: [entry] }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, n: 1, enabled: true });
    const rows = await store.listLogs({
      limit: 10,
      before: null,
      guild_id: null,
      user_id: null,
      scope: "all",
      q: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prompt).toBe("hello");
    expect(rows[0]?.failure_phase).toBeNull();
    expect(rows[0]?.failure_code).toBeNull();
    expect(rows[0]?.http_status).toBeNull();
    expect(rows[0]?.has_checkpoint).toBeNull();
  });

  test("POST /internal/logs persists failure fields and GET returns them", async () => {
    const { app, store } = await setup({ logsEnabled: true });
    const res = await app.handle(
      req("/internal/logs", {
        method: "POST",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({
          entries: [
            {
              ...entry,
              reply: null,
              error: "provider_rate_limit",
              failure_phase: "agent",
              failure_code: "provider_rate_limit",
              http_status: 429,
              has_checkpoint: false,
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, n: 1, enabled: true });

    const rows = await store.listLogs({
      limit: 10,
      before: null,
      guild_id: null,
      user_id: null,
      scope: "all",
      q: null,
    });
    expect(rows[0]).toMatchObject({
      failure_phase: "agent",
      failure_code: "provider_rate_limit",
      http_status: 429,
      has_checkpoint: false,
    });

    const listed = await app.handle(req("/api/logs", { cookie: "sess-mod" }));
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      logs: {
        failure_phase: string | null;
        failure_code: string | null;
        http_status: number | null;
        has_checkpoint: boolean | null;
      }[];
    };
    expect(body.logs[0]).toMatchObject({
      failure_phase: "agent",
      failure_code: "provider_rate_limit",
      http_status: 429,
      has_checkpoint: false,
    });
  });

  test("POST /internal/logs normalizes invalid failure fields to null", async () => {
    const { app, store } = await setup({ logsEnabled: true });
    const res = await app.handle(
      req("/internal/logs", {
        method: "POST",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({
          entries: [
            {
              ...entry,
              failure_phase: "not-a-phase",
              failure_code: "not-a-code",
              http_status: 99,
              has_checkpoint: "false",
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, n: 1, enabled: true });

    const rows = await store.listLogs({
      limit: 10,
      before: null,
      guild_id: null,
      user_id: null,
      scope: "all",
      q: null,
    });
    expect(rows[0]?.failure_phase).toBeNull();
    expect(rows[0]?.failure_code).toBeNull();
    expect(rows[0]?.http_status).toBeNull();
    expect(rows[0]?.has_checkpoint).toBeNull();
  });

  // #42: where a provider request failed, kept only as fixed vocabulary.
  test("POST /internal/logs keeps the provider failure detail and drops anything else", async () => {
    const { app, store } = await setup({ logsEnabled: true });
    const post = (fields: Record<string, unknown>) => app.handle(
      req("/internal/logs", {
        method: "POST",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ entries: [{ ...entry, reply: null, ...fields }] }),
      }),
    );
    await post({ failure_stage: "stream", failure_reason: "provider_error", error_type: "overloaded_error", retries: 5, effort: "medium" });
    await post({ failure_stage: "upload", failure_reason: "Secret text", error_type: "Overloaded Error!", retries: -1, effort: "x".repeat(40) });
    const query = { limit: 10, before: null, guild_id: null, user_id: null, scope: "all" as const, q: null };
    const [bad, good] = await store.listLogs(query);
    expect(good).toMatchObject({ failure_stage: "stream", failure_reason: "provider_error", error_type: "overloaded_error", retries: 5, effort: "medium" });
    expect(bad).toMatchObject({ failure_stage: null, failure_reason: null, error_type: null, retries: null, effort: null });
  });

  test("GET /api/logs is empty and flagged off by default", async () => {
    const { app } = await setup();
    const denied = await app.handle(req("/api/logs", { cookie: "sess-free" }));
    expect(denied.status).toBe(403);
    const res = await app.handle(req("/api/logs", { cookie: "sess-mod" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[]; enabled: boolean };
    expect(body.enabled).toBe(false);
    expect(body.logs).toEqual([]);
  });
});

describe("artifacts", () => {
  const site = {
    token: "deadbeef",
    guild_id: "g1",
    channel_id: "c1",
    url: "https://artifacts.xuanling.me/s/deadbeef/",
    source_path: "site",
    created_at_unix: 1_700_000_000,
    expires_at_unix: 1_800_000_000,
    retention: "ttl",
    bytes: 12,
    file_count: 1,
  };

  test("bot catalog replace + dashboard list + pin command", async () => {
    const { app } = await setup();
    const put = await app.handle(
      req("/internal/artifacts", {
        method: "POST",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ sites: [site] }),
      }),
    );
    expect(put.status).toBe(200);

    const listed = await app.handle(
      req("/api/guilds/g1/artifacts", { cookie: "sess-free" }),
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      sites: { token: string; pending: string | null }[];
    };
    expect(body.sites).toHaveLength(1);
    expect(body.sites[0]?.token).toBe("deadbeef");
    expect(body.sites[0]?.pending).toBeNull();

    const pin = await app.handle(
      req("/api/guilds/g1/artifacts/deadbeef", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ action: "permanent" }),
      }),
    );
    expect(pin.status).toBe(200);

    const snap = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    const snapBody = (await snap.json()) as {
      artifact_commands: { token: string; action: string }[];
    };
    expect(snapBody.artifact_commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ token: "deadbeef", action: "permanent" }),
      ]),
    );

    const pending = await app.handle(
      req("/api/artifacts", { cookie: "sess-free" }),
    );
    const all = (await pending.json()) as {
      sites: { pending: string | null }[];
    };
    expect(all.sites[0]?.pending).toBe("permanent");
  });

  test("ack drops the command", async () => {
    const { app } = await setup();
    await app.handle(
      req("/internal/artifacts", {
        method: "POST",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ sites: [site] }),
      }),
    );
    await app.handle(
      req("/api/guilds/g1/artifacts/deadbeef", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ action: "month" }),
      }),
    );
    const snap = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    const cmds = (
      (await snap.json()) as { artifact_commands: { id: number }[] }
    ).artifact_commands;
    expect(cmds.length).toBeGreaterThan(0);
    const ack = await app.handle(
      req("/internal/artifacts/ack", {
        method: "POST",
        headers: { authorization: "Bearer test-internal" },
        body: JSON.stringify({ ids: cmds.map((c) => c.id) }),
      }),
    );
    expect(ack.status).toBe(200);
    const snap2 = await app.handle(
      req("/internal/snapshot", {
        headers: { authorization: "Bearer test-internal" },
      }),
    );
    const cmds2 = ((await snap2.json()) as { artifact_commands: unknown[] })
      .artifact_commands;
    expect(cmds2).toEqual([]);
  });

  test("unknown token is 404", async () => {
    const { app } = await setup();
    const res = await app.handle(
      req("/api/guilds/g1/artifacts/aa", {
        method: "PATCH",
        cookie: "sess-free",
        body: JSON.stringify({ action: "permanent" }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

test("subagent policies validate fixed values and preserve independent user/guild choices in the snapshot", async () => {
  const { app, store } = await setup();
  for (const path of ["/api/guilds/g1/settings", "/api/me/settings"]) {
    const patch = (body: unknown) => app.handle(req(path, { method: "PATCH", cookie: "sess-free", body: JSON.stringify(body) }));
    expect((await patch({ subagent_model: { mode: "fixed", preset: "fable-5" } })).status).toBe(403);
    expect((await patch({ subagent_model: { mode: "fixed" } })).status).toBe(400);
    expect((await patch({ subagent_effort: { mode: "fixed", effort: "invalid" } })).status).toBe(400);
    expect((await patch({ subagent_model: { mode: "same" }, subagent_effort: { mode: "fixed", effort: "high" } })).status).toBe(200);
    expect((await patch({ subagent_model: { mode: "auto" } })).status).toBe(200);
  }
  expect((await store.getGuild("g1")).subagent_effort).toEqual({ mode: "fixed", effort: "high" });
  expect((await store.getUserOverride("free-1")).subagent_model).toEqual({ mode: "auto" });
  expect((await store.getUserOverride("admin-1")).subagent_effort).toBeNull();
  const snapshot = await app.handle(req("/internal/snapshot", { headers: { authorization: "Bearer test-internal" } }));
  const data = await snapshot.json() as { guilds: Record<string, { subagent_model: unknown }>; user_overrides: Record<string, { subagent_effort: unknown }> };
  expect(data.guilds.g1.subagent_model).toEqual({ mode: "auto" });
  expect(data.user_overrides["free-1"].subagent_effort).toEqual({ mode: "fixed", effort: "high" });
});

test("initial settings reads save concrete defaults once and reset never restores a live dependency", async () => {
  const { store } = await setup();
  const guild = await store.getGuild("new-guild");
  const user = await store.getUserOverride("new-user");
  expect(Object.values(guild).every(value => value !== null)).toBe(true);
  expect(Object.values(user).every(value => value === null)).toBe(true);
  expect((await store.allGuilds())["new-guild"]).toEqual(guild);
  expect((await store.allUserOverrides())["new-user"]).toEqual(user);
  const version = await store.version();
  store.defaults.temperature = 1.2;
  store.defaults.jev_enabled = false;
  expect(await store.getGuild("new-guild")).toEqual(guild);
  expect(await store.getUserOverride("new-user")).toEqual(user);
  expect(await store.version()).toBe(version);
  expect((await store.getGuild("another-guild")).temperature).toBe(1.2);
  expect((await store.getUserOverride("another-user")).jev_enabled).toBeNull();
});

test("Ultra mode and effort-only overrides persist independently in guild and personal settings", async () => {
  const { app, store } = await setup();
  for (const path of ["/api/guilds/g1/settings", "/api/me/settings"]) {
    const patch = (body: unknown) => app.handle(req(path, { method: "PATCH", cookie: "sess-free", body: JSON.stringify(body) }));
    expect((await patch({ ultra_mode: "on" })).status).toBe(400);
    expect((await patch({ ultra_mode: true, effort: "low" })).status).toBe(200);
    const response = await patch({ ultra_mode: false });
    expect(response.status).toBe(200);
    const { settings } = await response.json() as { settings: { selection: { model?: string; effort?: string } | null; ultra_mode: boolean; effort: string } };
    if (path.startsWith("/api/me/")) expect(settings.selection).toBeNull();
    else expect(settings.selection).toEqual({ ...store.defaults.selection, effort: "low" });
    expect(settings.effort).toBe("low");
    expect(settings.ultra_mode).toBe(false);
  }
  expect((await store.getGuild("g1")).ultra_mode).toBe(false);
  expect((await store.getUserOverride("free-1")).effort).toBe("low");
  expect((await store.getUserOverride("admin-1")).ultra_mode).toBeNull();
  const snapshot = await app.handle(req("/internal/snapshot", { headers: { authorization: "Bearer test-internal" } }));
  const data = await snapshot.json() as { user_overrides: Record<string, { ultra_mode: boolean; effort: string }> };
  expect(data.user_overrides["free-1"]).toMatchObject({ ultra_mode: false, effort: "low" });
});

test("subagent off/on/ultra persist through API and bot snapshot without crossing scopes", async () => {
  const { app, store } = await setup();
  for (const path of ["/api/guilds/g1/settings", "/api/me/settings"]) {
    for (const [enabled, ultra] of [[false, false], [true, false], [true, true], [false, false]]) {
      const response = await app.handle(req(path, { method: "PATCH", cookie: "sess-free",
        body: JSON.stringify({ subagent_enabled: enabled, ultra_mode: ultra, service_tier: "priority" }) }));
      expect(response.status).toBe(200);
      expect((await response.json()).settings).toMatchObject({ subagent_enabled: enabled, ultra_mode: ultra, service_tier: "priority" });
    }
  }
  expect((await store.getGuild("g2")).subagent_enabled).toBe(true);
  expect((await store.getUserOverride("admin-1")).subagent_enabled).toBeNull();
  const snapshot = await app.handle(req("/internal/snapshot", { headers: { authorization: "Bearer test-internal" } }));
  expect(snapshot.status).toBe(200);
  const data = await snapshot.json();
  expect(data.guilds.g1.service_tier).toBe("priority");
  expect(data.user_overrides["free-1"].service_tier).toBe("priority");
  expect((await store.getUserOverride("admin-1")).service_tier).toBeNull();
  expect(data.guilds.g1.subagent_enabled).toBe(false);
  expect(data.user_overrides["free-1"].subagent_enabled).toBe(false);
});

test("Multi-Agent persists as a fourth subagent mode for guild and personal settings", async () => {
  const { app, store } = await setup();
  for (const path of ["/api/guilds/g1/settings", "/api/me/settings"]) {
    const patch = (body: unknown) => app.handle(req(path, { method: "PATCH", cookie: "sess-free", body: JSON.stringify(body) }));
    expect((await patch({ multi_agent: "on" })).status).toBe(400);
    const multi = await patch({ subagent_enabled: true, ultra_mode: true, multi_agent: true });
    expect(multi.status).toBe(200);
    expect((await multi.json()).settings).toMatchObject({ subagent_enabled: true, ultra_mode: true, multi_agent: true });
    // An ultra-only client leaving Ultra must also leave its Multi-Agent superset.
    const left = await patch({ ultra_mode: false });
    expect((await left.json()).settings).toMatchObject({ ultra_mode: false, multi_agent: false });
    expect((await patch({ multi_agent: true })).status).toBe(200);
  }
  expect((await store.getGuild("g1")).multi_agent).toBe(true);
  expect((await store.getUserOverride("free-1")).multi_agent).toBe(true);
  expect((await store.getGuild("g2")).multi_agent).toBe(false);
  expect((await store.getUserOverride("admin-1")).multi_agent).toBeNull();
  const snapshot = await app.handle(req("/internal/snapshot", { headers: { authorization: "Bearer test-internal" } }));
  const data = await snapshot.json();
  expect(data.guilds.g1).toMatchObject({ ultra_mode: true, multi_agent: true });
  expect(data.user_overrides["free-1"]).toMatchObject({ ultra_mode: true, multi_agent: true });
});

test("Multi-Agent role overrides merge per role and enforce plan and visibility for their presets", async () => {
  const { app, store } = await setup();
  for (const path of ["/api/guilds/g1/settings", "/api/me/settings"]) {
    const patch = (body: unknown) => app.handle(req(path, { method: "PATCH", cookie: "sess-free", body: JSON.stringify(body) }));
    // A role preset gets the same checks as the main and common presets.
    expect((await patch({ multi_agent_roles: { reviewer: { model: { mode: "fixed", preset: "fable-5" } } } })).status).toBe(403);
    const hidden = await patch({ multi_agent_roles: { reviewer: { model: { mode: "fixed", preset: "plus-astra" } } } });
    expect(hidden.status).toBe(403);
    expect(await hidden.text()).toContain("unpublished");
    expect((await patch({ multi_agent_roles: { planner: { model: { mode: "same" } } } })).status).toBe(400);
    expect((await patch({ multi_agent_roles: { reviewer: { model: { mode: "fixed", preset: "sol" } } } })).status).toBe(200);
    const res = await patch({ multi_agent_roles: { explorer: { effort: { mode: "fixed", effort: "low" } } } });
    expect(res.status).toBe(200);
    const { settings } = await res.json() as { settings: { multi_agent_roles: Record<string, unknown> } };
    expect(settings.multi_agent_roles).toEqual({
      explorer: { model: { mode: "default" }, effort: { mode: "fixed", effort: "low" } },
      worker: { model: { mode: "default" }, effort: { mode: "default" } },
      reviewer: { model: { mode: "fixed", preset: "sol" }, effort: { mode: "default" } },
    });
  }
  expect((await store.getGuild("g2")).multi_agent_roles?.reviewer.model).toEqual({ mode: "default" });
  const snapshot = await app.handle(req("/internal/snapshot", { headers: { authorization: "Bearer test-internal" } }));
  const data = await snapshot.json();
  expect(data.user_overrides["free-1"].multi_agent_roles.reviewer.model).toEqual({ mode: "fixed", preset: "sol" });
});

test("personal defaults are installed once and later overrides stay", async () => {
  const store = new MemoryStore();
  await store.upsertUser({ discord_id: "a", username: "a", avatar: null });
  await store.putUserOverride("b", applyUserOverridePatch(emptyUserOverride(), {
    multi_agent: false,
    subagent_model: { mode: "same" },
  }));
  await installPersonalDefaults(store);
  expect((await store.getUserOverride("a")).selection).toBeNull();
  expect((await store.getUserOverride("b")).multi_agent).toBeNull();
  expect((await store.getUserOverride("b")).subagent_model).toBeNull();
  await store.putUserOverride("b", applyUserOverridePatch(emptyUserOverride(), { effort: "low" }));
  await installPersonalDefaults(store);
  expect((await store.getUserOverride("b")).effort).toBe("low");
  expect((await store.getUserOverride("a")).multi_agent).toBeNull();
});
