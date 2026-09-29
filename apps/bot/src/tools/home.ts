import { request } from "node:http";
import { randomBytes } from "node:crypto";
import type { Config } from "../config";
import { contextTask, type Context } from "../types";
import { sleep } from "../io";
import { HOME_IDLE_MS } from "../home-egress";

export type HomeStatus = {
  enabled: boolean; connected: number; idle: number; waiting: number;
  idle_timeout_secs: number; expires_in_secs: number;
};
export type HomeProxy = { server: string; username: string; password: string };
export function homeControl(socketPath: string, action: string, token?: string): Promise<HomeStatus> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/${action}`, method: action === "status" ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
    }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; if (data.length > 4096) req.destroy(new Error("Invalid home control response")); });
      res.on("end", () => {
        if (res.statusCode !== 200) { reject(new Error("Home route unavailable, busy or expired; check status and reconnect explicitly")); return; }
        try { resolve(JSON.parse(data)); } catch { reject(new Error("Invalid home control response")); }
      });
      res.on("error", reject);
    });
    req.on("error", () => reject(new Error("Home relay control unavailable")));
    req.setTimeout(5000, () => req.destroy());
    req.end(token ? JSON.stringify({ token }) : undefined);
  });
}

/** Media serializes this state together with browser lifecycle operations.
 * Task identity survives scoped Jev context copies, so another turn by the same user cannot
 * inherit a home session or have its browser closed by stale cleanup. */
export class HomeSession {
  private session?: { ctx: Context; token: string; touched: number };
  constructor(private config: Config,
    private control = (action: string, token?: string) => homeControl(config.homeControlSocket, action, token)) {}
  owns(ctx: Context) {
    return !!this.session && contextTask(this.session.ctx) === contextTask(ctx);
  }
  get active() { return !!this.session; }
  // Match the relay idle window so a hung turn cannot keep the ISP path
  // after the system-side lease has already been dropped.
  get expired() { return !!this.session && Date.now() - this.session.touched >= HOME_IDLE_MS; }
  proxy(ctx: Context) {
    if (!this.session) return undefined;
    if (!this.owns(ctx)) throw new Error("Home browser belongs to another task");
    return this.credentials();
  }
  // Other tasks keep the Surfshark/direct route. Only the owner may learn
  // the short-lived credential used by yt-dlp, bash HTTP(S) and Playwright.
  route(ctx: Context): HomeProxy | undefined {
    return this.owns(ctx) ? this.credentials() : undefined;
  }
  private credentials(): HomeProxy | undefined {
    if (!this.session) return undefined;
    return { server: this.config.browserProxyUrl, username: this.config.browserProxyUsername, password: this.session.token };
  }
  async status(ctx: Context) {
    const state = await this.control("status");
    return { ...state, owned_by_this_task: this.owns(ctx), route: this.owns(ctx) && state.enabled ? "home" : "normal" };
  }
  async connect(ctx: Context) {
    if (this.session) {
      if (!this.owns(ctx)) throw new Error("Home connection is busy in another task");
      await this.touch(ctx); return this.status(ctx);
    }
    ctx.signal?.throwIfAborted();
    const token = randomBytes(32).toString("base64url");
    this.session = { ctx, token, touched: Date.now() };
    try {
      await this.control("connect", token);
      // The device polls a closed listener while disconnected. Wait for a
      // real authenticated lane, not just a successful control response.
      // Touch each poll so a slow ESP32 handshake cannot trip the idle
      // window before the first browser or yt-dlp command.
      for (let i = 0; i < 60; i++) {
        await this.touch(ctx);
        const state = await this.control("status");
        if (state.enabled && state.connected > 0) return this.status(ctx);
        await sleep(500, ctx.signal);
      }
      throw new Error("Home device did not connect within 30 seconds");
    } catch (error) { await this.disconnect().catch(() => {}); throw error; }
  }
  async touch(ctx: Context) {
    if (!this.session) return;
    if (!this.owns(ctx)) throw new Error("Home browser belongs to another task");
    await this.control("touch", this.session.token);
    this.session.touched = Date.now();
  }
  async disconnect() {
    const session = this.session;
    this.session = undefined;
    if (session) await this.control("disconnect", session.token);
  }
}
