import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../config";
import { isClosedControllerError, withAbort } from "../io";
import { Runtime } from "../runtime";
import { retryDelay, WebSync } from "../sync";
import type { ToolRegistry } from "../tools";

test("withAbort stops waiting on work that has not settled", async () => {
  const abort = new AbortController(), pending = Promise.withResolvers<void>();
  const waiting = withAbort(pending.promise, abort.signal);
  abort.abort(new Error("cancelled"));
  await expect(waiting).rejects.toThrow("cancelled");
  pending.resolve();
});

describe("closed fetch-body errors", () => {
  test("matches Bun's webstreams adapter TypeError", () => {
    const error = new TypeError(
      "Invalid state: Controller is already closed",
    ) as TypeError & { code: string };
    error.code = "ERR_INVALID_STATE";
    expect(isClosedControllerError(error)).toBe(true);
    expect(isClosedControllerError(new TypeError("other"))).toBe(false);
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(
      false,
    );
  });
});

type Seen = { method: string; path: string; etag: string | null; status: number };

/** A stand-in for the settings API: counts what the bot asks for. */
function settingsApi() {
  const api = {
    seen: [] as Seen[],
    /** Answer every request with 402, as Vercel does for a paused project. */
    down: false,
    version: 1,
    blocked: [] as string[],
    /** Paths that answer 500 once. */
    failOnce: new Set<string>(),
    count: (method: string, path: string, status?: number) =>
      api.seen.filter(
        (s) => s.method === method && s.path === path && (status === undefined || s.status === status),
      ).length,
    url: "",
    stop: () => server.stop(true),
  };
  const answer = (request: Request, path: string) => {
    if (api.down) return new Response("Payment required", { status: 402 });
    if (api.failOnce.delete(path)) return new Response("boom", { status: 500 });
    if (request.method === "GET" && path === "/internal/snapshot") {
      const etag = `"${api.version}"`;
      if (request.headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers: { ETag: etag } });
      return Response.json(
        {
          version: api.version,
          guilds: {},
          user_contexts: {},
          user_overrides: {},
          blocked_users: api.blocked,
          user_roles: {},
          unpublished_presets: [],
          premium_presets: [],
          artifact_commands: [],
          skill_commands: [],
        },
        { headers: { ETag: etag } },
      );
    }
    if (path === "/internal/events")
      return new Response('event: hello\ndata: {"version":1}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    return Response.json({ ok: true });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      await request.arrayBuffer();
      const response = answer(request, path);
      api.seen.push({
        method: request.method,
        path,
        etag: request.headers.get("if-none-match"),
        status: response.status,
      });
      return response;
    },
  });
  api.url = `http://127.0.0.1:${server.port}`;
  return api;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function fixture(timing = { pollMs: 10, maxMs: 40 }) {
  const api = settingsApi();
  const runtime = new Runtime(
    loadConfig({
      WEB_API_URL: api.url,
      WEB_INTERNAL_TOKEN: "fixture",
      RUNTIME_STATE_PATH: "",
    }),
  );
  const assets = { skills: [{ name: "one" }] as unknown[], sites: [{ token: "a1" }] as unknown[] };
  const tools = {
    sites: { list: () => assets.sites, applyCommand: async () => {} },
    skills: { export: async () => assets.skills, execute: async () => ({ ok: true }) },
  } as unknown as ToolRegistry;
  const errors: string[] = [];
  const sync = new WebSync(
    runtime,
    tools,
    (e) => errors.push(e instanceof Error ? e.message : String(e)),
    timing,
  );
  cleanup.push(() => {
    sync.stop();
    api.stop();
  });
  return { api, runtime, assets, errors, sync };
}

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await Bun.sleep(5);
  }
}

