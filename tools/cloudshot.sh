#!/usr/bin/env bash
# Screenshots of the DEPLOYED site rendered on a GitHub runner (live network, software GL). Nothing runs locally
# or on anyone's own computer.
#   tools/cloudshot.sh <name> <request.json>
# <request.json>: { "shots": [{ "id": "island", "url": "https://jasonmatney.github.io/pr-digital-twin/?ui=0&cam=…", "w": 1280, "h": 800, "wait": 4000 }] }
# Writes /tmp/claude-0/shots/<name>/<id>.jpg and results.json (console errors, __garita.debug()). Takes 3-8 minutes.
# Deploy first if the page changed (tools/deploy.sh …) and allow ~90 s for Pages to publish.
set -euo pipefail
NAME="$1"; REQ="$(realpath "$2")"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WT="/home/claude/shots-wt-$NAME"; OUT="/tmp/claude-0/shots/$NAME"
REPO="https://github.com/jasonMatney/pr-digital-twin"
retry() { for i in 1 2 3 4 5 6; do "$@" && return 0; sleep 15; done; return 1; }
if [ ! -d "$WT/.git" ]; then retry git clone -q --depth 1 --no-tags "$REPO" "$WT"; fi
cd "$WT"
retry git fetch -q --depth 1 origin main
git checkout -q -B "shots/$NAME" FETCH_HEAD
# The runner uses the workflow and runner script from this branch: carry local edits of them, if any.
cp "$ROOT/tools/cloudshot-runner.mjs" tools/cloudshot-runner.mjs
cp "$ROOT/.github/workflows/shots.yml" .github/workflows/shots.yml
cp "$REQ" shots.request.json
STAMP="$(date -u +%FT%TZ)"; echo "$STAMP" > shots.stamp
git add -A && git commit -q -m "shots $NAME $STAMP"
BEFORE="$(git ls-remote origin "refs/heads/shots-out/$NAME" 2>/dev/null | cut -f1 || true)"
retry git push -q -f origin "HEAD:refs/heads/shots/$NAME"
echo "cloudshot: requested $NAME at $STAMP; waiting for the runner…"
for i in $(seq 1 200); do
  sleep 15
  NOW="$(git ls-remote origin "refs/heads/shots-out/$NAME" 2>/dev/null | cut -f1 || true)"
  if [ -n "$NOW" ] && [ "$NOW" != "$BEFORE" ]; then
    rm -rf "$OUT"; mkdir -p "$OUT"
    retry git fetch -q --depth 1 origin "refs/heads/shots-out/$NAME"
    git archive FETCH_HEAD | tar -x -C "$OUT"
    echo "cloudshot: done -> $OUT"; ls "$OUT"
    node -e "const r=JSON.parse(require('fs').readFileSync('$OUT/results.json','utf8'));for(const x of r.results)console.log(x.id,x.ok?'ok':'FAILED '+String(x.error).slice(0,90),x.ms+' ms','frame '+x.frameMs+' ms',JSON.stringify(x.logs.filter(l=>!/status of 40[04]|SharedArrayBuffer|GroupMarkerNotSet|GPU stall/.test(l)).slice(0,6)),JSON.stringify(x.failedHosts))" 2>/dev/null || true
    exit 0
  fi
done
echo "cloudshot: timed out waiting for shots-out/$NAME (check: gh run list -R jasonMatney/pr-digital-twin --workflow shots.yml -L 3)" >&2; exit 1
