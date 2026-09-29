#!/usr/bin/env bash
# Run on the Docker host. Only the bridge interface exposes the singing engine.
set -euo pipefail

DEPLOY_DIR=${1:-/opt/hibana}
IMAGE=${2:-hibana-voicevox:0.25.2-singing-v1}
NAME=hibana-voicevox
GATEWAY=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
[[ "$GATEWAY" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Docker bridge IPv4 gateway missing' >&2; exit 1; }

# Docker's bridge-to-host published-port path uses INPUT (userland proxy).
# UFW otherwise drops it even though the host itself can reach the service.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  BRIDGE=$(docker network inspect bridge --format '{{index .Options "com.docker.network.bridge.name"}}')
  ufw allow in on "${BRIDGE:-docker0}" to "$GATEWAY" port 50022 proto tcp comment 'hibana VOICEVOX'
fi

if docker container inspect "$NAME" >/dev/null 2>&1; then
  managed=$(docker inspect "$NAME" --format '{{index .Config.Labels "io.hibana.voicevox"}}')
  [[ "$managed" == 1 ]] || { echo "Refusing to replace unmanaged container: $NAME" >&2; exit 1; }
  actual=$(docker inspect "$NAME" --format '{{.Config.Image}}')
  [[ "$actual" == "$IMAGE" ]] || { echo 'VOICEVOX image differs; migrate the managed service explicitly' >&2; exit 1; }
  docker start "$NAME" >/dev/null
else
  docker image inspect "$IMAGE" >/dev/null
  docker run -d --name "$NAME" --label io.hibana.voicevox=1 \
    --restart unless-stopped --memory 640m --memory-swap 1g --cpus 1 --pids-limit 128 \
    --security-opt no-new-privileges --cap-drop ALL --read-only --tmpfs /tmp:rw,exec,size=128m \
    --log-driver json-file --log-opt max-size=5m --log-opt max-file=2 \
    -p "${GATEWAY}:50022:50021" "$IMAGE"
fi

ready=0
for _ in $(seq 1 120); do
  if curl --noproxy '*' -fsS --max-time 2 "http://${GATEWAY}:50022/version" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { docker logs --tail 20 "$NAME"; exit 1; }

# This is deployment data, not a secret. The bundled skill mount is read-only
# inside sandbox containers, and the bridge route also works through VPN netns.
python3 - "$DEPLOY_DIR" "$GATEWAY" <<'PY'
import json
from pathlib import Path
import sys
directory = Path(sys.argv[1]) / "skills/music-create"
directory.mkdir(parents=True, exist_ok=True)
path = directory / "service.json"
temp = path.with_suffix(".tmp")
temp.write_text(json.dumps({"url": f"http://{sys.argv[2]}:50022"}) + "\n")
temp.chmod(0o644)
temp.replace(path)
PY
docker inspect "$NAME" --format 'VOICEVOX {{.State.Status}}, memory limit {{.HostConfig.Memory}} bytes'