describe("settings sync", () => {
  test("starts from the saved snapshot while the settings API is down", async () => {
    const { api, runtime, errors, sync } = fixture();
    // What runtime.load() restores from runtime_state.json after a restart.
    runtime.snapshot.version = 7;
    runtime.snapshot.blocked_users = ["9"];
    api.down = true;
    await sync.start();
    expect(errors).toEqual(["Settings snapshot HTTP 402"]);
    expect(runtime.snapshot.blocked_users).toEqual(["9"]);
  });

  test("refuses to start without any snapshot while the settings API is down", async () => {
    const { api, sync } = fixture();
    api.down = true;
    await expect(sync.start()).rejects.toThrow("Settings snapshot HTTP 402");
  });

  test("polls the snapshot with its ETag and never opens the event stream", async () => {
    const { api, runtime, errors, sync } = fixture();
    await sync.start();
    await until(() => api.count("GET", "/internal/snapshot", 304) >= 3);
    expect(api.count("GET", "/internal/events")).toBe(0);
    expect(api.count("GET", "/internal/snapshot", 200)).toBe(1);
    expect(api.seen.filter((s) => s.status === 304).every((s) => s.etag === '"1"')).toBe(true);

    api.blocked = ["42"];
    api.version = 2;
    await until(() => runtime.snapshot.version === 2);
    expect(runtime.snapshot.blocked_users).toEqual(["42"]);
    expect(api.count("POST", "/internal/capabilities")).toBe(1);
    expect(errors).toEqual([]);
  });

  test("announces capabilities and assets once the API comes back", async () => {
    const { api, runtime, sync } = fixture();
    runtime.snapshot.version = 7;
    api.down = true;
    await sync.start();
    await until(() => api.count("GET", "/internal/snapshot", 402) >= 2);
    expect(api.count("POST", "/internal/capabilities")).toBe(0);

    api.down = false;
    await until(() => api.count("POST", "/internal/skills", 200) === 1);
    await until(() => api.count("GET", "/internal/snapshot", 304) >= 2);
    expect(runtime.snapshot.version).toBe(1);
    expect(api.count("POST", "/internal/capabilities", 200)).toBe(1);
    expect(api.count("POST", "/internal/artifacts", 200)).toBe(1);
    expect(api.count("POST", "/internal/skills", 200)).toBe(1);
  });

  test("a refused asset upload neither stops the start nor repeats on every poll", async () => {
    const { api, errors, sync } = fixture();
    api.failOnce.add("/internal/skills");
    await sync.start();
    expect(errors).toEqual(["Settings API POST /internal/skills: HTTP 500"]);
    await until(() => api.count("GET", "/internal/snapshot", 304) >= 3);
    expect(api.count("POST", "/internal/skills")).toBe(1);
    expect(api.count("POST", "/internal/capabilities")).toBe(1);
    // What the bot does after the next turn.
    await sync.publishAssets();
    expect(api.count("POST", "/internal/skills", 200)).toBe(1);
  });

  test("waits longer between attempts while the API keeps failing", async () => {
    const { api, runtime, sync } = fixture({ pollMs: 20, maxMs: 10_000 });
    runtime.snapshot.version = 7;
    api.down = true;
    await sync.start();
    await Bun.sleep(400);
    // 20 ms apart would be about 20 attempts; doubling gives 0, 40, 120, 280 ms.
    const attempts = api.count("GET", "/internal/snapshot");
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(6);
  });

  test("retryDelay doubles per consecutive failure up to the cap", () => {
    expect(retryDelay(0, 30_000, 300_000)).toBe(30_000);
    expect(retryDelay(1, 30_000, 300_000)).toBe(60_000);
    expect(retryDelay(3, 30_000, 300_000)).toBe(240_000);
    expect(retryDelay(4, 30_000, 300_000)).toBe(300_000);
    expect(retryDelay(5000, 30_000, 300_000)).toBe(300_000);
  });
});

describe("asset publishing", () => {
  test("sends the catalog and the site list only when they changed", async () => {
    const { api, assets, sync } = fixture();
    await sync.publishAssets();
    await sync.publishAssets();
    expect(api.count("POST", "/internal/artifacts")).toBe(1);
    expect(api.count("POST", "/internal/skills")).toBe(1);

    assets.skills = [{ name: "one" }, { name: "two" }];
    await sync.publishAssets();
    expect(api.count("POST", "/internal/artifacts")).toBe(1);
    expect(api.count("POST", "/internal/skills")).toBe(2);

    assets.sites = [];
    await sync.publishAssets();
    expect(api.count("POST", "/internal/artifacts")).toBe(2);
    expect(api.count("POST", "/internal/skills")).toBe(2);
  });

  test("does not upload an unchanged chunked catalog again", async () => {
    const { api, assets, sync } = fixture();
    assets.skills = [{ name: "big", body: "x".repeat(400_000) }];
    await sync.publishAssets();
    expect(api.count("POST", "/internal/skills/chunk")).toBe(3);
    await sync.publishAssets();
    expect(api.count("POST", "/internal/skills/chunk")).toBe(3);
    expect(api.count("POST", "/internal/skills")).toBe(0);
  });

  test("sends again after a publish that failed", async () => {
    const { api, sync } = fixture();
    api.failOnce.add("/internal/skills");
    await expect(sync.publishAssets()).rejects.toThrow("HTTP 500");
    await sync.publishAssets();
    expect(api.count("POST", "/internal/skills", 200)).toBe(1);
    // The site list went through the first time and is not repeated.
    expect(api.count("POST", "/internal/artifacts")).toBe(1);
    await sync.publishAssets();
    expect(api.count("POST", "/internal/skills")).toBe(2);
  });
});
