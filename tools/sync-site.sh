#!/usr/bin/env bash
# Refreshes /home/claude/site (the local copy of gh-pages that the dev server serves as tiles/ and data/).
exec flock /tmp/claude-0/site.lock git -C /home/claude/site pull -q --no-rebase origin gh-pages
