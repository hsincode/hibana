import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { Deployer, type DeployStatus, type Run } from "./deploy";
import { loadEnv } from "./env";
import { KeyStore } from "./keys";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "hibana-relay-"));
  dirs.push(dir);
  return dir;
}

/** Simulated git checkout + systemd. `ready` decides whether a restart logs the ready line. */
function fakeHost(
  opts: { remoteHead?: string; ready?: (sha: string) => boolean; relayChanged?: boolean; ancestor?: boolean } = {},
) {
  let head = OLD;
  let restartedAt: string | null = null;
  const calls: string[] = [];
  const run: Run = async (cmd) => {
    const line = cmd.join(" ");
    calls.push(line);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (cmd[0] === "git" && cmd[1] === "rev-parse") return ok(cmd[2] === "HEAD" ? head : (opts.remoteHead ?? NEW));
    if (cmd[0] === "git" && cmd[1] === "checkout") {
      head = cmd.at(-1)!;
      return ok();
    }
    if (cmd[0] === "git" && cmd[1] === "merge-base") return { code: opts.ancestor ? 0 : 1, stdout: "", stderr: "" };
    if (cmd[0] === "git" && cmd[1] === "diff") return { code: opts.relayChanged ? 1 : 0, stdout: "", stderr: "" };
    if (cmd[0] === "systemctl") {
      restartedAt = head;
      return ok();
    }
    if (cmd[0] === "journalctl") {
      const ready = restartedAt !== null && (opts.ready ?? (() => true))(restartedAt);
      return ok(ready ? '{"msg":"Hibana ready"}' : '{"msg":"starting"}');
    }
    return ok();
  };
  return { run, calls, head: () => head };
}

async function setup(host = fakeHost(), onSelfUpdate?: () => void) {
  const stateDir = await tempDir();
  const env = loadEnv({ RELAY_STATE_DIR: stateDir, RELAY_APP_DIR: stateDir, RELAY_READY_TIMEOUT_MS: "50" });
  const keys = new KeyStore(join(stateDir, "keys.json"));
  const deployer = new Deployer(env, { run: host.run, pollMs: 5, onSelfUpdate });
  const app = createApp({
    keys,
    deployer,
    readLogs: async ({ lines, since }) => [`lines=${lines}`, `since=${since ?? "-"}`],
    currentCommit: async () => host.head(),
  });
  const deploy = await keys.create("ci", ["deploy"]);
  const logs = await keys.create("ops", ["logs"]);
  const req = (path: string, token?: string, init: RequestInit = {}) =>
    app.handle(
      new Request(`http://relay${path}`, {
        ...init,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      }),
    );
  return { env, keys, deployer, req, host, deployToken: deploy.token, logsToken: logs.token, stateDir };
}

