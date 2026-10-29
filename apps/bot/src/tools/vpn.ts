import { setPublicProxy } from "../network";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Config } from "../config";
import type { Context, Json } from "../types";
import { sleep, readJson, atomicJson } from "../io";
import { processRun, type Sandbox } from "./sandbox";
import {
  fetchVpnGateCsv,
  parseVpnGateCsv,
  sanitizeOpenVpnConfig,
  selectVpnGateRelay,
  vpnGateCountry,
} from "./vpngate";

type VpnState = {
  provider?: string;
  server?: string;
  country?: string;
  host?: string;
  ip?: string;
  score?: number;
};

type VpnStatus = VpnState & {
  connected: boolean;
  status?: string;
};

type ContainerState = { Running?: boolean; Health?: { Status?: string } };

/** How long a restarted bot waits for a VPN that is not healthy yet. The
 * longest connect (VPN Gate) waits 90 seconds; this leaves some room. */
export const VPN_RESTORE_MS = 120_000;

async function inspectVpn(): Promise<ContainerState | undefined> {
  const r = await processRun(
    "docker",
    ["inspect", "-f", "{{json .State}}", "hibana-vpn"],
    { timeout: 10000, maxOutput: 2000 },
  ).catch(() => null);
  if (!r || r.exit_code) return undefined;
  return JSON.parse(r.stdout);
}

