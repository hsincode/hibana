# hibana VPN gateway — OpenVPN (Surfshark or VPN Gate) + HTTP proxy.
#
# Why a container instead of a host-wide tunnel: only *web* traffic must look
# like it comes from the VPN exit (YouTube et al. block VPS ranges). The LLM and
# Discord APIs stay on the host's direct route so latency is unaffected.
#
#   yt-dlp container ── --network container:hibana-vpn ──┐
#   host (Exa / download_file) ── http://127.0.0.1:8118 ─────┤→ tun0 → provider
#   host (LLM / Discord)  ─────────────────────────────────── direct
#
# Build:
#   make vpn-image
#   # → docker build -f sandbox/vpn/Dockerfile -t hibana-vpn:latest sandbox/vpn/
#
# Run (hibana does this itself; shown for manual debugging):
#   docker run -d --name hibana-vpn \
#     --cap-add NET_ADMIN --device /dev/net/tun \
#     -p 127.0.0.1:8118:8118 \
#     -e VPN_PROVIDER=surfshark -e VPN_SERVER=jp-tok -e VPN_PROTOCOL=udp \
#     -v /var/lib/hibana/vpn/auth:/run/vpn/auth:ro \
#     hibana-vpn:latest
# VPN Gate additionally bind-mounts the sanitized profile:
#   -v /var/lib/hibana/vpn/client.ovpn:/run/vpn/client.ovpn:ro \
#   -e VPN_PROVIDER=vpngate
FROM debian:trixie-slim

# openvpn: tunnel. tinyproxy: HTTP/CONNECT proxy for host-side web calls.
# curl/unzip: fetch the public Surfshark .ovpn bundle at first start.
# iproute2: tun0 presence check in the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openvpn \
        tinyproxy \
        ca-certificates \
        curl \
        unzip \
        iproute2 \
        procps \
    && rm -rf /var/lib/apt/lists/*

COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh \
    && mkdir -p /var/lib/vpn/configs /run/vpn

# Config cache survives restarts when the caller mounts a volume here.
VOLUME ["/var/lib/vpn/configs"]

ENV VPN_SERVER=jp-tok \
    VPN_PROTOCOL=udp \
    VPN_PROXY_PORT=8118 \
    VPN_AUTH_FILE=/run/vpn/auth \
    VPN_CONFIG_DIR=/var/lib/vpn/configs \
    VPN_INIT_TIMEOUT_SECS=60

EXPOSE 8118

# Unhealthy as soon as the tunnel or the proxy stops answering; hibana also
# probes the exit IP itself, so this is mainly for `docker ps` visibility.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
    CMD /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
