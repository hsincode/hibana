import { Elysia } from "elysia";
import type { Deployer } from "./deploy";
import type { ApiKey, KeyStore, Scope } from "./keys";

export interface RelayDeps {
  keys: KeyStore;
  deployer: Deployer;
  readLogs: (opts: { lines: number; since?: number }) => Promise<string[]>;
  currentCommit: () => Promise<string | null>;
}

const MAX_LOG_LINES = 2000;

export function createApp(deps: RelayDeps) {
  // Returns the key when it grants `scope`, or a Response to send instead.
  // An unknown key and a key without the scope answer differently (401 vs 403)
  // so a CI misconfiguration is diagnosable; neither reveals which keys exist.
  async function authorize(request: Request, scope: Scope | null): Promise<ApiKey | Response> {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const key = token ? await deps.keys.verify(token) : null;
    if (!key) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
    if (scope && !key.scopes.includes(scope)) return Response.json({ error: "forbidden", required: scope }, { status: 403 });
    return key;
  }

  return new Elysia()
    .get("/healthz", () => ({ ok: true }))
    .get("/status", async ({ request }) => {
      const key = await authorize(request, null);
      if (key instanceof Response) return key;
      const [latest] = deps.deployer.list();
      return { commit: await deps.currentCommit(), latest: latest ?? null };
    })
    .post("/deploy", async ({ request }) => {
      const key = await authorize(request, "deploy");
      if (key instanceof Response) return key;
      const body = (await request.json().catch(() => null)) as { sha?: unknown } | null;
      const sha = typeof body?.sha === "string" ? body.sha.trim().toLowerCase() : "";
      const result = deps.deployer.start(sha, key.name);
      if (!result.ok) {
        if (result.reason === "busy") return Response.json({ error: "busy", deployment: result.deployment }, { status: 409 });
        return Response.json({ error: "sha must be a full 40-character commit hash" }, { status: 400 });
      }
      console.log(JSON.stringify({ msg: "deploy started", key: key.id, name: key.name, sha, id: result.deployment.id }));
      return Response.json({ deployment: result.deployment }, { status: 202 });
    })
    .get("/deploys", async ({ request }) => {
      const key = await authorize(request, null);
      if (key instanceof Response) return key;
      return { deployments: deps.deployer.list() };
    })
    .get("/deploys/:id", async ({ request, params }) => {
      const key = await authorize(request, null);
      if (key instanceof Response) return key;
      const deployment = deps.deployer.get(params.id);
      return deployment ? { deployment } : Response.json({ error: "not_found" }, { status: 404 });
    })
    .get("/logs", async ({ request, query }) => {
      const key = await authorize(request, "logs");
      if (key instanceof Response) return key;
      const lines = Math.min(Math.max(Number(query.lines ?? 200) || 200, 1), MAX_LOG_LINES);
      let since: number | undefined;
      if (query.since) {
        // Accept epoch seconds or anything Date can parse (ISO 8601).
        const n = /^\d+$/.test(query.since) ? Number(query.since) * 1000 : Date.parse(query.since);
        if (!Number.isFinite(n)) return Response.json({ error: "since must be epoch seconds or ISO 8601" }, { status: 400 });
        since = Math.floor(n / 1000);
      }
      return { lines: await deps.readLogs({ lines, since }) };
    });
}
