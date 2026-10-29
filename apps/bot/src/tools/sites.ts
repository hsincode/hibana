import { mkdir, copyFile, lstat, rename, rm } from "node:fs/promises";
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
  /** "recording": a meeting recording's audio and transcript (#138). It
   *  lives until it expires and can be neither extended nor made permanent;
   *  the recordings' own limit bounds it, not the one for published sites. */
  retention: "ttl" | "month" | "permanent" | "recording";
  bytes: number;
  file_count: number;
};
const TOKEN = /^[a-f0-9]{16,64}$/;
// Splits STATIC_SITE_ORIGIN_TEMPLATE around {token}; the host must be matched
// as text because "{token}" itself is not a valid URL host.
function parseOrigin(template: string) {
  const m =
    /^(https?):\/\/([a-z0-9.-]*)\{token\}([a-z0-9.-]*(?::\d+)?)\/?$/i.exec(
      template.trim(),
    );
  if (!m)
    throw new Error(
      "STATIC_SITE_ORIGIN_TEMPLATE must look like https://{token}.example.com",
    );
  return {
    scheme: m[1]!.toLowerCase(),
    before: m[2]!.toLowerCase(),
    after: m[3]!.toLowerCase(),
  };
}
/** The one byte range asked for, as [first, last]; undefined for none (or
 *  one this does not serve: several ranges), null for one past the end. */
