#!/usr/bin/env bash
# Local headless screenshot, one at a time across everyone using this machine (software GL saturates both cores).
#   tools/shot.sh "<path-and-query on the dev server>" out.png [--w 1280 --h 800 --wait 1500 --eval "js"]
# Adds the screenshot-mode flags (low resolution while loading, full size for the final frame).
set -euo pipefail
URLPATH="$1"; OUT="$2"; shift 2
SEP='?'; [[ "$URLPATH" == *\?* ]] && SEP='&'
URL="http://127.0.0.1:5280/${URLPATH#/}${SEP}shot=1&scale=0.3"
exec flock /tmp/claude-0/shot.lock timeout 600 node "$(dirname "$0")/shot.mjs" "$URL" "$OUT" --ready 420000 --final 1 "$@"
