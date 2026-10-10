#!/usr/bin/env bash
# Copies out/ into the gh-pages checkout (site/) and pushes one commit. Only touches the paths this pipeline owns.
# usage: publish.sh "<commit message>" [--replace-tiles]
set -uo pipefail
MSG="${1:-vector pipeline}"; REPLACE="${2:-}"
OUT="${OUT_DIR:-out}"; SITE="${SITE_DIR:-site}"
[ -d "$OUT" ] || { echo "nothing to publish"; exit 0; }
[ -f "$OUT/vector_log.txt" ] && mkdir -p "$OUT/data/derived" && cp "$OUT/vector_log.txt" "$OUT/data/derived/vector_log.txt"
for d in data/geo data/osm data/derived; do
  if [ -d "$OUT/$d" ]; then mkdir -p "$SITE/$d" && cp -r "$OUT/$d/." "$SITE/$d/"; fi
done
if [ -d "$OUT/tiles/bld" ]; then
  [ "$REPLACE" = "--replace-tiles" ] && rm -rf "$SITE/tiles/bld"
  mkdir -p "$SITE/tiles/bld" && cp -r "$OUT/tiles/bld/." "$SITE/tiles/bld/"
fi
cd "$SITE"
git config user.name "garita-pipeline"; git config user.email "actions@users.noreply.github.com"
for d in data/geo data/osm data/derived tiles/bld; do
  if [ -e "$d" ]; then git add --sparse -A -- "$d" 2>/dev/null || git add -A -- "$d" || true; fi
done
if git diff --cached --quiet; then echo "no changes to publish"; exit 0; fi
git commit -q -m "$MSG"
for i in 1 2 3 4 5 6 7 8; do
  if git fetch -q origin gh-pages && git rebase -q origin/gh-pages && git push -q origin HEAD:gh-pages; then echo "published: $MSG"; exit 0; fi
  git rebase --abort 2>/dev/null || true
  echo "push attempt $i failed; retrying"; sleep $((5 + RANDOM % 10))
done
echo "publish failed"; exit 1
