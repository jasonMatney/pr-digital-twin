#!/usr/bin/env bash
# Builds the app and publishes it to the gh-pages branch.
#   tools/deploy.sh            -> site root
#   tools/deploy.sh dev/r1     -> https://webgpu-demos.github.io/garita/dev/r1/  (data still read from the root)
#   ENTRY=r1.html tools/deploy.sh dev/r1   -> builds only that root-level page: .../dev/r1/r1.html
# Each caller uses its own checkout of gh-pages (DEPLOY_DIR) so parallel deploys do not collide; pushes rebase and retry.
set -euo pipefail
SUB="${1:-}"
NAME="${SUB//\//-}"; NAME="${NAME:-root}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-/home/claude/deploy-$NAME}"
REPO_URL="https://github.com/webgpu-demos/garita"
cd "$ROOT"
if [ -n "$SUB" ]; then DEPTH=$(awk -F/ '{print NF}' <<<"$SUB"); BASE=$(printf '../%.0s' $(seq 1 "$DEPTH")); else BASE="./"; fi
VITE_DATA_BASE="$BASE" OUT_DIR="dist-$NAME" npx vite build --logLevel warn
if [ ! -d "$DEPLOY_DIR/.git" ]; then
  for i in 1 2 3; do git clone -q --depth 1 --branch gh-pages --no-tags --filter=blob:none --sparse "$REPO_URL" "$DEPLOY_DIR" && break || sleep 12; done
  git -C "$DEPLOY_DIR" sparse-checkout set --no-cone '/*' '!/tiles/' '!/data/' '!/fixtures/'
fi
cd "$DEPLOY_DIR"
for attempt in 1 2 3 4 5; do
  git fetch -q --depth 1 origin gh-pages && git reset -q --hard origin/gh-pages || { sleep 12; continue; }
  DEST="$DEPLOY_DIR/${SUB}"; mkdir -p "$DEST"
  rm -rf "$DEST/assets"; cp -r "$ROOT/dist-$NAME/." "$DEST/"
  touch "$DEPLOY_DIR/.nojekyll"
  git add -A "${SUB:-.}" .nojekyll
  if git diff --cached --quiet; then echo "deploy: nothing changed"; exit 0; fi
  git commit -q -m "Deploy ${SUB:-site} $(date -u +%FT%TZ)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UFDnHPw7W7Xe92VesEaMZd"
  if git push -q origin HEAD:gh-pages 2>/tmp/claude-0/push-$NAME.err; then echo "deployed -> https://webgpu-demos.github.io/garita/${SUB:+$SUB/}  (Pages takes ~40-90 s to publish)"; exit 0; fi
  echo "push attempt $attempt failed: $(tail -1 /tmp/claude-0/push-$NAME.err)"; sleep $((10 + attempt * 5))
done
echo "deploy failed after 5 attempts" >&2; exit 1
