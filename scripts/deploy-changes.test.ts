import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_PATHS, decide, touches } from "./deploy-changes";

describe("touches", () => {
  test("a directory entry matches files below it, anchored at the repository root", () => {
    expect(touches(BOT_PATHS, ["apps/bot/src/bot.ts"])).toBe(true);
    expect(touches(BOT_PATHS, ["apps/relay/src/deploy.ts"])).toBe(true);
    expect(touches(BOT_PATHS, ["packages/shared/src/settings.ts"])).toBe(true);
    expect(touches(BOT_PATHS, ["docs/apps/bot/notes.md"])).toBe(false);
  });

  test("a file entry matches only that file at the repository root", () => {
    expect(touches(BOT_PATHS, ["package.json"])).toBe(true);
    expect(touches(BOT_PATHS, ["bun.lock"])).toBe(true);
    expect(touches(BOT_PATHS, ["apps/web/package.json"])).toBe(false);
  });

  test("docs, the Vercel apps, CI and unit files leave the bot alone", () => {
    expect(
      touches(BOT_PATHS, [
        "README.md",
        "docs/production.md",
        "apps/api/src/store.ts",
        "apps/web/src/App.tsx",
        ".github/workflows/ci.yml",
        "scripts/deploy-changes.ts",
        "deploy/hibana.service",
      ]),
    ).toBe(false);
  });
});

describe("decide", () => {
  const vercel = { base: "a".repeat(40), changed: ["docs/relay.md"] };
  const bot = { deployed: "b".repeat(40), changed: ["docs/relay.md"] };

  test("a docs-only change deploys nothing", () => {
    expect(decide({ event: "push", vercel, bot })).toEqual({ api: false, web: false, bot: false, base: vercel.base });
  });

  test("each target follows its own diff", () => {
    const result = decide({
      event: "push",
      vercel: { base: vercel.base, changed: ["apps/web/src/App.tsx"] },
      bot: { deployed: bot.deployed, changed: ["apps/web/src/App.tsx", "apps/bot/src/llm.ts"] },
    });
    expect(result).toEqual({ api: false, web: true, bot: true, base: vercel.base });
  });

  test("the shared workspace deploys every target", () => {
    const changed = ["packages/shared/src/settings.ts"];
    const result = decide({ event: "push", vercel: { base: vercel.base, changed }, bot: { deployed: bot.deployed, changed } });
    expect(result).toMatchObject({ api: true, web: true, bot: true });
  });

  test("the bot is current when the relay already runs the commit", () => {
    expect(decide({ event: "push", vercel, bot: { deployed: bot.deployed, changed: [] } }).bot).toBe(false);
  });

  test("an unknown production commit deploys the bot", () => {
    expect(decide({ event: "push", vercel, bot: null }).bot).toBe(true);
  });

  test("a missing base deploys both Vercel apps and reports no base", () => {
    expect(decide({ event: "push", vercel: null, bot })).toEqual({ api: true, web: true, bot: false, base: "" });
  });

  test("workflow_dispatch deploys everything", () => {
    expect(decide({ event: "workflow_dispatch", vercel, bot })).toEqual({ api: true, web: true, bot: true, base: "" });
  });
});

