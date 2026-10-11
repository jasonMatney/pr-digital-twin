#!/usr/bin/env bash
# Publishes one hazard stage's outputs to gh-pages:  bash pipeline/hazards/publish.sh <stage> "<commit message>"
# Copies out/data/hazards/<stage>/ and, if present, out/tiles/<stage>/ over the same paths on gh-pages (a stage
# owns exactly those two paths and nothing else), then pushes, rebasing and retrying if another job pushed first.
# Needs GH_TOKEN and GITHUB_REPOSITORY (set by Actions). Run from the repository root.
set -euo pipefail
STAGE="$1"; MSG="$2"
[ -d "out/data/hazards/$STAGE" ] || { echo "nothing to publish: out/data/hazards/$STAGE is missing" >&2; exit 1; }
rm -rf ghp
git clone --quiet --filter=blob:none --no-checkout --single-branch --branch gh-pages "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" ghp
cd ghp
git sparse-checkout set --no-cone "/data/hazards/$STAGE/" "/tiles/$STAGE/"
git checkout --quiet gh-pages
git config user.name "github-actions[bot]"; git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
rm -rf "data/hazards/$STAGE"; mkdir -p data/hazards; cp -r "../out/data/hazards/$STAGE" data/hazards/
if [ -d "../out/tiles/$STAGE" ]; then rm -rf "tiles/$STAGE"; mkdir -p tiles; cp -r "../out/tiles/$STAGE" tiles/; fi
git add -A --sparse -- "data/hazards/$STAGE"; [ -d "tiles/$STAGE" ] && git add -A --sparse -- "tiles/$STAGE"
if git diff --cached --quiet; then echo "nothing changed"; exit 0; fi
git commit --quiet -m "$MSG"
for i in 1 2 3 4 5 6 7 8; do
  if git push --quiet origin HEAD:gh-pages; then echo "pushed on attempt $i"; git log --oneline -1; exit 0; fi
  sleep $((i * 5)); git fetch --quiet origin gh-pages; git rebase --quiet origin/gh-pages
done
echo "could not push to gh-pages" >&2; exit 1
