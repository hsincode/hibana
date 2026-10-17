// The budget fallback (#89): the API decides from the cost report and today's
// estimate whether Anthropic API turns switch, and stores the model they
// switch to.
import { describe, expect, test } from "bun:test";
import { createApp } from "./create-app";
import { loadTestEnv } from "./env";
import { MemoryStore } from "./store";

const ADMIN_KEY = "sk-ant-admin01-test-key";
const NOW = Date.parse("2026-10-09T03:00:00Z");
const INTERNAL = { authorization: "Bearer test-internal" };

/**
 * Fake Admin API. The cost report says `spentCents` were spent on 8 October;
 * the usage report says today used `opusInput` uncached Opus 5.5 input
 * tokens ($4 per million). A Response in `fail` answers both instead.
 */
function anthropic(spentCents: string, opusInput: number, fail?: Response) {
  const calls: URL[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    if (fail) return fail.clone();
    if (url.pathname.endsWith("/cost_report")) {
      return Response.json({
        data: [{
          starting_at: "2026-10-08T00:00:00Z",
          ending_at: "2026-10-09T00:00:00Z",
          results: [{ amount: spentCents, currency: "USD" }],
        }],
        has_more: false,
        next_page: null,
      });
    }
    return Response.json({
      data: [{
        starting_at: "2026-10-09T01:00:00Z",
        ending_at: "2026-10-09T01:01:00Z",
        results: [{ model: "claude-opus-5-5", service_tier: "standard", inference_geo: "global", context_window: "0-200k", uncached_input_tokens: opusInput }],
      }],
      has_more: false,
      next_page: null,
    });
  }) as typeof fetch;
  return { calls, fetcher };
}