export class Vpn {
  /** The background wait of `load`, for tests and for nothing else. */
  restoring?: Promise<void>;
  private restore = new AbortController();
  private log?: Logger;
  private inspect: () => Promise<ContainerState | undefined>;
  private restorePollMs: number;
  constructor(
    private config: Config,
    private sandbox: Sandbox,
    options: {
      log?: Logger;
      // Tests script the container's state instead of running Docker.
      inspect?: () => Promise<ContainerState | undefined>;
      restorePollMs?: number;
    } = {},
  ) {
    this.log = options.log;
    this.inspect = options.inspect ?? inspectVpn;
    this.restorePollMs = options.restorePollMs ?? 2000;
  }
  /** A deploy restarts the bot but leaves the hibana-vpn container running,
   * so its route is put back here (#130). A container that is still starting
   * (a connect the restart cut off) or briefly unhealthy is waited for in the
   * background: startup is not held up, and nothing goes through the
   * container before its tunnel is up, since until then its own default
   * route is the direct one. */
  async load() {
    if (!this.config.vpnEnabled) return;
    const now = await this.status();
    if (now.connected) {
      this.attach();
      this.log?.info({ server: now.server }, "VPN route restored");
      return;
    }
    if (now.status !== "starting" && now.status !== "unhealthy") return;
    this.restoring = this.waitAndAttach(this.restore.signal).catch((error) => {
      if (!this.restore.signal.aborted)
        this.log?.error(
          { error: error instanceof Error ? error.message : String(error) },
          "VPN route restore failed",
        );
    });
  }
  /** connect and disconnect decide the route themselves from here on. */
  stopRestore() {
    this.restore.abort(new Error("VPN route restore stopped"));
  }
  close() {
    this.stopRestore();
  }
  private async waitAndAttach(signal: AbortSignal) {
    for (const deadline = Date.now() + VPN_RESTORE_MS; Date.now() < deadline;) {
      await sleep(this.restorePollMs, signal);
      const now = await this.status();
      // A disconnect or reconnect may have run while docker inspect did.
      if (signal.aborted) return;
      if (now.connected) {
        this.attach();
        this.log?.info({ server: now.server }, "VPN route restored");
        return;
      }
      if (now.status !== "starting" && now.status !== "unhealthy") break;
    }
    this.log?.warn("VPN did not become healthy after restart; route is direct");
  }
  private attach() {
    this.sandbox.network = "container:hibana-vpn";
    setPublicProxy(8118);
  }
  private detach() {
    this.sandbox.network = "bridge";
    setPublicProxy(undefined);
  }
  async status(): Promise<VpnStatus> {
    const state = await this.inspect();
    if (!state) return { connected: false, provider: this.config.vpnProvider };
    const connected = Boolean(
      state.Running && state.Health?.Status === "healthy",
    );
    const base: VpnStatus = {
      connected,
      // A stopped container keeps the health of its last check.
      status: state.Running ? (state.Health?.Status ?? "starting") : "stopped",
      provider: this.config.vpnProvider,
    };
    if (!connected) return base;
    const saved = await readJson<VpnState>(this.statePath(), {});
    if (saved.provider && saved.provider !== this.config.vpnProvider)
      return base;
    return { ...base, ...saved };
  }
  async execute(name: string, a: Json, ctx: Context) {
    if (!this.config.vpnEnabled) throw new Error("VPN is disabled");
    if (name === "vpn_status") {
      const now = await this.status();
      // A healthy VPN is always routed to, even one startup missed.
      if (now.connected) this.attach();
      return now;
    }
    if (name === "vpn_disconnect") {
      this.stopRestore();
      await processRun("docker", ["rm", "-f", "hibana-vpn"], {
        timeout: 15000,
      });
      this.detach();
      return { ok: true };
    }
    const root = join(this.config.dataDir, "vpn");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (name === "vpn_login_code") {
      if (this.config.vpnProvider === "vpngate")
        throw new Error(
          "VPN Gate does not use Surfshark login; use vpn_connect",
        );
      return this.surfsharkLogin(root, ctx);
    }
    const server = String(a.server ?? this.config.vpnServer).toLowerCase();
    this.stopRestore();
    const current = await this.status();
    if (current.connected && !a.reconnect) {
      // Startup may have missed it (#130): "connected" must mean routed.
      this.attach();
      return current;
    }
    await processRun("docker", ["rm", "-f", "hibana-vpn"], { timeout: 15000 });
    this.detach();
    const auth = join(root, "auth");
    const dockerArgs = [
      "run",
      "-d",
      "--name",
      "hibana-vpn",
      "--cap-add=NET_ADMIN",
      "--device",
      "/dev/net/tun",
      "--memory=192m",
      "--cpus=.5",
      "--pids-limit=64",
      "-p",
      "127.0.0.1:8118:8118",
      "--mount",
      `type=bind,src=${auth},dst=/run/vpn/auth,readonly`,
      "-e",
      `VPN_PROVIDER=${this.config.vpnProvider}`,
    ];
    let info: VpnState = { provider: this.config.vpnProvider, server };
    if (this.config.vpnProvider === "vpngate") {
      const country = vpnGateCountry(server);
      const csv = await fetchVpnGateCsv(ctx.signal);
      const excludeIp = a.reconnect && current.ip ? current.ip : undefined;
      const relay = selectVpnGateRelay(parseVpnGateCsv(csv), {
        country,
        excludeIp,
      });
      const ovpn = join(root, "client.ovpn");
      await writeFile(ovpn, sanitizeOpenVpnConfig(relay.config), {
        mode: 0o600,
      });
      // VPN Gate's documented OpenVPN credentials; not a secret.
      await writeFile(auth, "vpn\nvpn\n", { mode: 0o600 });
      dockerArgs.push(
        "--mount",
        `type=bind,src=${ovpn},dst=/run/vpn/client.ovpn,readonly`,
        "-e",
        "VPN_INIT_TIMEOUT_SECS=90",
      );
      info = {
        provider: "vpngate",
        server,
        country: relay.country,
        host: relay.host,
        ip: relay.ip,
        score: relay.score,
      };
      await ctx.progress?.(
        `VPN Gate ${relay.country} ${relay.host} (${relay.ip}) に接続しています`,
      );
    } else {
      if (!/^[a-z0-9-]+$/.test(server)) throw new Error("Invalid VPN server");
      const credentials = await readJson(join(root, "credentials.json"), {
        username: this.config.vpnUsername,
        password: this.config.vpnPassword,
      });
      if (
        !credentials.username ||
        !credentials.password ||
        /[\r\n]/.test(credentials.username + credentials.password)
      )
        throw new Error("OpenVPN service credentials required");
      await writeFile(
        auth,
        `${credentials.username}\n${credentials.password}\n`,
        { mode: 0o600 },
      );
      dockerArgs.push("-e", `VPN_SERVER=${server}`);
    }
    dockerArgs.push("hibana-vpn:latest");
    const run = await processRun("docker", dockerArgs, { timeout: 30000 });
    if (run.exit_code) throw new Error(run.stderr);
    const attempts = this.config.vpnProvider === "vpngate" ? 45 : 30;
    for (let i = 0; i < attempts; i++) {
      await sleep(2000, ctx.signal);
      const now = await this.status();
      if (now.connected) {
        this.attach();
        await atomicJson(this.statePath(), info);
        return { connected: true, ...info };
      }
      if (now.status === "stopped") {
        const logs = await processRun(
          "docker",
          ["logs", "--tail", "80", "hibana-vpn"],
          { timeout: 10000, maxOutput: 8000 },
        ).catch(() => null);
        throw new Error(
          (logs?.stdout || logs?.stderr || "VPN container exited").trim(),
        );
      }
    }
    throw new Error("VPN did not become healthy");
  }
  private statePath() {
    return join(this.config.dataDir, "vpn", "state.json");
  }
  private async surfsharkLogin(root: string, ctx: Context) {
    const cookies = new Map<string, string>();
    const request = async (path: string, body?: Json) => {
      const res = await fetch("https://my.surfshark.com" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctx.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
        redirect: "error",
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0]!;
        const eq = pair.indexOf("=");
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return res;
    };
    const create = await request(
      "/auth/api/v1/account/authorization/create",
      {},
    );
    if (!create.ok) throw new Error(`Surfshark HTTP ${create.status}`);
    const challenge = (await create.json()) as {
      code: string;
      hash: string;
      expiresAfter: number;
    };
    if (!challenge.code || !challenge.hash)
      throw new Error("Invalid login challenge");
    await ctx.progress?.(
      `Surfsharkアプリでコードを入力してください: ${challenge.code}`,
    );
    for (
      const deadline =
        Date.now() + Math.min(600, challenge.expiresAfter || 300) * 1000;
      Date.now() < deadline;
    ) {
      await sleep(5000, ctx.signal);
      const poll = await request("/auth/login-code", {
        hash: challenge.hash,
      });
      if (!poll.ok) {
        await poll.body?.cancel();
        continue;
      }
      const res = await request("/auth/p_api/v2/account/users/me");
      const account = (await res.json()) as Json;
      const credentials = extractServiceCredentials(account);
      if (!credentials)
        throw new Error(
          "Surfshark response has no OpenVPN service credentials; configure service credentials in env",
        );
      const { username, password } = credentials;
      await atomicJson(join(root, "credentials.json"), {
        username,
        password,
      });
      return { ok: true };
    }
    throw new Error("Surfshark login expired");
  }
}

/** Account passwords must never be used as OpenVPN service credentials. */
export function extractServiceCredentials(
  value: unknown,
  path = "",
): { username: string; password: string } | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (
    /credential|openvpn|manual|service|vpn/i.test(path) &&
    typeof row.username === "string" &&
    typeof row.password === "string" &&
    row.username.trim() &&
    row.password.trim() &&
    !/[\r\n]/.test(row.username + row.password)
  )
    return { username: row.username.trim(), password: row.password };
  for (const [key, child] of Object.entries(value)) {
    const found = extractServiceCredentials(child, `${path}.${key}`);
    if (found) return found;
  }
}
