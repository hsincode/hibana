import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  readdir,
  rm,
  utimes,
  realpath,
} from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { Config } from "../config";
import type { Context } from "../types";
import { Serial } from "../io";
export function quote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
/** Env for curl/yt-dlp when this task owns the home lease. Values are passed
 * to Docker as `-e NAME` so the password is not in container argv. */
export function sandboxProxyEnv(proxy: {
  server: string;
  username: string;
  password: string;
}) {
  const origin = new URL(proxy.server);
  if (origin.protocol !== "http:" || origin.username || origin.password)
    throw new Error("Invalid home proxy origin");
  const value = `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${origin.host}`;
  return {
    HTTP_PROXY: value,
    HTTPS_PROXY: value,
    http_proxy: value,
    https_proxy: value,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };
}
export async function processRun(
  command: string,
  args: string[],
  options: {
    timeout?: number;
    signal?: AbortSignal;
    maxOutput?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onExit?: (details: { elapsed_ms: number; exit_code: number | null; termination: string; signal: string | null }) => void;
  } = {},
) {
  return new Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }>((resolveResult, reject) => {
    const started = performance.now();
    let timedOut = false, reported = false;
    const report = (code: number | null, signal: string | null, failed = false) => {
      if (reported) return;
      reported = true;
      // Preserve the actual cause: signal exits also map to 124 in the legacy result.
      options.onExit?.({ elapsed_ms: Math.round(performance.now() - started), exit_code: code,
        termination: timedOut ? "command_timeout" : options.signal?.aborted ? "parent_abort"
          : failed ? "process_error" : signal ? "signal" : "exit", signal });
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    const max = options.maxOutput ?? 40000;
    let stdout = "",
      stderr = "",
      truncated = false;
    const add = (key: "stdout" | "stderr", chunk: Buffer) => {
      const s = chunk.toString();
      if ((key === "stdout" ? stdout : stderr).length + s.length > max)
        truncated = true;
      if (key === "stdout") stdout = (stdout + s).slice(0, max);
      else stderr = (stderr + s).slice(0, max);
    };
    child.stdout.on("data", (b) => add("stdout", b));
    child.stderr.on("data", (b) => add("stderr", b));
    const timer = setTimeout(
      () => { timedOut = true; child.kill("SIGKILL"); },
      options.timeout ?? 120000,
    );
    child.on("error", (e) => {
      clearTimeout(timer);
      report(null, null, true);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      report(code, signal);
      resolveResult({ exit_code: code ?? 124, stdout, stderr, truncated });
    });
  });
}
export function scopeOf(
  ctx: Pick<Context, "guildId" | "channelId" | "thread">,
) {
  const id = ctx.thread ? ctx.channelId : (ctx.guildId ?? ctx.channelId);
  if (!/^\d{1,25}$/.test(id)) throw new Error("Invalid Discord scope");
  return `${ctx.thread ? "threads" : ctx.guildId ? "guilds" : "dms"}/${id}`;
}
/** Reject every symlink component, including dangling links. All host-side tools use this jail. */
export async function safePath(
  root: string,
  raw: string,
  allowRoot = false,
): Promise<string> {
  if (raw.includes("\0") || raw.includes("\\")) throw new Error("Invalid path");
  const name =
    raw === "/workspace"
      ? "."
      : raw.startsWith("/workspace/")
        ? raw.slice(11)
        : raw;
  if (name.startsWith("/")) throw new Error("Path must be inside /workspace");
  const base = resolve(root),
    target = resolve(base, name),
    rel = relative(base, target);
  if (rel === ".." || rel.startsWith("../") || (!allowRoot && !rel))
    throw new Error("Path escapes workspace");
  let cursor = base;
  for (const part of ["", ...rel.split("/").filter(Boolean)]) {
    if (part) cursor = join(cursor, part);
    try {
      const st = await lstat(cursor);
      if (st.isSymbolicLink()) throw new Error("Symlinks are not allowed");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return target;
}
export async function filesUnder(
  root: string,
  max = 1000,
): Promise<{ path: string; bytes: number; mtime: number }[]> {
  const out: { path: string; bytes: number; mtime: number }[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= max) throw new Error("Too many workspace files");
      if (e.isSymbolicLink()) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) {
        const st = await lstat(path);
        out.push({
          path: relative(root, path),
          bytes: st.size,
          mtime: st.mtimeMs,
        });
      }
    }
  };
  try {
    await walk(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return out;
}
export class Sandbox {
  available = false;
  private locks = new Map<string, Serial>();
  private active = new Set<string>();
  private leases = new Map<string, number>();
  network = "bridge";
  constructor(readonly config: Config) {}
  async probe() {
    if (!this.config.sandboxEnabled) return;
    try {
      const r = await processRun(
        "docker",
        ["image", "inspect", this.config.sandboxImage],
        { timeout: 10000, maxOutput: 100 },
      );
      this.available = r.exit_code === 0;
    } catch {
      this.available = false;
    }
    await mkdir(this.config.workspaceRoot, { recursive: true, mode: 0o700 });
  }
  async root(ctx: Context) {
    const path = await safePath(this.config.workspaceRoot, scopeOf(ctx));
    await mkdir(path, { recursive: true, mode: 0o700 });
    await utimes(path, new Date(), new Date());
    return path;
  }
  async path(ctx: Context, path: string, allowRoot = false) {
    return safePath(await this.root(ctx), path, allowRoot);
  }
  async locked<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
    const key = scopeOf(ctx);
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Serial();
      this.locks.set(key, lock);
    }
    return lock.run(fn);
  }
  lease(ctx: Context) {
    const key = scopeOf(ctx);
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(key) ?? 1) - 1;
      if (count) this.leases.set(key, count);
      else this.leases.delete(key);
    };
  }
  async sweep() {
    if (!this.config.workspaceTtl) return;
    for (const kind of ["guilds", "threads", "dms"])
      for (const entry of await readdir(join(this.config.workspaceRoot, kind), {
        withFileTypes: true,
      }).catch(() => [])) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const key = `${kind}/${entry.name}`,
          path = join(this.config.workspaceRoot, key);
        const stat = await lstat(path).catch(() => null);
        if (
          stat &&
          Date.now() - stat.mtimeMs > this.config.workspaceTtl &&
          !this.leases.has(key)
        ) {
          await rm(path, { recursive: true, force: true });
          this.locks.delete(key);
        }
      }
  }
  async quota(root: string, additional = 0) {
    const local = (await filesUnder(root, 100000)).reduce(
      (n, f) => n + f.bytes,
      0,
    );
    const total = (await filesUnder(this.config.workspaceRoot, 300000)).reduce(
      (n, f) => n + f.bytes,
      0,
    );
    if (
      local + additional > this.config.workspaceMaxBytes ||
      total + additional > this.config.workspaceMaxTotalBytes
    )
      throw new Error("Workspace storage quota exceeded");
  }
  async run(
    ctx: Context,
    command: string,
    timeoutSecs = 120,
    workdir = "/workspace",
    proxy?: { server: string; username: string; password: string },
  ) {
    if (!this.available) throw new Error("Docker sandbox is unavailable");
    if (!command.trim()) throw new Error("Command is required");
    const root = await this.root(ctx);
    await this.quota(root);
    const cwd = await safePath(root, workdir, true);
    const containerCwd =
      "/workspace" + (relative(root, cwd) ? "/" + relative(root, cwd) : "");
    const name = `hibana-${crypto.randomUUID()}`;
    this.active.add(name);
    const release = this.lease(ctx);
    const uid = process.getuid?.() ?? 1000,
      gid = process.getgid?.() ?? 1000;
    const proxyEnv = proxy ? sandboxProxyEnv(proxy) : undefined;
    const args = [
      "run",
      "--rm",
      "--name",
      name,
      "--init",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=512m",
      "--memory-swap=768m",
      "--cpus=1",
      "--network",
      // Home proxy lives on the Docker bridge. Joining hibana-vpn would make
      // yt-dlp/curl depend on Surfshark and unable to reach 172.17.0.1.
      proxy ? "bridge" : this.network,
      "--user",
      `${uid}:${gid}`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--mount",
      `type=bind,src=${root},dst=/workspace`,
      "--workdir",
      containerCwd,
      "-e",
      "HOME=/tmp",
      "-e",
      "TMPDIR=/tmp",
      ...(proxyEnv ? Object.keys(proxyEnv).flatMap((key) => ["-e", key]) : []),
    ];
    try {
      if ((await lstat(this.config.skillsRoot)).isDirectory())
        args.push(
          "--mount",
          `type=bind,src=${await realpath(this.config.skillsRoot)},dst=/skills,readonly`,
        );
    } catch {}
    await mkdir(this.config.skillCacheRoot, { recursive: true, mode: 0o700 });
    args.push(
      "--mount",
      `type=bind,src=${this.config.skillCacheRoot},dst=/skill-cache`,
      "-e",
      "NEKO_MEME_DIR=/skill-cache/neko-meme",
    );
    const auth = resolve(
      this.config.dataDir,
      "gh-auth",
      ctx.guildId ? `guilds/${ctx.guildId}` : `dms/${ctx.channelId}`,
    );
    try {
      if ((await lstat(auth)).isDirectory())
        args.push(
          "--mount",
          `type=bind,src=${auth},dst=/gh-auth,readonly`,
          "-e",
          "GH_CONFIG_DIR=/gh-auth",
        );
    } catch {}
    args.push(this.config.sandboxImage, "bash", "-lc", command);
    try {
      return await processRun("docker", args, {
        timeout: Math.max(1, Math.min(360, timeoutSecs)) * 1000,
        signal: ctx.signal,
        env: { ...process.env, ...proxyEnv },
      });
    } finally {
      await processRun("docker", ["rm", "-f", name], {
        timeout: 10000,
        maxOutput: 1000,
      }).catch(() => {});
      this.active.delete(name);
      release();
    }
  }
  async read(ctx: Context, path: string, offset = 0, limit = 40000) {
    const p = await this.path(ctx, path);
    const st = await lstat(p);
    if (!st.isFile() || st.size > 8 * 1024 * 1024)
      throw new Error("File too large or not a regular file");
    const text = await readFile(p, "utf8");
    return {
      path,
      content: text.slice(offset, offset + Math.min(limit, 80000)),
      truncated: offset + limit < text.length,
    };
  }
  async write(ctx: Context, path: string, content: string) {
    return this.locked(ctx, async () => {
      const p = await this.path(ctx, path);
      await this.quota(await this.root(ctx), Buffer.byteLength(content));
      await mkdir(dirname(p), { recursive: true });
      await safePath(await this.root(ctx), path);
      await writeFile(p, content, { mode: 0o600 });
      return { ok: true, path, bytes: Buffer.byteLength(content) };
    });
  }
  async edit(
    ctx: Context,
    path: string,
    oldText: string,
    newText: string,
    all = false,
  ) {
    return this.locked(ctx, async () => {
      const p = await this.path(ctx, path);
      const content = await readFile(p, "utf8");
      if (!oldText) throw new Error("old_text must not be empty");
      const count = content.split(oldText).length - 1;
      if (!count || (count > 1 && !all))
        throw new Error(`Expected unique match; found ${count}`);
      const next = all
        ? content.replaceAll(oldText, newText)
        : content.replace(oldText, newText);
      await this.quota(
        await this.root(ctx),
        Math.max(0, Buffer.byteLength(next) - Buffer.byteLength(content)),
      );
      await writeFile(p, next);
      return { ok: true, path, replacements: all ? count : 1 };
    });
  }
  async list(ctx: Context, path = ".") {
    const root = await this.path(ctx, path, true);
    return { files: await filesUnder(root, 10000) };
  }
  async removeThread(channelId: string) {
    if (!/^\d+$/.test(channelId)) return;
    await rm(
      await safePath(this.config.workspaceRoot, `threads/${channelId}`),
      { recursive: true, force: true },
    );
  }
  async close() {
    await Promise.all(
      [...this.active].map((name) =>
        processRun("docker", ["rm", "-f", name], { timeout: 10000 }).catch(
          () => {},
        ),
      ),
    );
  }
}
