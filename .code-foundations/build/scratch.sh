#!/usr/bin/env bash
set -uo pipefail
cd /Users/r/repos/claude-mux.mcp/.claude/worktrees/session-metadata

echo "===== node --check server.js (syntax) ====="
node --check server.js && echo "SYNTAX OK"

echo
echo "===== tmux server present? ====="
tmux list-sessions 2>&1 | head -5 || echo "(no tmux)"

echo
echo "===== bun scripts/smoke-meta.mjs ====="
bun scripts/smoke-meta.mjs
echo "SMOKE_EXIT=$?"

echo
echo "===== git diff HEAD -- server.js (listSessions/inspectSession guard) ====="
git diff HEAD -- server.js | grep -nE "listSessions|inspectSession" || echo "(no changed lines reference those fns)"

echo
echo "===== bun server.js boot probe ====="
timeout 1 bun server.js </dev/null >/dev/null 2>&1; ec=$?
if [ $ec -eq 124 ]; then echo "boot OK (timed out on stdin = healthy stdio server)"; elif [ $ec -eq 0 ]; then echo "boot OK (clean exit)"; else echo "boot FAIL exit:$ec"; fi

echo
echo "===== DW-1.5 manual spot-check: acceptance -F ====="
tmux list-sessions -F "#{session_name} #{session_activity} #{session_attached}" 2>&1 | head -10 || echo "(no tmux)"
