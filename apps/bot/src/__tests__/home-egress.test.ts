import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { connect, type TLSSocket } from "node:tls";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createHomeEgress, homeDestination, HOME_IDLE_MS } from "../home-egress";
import { loadConfig } from "../config";
import { homeControl } from "../tools/home";
import { Media } from "../tools/media";
import { Sandbox, sandboxProxyEnv } from "../tools/sandbox";
import { publicFetch } from "../network";
import type { Context } from "../types";
import { Hibana } from "../bot";
import pino from "pino";

let dir: string;
let relayEnv: Record<string, string>, deviceEnv: Record<string, string>;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hibana-relay-"));
  const generated = spawnSync("python3", [resolve(import.meta.dir, "../../../../devices/home-egress/provision.py"),
    "init", "--directory", dir, "--host", "127.0.0.1"], { encoding: "utf8" });
  if (generated.status !== 0) throw new Error("Test TLS identity generation failed");
  const env = async (name: string) => Object.fromEntries((await readFile(join(dir, name), "utf8")).trim().split("\n").map(line => {
    const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)];
  }));
  relayEnv = await env("relay.env"); deviceEnv = await env("device.env");
  // Each fixture uses a task credential, never a provisioned permanent proxy password.
  relayEnv.HOME_RELAY_PASSWORD = "test_" + crypto.randomUUID().replaceAll("-", "");
});
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const pem = (env: Record<string, string>, key: string) => Buffer.from(env[key], "base64").toString();
test("browser proxy configuration rejects credentials embedded in URLs", () => {
  expect(() => loadConfig({ BROWSER_PROXY_URL: "http://user:secret@127.0.0.1:18118" })).toThrow();
  expect(() => loadConfig({ BROWSER_PROXY_URL: "http://127.0.0.1:18118" })).toThrow();
  expect(loadConfig({ BROWSER_PROXY_URL: "http://127.0.0.1:18118", BROWSER_PROXY_USERNAME: "test" }).browserProxyUrl).toBe("http://127.0.0.1:18118");
});
async function start(waitMs = 200, reclaimIdleMs = 10000, activate = true, idleMs = HOME_IDLE_MS) {
  const relay = createHomeEgress({
    ca: pem(relayEnv, "HOME_RELAY_CA_B64"), cert: pem(relayEnv, "HOME_RELAY_CERT_B64"), key: pem(relayEnv, "HOME_RELAY_KEY_B64"),
    username: relayEnv.HOME_RELAY_USERNAME,
    controlPath: join(dir, `control-${crypto.randomUUID()}.sock`), idleMs,
    tunnelHost: "127.0.0.1", tunnelPort: 0, proxyHost: "127.0.0.1", proxyPort: 0, waitMs, reclaimIdleMs,
  });
  await relay.listen();
  if (activate) await relay.connect(relayEnv.HOME_RELAY_PASSWORD);
  return relay;
}
type Relay = Awaited<ReturnType<typeof start>>;
const auth = () => "Basic " + Buffer.from(`${relayEnv.HOME_RELAY_USERNAME}:${relayEnv.HOME_RELAY_PASSWORD}`).toString("base64");
function browser(relay: Relay, path = "1.1.1.1:443", authorization = auth()) {
  return new Promise<{ status: number; socket: import("node:stream").Duplex }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: (relay.proxy.address() as AddressInfo).port,
      method: "CONNECT", path, headers: { "Proxy-Authorization": authorization } });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode!, socket }));
    req.on("error", reject); req.end();
  });
}
async function device(relay: Relay, identity = true) {
  const socket = connect({ host: "127.0.0.1", port: (relay.tunnel.address() as AddressInfo).port,
    servername: "hibana-home-server", ca: pem(deviceEnv, "CA_B64"), maxVersion: "TLSv1.2",
    ...(identity ? { cert: pem(deviceEnv, "CERT_B64"), key: pem(deviceEnv, "KEY_B64") } : {}),
  });
  await new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
  return socket;
}

