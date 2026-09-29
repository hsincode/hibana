import { setPublicProxy } from "../network";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export class Vpn {
  constructor(
    private config: Config,
    private sandbox: Sandbox,
  ) {}
  async load() {
    if (this.config.vpnEnabled && (await this.status()).connected) {
      this.sandbox.network = "container:hibana-vpn";
      setPublicProxy(8118);
    }
  }
  async status(): Promise<VpnStatus> {
    const r = await processRun(
      "docker",
      ["inspect", "-f", "{{json .State}}", "hibana-vpn"],
      { timeout: 10000, maxOutput: 2000 },
    ).catch(() => null);
    if (!r || r.exit_code)
      return { connected: false, provider: this.config.vpnProvider };
    const state = JSON.parse(r.stdout);
    const connected = Boolean(
      state.Running && state.Health?.Status === "healthy",
    );
    const base: VpnStatus = {
      connected,
      status: state.Health?.Status ?? (state.Running ? "starting" : "stopped"),
      provider: this.config.vpnProvider,
    };
    if (!connected) return base;
    const saved = await readJson<VpnState>(this.statePath(), {});
    if (saved.provider && saved.provider !== this.config.vpnProvider) return base;
    return { ...base, ...saved };
  }
  async execute(name: string, a: Json, ctx: Context) {
    if (!this.config.vpnEnabled) throw new Error("VPN is disabled");
    if (name === "vpn_status") return this.status();
    if (name === "vpn_disconnect") {
      await processRun("docker", ["rm", "-f", "hibana-vpn"], {
        timeout: 15000,
      });
      this.sandbox.network = "bridge";
      setPublicProxy(undefined);
      return { ok: true };
    }
    const root = join(this.config.dataDir, "vpn");
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (name === "vpn_login_code") {
      if (this.config.vpnProvider === "vpngate")
        throw new Error("VPN Gate does not use Surfshark login; use vpn_connect");
      return this.surfsharkLogin(root, ctx);
    }
    const server = String(a.server ?? this.config.vpnServer).toLowerCase();
    const current = await this.status();
    if (current.connected && !a.reconnect) return current;
    await processRun("docker", ["rm", "-f", "hibana-vpn"], { timeout: 15000 });
    this.sandbox.network = "bridge";
    setPublicProxy(undefined);
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
      const excludeIp =
        a.reconnect && current.ip ? current.ip : undefined;
      const relay = selectVpnGateRelay(parseVpnGateCsv(csv), {
        country,
        excludeIp,
      });
      const ovpn = join(root, "client.ovpn");
      await writeFile(ovpn, sanitizeOpenVpnConfig(relay.config), { mode: 0o600 });
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
        this.sandbox.network = "container:hibana-vpn";
        setPublicProxy(8118);
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
