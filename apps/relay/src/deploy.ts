import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RelayEnv } from "./env";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Run = (cmd: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;

export const runCommand: Run = async (cmd, opts = {}) => {
  let proc;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (err) {
    // Spawn failures (missing executable, bad cwd) become a failed step with
    // the reason recorded, like a non-zero exit, instead of an opaque throw.
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 300_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};

/**
 * `superseded`: the sha is an ancestor of the remote head, i.e. a newer push
 * already exists and its own CI run will deploy it. Nothing was changed.
 */
export type DeployStatus = "running" | "succeeded" | "failed" | "rolled_back" | "superseded";

export interface Deployment {
  id: string;
  sha: string;
  keyName: string;
  status: DeployStatus;
  previous: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  steps: { name: string; ok: boolean; output: string }[];
}

export type StartResult =
  | { ok: true; deployment: Deployment }
  | { ok: false; reason: "invalid_sha" | "busy"; deployment?: Deployment };

const SHA_RE = /^[0-9a-f]{40}$/;
const HISTORY_LIMIT = 30;
const OUTPUT_LIMIT = 4000;
/** Paths whose change means the relay itself runs stale code after a deploy. */
const RELAY_PATHS = ["apps/relay", "package.json", "bun.lock"];

class StepError extends Error {}

const tail = (text: string) => (text.length > OUTPUT_LIMIT ? `…${text.slice(-OUTPUT_LIMIT)}` : text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DeployerOptions {
  run?: Run;
  now?: () => Date;
  pollMs?: number;
  /** Called after a successful deploy that changed the relay's own code. */
  onSelfUpdate?: () => void;
}

/**
 * Runs one deploy at a time. The only accepted target is the commit that
 * `<remote>/<branch>` points to right now, so a leaked deploy key can move
 * production forward to reviewed code but cannot pin an old or foreign commit.
 */
export class Deployer {
  private history: Deployment[] = [];
  private active: Deployment | null = null;
  private readonly run: Run;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly statePath: string;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly env: RelayEnv,
    private readonly opts: DeployerOptions = {},
  ) {
    this.run = opts.run ?? runCommand;
    this.now = opts.now ?? (() => new Date());
    this.pollMs = opts.pollMs ?? 2000;
    this.statePath = join(env.stateDir, "deployments.json");
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.statePath, "utf8")) as { deployments?: Deployment[] };
      this.history = (data.deployments ?? []).map((d) =>
        // A deploy that was running when the relay stopped never finished.
        d.status === "running" ? { ...d, status: "failed", error: "relay restarted during deploy" } : d,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  list(): Deployment[] {
    return this.history;
  }

  get(id: string): Deployment | undefined {
    return this.history.find((d) => d.id === id);
  }

  /** Resolves once the current deploy (if any) has finished. Used by tests. */
  settled(): Promise<void> {
    return this.idle;
  }

  start(sha: string, keyName: string): StartResult {
    if (!SHA_RE.test(sha)) return { ok: false, reason: "invalid_sha" };
    if (this.active) return { ok: false, reason: "busy", deployment: this.active };
    const deployment: Deployment = {
      id: `${this.now().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`,
      sha,
      keyName,
      status: "running",
      previous: null,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      error: null,
      steps: [],
    };
    this.active = deployment;
    this.history = [deployment, ...this.history].slice(0, HISTORY_LIMIT);
    this.idle = this.execute(deployment).finally(() => {
      this.active = null;
      return this.persist();
    });
    return { ok: true, deployment };
  }

  private async step(d: Deployment, name: string, cmd: string[], timeoutMs?: number): Promise<string> {
    const result = await this.run(cmd, { cwd: this.env.appDir, timeoutMs });
    const ok = result.code === 0;
    d.steps.push({ name, ok, output: tail((result.stdout + result.stderr).trim()) });
    await this.persist();
    if (!ok) throw new StepError(`${name} failed (exit ${result.code})`);
    return result.stdout.trim();
  }

  private async execute(d: Deployment) {
    const { remote, branch } = this.env;
    let checkedOut = false;
    try {
      await this.step(d, "fetch", ["git", "fetch", "--quiet", remote, branch], 120_000);
      const head = await this.step(d, "resolve", ["git", "rev-parse", `${remote}/${branch}`]);
      if (head !== d.sha) {
        const ancestor = await this.run(["git", "merge-base", "--is-ancestor", d.sha, head], { cwd: this.env.appDir });
        if (ancestor.code === 0) {
          d.error = `${remote}/${branch} has moved on to ${head}`;
          return this.finish(d, "superseded");
        }
        throw new StepError(`${d.sha} is not on ${remote}/${branch} (${head})`);
      }
      d.previous = await this.step(d, "current", ["git", "rev-parse", "HEAD"]);
      if (d.previous === d.sha) {
        d.steps.push({ name: "noop", ok: true, output: "already deployed" });
        return this.finish(d, "succeeded");
      }
      const relayChanged =
        (await this.run(["git", "diff", "--quiet", d.previous, d.sha, "--", ...RELAY_PATHS], { cwd: this.env.appDir }))
          .code !== 0;
      checkedOut = true;
      await this.activate(d, d.sha);
      this.finish(d, "succeeded");
      if (relayChanged) this.opts.onSelfUpdate?.();
    } catch (err) {
      d.error = err instanceof Error ? err.message : String(err);
      if (!checkedOut || !d.previous) return this.finish(d, "failed");
      try {
        await this.activate(d, d.previous, "rollback ");
        this.finish(d, "rolled_back");
      } catch (rollbackErr) {
        d.error += `; rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`;
        this.finish(d, "failed");
      }
    }
  }

  /**
   * Checks out `sha`, installs dependencies and restarts the service.
   * `--force` discards edits to tracked files so production always equals the
   * commit; untracked server-only files (node_modules, .local) are kept.
   */
  private async activate(d: Deployment, sha: string, prefix = "") {
    const { bun, service } = this.env;
    await this.step(d, `${prefix}checkout`, ["git", "checkout", "--quiet", "--force", "--detach", sha]);
    await this.step(d, `${prefix}install`, [bun, "install", "--frozen-lockfile"], 600_000);
    const since = Math.floor(this.now().getTime() / 1000);
    await this.step(d, `${prefix}restart`, ["systemctl", "restart", service]);
    await this.waitReady(d, since, prefix);
  }

  private async waitReady(d: Deployment, since: number, prefix: string) {
    const deadline = Date.now() + this.env.readyTimeoutMs;
    while (Date.now() < deadline) {
      const log = await this.run(
        ["journalctl", "-u", this.env.service, "--since", `@${since}`, "--no-pager", "-o", "cat"],
        { timeoutMs: 15_000 },
      );
      if (log.stdout.includes(this.env.readyPattern)) {
        d.steps.push({ name: `${prefix}ready`, ok: true, output: this.env.readyPattern });
        return;
      }
      await sleep(this.pollMs);
    }
    d.steps.push({ name: `${prefix}ready`, ok: false, output: `no "${this.env.readyPattern}" within ${this.env.readyTimeoutMs}ms` });
    throw new StepError(`${prefix}service did not become ready`);
  }

  private finish(d: Deployment, status: DeployStatus) {
    d.status = status;
    d.finishedAt = this.now().toISOString();
  }

  private async persist() {
    await mkdir(this.env.stateDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ deployments: this.history }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}

export async function readLogs(
  env: RelayEnv,
  opts: { lines: number; since?: number },
  run: Run = runCommand,
): Promise<string[]> {
  const cmd = ["journalctl", "-u", env.service, "--no-pager", "-o", "short-iso", "-n", String(opts.lines)];
  if (opts.since !== undefined) cmd.push("--since", `@${opts.since}`);
  const result = await run(cmd, { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `journalctl exit ${result.code}`);
  return result.stdout.split("\n").filter((line) => line.length > 0);
}
