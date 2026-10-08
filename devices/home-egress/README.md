# ESP32 home browser egress

An ESP32-S3 with 8 MB PSRAM relays Hibana browser TCP connections through the
home Wi-Fi. Chromium stays in the bounded VPS sandbox. When enabled, the ESP32 initiates six TLS connections to the VPS, so the home
router needs no inbound port mapping. It normally stays disconnected; the VPS
closes its TLS listener and all device sockets outside an active task. The
ESP32 polls the closed endpoint roughly every 10 seconds to discover activation.
It stays associated with home Wi-Fi, but has no standing VPS tunnel while off.
The existing eo-RT100 provides Wi-Fi and Internet access only.

The VPS validates both the device client certificate and the browser proxy
credentials generated separately for every task. Permanent proxy passwords
are not accepted. The device validates the private CA, server name and certificate
dates. Website HTTPS remains end-to-end between Chromium and the origin.
This is an application proxy, not a WireGuard gateway or a Tailscale exit node.

## Routing and limits

- `BROWSER_PROXY_URL` and `BROWSER_PROXY_USERNAME` enable the tool capability;
  they do not activate the route. `home_vpn_status`, `home_vpn_connect` and
  `home_vpn_disconnect` are available only to administrator parent tasks.
- After a site blocks the normal route, connect explicitly, reopen the browser
  or retry yt-dlp/bash HTTP, complete the work and disconnect. Browser
  transitions close the browser and discard its in-memory cookies. The route
  belongs to one exact task context; another conversation, subagent or later
  turn cannot inherit or disconnect it.
- This task's Playwright, `download_media` (yt-dlp) and bash HTTP(S) 80/443
  use the home proxy. Discord, model APIs, Exa, `web_fetch` and other tasks
  keep their existing routes. Discord CDN attachments never use home lanes.
- Disconnect happens on turn completion/error/cancellation, browser close or
  timeout, or 15 minutes without an owning-task command. Browser, yt-dlp and
  bash keep the route alive for the whole work session; there is no hard
  15-minute cap. Status checks and website background traffic do not renew the
  lease. Relay expiry is independent of bot liveness. The bot also closes an
  expired browser.
- Control uses `/run/hibana-home-egress/control.sock` inside a 0700 runtime
  directory with a 0600 socket, available only on the host as the service user.
  It is not exposed through the browser proxy, HTTP endpoints or Docker mounts.
- Only the owning task receives the short-lived proxy credential.
  Connected browsers and that task's sandbox stay on the Docker bridge even if
  the Surfshark / VPN Gate gateway is enabled, so they can reach the home proxy.
  Discord, model APIs, Exa and `web_fetch` retain their existing routes.
- IPv4 TCP ports 80 and 443 only; no QUIC, UDP or non-proxied WebRTC. Chromium's
  implicit loopback proxy bypass is disabled. IPv6-only origins are unsupported.
- DNS is resolved and checked on the VPS. The device receives the pinned
  public IPv4, with another private/reserved-address check on the ESP32. This
  prevents pages from reaching home LAN devices or rebinding a checked hostname.
  The VPS also denies the address the device connected from: the home line's
  own public IPv4 is the router when reached from inside the LAN.
- Six device lanes, eight accepted device sessions, 24 queued requests, 32
  proxy connections. Queue timeout 15 s; connect timeout 12 s; idle TCP timeout
  60 s. Each completed connection gets a fresh authenticated TLS session.
  When new requests are queued, an existing connection with no traffic for
  10 s can be reclaimed so idle per-origin keepalives do not exhaust all lanes.
  Long-polling or quiet WebSocket sessions may reconnect under this pressure.
- No automatic direct fallback. An unplugged device produces a proxy failure.
  Heavy pages, streaming and many concurrent origins may exceed these limits;
  successful navigation is not a throughput or long-term availability guarantee.

## Build and provisioning

Run from the repository root. `espressif/idf:v5.4.2` is the tested SDK.

