#!/usr/bin/env bash
# Posts a deploy report (per-target result and the commits it shipped) to a
# Discord webhook. Does nothing while DISCORD_DEPLOY_WEBHOOK is unset, and a
# failed post only warns: the notification must never fail a deploy.
# Usage: DISCORD_DEPLOY_WEBHOOK=... [BASE=<sha>] API_RESULT=success WEB_RESULT=skipped \
#        BOT_RESULT=success [RUN_URL=...] scripts/deploy-notify.sh <sha>
# Results are GitHub job results: success / failure / skipped / cancelled.
# An empty BASE (workflow_dispatch, force push, local deploy) lists only <sha>.
# NOTIFY_DRY_RUN=1 prints the payload instead of posting it.
set -euo pipefail
head=${1:?usage: deploy-notify.sh <sha>}
webhook=${DISCORD_DEPLOY_WEBHOOK:-}
[ -n "$webhook" ] || exit 0

head=$(git rev-parse "$head")
base=${BASE:-}
repo_url=${REPO_URL:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-hsincode/hibana}}
run_url=${RUN_URL:-}
short=$(git rev-parse --short "$head")

failed=false
results=()
for pair in "api:${API_RESULT:-skipped}" "web:${WEB_RESULT:-skipped}" "bot:${BOT_RESULT:-skipped}"; do
  name=${pair%%:*} result=${pair#*:}
  case $result in
    success) mark=✅ ;;
    failure) mark=❌ failed=true ;;
    cancelled) mark=cancelled failed=true ;;
    *) mark=$result ;;
  esac
  results+=("$name: $mark")
done

if [ -n "$base" ]; then
  range=("$base..$head")
else
  range=(-1 "$head")
fi
mapfile -t commits < <(git log --no-merges --format='%h%x09%H%x09%s' "${range[@]}")

# Discord caps an embed description at 4096 characters; stop well before it
# and point to the full diff instead.
list=
shown=0
for c in "${commits[@]}"; do
  IFS=$'\t' read -r abbrev full subject <<<"$c"
  line="- [\`$abbrev\`]($repo_url/commit/$full) ${subject:0:100}"
  [ $((${#list} + ${#line})) -gt 3500 ] && break
  list+="$line"$'\n'
  shown=$((shown + 1))
done
rest=$((${#commits[@]} - shown))
[ "$rest" -gt 0 ] && list+="- ほか ${rest} 件"$'\n'

links=()
[ -n "$run_url" ] && links+=("[Actions run ↗]($run_url)")
[ -n "$base" ] && links+=("[差分 ↗]($repo_url/compare/$base...$head)")

heading="**変更内容 (${#commits[@]}件)**"
[ -z "$base" ] && heading="**全体を再デプロイ**"
description=$(printf '%s  ' "${results[@]}")
description="${description%  }"$'\n\n'"$heading"$'\n'"$list"
[ ${#links[@]} -gt 0 ] && description+=$'\n'"${links[*]}"

if $failed; then title="❌ デプロイ失敗 $short" color=15548997; else title="✅ デプロイ完了 $short" color=5763719; fi

# The icon is 火花 (character 1501) from Honkai: Star Rail, hotlinked
# from the community asset repo StarRailRes and pinned to a commit so it
# cannot change; the artwork is HoYoverse's, so it is not copied into this repo.
avatar_url=https://raw.githubusercontent.com/Mar-7th/StarRailRes/dbe8cdfcfb0bf657b9fe1cf92d5537f118ccb487/icon/character/1501.png
payload=$(jq -n \
  --arg username "${NOTIFY_USERNAME:-Hibana}" \
  --arg avatar "${NOTIFY_AVATAR_URL:-$avatar_url}" \
  --arg title "$title" --arg url "${run_url:-$repo_url/commit/$head}" \
  --arg description "$description" --argjson color "$color" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{username: $username, avatar_url: $avatar, allowed_mentions: {parse: []},
    embeds: [{title: $title, url: $url, description: $description, color: $color, timestamp: $timestamp}]}')

[ "${NOTIFY_DRY_RUN:-}" = 1 ] && { echo "$payload"; exit 0; }

# The webhook URL is a credential: keep it out of the output, including curl errors.
status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
  -H 'content-type: application/json' --data "$payload" "$webhook" 2>/dev/null) || status=000
case $status in
  2??) echo "deploy notification sent" ;;
  *) echo "::warning::deploy notification failed: HTTP $status" ;;
esac