describe("KeyStore", () => {
  test("stores only a hash, verifies tokens and honours revocation", async () => {
    const { keys, deployToken, stateDir } = await setup();
    const file = await Bun.file(join(stateDir, "keys.json")).text();
    expect(file).not.toContain(deployToken.split("_")[2]!);
    expect((await stat(join(stateDir, "keys.json"))).mode & 0o777).toBe(0o600);

    const key = await keys.verify(deployToken);
    expect(key?.scopes).toEqual(["deploy"]);
    expect(await keys.verify(deployToken.slice(0, -1) + (deployToken.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await keys.verify("garbage")).toBeNull();

    expect(await keys.revoke(key!.id)).toBe(true);
    expect(await keys.verify(deployToken)).toBeNull();
  });
});

describe("relay API", () => {
  test("rejects missing, invalid and under-scoped keys", async () => {
    const { req, deployToken, logsToken } = await setup();
    expect((await req("/healthz")).status).toBe(200);
    expect((await req("/status")).status).toBe(401);
    expect((await req("/status", "hbr_000000000000_" + "x".repeat(43))).status).toBe(401);
    expect((await req("/logs", deployToken)).status).toBe(403);
    expect((await req("/deploy", logsToken, { method: "POST", body: JSON.stringify({ sha: NEW }) })).status).toBe(403);
    expect((await req("/deploy", deployToken, { method: "POST", body: JSON.stringify({ sha: "main" }) })).status).toBe(400);
  });

  test("clamps log lines and parses since", async () => {
    const { req, logsToken } = await setup();
    const body = await (await req("/logs?lines=999999&since=2026-09-29T00:00:00Z", logsToken)).json();
    expect(body.lines).toEqual(["lines=2000", `since=${Date.parse("2026-09-29T00:00:00Z") / 1000}`]);
    expect((await req("/logs?since=yesterday", logsToken)).status).toBe(400);
  });

  test("deploys the current remote head and reports progress", async () => {
    const { req, deployer, deployToken, host } = await setup();
    const res = await req("/deploy", deployToken, { method: "POST", body: JSON.stringify({ sha: NEW.toUpperCase() }) });
    expect(res.status).toBe(202);
    const { deployment } = await res.json();
    await deployer.settled();

    const done = await (await req(`/deploys/${deployment.id}`, deployToken)).json();
    expect(done.deployment.status).toBe("succeeded");
    expect(done.deployment.previous).toBe(OLD);
    expect(host.head()).toBe(NEW);
    expect(host.calls).toContain(`git checkout --quiet --force --detach ${NEW}`);
    expect(host.calls).toContain("/usr/local/bin/bun install --frozen-lockfile");
    expect(host.calls).toContain("systemctl restart hibana");
  });

  test.each([
    [false, "failed", "is not on origin/main"],
    [true, "superseded", "has moved on"],
  ] as [boolean, DeployStatus, string][])("refuses a sha that is not the remote head (ancestor=%p)", async (ancestor, status, error) => {
    const { deployer, host } = await setup(fakeHost({ remoteHead: "c".repeat(40), ancestor }));
    deployer.start(NEW, "ci");
    await deployer.settled();
    expect(deployer.list()[0]!.status).toBe(status);
    expect(deployer.list()[0]!.error).toContain(error);
    expect(host.calls.some((c) => c.startsWith("git checkout") || c.startsWith("systemctl"))).toBe(false);
  });

  test("rolls back when the new commit never becomes ready", async () => {
    const { deployer, host } = await setup(fakeHost({ ready: (sha) => sha !== NEW }));
    deployer.start(NEW, "ci");
    await deployer.settled();
    const d = deployer.list()[0]!;
    expect(d.status).toBe("rolled_back");
    expect(d.error).toContain("did not become ready");
    expect(host.head()).toBe(OLD);
    expect(d.steps.map((s) => s.name)).toContain("rollback ready");
  });

  test("allows one deploy at a time and treats the deployed head as a no-op", async () => {
    const { req, deployer, deployToken, host } = await setup(fakeHost({ remoteHead: OLD }));
    expect(deployer.start(OLD, "ci").ok).toBe(true);
    const busy = await req("/deploy", deployToken, { method: "POST", body: JSON.stringify({ sha: OLD }) });
    expect(busy.status).toBe(409);
    await deployer.settled();
    expect(deployer.list()[0]!.status).toBe("succeeded");
    expect(host.calls.some((c) => c.startsWith("systemctl"))).toBe(false);
  });

  test("restarts itself only when its own code changed, and history survives", async () => {
    let restarts = 0;
    const { deployer, env } = await setup(fakeHost({ relayChanged: true }), () => restarts++);
    deployer.start(NEW, "ci");
    await deployer.settled();
    expect(restarts).toBe(1);

    const reloaded = new Deployer(env, { run: fakeHost().run });
    await reloaded.load();
    expect(reloaded.list()[0]!.sha).toBe(NEW);
  });
});

test("runCommand reports a missing executable as a failed result", async () => {
  const { runCommand } = await import("./deploy");
  const result = await runCommand(["hibana-relay-no-such-binary"]);
  expect(result.code).toBe(127);
  expect(result.stderr).toContain("hibana-relay-no-such-binary");
});
