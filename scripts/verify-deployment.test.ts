import { afterEach, describe, expect, test } from "bun:test";
import { verify } from "./verify-deployment";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

/** Serves `routes` (path -> response factory) and returns the base URL. */
function serve(routes: Record<string, (request: Request) => Response>, guard?: (request: Request) => Response | null) {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const blocked = guard?.(request);
      if (blocked) return blocked;
      const handler = routes[new URL(request.url).pathname];
      return handler ? handler(request) : new Response("not found", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

const api = (commit: string | null) => ({
  "/healthz": () => new Response("ok"),
  "/version": () => Response.json({ commit }),
});

const page = (commit: string) =>
  `<!doctype html><html><head><meta name="hibana-commit" content="${commit}" /><script type="module" crossorigin src="/assets/index-abc.js"></script></head><body></body></html>`;
const web = (commit: string, asset = true) => ({
  "/": () => new Response(page(commit), { headers: { "content-type": "text/html" } }),
  ...(asset ? { "/assets/index-abc.js": () => new Response("export {}", { headers: { "content-type": "text/javascript" } }) } : {}),
});

const once = { attempts: 1, delayMs: 1 };

describe("api", () => {
  test("passes when the app boots and serves the commit being deployed", async () => {
    expect(await verify("api", serve(api(SHA)), SHA, once)).toMatchObject({ ok: true });
  });

  test("fails when another commit is served", async () => {
    const result = await verify("api", serve(api(OTHER)), SHA, once);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(OTHER);
  });

  test("fails when the build does not report a commit", async () => {
    expect((await verify("api", serve(api(null)), SHA, once)).ok).toBe(false);
  });

  test("fails when the app does not boot", async () => {
    const url = serve({ "/healthz": () => new Response(JSON.stringify({ error: "internal error" }), { status: 500 }) });
    const result = await verify("api", url, SHA, once);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("500");
  });

  test("retries a deployment that is still starting", async () => {
    let calls = 0;
    const url = serve({
      "/healthz": () => (++calls < 3 ? new Response("starting", { status: 503 }) : new Response("ok")),
      "/version": () => Response.json({ commit: SHA }),
    });
    expect((await verify("api", url, SHA, { attempts: 5, delayMs: 1 })).ok).toBe(true);
    expect(calls).toBe(3);
  });
});

describe("web", () => {
  test("passes when the page names the commit and its script loads", async () => {
    expect(await verify("web", serve(web(SHA)), SHA, once)).toMatchObject({ ok: true });
  });

  test("fails when the page was built from another commit", async () => {
    expect((await verify("web", serve(web(OTHER)), SHA, once)).ok).toBe(false);
  });

  test("fails when the script the page loads is missing", async () => {
    const result = await verify("web", serve(web(SHA, false)), SHA, once);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("/assets/index-abc.js");
  });
});

describe("deployment protection", () => {
  const guard = (request: Request) =>
    request.headers.get("x-vercel-protection-bypass") === "secret"
      ? null
      : new Response(null, { status: 307, headers: { location: "https://vercel.com/sso-api" } });

  test("a protected deployment fails without the bypass secret and says why", async () => {
    const result = await verify("api", serve(api(SHA), guard), SHA, once);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("VERCEL_BYPASS");
  });

  test("the bypass secret is sent on every request", async () => {
    expect((await verify("api", serve(api(SHA), guard), SHA, { ...once, bypass: "secret" })).ok).toBe(true);
    expect((await verify("web", serve(web(SHA), guard), SHA, { ...once, bypass: "secret" })).ok).toBe(true);
  });
});
