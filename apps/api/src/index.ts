import { Elysia } from "elysia";
import { createApp } from "./create-app";
import { loadEnv } from "./env";
import { openStore } from "./store";

let inner: Elysia | null = null;
let boot: Promise<Elysia> | null = null;

export function bootApp(): Promise<Elysia> {
  if (inner) return Promise.resolve(inner);
  if (!boot) {
    boot = (async () => {
      const env = loadEnv();
      const store = await openStore(env.databaseUrl, { logs: env.logsEnabled });
      const app = createApp(env, store) as unknown as Elysia;
      app.get("/", () => ({ ok: true, service: "hibana-api" }));
      inner = app;
      return app;
    })().catch((err) => {
      // Drop the cached rejection so a later request can retry after env is fixed.
      boot = null;
      throw err;
    });
  }
  return boot;
}

function bootFailedResponse() {
  // Wrapper is outside createApp's onError; neon() also embeds the DSN in Error.
  return new Response(JSON.stringify({ error: "internal error" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

// Vercel detects `import { Elysia } from "elysia"` + default export.
// No top-level await and no `listen()` — both break entrypoint detection.
const app = new Elysia().all("/*", async ({ request }) => {
  try {
    const a = await bootApp();
    return a.handle(request);
  } catch (err) {
    console.error(
      "bootApp failed:",
      err instanceof Error ? err.message.slice(0, 120) : "unknown",
    );
    return bootFailedResponse();
  }
});

export default app;