```sh
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e IDF_TARGET=esp32s3 \
  -v "$PWD/devices/home-egress:/project" -w /project \
  espressif/idf:v5.4.2 idf.py build
python3 devices/home-egress/provision.py init
```

`init` reads the VPS address from `.local/deployment.json` and creates private
environment files in `.local/home-egress/`. It refuses to overwrite identities.
The CA key stays on the provisioning PC; it is never deployed to the VPS or
device. Client/server certificates expire after 825 days; provision and deploy
renewed certificates before expiry. The CA lasts 3650 days.

Create owner-readable `.local/home-egress/provision.env` with `WIFI_SSID` and
`WIFI_PASSWORD` for 2.4 GHz Wi-Fi. Values may be quoted; they are never evaluated
as shell expressions. Then:

```sh
python3 devices/home-egress/provision.py nvs
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/.local/home-egress:/provision" espressif/idf:v5.4.2 \
  python /opt/esp/idf/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py \
  generate /provision/nvs.csv /provision/nvs.bin 0x6000
```

Before the first flash, back up the full original 8 MB flash into the private
directory. Keep that backup owner-readable too: existing firmware may contain
credentials. Flash the built bootloader at `0x0`, partition table at `0x8000`,
private `nvs.bin` at `0x9000`, and application at `0x10000` using esptool.
Firmware builds contain no credentials. NVS images, backups and provisioning
environment files do contain secrets and must never be committed or published.
NVS is not flash-encrypted; physical possession permits extraction. Secure boot
and irreversible eFuse changes are not part of this deployment.

The device needs SNTP on startup to validate certificate dates. Relay and device logs omit Wi-Fi
credentials, SSIDs, keys, URLs and browsing payloads. Power it from a stable USB
adapter to operate while the PC is off; verify the new power source before
relying on unattended operation.

## VPS installation

Install the repo under `/opt/hibana` and the included systemd unit under
`/etc/systemd/system/hibana-home-egress.service`. Install `relay.env` as
`/etc/hibana/home-egress.env` with mode 0600 (systemd reads it as root). The unit
runs as `hibana` with no new privileges, a read-only system and a memory limit.

Allow inbound TCP 18443 for device mTLS; it listens only during active leases. Proxy port 18118 binds only to Docker's
bridge address `172.17.0.1`; allow it on `docker0` only, never the public interface.
The device needs its client certificate and the browser needs its current task credential.
The bot sandbox's existing resource and conversation isolation remain in effect.

Merge the endpoint and username from `browser.env` into `/etc/hibana/bot.env`
without echoing values. Remove the obsolete `BROWSER_PROXY_PASSWORD` and
`HOME_RELAY_PASSWORD` variables from bot/relay environments; existing values
are no longer used. Install the updated unit (including RuntimeDirectory),
reload systemd and restart both services. The relay always starts disconnected.
Rebuild the browser sandbox if its CLI proxy support is not already installed.
A narrow image layer copying the CLI over the current sandbox is sufficient.

Check `systemctl is-active hibana hibana-home-egress`, relay lane counts in
`journalctl -u hibana-home-egress`, disconnected state and absent TLS listener, then explicitly connect using the
bot tools and verify browser egress and target navigation. Disconnect afterwards.
The connect tool waits up to 30 seconds for an authenticated ESP32 lane. Do not log authentication headers or private environment files.

## Rollback

To disable the feature, remove `BROWSER_PROXY_URL` and restart Hibana, then
stop the relay. Do not restore the obsolete always-on proxy configuration. Disable the relay service and remove only
the two firewall entries added for it. Restore the original flash backup at
address zero to return the ESP32 to its previous application. Keep the new
device disconnected while restoring its identity or Wi-Fi credentials.

Run `make test` and `make ci` for bot changes. Relay integration tests use
temporary certificates and mock device sockets; they do not substitute for
ESP32 Wi-Fi, power-cycle or real-browser validation.
