import { Agent, createServer as createHttpServer, request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { chmod, unlink } from "node:fs/promises";
import { Serial } from "./io";
import { isPublicAddress } from "./network";

type Resolver = typeof lookup;

/** Resolve once on the VPS and send the checked IPv4 to the device, closing
 * both DNS-rebinding and home-LAN access paths before any home socket opens. */
export async function homeDestination(host: string, port: number, resolve: Resolver = lookup) {
  if (![80, 443].includes(port) || !host || /[\s/@\\\0]/.test(host) ||
      /(^|\.)(localhost|local|internal)$/i.test(host)) throw new Error("Destination denied");
  const rows = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true });
  if (!rows.length || rows.some(row => !isPublicAddress(row.address))) throw new Error("Destination denied");
  const row = rows.find(row => row.family === 4);
  if (!row) throw new Error("IPv4 destination required");
  const header = Buffer.alloc(8);
  header.write("HE", 0, "ascii");
  row.address.split(".").forEach((v, i) => header[i + 2] = Number(v));
  header.writeUInt16BE(port, 6);
  return header;
}

/** Drop the home tunnel after this much time without owning-task commands.
 * Work sessions may last longer than the old 15-minute hard cap; the home
 * line is released only when the operator stops issuing commands. Status
 * checks and origin keepalives do not count, so a quiet page cannot pin the
 * ISP path. Tests override `idleMs` rather than this constant. */
export const HOME_IDLE_MS = 900_000;

export type HomeEgressOptions = {
  ca: string; cert: string; key: string;
  username: string;
  tunnelHost: string; tunnelPort: number;
  proxyHost: string; proxyPort: number;
  // Dependency injection lets tests exercise real TLS without permitting LAN
  // targets in production merely to accommodate an integration fixture.
  destination?: typeof homeDestination;
  waitMs?: number;
  reclaimIdleMs?: number;
  idleMs?: number;
  controlPath?: string;
};

