// Decides which deploy targets a main build has to update; prints `api=` /
// `web=` / `bot=` lines for $GITHUB_OUTPUT, plus `base=` (empty when there is
// no usable base) for the deploy notification's commit list.
// Usage: GH_TOKEN=... [RELAY_URL=... RELAY_TOKEN=...] bun scripts/deploy-changes.ts <sha>
//
// API and web compare with the head of the last successful main CI run, not
// the previous push: the workflow cancels superseded runs and a failed deploy
// fails the run, so a change skipped that way is still in the next diff. A
// missing base or a force push (base not an ancestor) deploys both.
//
// The bot compares with the commit the relay reports as running. Run history
// is not enough for it: a run whose deploy the relay answered with `superseded`
// succeeds without changing production. When the relay cannot be asked, or it
// runs a commit outside this history, the bot is deployed, because a needless
// restart costs less than a change that never ships.
//
// workflow_dispatch deploys everything.

/** Both Vercel apps and the VPS build packages/shared through the root workspace install. */
const SHARED_PATHS = ["packages/shared/", "package.json", "bun.lock"];
export const API_PATHS = ["apps/api/", ...SHARED_PATHS];
export const WEB_PATHS = ["apps/web/", ...SHARED_PATHS];
/**
 * What the VPS runs: the bot, the relay that deploys it, and their workspace
 * install. Docs, the Vercel apps, CI and the unit files under deploy/ (which
 * are installed by hand) leave the running bot unchanged. A new top-level path
 * the bot starts to read has to be added here, or its changes never deploy.
 */
export const BOT_PATHS = ["apps/bot/", "apps/relay/", ...SHARED_PATHS];
/**
 * The running bot does not load its tests, so a change to them alone is not a
 * reason to restart it. A fixture that production code reads must not live in
 * a file this matches.
 */
const TEST_FILE = /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/;

export function touchesBot(changed: readonly string[]): boolean {
  return touches(BOT_PATHS, changed.filter((file) => !TEST_FILE.test(file)));
}

/** An entry ending in `/` is a directory; any other entry is one file at the repository root. */
export function touches(paths: readonly string[], changed: readonly string[]): boolean {
  return changed.some((file) => paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)));
}

export interface Facts {
  event: string;
  /** Head of the last successful main run and the files changed since; null when there is no such ancestor. */
  vercel: { base: string; changed: string[] } | null;
  /** Commit production runs and the files changed since; null when it is unknown or outside this history. */
  bot: { deployed: string; changed: string[] } | null;
}

export interface Decision {
  api: boolean;
  web: boolean;
  bot: boolean;
  base: string;
}

export function decide(facts: Facts): Decision {
  if (facts.event === "workflow_dispatch") return { api: true, web: true, bot: true, base: "" };
  return {
    api: facts.vercel ? touches(API_PATHS, facts.vercel.changed) : true,
    web: facts.vercel ? touches(WEB_PATHS, facts.vercel.changed) : true,
    bot: facts.bot ? touchesBot(facts.bot.changed) : true,
    base: facts.vercel?.base ?? "",
  };
}

const SHA_RE = /^[0-9a-f]{40}$/;

function run(cmd: string[]): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString().trim() };
}

const isAncestor = (base: string, head: string) => run(["git", "merge-base", "--is-ancestor", base, head]).ok;

function changedSince(base: string, head: string): string[] {
  const diff = run(["git", "diff", "--name-only", base, head]);
  if (!diff.ok) throw new Error(`git diff ${base} ${head} failed`);
  return diff.out.split("\n").filter(Boolean);
}

function vercelFacts(head: string): Facts["vercel"] {
  const list = run([
    "gh", "run", "list", "--workflow", "ci.yml", "--branch", "main", "--status", "success",
    "--limit", "50", "--json", "headSha,event",
  ]);
  if (!list.ok) return null;
  let runs: { headSha: string; event: string }[];
  try {
    runs = JSON.parse(list.out);
  } catch {
    return null;
  }
  const base = runs.find((r) => (r.event === "push" || r.event === "workflow_dispatch") && r.headSha !== head)?.headSha;
  if (!base || !isAncestor(base, head)) return null;
  return { base, changed: changedSince(base, head) };
}

async function botFacts(head: string): Promise<Facts["bot"]> {
  const url = process.env.RELAY_URL?.replace(/\/$/, "");
  const token = process.env.RELAY_TOKEN;
  if (!url || !token) return null;
  let deployed: unknown;
  try {
    const response = await fetch(`${url}/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error(`relay /status answered HTTP ${response.status}`);
      return null;
    }
    deployed = ((await response.json()) as { commit?: unknown }).commit;
  } catch (err) {
    console.error(`relay /status failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (typeof deployed !== "string" || !SHA_RE.test(deployed)) return null;
  if (deployed !== head && !isAncestor(deployed, head)) return null;
  return { deployed, changed: changedSince(deployed, head) };
}

if (import.meta.main) {
  const head = process.argv[2];
  if (!head) {
    console.error("usage: deploy-changes.ts <sha>");
    process.exit(2);
  }
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  // workflow_dispatch needs neither lookup.
  const facts: Facts =
    event === "workflow_dispatch"
      ? { event, vercel: null, bot: null }
      : { event, vercel: vercelFacts(head), bot: await botFacts(head) };
  console.error(facts.vercel ? `api/web: ${facts.vercel.changed.length} files since ${facts.vercel.base.slice(0, 7)}` : "api/web: no deployable base");
  console.error(facts.bot ? `bot: ${facts.bot.changed.length} files since ${facts.bot.deployed.slice(0, 7)} in production` : "bot: production commit unknown");
  const decision = decide(facts);
  console.log(`api=${decision.api}\nweb=${decision.web}\nbot=${decision.bot}\nbase=${decision.base}`);
}