// Runs the script the way the workflow does: a real git history, a stub `gh`
// on PATH for the run history, and a local server standing in for the relay.
describe("deploy-changes.ts", () => {
  const script = join(import.meta.dir, "deploy-changes.ts");
  let root: string;
  let repo: string;
  let bin: string;
  let relay: ReturnType<typeof Bun.serve>;
  let relayCommit: string | null = null;
  let relayStatus = 200;
  let seenAuthorization: string | null = null;
  const sha: Record<string, string> = {};

  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: repo });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
  };
  const commit = async (name: string, file: string) => {
    await mkdir(join(repo, file, ".."), { recursive: true });
    await writeFile(join(repo, file), `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", name);
    sha[name] = git("rev-parse", "HEAD");
  };
  /**
   * Returns the script's stdout as a key/value object. The script runs
   * asynchronously: the stub relay lives in this process and could not answer
   * while a synchronous spawn blocks the event loop.
   */
  const decideFor = async (head: string, env: Record<string, string> = {}) => {
    const proc = Bun.spawn(["bun", script, head], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: "push",
        RELAY_URL: `http://127.0.0.1:${relay.port}`,
        RELAY_TOKEN: "hbr_test",
        ...env,
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(stderr);
    return Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hibana-deploy-changes-"));
    repo = join(root, "repo");
    bin = join(root, "bin");
    await mkdir(repo);
    await mkdir(bin);
    git("init", "-q", "-b", "main");
    await commit("bot", "apps/bot/src/bot.ts");
    await commit("docs", "docs/production.md");
    await commit("web", "apps/web/src/App.tsx");
    git("switch", "-q", "--orphan", "unrelated");
    await commit("foreign", "apps/bot/src/other.ts");
    git("switch", "-q", "main");
    // The last successful main run built the first commit.
    await writeFile(join(bin, "gh"), `#!/bin/sh\necho '[{"headSha":"${sha.bot}","event":"push"}]'\n`);
    await chmod(join(bin, "gh"), 0o755);
    relay = Bun.serve({
      port: 0,
      fetch(request) {
        seenAuthorization = request.headers.get("authorization");
        return Response.json({ commit: relayCommit, latest: null }, { status: relayStatus });
      },
    });
  });

  afterAll(async () => {
    relay.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  test("a docs-only commit on top of the running commit deploys nothing", async () => {
    relayCommit = sha.bot;
    relayStatus = 200;
    expect(await decideFor(sha.docs)).toEqual({ api: "false", web: "false", bot: "false", base: sha.bot });
    expect(seenAuthorization).toBe("Bearer hbr_test");
  });

  test("the bot is compared with production, not with the last successful run", async () => {
    // Production is still on the commit before the bot change, although a run
    // for the bot change succeeded (the relay answered `superseded`).
    git("switch", "-q", "-c", "ahead");
    await commit("bot2", "apps/bot/src/llm.ts");
    await commit("docs2", "docs/relay.md");
    await writeFile(join(bin, "gh"), `#!/bin/sh\necho '[{"headSha":"${sha.bot2}","event":"push"}]'\n`);
    relayCommit = sha.web;
    expect(await decideFor(sha.docs2)).toEqual({ api: "false", web: "false", bot: "true", base: sha.bot2 });
    await writeFile(join(bin, "gh"), `#!/bin/sh\necho '[{"headSha":"${sha.bot}","event":"push"}]'\n`);
    git("switch", "-q", "main");
  });

  test("the web app deploys when only it changed", async () => {
    relayCommit = sha.bot;
    expect(await decideFor(sha.web)).toEqual({ api: "false", web: "true", bot: "false", base: sha.bot });
  });

  test("the bot deploys when the relay cannot be asked", async () => {
    relayStatus = 503;
    expect((await decideFor(sha.docs)).bot).toBe("true");
    relayStatus = 200;
    expect((await decideFor(sha.docs, { RELAY_URL: "http://127.0.0.1:1" })).bot).toBe("true");
    expect((await decideFor(sha.docs, { RELAY_URL: "" })).bot).toBe("true");
  });

  test("the bot deploys when the relay reports a commit outside the history", async () => {
    relayStatus = 200;
    relayCommit = sha.foreign;
    expect((await decideFor(sha.docs)).bot).toBe("true");
    relayCommit = "not-a-commit";
    expect((await decideFor(sha.docs)).bot).toBe("true");
    relayCommit = null;
    expect((await decideFor(sha.docs)).bot).toBe("true");
  });

  test("workflow_dispatch deploys everything without asking", async () => {
    relayCommit = sha.docs;
    expect(await decideFor(sha.docs, { GITHUB_EVENT_NAME: "workflow_dispatch" })).toEqual({
      api: "true",
      web: "true",
      bot: "true",
      base: "",
    });
  });
});
