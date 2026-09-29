#!/usr/bin/env bash
# Decides which Vercel apps a main build has to deploy; prints `api=` / `web=`
# lines for $GITHUB_OUTPUT, plus `base=` (empty when there is no usable base)
# for the deploy notification's commit list. Usage: GH_TOKEN=... scripts/vercel-changes.sh <sha>
#
# The base is the head of the last successful main CI run, not the previous
# push: the workflow cancels superseded runs and a failed deploy fails the run,
# so a change skipped that way is still in the next diff. A missing base or a
# force push (base not an ancestor) deploys both. workflow_dispatch deploys both.
set -euo pipefail
head=${1:?usage: vercel-changes.sh <sha>}

both() { echo api=true; echo web=true; echo base=; exit 0; }
[ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] && both

base=$(gh run list --workflow ci.yml --branch main --status success --limit 50 \
  --json headSha,event \
  --jq "[.[] | select((.event == \"push\" or .event == \"workflow_dispatch\") and .headSha != \"$head\")][0].headSha // empty")
if [ -z "$base" ] || ! git merge-base --is-ancestor "$base" "$head" 2>/dev/null; then
  echo "no deployable base; deploying both" >&2
  both
fi

changed=$(git diff --name-only "$base" "$head")
echo "changes since ${base:0:7}:" >&2
printf '  %s\n' $changed >&2
# Both apps build packages/shared through the root workspace install.
common='packages/shared/|package\.json$|bun\.lock$'
has() { grep -qE "^($1|$common)" <<<"$changed" && echo true || echo false; }
echo "api=$(has 'apps/api/')"
echo "web=$(has 'apps/web/')"
echo "base=$base"
