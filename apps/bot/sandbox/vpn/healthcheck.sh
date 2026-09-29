#!/usr/bin/env bash
# Healthy = tunnel interface present *and* the proxy still relays through it.
# Checking only tun0 would keep the container "healthy" after tinyproxy dies.
set -euo pipefail

PROXY_PORT="${VPN_PROXY_PORT:-8118}"
IP_CHECK_URL="${VPN_IP_CHECK_URL:-https://api.ipify.org}"

# OpenVPN uses tun0; a tap profile (uncommon) would be tap0.
ip link show tun0 >/dev/null 2>&1 || ip link show tap0 >/dev/null 2>&1 || exit 1
curl -fsS --max-time 8 -x "http://127.0.0.1:${PROXY_PORT}" "$IP_CHECK_URL" >/dev/null || exit 1