async function setup(adminKey: string | null, api = anthropic("0", 0)) {
  const env = loadTestEnv({ adminIds: ["admin-1"], anthropicAdminKey: adminKey });
  const store = new MemoryStore();
  await store.migrate();
  for (const [id, role] of [["admin-1", null], ["mod-1", "moderator"], ["premium-1", "premium"], ["free-1", "free"]] as const) {
    await store.upsertUser({ discord_id: id, username: id, avatar: null });
    if (role) await store.setUserRole(id, role);
    await store.putSession(`sess-${id}`, id, `tok-${id}`, Date.now() + 60_000);
  }
  const app = createApp(env, store, {
    guildAccess: async () => true,
    listGuilds: async () => [],
    anthropicFetch: api.fetcher,
    now: () => NOW,
  });
  const call = (path: string, init: { session?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.handle(new Request(`http://127.0.0.1${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.session ? { cookie: `hibana_session=sess-${init.session}` } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }));
  return { call, store, calls: api.calls };
}

describe("GET /internal/budget", () => {
  test("low once the remaining budget, today's estimate taken off, is below $10", async () => {
    // $200 − $185 spent = $15 left; today $6 → $9 left.
    const { call } = await setup(ADMIN_KEY, anthropic("18500", 1_500_000));
    const res = await call("/internal/budget", { headers: INTERNAL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ configured: true, month: "2026-10", threshold_usd: 10, low: true });
    expect(body.remaining_usd).toBeCloseTo(15, 10);
    expect(body.today_usd).toBeCloseTo(6, 10);
    expect(body.remaining_after_today_usd).toBeCloseTo(9, 10);
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });

  test("exactly $10 left has not gone below it", async () => {
    const { call } = await setup(ADMIN_KEY, anthropic("18500", 1_250_000));
    const body = await (await call("/internal/budget", { headers: INTERNAL })).json();
    expect(body.remaining_after_today_usd).toBeCloseTo(10, 10);
    expect(body.low).toBe(false);
  });

  test("today's estimate is what tips it: without it the month alone is above", async () => {
    const quiet = await (await (await setup(ADMIN_KEY, anthropic("18500", 0))).call("/internal/budget", { headers: INTERNAL })).json();
    expect(quiet.low).toBe(false);
    const busy = await (await (await setup(ADMIN_KEY, anthropic("18500", 2_000_000))).call("/internal/budget", { headers: INTERNAL })).json();
    expect(busy.low).toBe(true);
  });

  test("needs the internal token", async () => {
    const { call, calls } = await setup(ADMIN_KEY);
    expect((await call("/internal/budget")).status).toBe(401);
    expect((await call("/internal/budget", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("without an Admin API key it says it cannot tell, and calls nothing", async () => {
    const { call, calls } = await setup(null);
    expect(await (await call("/internal/budget", { headers: INTERNAL })).json()).toEqual({ configured: false });
    expect(calls).toHaveLength(0);
  });

  test("a failed report is an error, not a guess, so the bot keeps its last answer", async () => {
    const { call } = await setup(ADMIN_KEY, anthropic("0", 0, new Response("{}", { status: 500 })));
    const res = await call("/internal/budget", { headers: INTERNAL });
    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty("low");
  });
});

describe("/api/budget-fallback", () => {
  test("every logged-in user sees the model and the status; staff may edit", async () => {
    const { call } = await setup(ADMIN_KEY, anthropic("18500", 1_500_000));
    expect((await call("/api/budget-fallback")).status).toBe(401);
    for (const [user, edit] of [["free-1", false], ["premium-1", false], ["mod-1", true], ["admin-1", true]] as const) {
      const res = await call("/api/budget-fallback", { session: user });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.can_edit).toBe(edit);
      // The owner's default (#89).
      expect(body.fallback).toEqual({ preset: "anthropic-haiku-5-5", effort: "high" });
      expect(body.threshold_usd).toBe(10);
      expect(body.status).toMatchObject({ configured: true, low: true });
    }
  });

  test("offers Anthropic API presets only: not Auto, not Workspace, not another provider", async () => {
    const { call } = await setup(ADMIN_KEY);
    const body = await (await call("/api/budget-fallback", { session: "free-1" })).json();
    const ids = body.presets.map((p: { id: string }) => p.id);
    expect(ids).toContain("anthropic-haiku-5-5");
    expect(ids).toContain("anthropic-opus-5-5");
    expect(ids).not.toContain("anthropic-auto");
    expect(ids.some((id: string) => id.startsWith("anthropic-workspace"))).toBe(false);
    expect(ids).not.toContain("sonnet-5");
    expect(body.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("a failed status still shows the setting, with the reason", async () => {
    const { call } = await setup(ADMIN_KEY, anthropic("0", 0, new Response("{}", { status: 401 })));
    const body = await (await call("/api/budget-fallback", { session: "free-1" })).json();
    expect(body.fallback.preset).toBe("anthropic-haiku-5-5");
    expect(body.status.configured).toBe(true);
    expect(body.status.error).toContain("HTTP 401");
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });

  test("a change reaches the bot's snapshot under a new version", async () => {
    const { call } = await setup(ADMIN_KEY);
    const before = await (await call("/internal/snapshot", { headers: INTERNAL })).json();
    expect(before.budget_fallback).toEqual({ preset: "anthropic-haiku-5-5", effort: "high" });

    const saved = await call("/api/budget-fallback", { session: "mod-1", method: "PUT", body: { preset: "anthropic-sonnet-5-5", effort: "medium" } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ fallback: { preset: "anthropic-sonnet-5-5", effort: "medium" } });

    const etag = `"${before.version}"`;
    const after = await call("/internal/snapshot", { headers: { ...INTERNAL, "if-none-match": etag } });
    expect(after.status).toBe(200);
    const body = await after.json();
    expect(body.version).toBeGreaterThan(before.version);
    expect(body.budget_fallback).toEqual({ preset: "anthropic-sonnet-5-5", effort: "medium" });
    expect((await (await call("/api/budget-fallback", { session: "free-1" })).json()).fallback.preset).toBe("anthropic-sonnet-5-5");
  });

  test("only staff may change it, and only to an Anthropic API preset that is public", async () => {
    const { call, store } = await setup(ADMIN_KEY);
    const put = (session: string | undefined, body: unknown) => call("/api/budget-fallback", { session, method: "PUT", body });
    expect((await put(undefined, { preset: "anthropic-opus-5-5", effort: "high" })).status).toBe(401);
    expect((await put("free-1", { preset: "anthropic-opus-5-5", effort: "high" })).status).toBe(403);
    expect((await put("premium-1", { preset: "anthropic-opus-5-5", effort: "high" })).status).toBe(403);
    for (const body of [
      { preset: "anthropic-auto", effort: "high" },
      { preset: "anthropic-workspace-haiku-5-5", effort: "high" },
      { preset: "sonnet-5", effort: "high" },
      { preset: "anthropic-haiku-5-5", effort: "none" },
      { preset: "anthropic-haiku-5-5", effort: "ultra" },
      { preset: "anthropic-haiku-5-5" },
      { preset: "anthropic-haiku-5-5", effort: "high", extra: true },
    ]) expect((await put("admin-1", body)).status).toBe(400);
    // A preset staff hid from pickers may not have a live wire id.
    await store.setMeta("preset_visibility", JSON.stringify({ "anthropic-sonnet-5-5": false }));
    expect((await put("admin-1", { preset: "anthropic-sonnet-5-5", effort: "high" })).status).toBe(400);
    // Nothing was stored by the refused writes.
    expect(await store.getMeta("budget_fallback")).toBeNull();
  });
});
