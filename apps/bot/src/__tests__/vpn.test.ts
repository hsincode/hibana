import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { commands } from "../commands";
import { Vpn } from "../tools/vpn";
import { Sandbox } from "../tools/sandbox";
import {
  parseVpnGateCsv,
  sanitizeOpenVpnConfig,
  selectVpnGateRelay,
  vpnGateCountry,
} from "../tools/vpngate";
import type { Runtime } from "../runtime";
import type { Context } from "../types";

const ovpn = (extra = "") =>
  [
    "dev tun",
    "proto tcp",
    "remote 1.1.1.1 443",
    extra,
    "<ca>",
    "CERT",
    "</ca>",
  ].join("\n");

const b64 = (text: string) => Buffer.from(text).toString("base64");

const csv = (...rows: string[]) =>
  [
    "*vpn_servers",
    "#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64",
    ...rows,
  ].join("\n");

const row = (
  host: string,
  ip: string,
  score: number,
  countryLong: string,
  country: string,
  config = ovpn(),
) =>
  `${host},${ip},${score},10,1000,${countryLong},${country},0,0,0,0,2weeks,op,,${b64(config)}`;

test("VPN_PROVIDER selects vpngate defaults and rejects unknown values", () => {
  expect(loadConfig({ HIBANA_DATA_DIR: "/tmp/hibana-tests" }).vpnProvider).toBe(
    "surfshark",
  );
  const vpngate = loadConfig({
    HIBANA_DATA_DIR: "/tmp/hibana-tests",
    VPN_PROVIDER: "vpngate",
  });
  expect(vpngate.vpnProvider).toBe("vpngate");
  expect(vpngate.vpnServer).toBe("jp");
  expect(
    loadConfig({
      HIBANA_DATA_DIR: "/tmp/hibana-tests",
      VPN_PROVIDER: "vpngate",
      VPN_SERVER: "us",
    }).vpnServer,
  ).toBe("us");
  expect(() =>
    loadConfig({ HIBANA_DATA_DIR: "/tmp/hibana-tests", VPN_PROVIDER: "wireguard" }),
  ).toThrow(/VPN_PROVIDER/);
});

test("vpnGateCountry keeps Surfshark-style location codes as ISO prefixes", () => {
  expect(vpnGateCountry("jp")).toBe("JP");
  expect(vpnGateCountry("JP-tok")).toBe("JP");
  expect(vpnGateCountry("auto")).toBe("auto");
  expect(() => vpnGateCountry("tokyo")).toThrow();
});

test("parseVpnGateCsv skips private exits and keeps CountryLong commas", () => {
  const relays = parseVpnGateCsv(
    csv(
      row("public-vpn-1", "1.1.1.1", 100, "Japan", "JP"),
      row("private", "10.0.0.1", 999, "Japan", "JP"),
      row("kr-1", "8.8.8.8", 50, "Korea, Republic of", "KR"),
    ),
  );
  expect(relays.map((r) => r.host)).toEqual(["public-vpn-1", "kr-1"]);
  expect(relays[1]).toMatchObject({
    country: "KR",
    countryLong: "Korea, Republic of",
    ip: "8.8.8.8",
  });
});

test("selectVpnGateRelay prefers score and skips the previous exit on reconnect", () => {
  const relays = parseVpnGateCsv(
    csv(
      row("jp-a", "1.1.1.1", 300, "Japan", "JP"),
      row("jp-b", "1.0.0.1", 200, "Japan", "JP"),
      row("us-a", "8.8.8.8", 900, "United States", "US"),
    ),
  );
  expect(selectVpnGateRelay(relays, { country: "JP" }).host).toBe("jp-a");
  expect(
    selectVpnGateRelay(relays, { country: "JP", excludeIp: "1.1.1.1" }).host,
  ).toBe("jp-b");
  expect(selectVpnGateRelay(relays, { country: "auto" }).host).toBe("us-a");
  expect(() => selectVpnGateRelay(relays, { country: "DE" })).toThrow(/DE/);
});

test("sanitizeOpenVpnConfig strips scripts and private remotes, then forces a default route", () => {
  const cleaned = sanitizeOpenVpnConfig(`
dev tun
proto tcp
remote 1.1.1.1 443
remote 127.0.0.1 1194
up /bin/evil
plugin /evil.so
config /etc/passwd
http-proxy 10.0.0.1 8080
auth-user-pass /secret
<script>
rm -rf /
</script>
<ca>
CERT
</ca>
`);
  expect(cleaned).toContain("remote 1.1.1.1 443");
  expect(cleaned).toContain("<ca>");
  expect(cleaned).toContain("redirect-gateway def1");
  expect(cleaned).not.toMatch(/\bup\b/);
  expect(cleaned).not.toContain("plugin");
  expect(cleaned).not.toContain("http-proxy");
  expect(cleaned).not.toContain("127.0.0.1");
  expect(cleaned).not.toContain("rm -rf");
  expect(cleaned).not.toContain("auth-user-pass");
  expect(() => sanitizeOpenVpnConfig("remote 10.0.0.1 1194\n")).toThrow(
    /no public remote/,
  );
});

test("vpngate omits Surfshark login command and rejects vpn_login_code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hibana-vpngate-"));
  const config = loadConfig({
    HIBANA_DATA_DIR: dir,
    VPN_ENABLED: "true",
    VPN_PROVIDER: "vpngate",
  });
  const names = commands({ config } as Runtime).map((c) => c.name);
  expect(names).toContain("connect-vpn");
  expect(names).not.toContain("login-vpn");
  expect(
    commands({
      config: loadConfig({
        HIBANA_DATA_DIR: dir,
        VPN_ENABLED: "true",
        VPN_PROVIDER: "surfshark",
      }),
    } as Runtime)
      .map((c) => c.name),
  ).toContain("login-vpn");
  const vpn = new Vpn(config, new Sandbox(config));
  const ctx: Context = {
    guildId: "1",
    channelId: "2",
    userId: "3",
    botId: "4",
    thread: false,
    depth: 0,
    delivered: false,
  };
  await expect(vpn.execute("vpn_login_code", {}, ctx)).rejects.toThrow(/VPN Gate/);
});