export function byteRange(
  header: string | null,
  size: number,
): [number, number] | undefined | null {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!suffix) return null;
    return [Math.max(0, size - suffix), size - 1];
  }
  const first = Number(m[1]);
  const last = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (first >= size || last < first) return null;
  return [first, last];
}
export class Sites {
  private rows: Site[] = [];
  private serial = new Serial();
  private server?: Server<undefined>;
  // Set when each site is served on its own origin. Without it every site
  // shares STATIC_SITE_BASE_URL's origin under /s/<token>/.
  private origin?: ReturnType<typeof parseOrigin>;
  readonly root: string;
  constructor(
    private config: Config,
    private sandbox: Sandbox,
  ) {
    this.root = join(config.dataDir, "sites");
    if (config.siteEnabled && config.siteOriginTemplate)
      this.origin = parseOrigin(config.siteOriginTemplate);
  }
  async load() {
    this.rows = await readJson(join(this.root, "sites.json"), []);
    // URLs follow the current configuration, so switching to per-site origins
    // moves sites published earlier as well.
    for (const site of this.rows) site.url = this.urlOf(site.token);
    await this.sweep();
  }
  private urlOf(token: string) {
    return this.origin
      ? `${this.origin.scheme}://${this.origin.before}${token}${this.origin.after}/`
      : `${this.config.siteBase.replace(/\/$/, "")}/s/${token}/`;
  }
  private tokenOfHost(host: string) {
    const o = this.origin;
    if (!o || !host.startsWith(o.before) || !host.endsWith(o.after)) return;
    const token = host.slice(o.before.length, host.length - o.after.length);
    return TOKEN.test(token) ? token : undefined;
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
  /** Whether sites are served: a recording's audio needs a place to go. */
  get serving() {
    return Boolean(this.server);
  }
  /** Bytes the live recordings take (#138). */
  recordingBytes() {
    return this.list()
      .filter((s) => s.retention === "recording")
      .reduce((n, s) => n + s.bytes, 0);
  }
  /** Removes the oldest live recording other than `except`. */
  async dropOldestRecording(except?: string) {
    return this.serial.run(async () => {
      const oldest = this.list()
        .filter((s) => s.retention === "recording" && s.token !== except)
        .sort((a, b) => a.created_at_unix - b.created_at_unix)[0];
      if (!oldest) return false;
      await rm(join(this.root, oldest.directory ?? oldest.token), {
        recursive: true,
        force: true,
      });
      this.rows = this.rows.filter((s) => s !== oldest);
      await this.save();
      return true;
    });
  }
  /** Lists a meeting recording (#138). `build` fills its directory, which
   *  becomes visible only once it is complete. */
  async addRecording(o: {
    guildId: string;
    channelId: string;
    title: string;
    expiresAt: number;
    build: (dir: string) => Promise<void>;
  }) {
    return this.serial.run(async () => {
      if (!this.server) throw new Error("Static site hosting is disabled");
      const token = crypto.randomUUID().replaceAll("-", "");
      const directory = `${token}-${crypto.randomUUID()}`;
      const target = join(this.root, directory);
      const staging = `${target}.staging`;
      await mkdir(staging, { recursive: true });
      try {
        await o.build(staging);
        await rename(staging, target);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      const files = await filesUnder(target, 1000);
      const site: Site = {
        token,
        directory,
        scope: scopeOf({
          guildId: o.guildId,
          channelId: o.channelId,
          thread: false,
        }),
        guild_id: o.guildId,
        channel_id: o.channelId,
        url: this.urlOf(token),
        source_path: o.title,
        created_at_unix: Math.floor(Date.now() / 1000),
        updated_at_unix: null,
        expires_at_unix: Math.floor(o.expiresAt / 1000),
        retention: "recording",
        bytes: files.reduce((n, f) => n + f.bytes, 0),
        file_count: files.length,
      };
      this.rows.push(site);
      await this.save();
      return site;
    });
  }
  async start() {
    if (!this.config.siteEnabled) return;
    if (!this.config.siteBase && !this.origin)
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
    const hosted = this.tokenOfHost(url.host);
    let token = hosted,
      rest = url.pathname.slice(1);
    if (!hosted) {
      const match = /^\/s\/([a-f0-9]{16,64})(?:\/(.*))?$/.exec(url.pathname);
      if (!match) return new Response("Not found", { status: 404 });
      [, token, rest = ""] = match;
    }
    const site = this.list().find((s) => s.token === token);
    if (!site) return new Response("Not found", { status: 404 });
    // URLs shared before the switch to per-site origins keep working, but
    // they are not served on the shared host, where sites would share storage.
    if (this.origin && !hosted)
      return new Response(null, {
        status: 308,
        headers: { Location: this.urlOf(site.token) + rest + url.search },
      });
    try {
      const root = join(this.root, site.directory ?? site.token);
      let file = await safePath(root, decodeURIComponent(rest || "index.html"));
      const st = await lstat(file);
      if (st.isDirectory()) file = await safePath(root, `${rest}/index.html`);
      const data = Bun.file(file);
      if (!(await data.exists()))
        return new Response("Not found", { status: 404 });
      // A recording's page fetches one chunk of a speaker's file at a time
      // (#138). One range is served; anything else gets the whole file.
      const range = byteRange(request.headers.get("range"), data.size);
      if (range === null)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${data.size}` },
        });
      const body = range ? data.slice(range[0], range[1] + 1) : data;
      return new Response(request.method === "HEAD" ? null : body, {
        status: range ? 206 : 200,
        headers: {
          "Accept-Ranges": "bytes",
          ...(range
            ? {
                "Content-Range": `bytes ${range[0]}-${range[1]}/${data.size}`,
                "Content-Length": String(range[1] - range[0] + 1),
              }
            : {}),
          "Content-Type": data.type,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          // allow-same-origin lets a site use cookies and localStorage. It is
          // given only on a site's own origin: on the shared host it would let
          // one site read another's storage. Sites on sibling subdomains still
          // share cookies set with a parent Domain attribute.
          "Content-Security-Policy": `sandbox allow-scripts allow-forms allow-downloads${hosted ? " allow-same-origin" : ""}; default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; frame-ancestors 'none'`,
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
      if (old?.retention === "recording")
        throw new Error("A meeting recording cannot be replaced");
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
      // Recordings have their own limit (#138).
      const live = this.list().filter(
        (s) => s.token !== old?.token && s.retention !== "recording",
      );
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
        url: this.urlOf(token),
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
      } else if (site.retention === "recording")
        // The room for recordings assumes each lives three days (#138).
        throw new Error(
          "A meeting recording can be neither extended nor made permanent",
        );
      else if (mode === "permanent") site.retention = "permanent";
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
