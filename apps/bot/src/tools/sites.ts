import { mkdir, copyFile, readFile, lstat, rm } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import type { Server } from "bun";
import type { Config } from "../config";
import type { Context } from "../types";
import { atomicJson, readJson, Serial } from "../io";
import { filesUnder, safePath, scopeOf, type Sandbox } from "./sandbox";
export type Site = {
  token: string;
  directory?: string;
  scope: string;
  guild_id: string | null;
  channel_id: string;
  url: string;
  source_path: string;
  created_at_unix: number;
  updated_at_unix: number | null;
  expires_at_unix: number;
  retention: "ttl" | "month" | "permanent";
  bytes: number;
  file_count: number;
};
export class Sites {
  private rows: Site[] = [];
  private serial = new Serial();
  private server?: Server<undefined>;
  readonly root: string;
  constructor(
    private config: Config,
    private sandbox: Sandbox,
  ) {
    this.root = join(config.dataDir, "sites");
  }
  async load() {
    this.rows = await readJson(join(this.root, "sites.json"), []);
    await this.sweep();
  }
  async sweep() {
    return this.serial.run(async () => {
      const now = Date.now() / 1000,
        expired = this.rows.filter(
          (s) =>
            s.retention !== "permanent" &&
            s.expires_at_unix !== 0 &&
            s.expires_at_unix <= now,
        );
      if (!expired.length) return;
      for (const site of expired)
        await rm(join(this.root, site.directory ?? site.token), {
          recursive: true,
          force: true,
        });
      this.rows = this.rows.filter((s) => !expired.includes(s));
      await this.save();
    });
  }
  list(ctx?: Context) {
    return this.rows.filter(
      (s) =>
        (!ctx || s.scope === scopeOf(ctx)) &&
        (s.retention === "permanent" ||
          s.expires_at_unix === 0 ||
          s.expires_at_unix > Date.now() / 1000),
    );
  }
  async save() {
    await atomicJson(join(this.root, "sites.json"), this.rows);
  }
  async start() {
    if (!this.config.siteEnabled) return;
    if (!this.config.siteBase)
      throw new Error("STATIC_SITE_BASE_URL is required");
    const u = new URL(`http://${this.config.siteBind}`);
    this.server = Bun.serve({
      hostname: u.hostname,
      port: Number(u.port),
      fetch: (request) => this.serve(request),
    });
  }
  async serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/s\/([a-f0-9]{16,64})(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const site = this.list().find((s) => s.token === match[1]);
    if (!site) return new Response("Not found", { status: 404 });
    try {
      const root = join(this.root, site.directory ?? site.token);
      let file = await safePath(
        root,
        decodeURIComponent(match[2] || "index.html"),
      );
      const st = await lstat(file);
      if (st.isDirectory())
        file = await safePath(root, `${match[2]}/index.html`);
      const data = Bun.file(file);
      if (!(await data.exists()))
        return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : data, {
        headers: {
          "Content-Type": data.type,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "sandbox allow-scripts allow-forms allow-downloads; default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; frame-ancestors 'none'",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }
  async publish(ctx: Context, path: string, token?: string) {
    return this.serial.run(async () => {
      if (!this.config.siteEnabled || !this.server)
        throw new Error("Static site hosting is disabled");
      const old = token
        ? this.rows.find((s) => s.token === token && s.scope === scopeOf(ctx))
        : undefined;
      if (token && !old) throw new Error("Site not found in this workspace");
      const source = await this.sandbox.path(ctx, path, true),
        st = await lstat(source);
      const files = st.isDirectory()
        ? await filesUnder(source, 1000)
        : [{ path: "index.html", bytes: st.size, mtime: st.mtimeMs }];
      if (!st.isDirectory() && !/\.html?$/i.test(source))
        throw new Error("Publish a directory or HTML file");
      if (!files.some((f) => f.path === "index.html"))
        throw new Error("Site requires index.html");
      const bytes = files.reduce((n, f) => n + f.bytes, 0);
      if (bytes > this.config.siteMaxBytes)
        throw new Error("Site exceeds publication size limit");
      const live = this.list().filter((s) => s.token !== old?.token);
      if (
        live.filter((s) => s.scope === scopeOf(ctx)).length >=
          this.config.siteMaxCount ||
        live.reduce((n, s) => n + s.bytes, 0) + bytes >
          this.config.siteMaxTotalBytes
      )
        throw new Error("Published site quota exceeded");
      token = old?.token ?? crypto.randomUUID().replaceAll("-", "");
      const directory = `${token}-${crypto.randomUUID()}`;
      const target = join(this.root, directory);
      const staging = join(this.root, `${directory}.staging`);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      for (const file of files) {
        if (file.path.split("/").some((p) => p.startsWith("."))) continue;
        const from = st.isDirectory()
          ? await safePath(source, file.path)
          : source;
        const to = await safePath(staging, file.path);
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
      }
      // Each publication is independent of workspace TTL and verified before becoming visible.
      const { rename } = await import("node:fs/promises");
      await rename(staging, target);
      const now = Math.floor(Date.now() / 1000);
      const site: Site = {
        token,
        directory,
        scope: scopeOf(ctx),
        guild_id: ctx.guildId ?? null,
        channel_id: ctx.channelId,
        url: `${this.config.siteBase.replace(/\/$/, "")}/s/${token}/`,
        source_path: path,
        created_at_unix: old?.created_at_unix ?? now,
        updated_at_unix: old ? now : null,
        expires_at_unix:
          old?.retention === "month"
            ? Math.max(old.expires_at_unix, now + this.config.siteTtl)
            : this.config.siteTtl
              ? now + this.config.siteTtl
              : 0,
        retention: old?.retention ?? "ttl",
        bytes,
        file_count: files.length,
      };
      this.rows = this.rows.filter((s) => s.token !== token);
      this.rows.push(site);
      await this.save();
      if (old)
        await rm(join(this.root, old.directory ?? old.token), {
          recursive: true,
          force: true,
        });
      ctx.delivered = true;
      return { ok: true, ...site };
    });
  }
  async mutate(ctx: Context, token: string, mode: string) {
    return this.serial.run(async () => {
      const site = this.rows.find(
        (s) => s.token === token && s.scope === scopeOf(ctx),
      );
      if (!site) throw new Error("Site not found in this workspace");
      if (mode === "delete") {
        await rm(join(this.root, site.directory ?? site.token), {
          recursive: true,
          force: true,
        });
        this.rows = this.rows.filter((s) => s !== site);
      } else if (mode === "permanent") site.retention = "permanent";
      else if (mode === "month" && site.retention === "permanent")
        return { ok: true, note: "Already permanent" };
      else if (mode === "month" || mode === "unpermanent") {
        site.retention = "month";
        site.expires_at_unix =
          Math.max(Math.floor(Date.now() / 1000), site.expires_at_unix) +
          30 * 86400;
      } else throw new Error("Unknown retention mode");
      await this.save();
      return { ok: true };
    });
  }
  async applyCommand(command: {
    token: string;
    guild_id: string | null;
    action: string;
  }) {
    const site = this.rows.find(
      (s) => s.token === command.token && s.guild_id === command.guild_id,
    );
    if (!site) throw new Error("Site not found");
    return this.mutate(
      {
        guildId: site.guild_id ?? undefined,
        channelId: site.channel_id,
        thread: site.scope.startsWith("threads/"),
        userId: "0",
        botId: "0",
        depth: 0,
        delivered: false,
      },
      site.token,
      command.action,
    );
  }
  stop() {
    this.server?.stop();
  }
}
