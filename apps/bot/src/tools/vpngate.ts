import { isIP } from "node:net";
import { isPublicAddress } from "../network";

export type VpnGateRelay = {
  host: string;
  ip: string;
  score: number;
  ping: number;
  speed: number;
  country: string;
  countryLong: string;
  config: string;
};

// Hardcoded: the list URL must never come from tool arguments (SSRF).
const LIST_URLS = [
  "https://www.vpngate.net/api/iphone/",
  "http://www.vpngate.net/api/iphone/",
] as const;

const BLOCKED_DIRECTIVES = new Set([
  "up",
  "down",
  "route-up",
  "route-pre-down",
  "ipchange",
  "tls-verify",
  "auth-user-pass-verify",
  "client-connect",
  "client-disconnect",
  "learn-address",
  "plugin",
  "management",
  "config",
  "script-security",
  "setenv",
  "setenv-safe",
  "cd",
  "chroot",
  "user",
  "group",
  "daemon",
  "writepid",
  "log",
  "log-append",
  "status",
  "http-proxy",
  "socks-proxy",
  "http-proxy-retry",
  "http-proxy-option",
  "http-proxy-user-pass",
  "tmp-dir",
  "echo",
  // CLI supplies vpn/vpn; a path here would read a container file.
  "auth-user-pass",
]);

const ALLOWED_TAGS = new Set([
  "ca",
  "cert",
  "key",
  "tls-auth",
  "tls-crypt",
  "tls-crypt-v2",
  "extra-certs",
]);

export async function fetchVpnGateCsv(signal?: AbortSignal): Promise<string> {
  let last: Error | undefined;
  for (const url of LIST_URLS) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/plain", "User-Agent": "hibana-vpn/1.0" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
        redirect: "follow",
      });
      if (!res.ok) {
        await res.body?.cancel();
        last = new Error(`VPN Gate list HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (!text.includes("OpenVPN_ConfigData_Base64")) {
        last = new Error("VPN Gate list was not a server CSV");
        continue;
      }
      return text;
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw last ?? new Error("VPN Gate list download failed");
}

/** `jp-tok` keeps working when switching provider: take the ISO country prefix. */
export function vpnGateCountry(server: string): string {
  const s = server.trim().toLowerCase();
  if (s === "auto") return "auto";
  const match = /^([a-z]{2})(?:-[a-z0-9-]+)?$/.exec(s);
  if (!match)
    throw new Error(
      "VPN Gate server must be a 2-letter country code, auto, or a location like jp-tok",
    );
  return match[1]!.toUpperCase();
}

export function parseVpnGateCsv(text: string): VpnGateRelay[] {
  const relays: VpnGateRelay[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("*") || line.startsWith("#")) continue;
    const last = line.lastIndexOf(",");
    if (last < 0) continue;
    const b64 = line.slice(last + 1).trim();
    const cols = line.slice(0, last).split(",").map((c) => c.trim());
    if (cols.length < 7) continue;
    const host = cols[0]!;
    const ip = cols[1]!;
    const score = Number(cols[2]);
    const ping = Number(cols[3]);
    const speed = Number(cols[4]);
    // Header is CountryLong then CountryShort; CountryLong can contain commas
    // ("Korea, Republic of"), so scan for the first ISO-3166 alpha-2.
    let countryIdx = 5;
    while (countryIdx < cols.length && !/^[A-Z]{2}$/.test(cols[countryIdx]!))
      countryIdx++;
    const country = cols[countryIdx];
    if (!country) continue;
    const countryLong = cols.slice(5, countryIdx).join(", ");
    if (!/^[a-zA-Z0-9._-]+$/.test(host) || !isPublicAddress(ip)) continue;
    if (!Number.isFinite(score) || !b64) continue;
    let config: string;
    try {
      config = Buffer.from(b64, "base64").toString("utf8");
    } catch {
      continue;
    }
    if (!/\bremote\s+\S+/.test(config)) continue;
    relays.push({
      host,
      ip,
      score,
      ping: Number.isFinite(ping) ? ping : 0,
      speed: Number.isFinite(speed) ? speed : 0,
      country,
      countryLong,
      config,
    });
  }
  return relays;
}

export function selectVpnGateRelay(
  relays: VpnGateRelay[],
  opts: { country: string; excludeIp?: string },
): VpnGateRelay {
  const country =
    opts.country === "auto" ? undefined : opts.country.toUpperCase();
  let pool = country
    ? relays.filter((r) => r.country === country)
    : relays.slice();
  if (!pool.length) {
    const available = [...new Set(relays.map((r) => r.country))].sort().join(", ");
    throw new Error(
      `No VPN Gate relays for ${country ?? "auto"}${available ? ` (available: ${available})` : ""}`,
    );
  }
  pool.sort((a, b) => b.score - a.score || a.ping - b.ping);
  if (opts.excludeIp) {
    const filtered = pool.filter((r) => r.ip !== opts.excludeIp);
    if (filtered.length) pool = filtered;
  }
  return pool[0]!;
}

/**
 * Volunteer CSV can ship `up`/`plugin`/`config` directives. Keep only the
 * tunnel bits and force a default route: SoftEther-generated profiles often
 * omit `redirect-gateway`, which would leak tinyproxy out the VPS IP.
 */
export function sanitizeOpenVpnConfig(ovpn: string): string {
  let tag: { name: string; keep: boolean } | undefined;
  const out: string[] = [];
  let remotes = 0;
  for (const raw of ovpn.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (tag) {
      if (trimmed.toLowerCase() === `</${tag.name}>`) {
        if (tag.keep) out.push(`</${tag.name}>`);
        tag = undefined;
      } else if (tag.keep) out.push(line);
      continue;
    }
    const open = /^<([a-z0-9-]+)>$/i.exec(trimmed);
    if (open) {
      const name = open[1]!.toLowerCase();
      tag = { name, keep: ALLOWED_TAGS.has(name) };
      if (tag.keep) out.push(`<${name}>`);
      continue;
    }
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    const key = trimmed.split(/\s+/)[0]!.toLowerCase();
    if (BLOCKED_DIRECTIVES.has(key) || key.startsWith("--")) continue;
    if (key === "remote") {
      const parts = trimmed.split(/\s+/);
      const host = parts[1];
      const port = Number(parts[2] || 1194);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (isIP(host) ? !isPublicAddress(host) : !isSafeRemoteHostname(host))
        continue;
      remotes++;
      out.push(`remote ${host} ${port}${parts[3] ? ` ${parts[3]}` : ""}`);
      continue;
    }
    if (key === "dev") {
      const dev = (trimmed.split(/\s+/)[1] || "tun").toLowerCase();
      if (!dev.startsWith("tun") && !dev.startsWith("tap")) continue;
    }
    out.push(trimmed);
  }
  if (!remotes) throw new Error("VPN Gate profile has no public remote");
  if (!out.some((l) => l.toLowerCase().startsWith("redirect-gateway")))
    out.push("redirect-gateway def1");
  return out.join("\n") + "\n";
}

function isSafeRemoteHostname(host: string): boolean {
  const h = host.replace(/\.$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(h) || !h.includes(".")) return false;
  return !/(^|\.)(localhost|local|internal|arpa)$/.test(h);
}