test("home destination rejects LAN, metadata, mapped IPv6 and mixed DNS results", async () => {
  for (const host of ["127.0.0.1", "192.168.0.1", "10.0.0.1", "169.254.169.254", "::ffff:192.168.0.1", "localhost", "router.local"]) {
    await expect(homeDestination(host, 443)).rejects.toThrow();
  }
  await expect(homeDestination("1.1.1.1", 22)).rejects.toThrow();
  const mixed = (async () => [{ address: "1.1.1.1", family: 4 }, { address: "192.168.0.1", family: 4 }]) as never;
  await expect(homeDestination("example.com", 443, mixed)).rejects.toThrow();
  expect(await homeDestination("1.1.1.1", 443)).toEqual(Buffer.from([72, 69, 1, 1, 1, 1, 1, 187]));
});

test("proxy authentication is required and missing home device fails closed", async () => {
  const relay = await start();
  try {
    const denied = await browser(relay, "1.1.1.1:443", "Basic wrong");
    expect(denied.status).toBe(407); denied.socket.destroy();
    const offline = await browser(relay);
    expect(offline.status).toBe(503); offline.socket.destroy();
    expect(relay.status().waiting).toBe(0);
  } finally { await relay.close(); }
});

test("relay requires a client certificate", async () => {
  const relay = await start();
  try { await expect(device(relay, false)).rejects.toThrow(); expect(relay.status().connected).toBe(0); }
  finally { await relay.close(); }
});

test("authenticated CONNECT preserves bytes and closes both peers", async () => {
  const relay = await start();
  let home: TLSSocket | undefined;
  try {
    home = await device(relay);
    let ready = false;
    home.on("data", data => {
      if (!ready) { expect(data).toEqual(Buffer.from([72, 69, 1, 1, 1, 1, 1, 187])); ready = true; home!.write(Buffer.from([0])); }
      else home!.write(data);
    });
    const client = await browser(relay);
    expect(client.status).toBe(200);
    const payload = Buffer.alloc(128 * 1024, 0xa5);
    const received = new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = []; let length = 0;
      client.socket.on("data", data => { parts.push(data); length += data.length; if (length === payload.length) resolve(Buffer.concat(parts)); });
      client.socket.once("error", reject);
    });
    client.socket.write(payload);
    expect(await received).toEqual(payload);
    const closed = new Promise<void>(r => home!.once("close", () => r()));
    client.socket.destroy(); await closed;
    await new Promise<void>(r => setImmediate(r));
    expect(relay.status().connected).toBe(0);
  } finally { home?.destroy(); await relay.close(); }
});

// The home line's own WAN address is public, so the range checks pass it, yet
// from inside the LAN it is the router itself (#39).
test("a destination equal to the device's own address is denied before the device hears of it", async () => {
  let ip = [127, 0, 0, 1]; // the test device connects from loopback
  const relay = createHomeEgress({
    ca: pem(relayEnv, "HOME_RELAY_CA_B64"), cert: pem(relayEnv, "HOME_RELAY_CERT_B64"), key: pem(relayEnv, "HOME_RELAY_KEY_B64"),
    username: relayEnv.HOME_RELAY_USERNAME, controlPath: join(dir, `control-${crypto.randomUUID()}.sock`),
    tunnelHost: "127.0.0.1", tunnelPort: 0, proxyHost: "127.0.0.1", proxyPort: 0, waitMs: 200,
    destination: async () => Buffer.from([72, 69, ...ip, 1, 187]),
  });
  await relay.listen(); await relay.connect(relayEnv.HOME_RELAY_PASSWORD);
  let home: TLSSocket | undefined;
  try {
    home = await device(relay);
    const headers: Buffer[] = [];
    home.on("data", (data: Buffer) => { headers.push(data); home!.write(Buffer.from([0])); });
    while (relay.status().idle !== 1) await new Promise(r => setTimeout(r, 5));
    const denied = await browser(relay);
    expect(denied.status).toBe(503); denied.socket.destroy();
    expect(headers).toEqual([]);
    // The lane was never used, so it serves the next, allowed destination.
    expect(relay.status().idle).toBe(1);
    ip = [1, 1, 1, 1];
    const allowed = await browser(relay);
    expect(allowed.status).toBe(200); allowed.socket.destroy();
    expect(headers).toEqual([Buffer.from([72, 69, 1, 1, 1, 1, 1, 187])]);
  } finally { home?.destroy(); await relay.close(); }
});

