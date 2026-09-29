#!/usr/bin/env bash
# Asks the production relay to deploy a commit and waits for the result.
# Usage: RELAY_URL=https://... RELAY_TOKEN=hbr_... scripts/relay-deploy.sh <40-char sha>
set -euo pipefail
sha=${1:?usage: relay-deploy.sh <sha>}
url=${RELAY_URL:?RELAY_URL is required}
url=${url%/}
: "${RELAY_TOKEN:?RELAY_TOKEN is required}"
body=$(mktemp)
trap 'rm -f "$body"' EXIT

call() { # method path [data] -> prints HTTP status, body in $body
  curl -sS -o "$body" -w '%{http_code}' --max-time 30 -X "$1" \
    -H "Authorization: Bearer $RELAY_TOKEN" -H 'content-type: application/json' \
    ${3:+--data "$3"} "$url$2" 2>/dev/null || echo 000
}

# 409: another deploy is running. 000/502/503: relay restarting after updating itself.
id=
for _ in $(seq 1 60); do
  status=$(call POST /deploy "{\"sha\":\"$sha\"}")
  case $status in
    202) id=$(jq -r .deployment.id "$body"); break ;;
    409 | 000 | 502 | 503) echo "relay busy or unreachable ($status); retrying"; sleep 10 ;;
    *) echo "deploy request failed: HTTP $status"; cat "$body"; echo; exit 1 ;;
  esac
done
[ -n "$id" ] || { echo "relay stayed busy"; exit 1; }
echo "deployment $id started for $sha"

for _ in $(seq 1 180); do
  sleep 5
  status=$(call GET "/deploys/$id")
  [ "$status" = 200 ] || { echo "poll: HTTP $status"; continue; }
  state=$(jq -r .deployment.status "$body")
  [ "$state" = running ] && continue
  jq -r '.deployment.steps[] | "[\(if .ok then "ok" else "NG" end)] \(.name)\(if .ok then "" else "\n\(.output)" end)"' "$body"
  jq -r '.deployment.error // empty' "$body"
  echo "result: $state"
  case $state in succeeded | superseded) exit 0 ;; *) exit 1 ;; esac
done
echo "timed out waiting for deployment $id"
exit 1
