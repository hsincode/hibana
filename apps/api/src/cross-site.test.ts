import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "./create-app";
import { loadTestEnv, type WebEnv } from "./env";
import { MemoryStore } from "./store";

// Public sites run arbitrary scripts on subdomains of the same registrable
// domain as the API and the dashboard (https://<token>.hsincode.com, #114).
// To the browser they are the same site, so SameSite does not hold their
// requests back, and CORS only hides the responses: these tests keep them
// from changing anything or overwriting the session cookie.

const DASHBOARD = "http://127.0.0.1:5173";
const PUBLIC_SITE = "https://0123456789abcdef.hsincode.com";
const SESSION = "__Host-hibana_session";

async function setup(env: Partial<WebEnv> = {}) {
  const store = new MemoryStore();
  await store.migrate();
  await store.upsertUser({
    discord_id: "mod-1",
    username: "mod",
    avatar: null,
  });
  await store.setUserRole("mod-1", "moderator");
  await store.putSession("sess-mod", "mod-1", "tok-mod", Date.now() + 60_000);
  const app = createApp(loadTestEnv({ adminIds: ["admin-1"], ...env }), store, {
    guildAccess: async () => true,
    listGuilds: async () => [],
  });
  const call = (
    path: string,
    init: {
      method?: string;
      /** null leaves the header out. */
      origin?: string | null;
      cookie?: string | null;
      headers?: Record<string, string>;
      body?: BodyInit;
    } = {},
  ) => {
    const headers = new Headers(init.headers);
    const origin = init.origin === undefined ? DASHBOARD : init.origin;
    const cookie =
      init.cookie === undefined ? `${SESSION}=sess-mod` : init.cookie;
    if (origin !== null) headers.set("origin", origin);
    if (cookie !== null) headers.set("cookie", cookie);
    return app.handle(
      new Request(`http://127.0.0.1${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
      }),
    );
  };
  return { app, store, call };
}

const json = (value: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

describe("mutations need the dashboard's Origin", () => {
  test("a form post from a public site cannot block a user", async () => {
    const { store, call } = await setup();
    // A form post is a simple request: no preflight, and the cookie goes along.
    const form = {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ discord_id: "123456789012" }).toString(),
    };
    // A public site sends its own origin, or "null" (sandboxed or
    // no-referrer); an Origin that is missing altogether is refused too.
    for (const origin of [PUBLIC_SITE, "null", null]) {
      const res = await call("/api/blocked", {
        method: "POST",
        origin,
        ...form,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden origin" });
    }
    expect(await store.listBlocked()).toEqual([]);

    const ok = await call("/api/blocked", { method: "POST", ...form });
    expect(ok.status).toBe(200);
    expect((await store.listBlocked()).map((b) => b.discord_id)).toEqual([
      "123456789012",
    ]);
  });

  test("every mutating method, and logout", async () => {
    const { call } = await setup();
    for (const [method, path, init] of [
      ["PATCH", "/api/me/settings", json({})],
      ["PUT", "/api/budget-fallback", json({})],
      ["DELETE", "/api/blocked/123456789012", {}],
      ["POST", "/auth/logout", {}],
    ] as const) {
      const res = await call(path, { method, origin: PUBLIC_SITE, ...init });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
    }
    // The refused logout left the session alone.
    expect((await call("/api/me")).status).toBe(200);
  });

  test("reads and the bot's routes are not affected", async () => {
    const { call } = await setup();
    // CORS keeps other origins from reading the answer.
    expect((await call("/api/me", { origin: PUBLIC_SITE })).status).toBe(200);
    // The bot authenticates with the internal token and sends no Origin.
    const res = await call("/internal/logs", {
      method: "POST",
      origin: null,
      cookie: null,
      headers: {
        authorization: "Bearer test-internal",
        "content-type": "application/json",
      },
      body: JSON.stringify({ entries: [] }),
    });
    expect(res.status).toBe(200);
  });
});

describe("session cookie", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Runs the Discord login and returns the Set-Cookie headers. */
  async function login(env: Partial<WebEnv> = {}) {
    const { app } = await setup(env);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/oauth2/token"))
        return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.endsWith("/users/@me"))
        return Response.json({
          id: "42",
          username: "u",
          global_name: null,
          avatar: null,
        });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const start = await app.handle(
      new Request("http://127.0.0.1/auth/discord"),
    );
    const state = new URL(start.headers.get("location") ?? "").searchParams.get(
      "state",
    );
    const res = await app.handle(
      new Request(
        `http://127.0.0.1/auth/discord/callback?code=c&state=${state}`,
      ),
    );
    expect(res.status).toBe(302);
    return res.headers.getSetCookie();
  }

  test("is __Host- prefixed: Secure, host-only and Path=/", async () => {
    const [cookie, ...rest] = await login();
    expect(rest).toEqual([]);
    expect(cookie).toStartWith(`${SESSION}=`);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toMatch(/Domain=/i);
  });

  test("plain HTTP on one origin (local dev) keeps the plain name", async () => {
    const [cookie] = await login({
      publicBaseUrl: DASHBOARD,
      frontendOrigin: DASHBOARD,
    });
    expect(cookie).toStartWith("hibana_session=");
    expect(cookie).not.toContain("Secure");
  });

  test("a cookie without the prefix is not a session", async () => {
    // A sibling subdomain can set hibana_session with Domain=hsincode.com,
    // but not a __Host- cookie.
    const { call } = await setup();
    expect(
      (await call("/api/me", { cookie: "hibana_session=sess-mod" })).status,
    ).toBe(401);
    expect((await call("/api/me")).status).toBe(200);
  });

  test("logout expires it with the attributes __Host- requires", async () => {
    const { call } = await setup();
    const res = await call("/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toStartWith(`${SESSION}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect((await call("/api/me")).status).toBe(401);
  });
});