test("plain HTTP is forwarded through the device without proxy credentials", async () => {
  const relay = await start();
  let home: TLSSocket | undefined;
  try {
    home = await device(relay);
    let ready = false, incoming = "";
    home.on("data", data => {
      if (!ready) { expect(Buffer.from(data).readUInt16BE(6)).toBe(80); ready = true; home!.write(Buffer.from([0])); return; }
      incoming += data.toString();
      if (incoming.includes("\r\n\r\n")) {
        expect(incoming.toLowerCase()).not.toContain("proxy-authorization");
        expect(incoming).not.toContain(relayEnv.HOME_RELAY_PASSWORD);
        home!.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nhome");
      }
    });
    const result = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: (relay.proxy.address() as AddressInfo).port,
        path: "http://1.1.1.1/test", headers: { "Proxy-Authorization": auth() } }, response => {
        let body = ""; response.on("data", data => body += data); response.on("end", () => resolve(body));
      }); req.on("error", reject); req.end();
    });
    expect(result).toBe("home");
  } finally { home?.destroy(); await relay.close(); }
});

test("idle browser keepalives cannot starve a queued new origin", async () => {
  const relay = await start(1000, 30);
  let first: TLSSocket | undefined, replacement: TLSSocket | undefined;
  try {
    first = await device(relay);
    first.once("data", () => first!.write(Buffer.from([0])));
    const a = await browser(relay);
    expect(a.status).toBe(200);
    const reclaimed = new Promise<void>(r => first!.once("close", () => r()));
    const pending = browser(relay, "8.8.8.8:443");
    await reclaimed;
    replacement = await device(relay);
    replacement.once("data", () => replacement!.write(Buffer.from([0])));
    const b = await pending;
    expect(b.status).toBe(200);
    a.socket.destroy(); b.socket.destroy();
  } finally { first?.destroy(); replacement?.destroy(); await relay.close(); }
});

test("relay starts disconnected and rejects another task's control token", async () => {
  const relay = await start(200, 10000, false);
  try {
    expect(relay.status().enabled).toBe(false);
    expect(relay.status().idle_timeout_secs).toBe(HOME_IDLE_MS / 1000);
    expect(Boolean(relay.tunnel.listening)).toBe(false);
    const denied = await browser(relay); expect(denied.status).toBe(407); denied.socket.destroy();
    await relay.connect(relayEnv.HOME_RELAY_PASSWORD);
    await expect(relay.connect("x".repeat(43))).rejects.toThrow("busy");
    await expect(relay.disconnect("x".repeat(43))).rejects.toThrow();
    expect(relay.status().enabled).toBe(true);
    await relay.disconnect(relayEnv.HOME_RELAY_PASSWORD);
    expect(Boolean(relay.tunnel.listening)).toBe(false);
  } finally { await relay.close(); }
});

test("disconnect closes an active home tunnel and old credentials cannot enter a new lease", async () => {
  const relay = await start();
  const home = await device(relay);
  try {
    home.once("data", () => home.write(Buffer.from([0])));
    const client = await browser(relay); expect(client.status).toBe(200);
    const closed = new Promise<void>(r => home.once("close", () => r()));
    await relay.disconnect(relayEnv.HOME_RELAY_PASSWORD); await closed;
    expect(relay.status().enabled).toBe(false);
    await relay.connect("x".repeat(43));
    const stale = await browser(relay); expect(stale.status).toBe(407);
    stale.socket.destroy(); client.socket.destroy();
  } finally { home.destroy(); await relay.close(); }
});

test("website traffic does not extend the idle lease", async () => {
  const relay = await start(200, 10000, true, 120);
  const home = await device(relay);
  let send: ReturnType<typeof setInterval> | undefined;
  try {
    let started = false;
    home.on("data", data => { if (!started) { started = true; home.write(Buffer.from([0])); } else home.write(data); });
    const client = await browser(relay); expect(client.status).toBe(200);
    client.socket.on("data", () => {});
    const closed = new Promise<void>(r => home.once("close", () => r()));
    send = setInterval(() => client.socket.write("keepalive"), 10);
    await closed;
    expect(relay.status().enabled).toBe(false);
    expect(Boolean(relay.tunnel.listening)).toBe(false);
    client.socket.destroy();
  } finally { clearInterval(send); home.destroy(); await relay.close(); }
});

