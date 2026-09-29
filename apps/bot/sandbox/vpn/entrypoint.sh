#!/usr/bin/env bash
# OpenVPN + HTTP proxy supervisor for the hibana VPN gateway.
#
# Order matters: the proxy only starts *after* the tunnel is up, so a host
# request can never leak out of the VPS's own IP through a half-open gateway.
# When OpenVPN dies the script exits, the container stops, and every consumer
# (published proxy port + joined yt-dlp containers) loses networking rather than
# silently falling back to the direct route.
#
# Two profile sources:
#   - mounted /run/vpn/client.ovpn (VPN Gate: host already sanitized the CSV)
#   - Surfshark public zip, fetched here (existing path)
set -euo pipefail

PROVIDER="${VPN_PROVIDER:-surfshark}"
SERVER="${VPN_SERVER:-jp-tok}"
PROTOCOL="${VPN_PROTOCOL:-udp}"
AUTH_FILE="${VPN_AUTH_FILE:-/run/vpn/auth}"
CLIENT_OVPN="${VPN_CLIENT_OVPN:-/run/vpn/client.ovpn}"
CONFIG_DIR="${VPN_CONFIG_DIR:-/var/lib/vpn/configs}"
PROXY_PORT="${VPN_PROXY_PORT:-8118}"
INIT_TIMEOUT="${VPN_INIT_TIMEOUT_SECS:-60}"
# Public bundle of every Surfshark OpenVPN profile (no auth required).
CONFIG_URL="${VPN_CONFIG_URL:-https://surfshark.com/api/v1/server/configurations}"
LOG_FILE=/tmp/openvpn.log

log() { printf '[vpn] %s\n' "$*"; }
die() { printf '[vpn] error: %s\n' "$*" >&2; exit 1; }

[ -s "$AUTH_FILE" ] || die "auth file $AUTH_FILE is missing or empty (mount OpenVPN service credentials)"
[ -e /dev/net/tun ] || die "/dev/net/tun missing (run with --device /dev/net/tun --cap-add NET_ADMIN)"

case "$PROVIDER" in
  surfshark | vpngate) ;;
  *) die "VPN_PROVIDER must be surfshark or vpngate (got '$PROVIDER')" ;;
esac

case "$PROTOCOL" in
  udp | tcp) ;;
  *) die "VPN_PROTOCOL must be udp or tcp (got '$PROTOCOL')" ;;
esac

fetch_configs() {
  log "downloading Surfshark OpenVPN profiles"
  local zip=/tmp/surfshark-configs.zip
  curl -fsSL --max-time 120 \
    -H 'Accept: application/zip, application/octet-stream' \
    -A 'hibana-vpn/1.0' \
    -o "$zip" "$CONFIG_URL" || die "could not download $CONFIG_URL"
  mkdir -p "$CONFIG_DIR"
  # -j: flatten, so a crafted archive path cannot write outside CONFIG_DIR.
  unzip -o -j -q "$zip" '*.ovpn' -d "$CONFIG_DIR" || die "could not extract profiles"
  rm -f "$zip"
  log "profiles: $(find "$CONFIG_DIR" -maxdepth 1 -name '*.ovpn' | wc -l)"
}

select_surfshark_profile() {
  # Profile names are attacker-irrelevant here (hibana validates them too) but
  # keep the glob from escaping the config dir.
  case "$SERVER" in
    *[!a-z0-9-]*) die "VPN_SERVER must be [a-z0-9-] (got '$SERVER')" ;;
  esac
  if [ "${VPN_REFRESH_CONFIGS:-0}" = "1" ] || ! compgen -G "$CONFIG_DIR/*.ovpn" >/dev/null; then
    fetch_configs
  fi
  profile="$CONFIG_DIR/${SERVER}.prod.surfshark.com_${PROTOCOL}.ovpn"
  if [ ! -f "$profile" ]; then
    # Surfshark also ships names like `jp-tok-mp`, `us-nyc-st001`; take the first
    # match for the requested location prefix before giving up.
    profile="$(find "$CONFIG_DIR" -maxdepth 1 -name "${SERVER}*_${PROTOCOL}.ovpn" | sort | head -1)"
  fi
  if [ -z "$profile" ] || [ ! -f "$profile" ]; then
    log "available (first 20):"
    find "$CONFIG_DIR" -maxdepth 1 -name "*_${PROTOCOL}.ovpn" -printf '  %f\n' | sort | head -20 >&2 || true
    die "no OpenVPN profile for server='$SERVER' protocol='$PROTOCOL'"
  fi
}

if [ -s "$CLIENT_OVPN" ]; then
  profile="$CLIENT_OVPN"
elif [ "$PROVIDER" = "vpngate" ]; then
  # Fail closed: never fall through to Surfshark zip when the host meant VPN Gate.
  die "VPN Gate requires a mounted OpenVPN profile at $CLIENT_OVPN"
else
  select_surfshark_profile
fi
log "provider=$PROVIDER profile=$(basename "$profile")"

cleanup() {
  # Kill the whole process group's children we started; container teardown then
  # takes the netns with it.
  [ -n "${OPENVPN_PID:-}" ] && kill "$OPENVPN_PID" 2>/dev/null || true
  [ -n "${TINYPROXY_PID:-}" ] && kill "$TINYPROXY_PID" 2>/dev/null || true
  [ -n "${TAIL_PID:-}" ] && kill "$TAIL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

: >"$LOG_FILE"
# AES-128-CBC: VPN Gate / SoftEther still advertise it; AES-256-CBC: Surfshark.
# --allow-compression: some volunteer profiles still declare comp-lzo.
openvpn \
  --config "$profile" \
  --auth-user-pass "$AUTH_FILE" \
  --auth-nocache \
  --allow-compression yes \
  --data-ciphers 'AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-256-CBC:AES-128-CBC' \
  --verb 3 \
  >>"$LOG_FILE" 2>&1 &
OPENVPN_PID=$!

# Mirror the OpenVPN log to stdout so `docker logs` (and hibana's failure
# diagnostics) show why a connection failed.
tail -n +1 -f "$LOG_FILE" &
TAIL_PID=$!

deadline=$((SECONDS + INIT_TIMEOUT))
while :; do
  if grep -q 'Initialization Sequence Completed' "$LOG_FILE"; then
    break
  fi
  if grep -qE 'AUTH_FAILED|auth-failure' "$LOG_FILE"; then
    die "OpenVPN rejected the credentials (AUTH_FAILED)"
  fi
  if ! kill -0 "$OPENVPN_PID" 2>/dev/null; then
    die "openvpn exited before the tunnel came up"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    die "tunnel did not come up within ${INIT_TIMEOUT}s"
  fi
  sleep 1
done

log "tunnel up; starting proxy on :${PROXY_PORT}"
sed -i "s/^Port .*/Port ${PROXY_PORT}/" /etc/tinyproxy/tinyproxy.conf
tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf &
TINYPROXY_PID=$!

# Exit as soon as either side dies so the container never serves a broken path.
wait -n "$OPENVPN_PID" "$TINYPROXY_PID"
status=$?
log "supervised process exited (status=$status); shutting down"
exit "$status"
