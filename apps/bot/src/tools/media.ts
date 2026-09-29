import type { Logger } from "pino";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  cp,
  lstat,
  readdir,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Context, Json } from "../types";
import { atomicJson, readJson, Serial } from "../io";
import { HomeSession, type HomeProxy } from "./home";
import type { EgressProxy } from "../network";
import {
  safePath,
  scopeOf,
  processRun,
  quote,
  type Sandbox,
  filesUnder,
} from "./sandbox";
export class Media {
  private browser?: { name: string; owner: string; release: () => void };
  private lock = new Serial();
  private home: HomeSession;
  private homeTimer: ReturnType<typeof setInterval>;
  constructor(private sandbox: Sandbox, private log?: Logger) {
    this.home = new HomeSession(sandbox.config);
    this.homeTimer = setInterval(() => {
      void this.lock.run(async () => {
        if (this.home.expired) await this.closeBrowserUnlocked();
      }).catch(() => console.error("Home browser cleanup failed; relay expiry remains enforced"));
    }, 5000);
    this.homeTimer.unref();
  }
  homeRoute(ctx: Context): HomeProxy | undefined {
    return this.home.route(ctx);
  }
  homeEgress(ctx: Context): EgressProxy | undefined {
    const route = this.home.route(ctx);
    if (!route) return undefined;
    const url = new URL(route.server);
    return {
      host: url.hostname,
      port: Number(url.port || 80),
      username: route.username,
      password: route.password,
    };
  }
  // yt-dlp and other owning-task tools must renew the same idle window as
  // Playwright; a long download would otherwise be cut at 15 minutes idle.
  beginHomeWork(ctx: Context, everyMs = 60_000) {
    if (!this.home.owns(ctx)) return () => {};
    const pulse = () => void this.home.touch(ctx).catch(() => {});
    pulse();
    const timer = setInterval(pulse, Math.max(10, everyMs));
    timer.unref();
    return () => clearInterval(timer);
  }
  async homeCommand(name: string, ctx: Context) {
    return this.lock.run(async () => {
      if (!this.sandbox.config.browserProxyUrl) throw new Error("Home route is not configured");
      if (name === "home_vpn_status") return this.home.status(ctx);
      if (this.home.active && !this.home.owns(ctx)) throw new Error("Home connection belongs to another task");
      if (this.browser && this.browser.owner !== `${ctx.channelId}/${ctx.userId}`) throw new Error("Browser is busy in another turn");
      if (name === "home_vpn_disconnect") {
        await this.closeBrowserUnlocked(); return this.home.status(ctx);
      }
      if (name !== "home_vpn_connect") throw new Error("Unknown home tool");
      if (!this.home.active) await this.closeBrowserUnlocked();
      return this.home.connect(ctx);
    });
  }
  async finishHome(ctx: Context) {
    await this.lock.run(async () => { if (this.home.owns(ctx)) await this.closeBrowserUnlocked(); });
  }
  async browserCommand(ctx: Context, a: Json) {
    const started = performance.now();
    // Arguments, URLs, scripts and output can contain credentials or private page data.
    const commands = new Set(["open", "goto", "close", "click", "dblclick", "fill", "type", "press", "hover",
      "drag", "select", "check", "uncheck", "upload", "snapshot", "screenshot", "eval", "run-code",
      "mousemove", "mousedown", "mouseup", "mousewheel", "keydown", "keyup", "resize", "reload",
      "go-back", "go-forward", "tab-list", "tab-new", "tab-close", "tab-select", "console", "network"]);
    const command = Array.isArray(a.args) && commands.has(a.args[0]) ? a.args[0] : "unknown";
    const fields = { operation_id: crypto.randomUUID(), channel: ctx.channelId,
      message_id: ctx.messageId, jev_run_id: ctx.jevDiagnostic?.runId, command };
    let stage = "queue", outcome = "error";
    this.log?.info(fields, "Browser operation started");
    try {
      return await this.lock.run(async () => {
        const queueMs = Math.round(performance.now() - started);
        stage = "setup";
        if (!this.sandbox.available)
          throw new Error("Docker sandbox unavailable");
        const args = a.args as string[];
        if (
          !Array.isArray(args) ||
          !args.length ||
          args.some((x) => typeof x !== "string") ||
          args.some(
            (x) =>
              /^--(?:config|session|browser|cdp-endpoint|extension)/.test(x) ||
              x.startsWith("-s="),
          )
        )
          throw new Error("Invalid browser arguments");
        const owner = `${ctx.channelId}/${ctx.userId}`;
        if (this.browser && this.browser.owner !== owner)
          throw new Error("Browser is busy in another turn");
        // Check ownership before touching or closing anything belonging to a
        // different task, even when it is from the same user and channel.
        const proxy = this.home.proxy(ctx);
        try { await this.home.touch(ctx); }
        catch (error) { await this.closeBrowserUnlocked(); throw error; }
        if (this.browser) {
          const check = await processRun(
            "docker",
            ["inspect", "-f", "{{.State.Running}}", this.browser.name],
            { timeout: 10000 },
          );
          if (check.stdout.trim() !== "true") {
            this.browser.release();
            this.browser = undefined;
          }
        }
        if (!this.browser) {
          const workers = await processRun(
            "docker",
            ["ps", "-q", "--filter", "label=hibana.video=true"],
            { timeout: 10000 },
          );
          if (workers.exit_code || workers.stdout.trim())
            throw new Error("Video renderer is busy or unavailable");
          const name = `hibana-browser-${crypto.randomUUID()}`,
            root = await this.sandbox.root(ctx);
          const r = await processRun("docker", [
            "run",
            "-d",
            "--rm",
            "--name",
            name,
            "--init",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=128",
            "--memory=384m",
            "--memory-swap=512m",
            "--cpus=.5",
            "--network",
            // The home proxy is on the Docker bridge. Joining the Surfshark
            // namespace would make the home route depend on an unrelated VPN.
            proxy ? "bridge" : this.sandbox.network,
            "--user",
            `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
            "--tmpfs",
            "/tmp:rw,size=128m",
            "--shm-size=64m",
            "-e",
            "HOME=/tmp",
            // Pass names only: Docker inherits values without putting credentials
            // into argv, process listings or a failed-command error message.
            ...(proxy
              ? ["-e", "HIBANA_BROWSER_PROXY_URL", "-e", "HIBANA_BROWSER_PROXY_USERNAME", "-e", "HIBANA_BROWSER_PROXY_PASSWORD"]
              : []),
            "--mount",
            `type=bind,src=${root},dst=/workspace`,
            "--workdir",
            "/workspace",
            this.sandbox.config.sandboxImage,
            "node",
            "/opt/hibana-browser/keeper.cjs",
          ], { env: {
            ...process.env,
            HIBANA_BROWSER_PROXY_URL: proxy?.server,
            HIBANA_BROWSER_PROXY_USERNAME: proxy?.username,
            HIBANA_BROWSER_PROXY_PASSWORD: proxy?.password,
          } });
          if (r.exit_code !== 0) throw new Error(r.stderr);
          this.browser = { name, owner, release: this.sandbox.lease(ctx) };
        }
        stage = "command";
        const timeoutMs = Math.min(120, Number(a.timeout_secs ?? 60)) * 1000;
        this.log?.info({ ...fields, queue_ms: queueMs, timeout_ms: timeoutMs,
          jev_remaining_ms: ctx.jevDiagnostic ? Math.max(0, ctx.jevDiagnostic.deadline - performance.now()) : undefined,
        }, "Browser command started");
        const result = await processRun(
          "docker",
          [
            "exec",
            this.browser.name,
            "node",
            "/opt/hibana-browser/cli.cjs",
            ...args,
          ],
          {
            timeout: timeoutMs,
            onExit: details => {
              outcome = details.termination;
              this.log?.info({ ...fields, ...details }, "Browser command finished");
            },
            signal: ctx.signal,
          },
        );
        // Playwright may report a timeout in its output while the CLI itself exits normally.
        // Keep that signal separate from the outer process deadline; never persist raw output.
        this.log?.info({ ...fields, exit_code: result.exit_code,
          output_reports_timeout: /TimeoutError|Timeout \d+ms exceeded|timed out/i.test(result.stdout + result.stderr),
          output_truncated: result.truncated,
        }, "Browser result received");
        if (args[0] === "close" || result.exit_code === 124) {
          stage = "cleanup";
          this.log?.info({ ...fields, reason: args[0] === "close" ? "requested" : outcome }, "Browser closing");
          await this.closeBrowserUnlocked();
        }
        stage = "complete";
        return result;
      });
    } finally {
      this.log?.info({ ...fields, stage, outcome, elapsed_ms: Math.round(performance.now() - started),
        parent_aborted: ctx.signal?.aborted ?? false }, "Browser operation finished");
    }
  }
  async closeBrowser() {
    await this.lock.run(() => this.closeBrowserUnlocked());
  }
  async close() {
    clearInterval(this.homeTimer);
    await this.closeBrowser();
  }
  private async closeBrowserUnlocked() {
    // Revoke the route first, so a slow or failing Docker removal cannot keep
    // the home connection usable. The relay has its own expiry if IPC fails.
    let failure: unknown;
    try { await this.home.disconnect(); } catch (error) { failure = error; }
    if (this.browser) {
      await processRun("docker", ["rm", "-f", this.browser.name], {
        timeout: 10000,
      });
      this.browser.release();
      this.browser = undefined;
    }
    if (failure) throw failure;
  }
  private projectRoot(ctx: Context) {
    return join(this.sandbox.config.dataDir, "video-projects", scopeOf(ctx));
  }
  async video(ctx: Context, a: Json): Promise<unknown> {
    const parent = this.projectRoot(ctx);
    await mkdir(parent, { recursive: true });
    if (a.action === "list")
      return {
        projects: (await readdir(parent, { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name),
      };
    const project = String(a.project ?? "");
    if (!/^[a-zA-Z0-9_-]{1,48}$/.test(project))
      throw new Error("Invalid video project");
    const root = await safePath(parent, project),
      statePath = join(root, "state.json");
    const state = await readJson<{
      container?: string;
      started?: number;
      status?: string;
    }>(statePath, {});
    const inspect = async () => {
      if (!state.container) return { running: false, exit_code: null };
      const r = await processRun(
        "docker",
        ["inspect", "-f", "{{json .State}}", state.container],
        { timeout: 10000 },
      );
      if (r.exit_code !== 0) return { running: false, exit_code: null };
      const d = JSON.parse(r.stdout);
      return { running: !!d.Running, exit_code: d.ExitCode };
    };
    const current = await inspect();
    if (a.action === "status") return { ...state, ...current };
    if (a.action === "cancel") {
      if (state.container)
        await processRun("docker", ["rm", "-f", state.container], {
          timeout: 10000,
        });
      await atomicJson(statePath, { ...state, status: "cancelled" });
      return { ok: true };
    }
    if (current.running) throw new Error("Video project is rendering");
    if (a.action === "save") {
      const source = await this.sandbox.path(ctx, String(a.path), true);
      await filesUnder(source, 10000);
      if (!(await Bun.file(join(source, "timeline.json")).exists()))
        throw new Error("timeline.json required");
      for (const f of await filesUnder(source, 10000))
        await safePath(source, f.path);
      await rm(join(root, "workspace"), { recursive: true, force: true });
      await mkdir(root, { recursive: true });
      await cp(source, join(root, "workspace"), {
        recursive: true,
        dereference: false,
      });
      await atomicJson(statePath, { status: "saved" });
      return { ok: true, project };
    }
    if (a.action === "delete") {
      await rm(root, { recursive: true, force: true });
      return { ok: true };
    }
    if (a.action === "collect" || a.action === "restore") {
      const target = await this.sandbox.path(ctx, String(a.path));
      if (
        (await Bun.file(target).exists()) ||
        (await lstat(target)
          .then(() => true)
          .catch(() => false))
      )
        throw new Error("Destination must be new");
      await mkdir(dirname(target), { recursive: true });
      await cp(join(root, "workspace"), target, {
        recursive: true,
        dereference: false,
      });
      return { ok: true, path: a.path };
    }
    if (a.action === "render") {
      if (this.browser)
        throw new Error("Close the browser before rendering video");
      const workers = await processRun(
        "docker",
        ["ps", "-q", "--filter", "label=hibana.video=true"],
        { timeout: 10000 },
      );
      if (workers.exit_code || workers.stdout.trim())
        throw new Error("Another video render is active");
      const name = `hibana-video-${crypto.randomUUID()}`;
      const command = [
        "timeout",
        "3600",
        "python3",
        "/skills/video-edit/scripts/render.py",
        "timeline.json",
      ];
      if (a.preview !== false) command.push("--preview");
      const r = await processRun("docker", [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "hibana.video=true",
        "--init",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        "--memory=1g",
        "--memory-swap=1536m",
        "--cpus=1",
        "--network",
        "bridge",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--tmpfs",
        "/tmp:rw,size=512m",
        "-e",
        "HOME=/tmp",
        "--mount",
        `type=bind,src=${join(root, "workspace")},dst=/workspace`,
        "--mount",
        `type=bind,src=${this.sandbox.config.skillsRoot},dst=/skills,readonly`,
        "--workdir",
        "/workspace",
        "hibana-video:latest",
        ...command,
      ]);
      if (r.exit_code !== 0) throw new Error(r.stderr);
      await atomicJson(statePath, {
        container: name,
        started: Date.now(),
        status: "rendering",
      });
      return { ok: true, project, status: "rendering" };
    }
    throw new Error("Unknown video action");
  }
  async github(name: string, ctx: Context) {
    const root = join(
      this.sandbox.config.dataDir,
      "gh-auth",
      ctx.guildId ? `guilds/${ctx.guildId}` : `dms/${ctx.channelId}`,
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (name === "gh_logout") {
      await rm(root, { recursive: true, force: true });
      return { ok: true };
    }
    if (name === "gh_status") {
      const file = await readFile(join(root, "hosts.yml"), "utf8").catch(
        () => "",
      );
      return { authenticated: /oauth_token:/.test(file) };
    }
    // Official GitHub CLI device OAuth app. The token is persisted only in the scoped, read-only-mounted config.
    const response = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: "Iv1.b507a08c87ecfe98",
        scope: "repo read:org gist",
      }),
    });
    if (!response.ok) throw new Error(`GitHub login HTTP ${response.status}`);
    const challenge = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
      expires_in: number;
    };
    await ctx.progress?.(
      `GitHub: ${challenge.verification_uri}\nコード: ${challenge.user_code}`,
    );
    const { sleep } = await import("../io");
    let interval = challenge.interval ?? 5;
    for (
      const deadline = Date.now() + Math.min(900, challenge.expires_in) * 1000;
      Date.now() < deadline;

    ) {
      await sleep(interval * 1000, ctx.signal);
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: "Iv1.b507a08c87ecfe98",
          device_code: challenge.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: ctx.signal,
      });
      const body = (await res.json()) as {
        access_token?: string;
        error?: string;
      };
      if (body.access_token) {
        await writeFile(
          join(root, "hosts.yml"),
          `github.com:\n    oauth_token: ${body.access_token}\n    git_protocol: https\n`,
          { mode: 0o600 },
        );
        return { ok: true, authenticated: true };
      }
      if (body.error === "slow_down") interval += 5;
      else if (body.error !== "authorization_pending")
        throw new Error("GitHub authorization denied or expired");
    }
    throw new Error("GitHub login expired");
  }
}