test("sandbox proxy env encodes home credentials without embedding them in the origin", () => {
  const env = sandboxProxyEnv({ server: "http://172.17.0.1:18118", username: "hibana", password: "tok_ab-c" });
  expect(env.HTTPS_PROXY).toBe("http://hibana:tok_ab-c@172.17.0.1:18118");
  expect(env.http_proxy).toBe(env.HTTPS_PROXY);
  expect(env.NO_PROXY).toContain("localhost");
  expect(() => sandboxProxyEnv({ server: "http://user:pass@127.0.0.1:18118", username: "a", password: "b" })).toThrow();
});

test("browser commands keep a work session alive until the idle window elapses", async () => {
  const relay = await start(200, 10000, true, 80);
  try {
    await relay.touch(relayEnv.HOME_RELAY_PASSWORD);
    await Bun.sleep(50);
    await relay.touch(relayEnv.HOME_RELAY_PASSWORD);
    expect(relay.status().enabled).toBe(true);
    await Bun.sleep(120);
    await expect(relay.touch(relayEnv.HOME_RELAY_PASSWORD)).rejects.toThrow("expired");
    expect(relay.status().enabled).toBe(false);
    expect(Boolean(relay.tunnel.listening)).toBe(false);
  } finally { await relay.close(); }
});

test("task ownership, turn cleanup and status preserve an exclusive home session", async () => {
  const path = join(dir, `bot-${crypto.randomUUID()}.sock`);
  const relay = createHomeEgress({ca:pem(relayEnv,"HOME_RELAY_CA_B64"),cert:pem(relayEnv,"HOME_RELAY_CERT_B64"),key:pem(relayEnv,"HOME_RELAY_KEY_B64"),
    username:relayEnv.HOME_RELAY_USERNAME,tunnelHost:"127.0.0.1",tunnelPort:0,proxyHost:"127.0.0.1",proxyPort:0,controlPath:path});
  await relay.listen();
  const media = new Media(new Sandbox(loadConfig({BROWSER_PROXY_URL:"http://127.0.0.1:18118",BROWSER_PROXY_USERNAME:"hibana",HOME_RELAY_CONTROL_SOCKET:path})));
  const ctx: Context = {channelId:"100",userId:"200",botId:"300",thread:false,depth:0,delivered:false};
  let home: TLSSocket | undefined;
  try {
    const connecting = media.homeCommand("home_vpn_connect",ctx);
    while (!relay.tunnel.listening) await Bun.sleep(5);
    home = await device(relay);
    const result = await connecting;
    expect(result.enabled).toBe(true);
    expect(result.idle_timeout_secs).toBe(HOME_IDLE_MS / 1000);
    expect(JSON.stringify(result)).not.toContain("token");
    await expect(media.homeCommand("home_vpn_disconnect",{...ctx})).rejects.toThrow();
    await media.finishHome({...ctx});
    expect(relay.status().enabled).toBe(true);
    await media.finishHome(ctx);
    expect(relay.status().enabled).toBe(false);
    expect((await homeControl(path,"status")).connected).toBe(0);
    expect(Boolean(relay.tunnel.listening)).toBe(false);
  } finally { home?.destroy(); await media.close(); await relay.close(); }
});

