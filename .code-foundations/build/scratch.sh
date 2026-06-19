#!/usr/bin/env bash
set +e
cd /Users/r/repos/claude-mux.mcp

echo "=== node --check server.js (syntax) ==="
node --check server.js; echo "node --check exit: $?"

echo
echo "=== bun scripts/smoke-transcript.mjs ==="
bun scripts/smoke-transcript.mjs; echo "smoke exit: $?"

echo
echo "=== bun server.js boot probe (independent) ==="
timeout 1 bun server.js </dev/null >/dev/null 2>&1; ec=$?
if [ $ec -eq 124 ]; then echo "boot OK (timed out waiting on stdin = healthy stdio server)"; elif [ $ec -eq 0 ]; then echo "boot OK (clean exit)"; else echo "boot FAIL exit:$ec"; fi
