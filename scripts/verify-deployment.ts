// Checks a Vercel deployment before the production domain points at it, so a
// build that does not boot never serves users. The deploy job stages the build
// (`vercel deploy --prod --skip-domain`), runs this against the deployment's
// own URL and promotes it only when this exits 0.
// Usage: [VERCEL_BYPASS=...] bun scripts/verify-deployment.ts <api|web> <url> <sha>
//
// The commit is compared as well as the status: a 200 from some other build
// would not show that the build being promoted works.
// - api: /healthz answers through the app's boot (env, database, migrations),
//   and /version reports HIBANA_COMMIT, which the deploy job sets.
// - web: the page carries the commit in a meta tag written at build time, and
//   the script it loads is fetched, because the page alone is static HTML.
//
// Deployment URLs sit behind Vercel's Deployment Protection. VERCEL_BYPASS is
// the project's "Protection Bypass for Automation" secret.

export type Target = "api" | "web";

export interface Check {
  ok: boolean;
  detail: string;
}

export interface VerifyOptions {
  bypass?: string;
  /** A fresh deployment can answer 5xx while it cold-starts. */
  attempts?: number;
  delayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(base: string, path: string, bypass: string | undefined): Promise<Response> {
  return fetch(new URL(path, base), {
    headers: bypass ? { "x-vercel-protection-bypass": bypass } : {},
    // A redirect here is the protection's login page, not the app.
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
}

function unexpected(path: string, response: Response): Check {
  const protectedHint =
    response.status === 401 || (response.status >= 300 && response.status < 400)
      ? " (the deployment is protected: VERCEL_BYPASS is missing or wrong)"
      : "";
  return { ok: false, detail: `${path} answered HTTP ${response.status}${protectedHint}` };
}

async function checkApi(base: string, sha: string, bypass: string | undefined): Promise<Check> {
  const health = await get(base, "/healthz", bypass);
  if (health.status !== 200) return unexpected("/healthz", health);
  const version = await get(base, "/version", bypass);
  if (version.status !== 200) return unexpected("/version", version);
  const commit = ((await version.json().catch(() => null)) as { commit?: unknown } | null)?.commit;
  if (commit !== sha) return { ok: false, detail: `/version reports commit ${String(commit)}, expected ${sha}` };
  return { ok: true, detail: `api serves ${sha}` };
}

async function checkWeb(base: string, sha: string, bypass: string | undefined): Promise<Check> {
  const page = await get(base, "/", bypass);
  if (page.status !== 200) return unexpected("/", page);
  const html = await page.text();
  const commit = /<meta\s+name="hibana-commit"\s+content="([^"]*)"/.exec(html)?.[1];
  if (commit !== sha) return { ok: false, detail: `the page was built from commit ${String(commit)}, expected ${sha}` };
  const script = /<script[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
  if (!script) return { ok: false, detail: "the page loads no script" };
  const asset = await get(base, script, bypass);
  if (asset.status !== 200) return unexpected(script, asset);
  return { ok: true, detail: `web serves ${sha}` };
}

export async function verify(target: Target, url: string, sha: string, options: VerifyOptions = {}): Promise<Check> {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 5000;
  let last: Check = { ok: false, detail: "not checked" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      last = await (target === "api" ? checkApi : checkWeb)(url, sha, options.bypass);
    } catch (err) {
      last = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    if (last.ok) return last;
    if (attempt < attempts) await sleep(delayMs);
  }
  return last;
}

if (import.meta.main) {
  const [target, url, sha] = process.argv.slice(2);
  if ((target !== "api" && target !== "web") || !url || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
    console.error("usage: verify-deployment.ts <api|web> <url> <40-char sha>");
    process.exit(2);
  }
  const result = await verify(target, url, sha!, { bypass: process.env.VERCEL_BYPASS || undefined });
  console.log(`${result.ok ? "ok" : "FAILED"}: ${result.detail}`);
  process.exit(result.ok ? 0 : 1);
}