export function createHomeEgress(options: HomeEgressOptions) {
  if (!options.username) throw new Error("Proxy username required");
  let lease: { token: string; touched: number } | undefined;
  const lock = new Serial();
  const idleMs = options.idleMs ?? HOME_IDLE_MS;
  const idle: TLSSocket[] = [];
  const devices = new Set<TLSSocket>();
  const activity = new Map<TLSSocket, number>();
  const clients = new Set<Duplex>();
  const transports = new Set<Duplex>();
  const waiters: Array<{ resolve: (s: TLSSocket) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let closing = false;
  const authorized = (req: IncomingMessage) => {
    if (!lease) return false;
    const expected = Buffer.from("Basic " + Buffer.from(`${options.username}:${lease.token}`).toString("base64"));
    const actual = Buffer.from(req.headers["proxy-authorization"] || "");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  function take(): Promise<TLSSocket> {
    let s: TLSSocket | undefined;
    while ((s = idle.shift())) if (!s.destroyed) { s.setTimeout(0); return Promise.resolve(s); }
    if (closing || waiters.length >= 24) return Promise.reject(new Error("Home unavailable"));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: setTimeout(() => {
        const i = waiters.indexOf(entry); if (i >= 0) waiters.splice(i, 1);
        reject(new Error("Home unavailable"));
      }, options.waitMs ?? 15000) };
      waiters.push(entry);
    });
  }
  async function open(host: string, port: number) {
    const session = lease;
    if (!session) throw new Error("Home disconnected");
    const header = await (options.destination ?? homeDestination)(host, port);
    if (session !== lease) throw new Error("Home disconnected");
    const device = await take();
    if (session !== lease) { device.destroy(); throw new Error("Home disconnected"); }
    // Every TLS connection carries one target only. Closing either end releases
    // the device slot; it reconnects with a fresh authenticated TLS session.
    return new Promise<TLSSocket>((resolve, reject) => {
      const failed = () => { cleanup(); device.destroy(); reject(new Error("Home connect failed")); };
      const timer = setTimeout(failed, 12000);
      const cleanup = () => {
        clearTimeout(timer); device.off("data", ready); device.off("close", failed); device.off("error", failed);
      };
      const ready = (data: Buffer) => {
        device.pause(); cleanup();
        if (data[0] !== 0 || session !== lease) { device.destroy(); reject(new Error("Home connect denied")); return; }
        if (data.length > 1) device.unshift(data.subarray(1));
        activity.set(device, Date.now());
        device.on("data", () => { if (activity.has(device)) activity.set(device, Date.now()); });
        resolve(device);
      };
      device.once("data", ready); device.once("error", failed); device.once("close", failed);
      device.write(header); device.resume();
    });
  }
  const tunnel = createTlsServer({
    ca: options.ca, cert: options.cert, key: options.key,
    requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2", maxVersion: "TLSv1.2",
    handshakeTimeout: 10000,
  }, device => {
    if (!device.authorized || !lease || closing || devices.size >= 8) { device.destroy(); return; }
    devices.add(device); device.pause(); device.setNoDelay(true); device.setKeepAlive(true, 15000);
    // Small records bound the ESP32's receive memory. Browser TLS stays nested
    // inside this transport and is still verified by Chromium end to end.
    device.setMaxSendFragment(4096);
    device.on("error", () => device.destroy());
    device.on("close", () => {
      devices.delete(device); activity.delete(device); const i = idle.indexOf(device); if (i >= 0) idle.splice(i, 1);
    });
    const next = waiters.shift();
    if (next) { clearTimeout(next.timer); next.resolve(device); }
    else { idle.push(device); device.setTimeout(90000, () => device.destroy()); }
  });
  tunnel.on("tlsClientError", () => {}); // Authentication failures never include peer certificates in logs.
  tunnel.on("connection", socket => {
    transports.add(socket); socket.on("close", () => transports.delete(socket));
  });
  tunnel.maxConnections = 12;

  // Browsers keep idle connections per origin. With only six device lanes,
  // those sockets otherwise starve new origins until their requests time out.
  // Reclaim only under queue pressure and only after 10 seconds without bytes;
  // normal idle sessions still retain the longer 60-second timeout.
  const reclaimMs = options.reclaimIdleMs ?? 10000;
  const reclaim = setInterval(() => {
    if (!waiters.length) return;
    const candidates = [...activity.entries()].filter(([socket, last]) => !socket.destroyed && Date.now() - last >= reclaimMs);
    candidates.sort((a, b) => a[1] - b[1]);
    for (const [socket] of candidates.slice(0, waiters.length)) socket.destroy();
  }, Math.min(1000, reclaimMs));

  const proxy = createHttpServer(async (req, res) => {
    if (!authorized(req)) { res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="home-egress"' }).end(); return; }
    try {
      const url = new URL(req.url || "");
      if (url.protocol !== "http:" || url.username || url.password || req.headers.upgrade) throw new Error("Invalid proxy request");
      const device = await open(url.hostname, Number(url.port || 80));
      if (res.destroyed) { device.destroy(); return; }
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host, connection: "close" };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      // Strip headers nominated by Connection as well, so proxy auth cannot be
      // reintroduced or hop-specific metadata forwarded to the origin.
      for (const name of String(req.headers.connection || "").split(",")) {
        const key = name.trim().toLowerCase(); if (key && key !== "host") delete headers[key as keyof typeof headers];
      }
      // Use an Agent explicitly: Bun's agent:false path may open a fresh direct
      // socket instead of honoring request-level createConnection.
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => device;
      const upstream = request({ method: req.method, path: url.pathname + url.search, headers,
        agent,
      }, response => {
        res.writeHead(response.statusCode || 502, response.headers); response.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); device.destroy(); });
      res.on("close", () => { upstream.destroy(); device.destroy(); });
      device.setTimeout(60000, () => device.destroy());
      req.on("data", () => { if (activity.has(device)) activity.set(device, Date.now()); });
      req.pipe(upstream);
      device.resume();
    } catch { if (!res.headersSent) res.writeHead(503); res.end("Home connection unavailable"); }
  });
  proxy.on("connect", async (req, client, head) => {
    if (!authorized(req)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="home-egress"\r\nConnection: close\r\n\r\n'); return; }
    try {
      const match = /^([^:]+):(\d+)$/.exec(req.url || "");
      if (!match) throw new Error("Invalid CONNECT");
      const device = await open(match[1], Number(match[2]));
      if (client.destroyed) { device.destroy(); return; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) device.write(head);
      client.on("close", () => device.destroy()); device.on("close", () => client.destroy());
      client.on("data", () => { if (activity.has(device)) activity.set(device, Date.now()); });
      device.setTimeout(60000, () => device.destroy());
      client.pipe(device); device.pipe(client);
    } catch { if (!client.destroyed) client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); }
  });
  proxy.on("connection", client => {
    clients.add(client); client.on("close", () => clients.delete(client)); client.on("error", () => client.destroy());
    client.setTimeout(65000, () => client.destroy());
  });
  proxy.maxConnections = 32;
  proxy.headersTimeout = 10000; proxy.requestTimeout = 60000;
  const status = () => ({
    enabled: !!lease, connected: [...devices].filter(s => !s.destroyed).length,
    idle: idle.filter(s => !s.destroyed).length, waiting: waiters.length,
    idle_timeout_secs: idleMs / 1000,
    expires_in_secs: lease ? Math.max(0, Math.ceil((lease.touched + idleMs - Date.now()) / 1000)) : 0,
  });
  async function stop() {
    // Revoke authentication before closing sockets: a queued DNS lookup or
    // browser request must not survive disconnect and enter the next lease.
    lease = undefined;
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error("Home disconnected")); }
    for (const socket of [...devices, ...transports, ...clients]) socket.destroy();
    idle.length = 0; activity.clear();
    if (tunnel.listening) await new Promise<void>(r => tunnel.close(() => r()));
  }
  const connect = (token: string) => lock.run(async () => {
    if (closing || !/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error("Invalid session");
    if (lease && lease.token !== token) throw new Error("Home connection is busy");
    if (!lease) {
      lease = { token, touched: Date.now() };
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => reject(error);
          tunnel.once("error", failed);
          tunnel.listen(options.tunnelPort, options.tunnelHost, () => { tunnel.off("error", failed); resolve(); });
        });
      } catch (error) { lease = undefined; throw error; }
    }
    return status();
  });
  const touch = (token: string) => lock.run(async () => {
    if (!lease || lease.token !== token || Date.now() >= lease.touched + idleMs) {
      if (lease?.token === token) await stop();
      throw new Error("Home session expired; reconnect explicitly");
    }
    lease.touched = Date.now(); return status();
  });
  const disconnect = (token: string) => lock.run(async () => {
    if (lease && lease.token !== token) throw new Error("Home session belongs to another task");
    await stop(); return status();
  });
  // Independent of bot liveness and website traffic: background polling and
  // WebSockets cannot keep the home route open after the agent stops working.
  // Owning-task commands (browser, yt-dlp, bash HTTP) may renew indefinitely.
  const expiry = setInterval(() => void lock.run(async () => {
    if (lease && Date.now() >= lease.touched + idleMs) await stop();
  }), Math.min(1000, idleMs));
  const control = createHttpServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/status") { res.end(JSON.stringify(status())); return; }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new Error("Control body too large"); }
      const { token } = JSON.parse(body);
      if (typeof token !== "string") throw new Error("Invalid session");
      const action = req.url === "/connect" ? connect : req.url === "/touch" ? touch : req.url === "/disconnect" ? disconnect : undefined;
      if (!action) { res.writeHead(404).end(); return; }
      res.end(JSON.stringify(await action(token)));
    } catch { res.writeHead(409).end(JSON.stringify({ error: "Home control rejected; session expired, busy or unavailable" })); }
  });
  control.requestTimeout = 5000; control.headersTimeout = 5000;
  return {
    proxy, tunnel,
    status, connect, touch, disconnect,
    async listen() {
      await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(options.proxyPort, options.proxyHost, resolve); });
      if (options.controlPath) {
        await unlink(options.controlPath).catch(error => { if (error.code !== "ENOENT") throw error; });
        await new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(options.controlPath, resolve); });
        await chmod(options.controlPath, 0o600);
      }
    },
    async close() {
      closing = true;
      clearInterval(reclaim);
      clearInterval(expiry);
      await lock.run(stop);
      control.closeAllConnections();
      await Promise.all([new Promise<void>(r => control.close(() => r())), new Promise<void>(r => proxy.close(() => r()))]);
    },
  };
}

if (import.meta.main) {
  const required = (key: string) => { const value = process.env[key]; if (!value) throw new Error(`Missing ${key}`); return value; };
  const pem = (key: string) => Buffer.from(required(key), "base64").toString();
  const relay = createHomeEgress({
    ca: pem("HOME_RELAY_CA_B64"), cert: pem("HOME_RELAY_CERT_B64"), key: pem("HOME_RELAY_KEY_B64"),
    username: required("HOME_RELAY_USERNAME"),
    controlPath: process.env.HOME_RELAY_CONTROL_SOCKET || "/run/hibana-home-egress/control.sock",
    tunnelHost: process.env.HOME_RELAY_TUNNEL_HOST || "0.0.0.0", tunnelPort: Number(process.env.HOME_RELAY_TUNNEL_PORT || 18443),
    proxyHost: process.env.HOME_RELAY_PROXY_HOST || "172.17.0.1", proxyPort: Number(process.env.HOME_RELAY_PROXY_PORT || 18118),
  });
  await relay.listen();
  console.log("Home relay ready");
  const timer = setInterval(() => console.log(JSON.stringify(relay.status())), 60000);
  process.on("SIGTERM", async () => { clearInterval(timer); await relay.close(); process.exit(0); });
}