test("owning-task yt-dlp-style work keeps the home lease; other tasks do not", async () => {
  const path = join(dir, `work-${crypto.randomUUID()}.sock`);
  const relay = createHomeEgress({ca:pem(relayEnv,"HOME_RELAY_CA_B64"),cert:pem(relayEnv,"HOME_RELAY_CERT_B64"),key:pem(relayEnv,"HOME_RELAY_KEY_B64"),
    username:relayEnv.HOME_RELAY_USERNAME,tunnelHost:"127.0.0.1",tunnelPort:0,proxyHost:"127.0.0.1",proxyPort:0,controlPath:path,idleMs:800});
  await relay.listen();
  const media = new Media(new Sandbox(loadConfig({BROWSER_PROXY_URL:"http://127.0.0.1:18118",BROWSER_PROXY_USERNAME:"hibana",HOME_RELAY_CONTROL_SOCKET:path})));
  const ctx: Context = {channelId:"100",userId:"200",botId:"300",thread:false,depth:0,delivered:false};
  let home: TLSSocket | undefined;
  try {
    const connecting = media.homeCommand("home_vpn_connect",ctx);
    while (!relay.tunnel.listening) await Bun.sleep(5);
    home = await device(relay);
    await connecting;
    expect(media.homeRoute(ctx)?.server).toBe("http://127.0.0.1:18118");
    expect(media.homeRoute({...ctx})).toBeUndefined();
    const stop = media.beginHomeWork(ctx, 50);
    await Bun.sleep(1000);
    expect(relay.status().enabled).toBe(true);
    stop();
    media.beginHomeWork({...ctx}, 50);
    await Bun.sleep(1000);
    expect(relay.status().enabled).toBe(false);
  } finally { home?.destroy(); await media.close(); await relay.close(); }
}, 15000);

test("host downloads through the home proxy require this task's credential", async () => {
  const relay = await start();
  let home: TLSSocket | undefined;
  try {
    home = await device(relay);
    let ready = false, incoming = "";
    home.on("data", data => {
      if (!ready) { expect(Buffer.from(data).readUInt16BE(6)).toBe(80); ready = true; home!.write(Buffer.from([0])); return; }
      incoming += data.toString();
      if (incoming.includes("\r\n\r\n")) {
        expect(incoming.toLowerCase()).not.toContain("proxy-authorization");
        home!.end("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nhome");
      }
    });
    const port = (relay.proxy.address() as AddressInfo).port;
    const body = await (await publicFetch("http://1.1.1.1/test", {}, 1024, {
      host: "127.0.0.1", port, username: relayEnv.HOME_RELAY_USERNAME, password: relayEnv.HOME_RELAY_PASSWORD,
    })).text();
    expect(body).toBe("home");
    await expect(publicFetch("http://1.1.1.1/test", {}, 1024, { host: "127.0.0.1", port })).rejects.toThrow();
  } finally { home?.destroy(); await relay.close(); }
});

test("home tools require an administrator parent task and turn cleanup runs after errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibana-home-turn-"));
  const bot = new Hibana(loadConfig({HIBANA_DATA_DIR:root,LOG_DIR:"",SKILLS_ENABLED:"false",
    BROWSER_PROXY_URL:"http://127.0.0.1:18118",BROWSER_PROXY_USERNAME:"hibana"}),pino({enabled:false}));
  const ctx: Context = {channelId:"100",userId:"200",botId:"300",thread:false,depth:0,delivered:false};
  let cleanups = 0;
  const original = bot.tools.media.finishHome.bind(bot.tools.media);
  bot.tools.media.finishHome = async current => { expect(current.channelId).toBe(ctx.channelId); cleanups++; await original(current); };
  bot.tools.sandbox.available = true;
  bot.client.channels.fetch = (async () => ({id:ctx.channelId,isSendable:()=>true,
    send:async()=>({id:"1",edit:async()=>{}}),sendTyping:async()=>{}})) as never;
  try {
    expect(bot.tools.base(ctx).some(t=>t.function.name==="home_vpn_connect")).toBe(false);
    await expect(bot.tools.execute("home_vpn_connect",{},ctx)).rejects.toThrow();
    bot.runtime.snapshot.user_roles[ctx.userId]="administrator";
    expect(bot.tools.base(ctx).some(t=>t.function.name==="home_vpn_connect")).toBe(true);
    expect(bot.tools.base({...ctx,depth:1}).some(t=>t.function.name.startsWith("home_vpn_"))).toBe(false);
    await expect(bot.tools.execute("home_vpn_connect",{},{...ctx,depth:1})).rejects.toThrow();
    bot.llm.complete = async () => {throw new Error("simulated provider failure");};
    await bot.respond("test",ctx);
    expect(cleanups).toBe(1);
    bot.llm.complete = async () => ({message:{role:"assistant",content:"完了しました。"},usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cached_tokens:0},incomplete:false});
    await bot.respond("test again",ctx);
    expect(cleanups).toBe(2);
  } finally {await bot.close();await rm(root,{recursive:true,force:true});}
});
