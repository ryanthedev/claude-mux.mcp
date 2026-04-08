---
description: Install and verify claude-mux. Checks bun, installs dependencies, verifies MCP server and tmux. Run after installing the plugin.
allowed-tools: Bash, Read
---

Run these checks in order. Fix any issues found. Report a summary at the end.

## 1. Version

Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and extract the version. Print it early so the user knows what's installed:

```
claude-mux v0.6.0
```

## 2. Bun runtime

Verify `bun --version` works. claude-mux requires Bun. If missing, tell the user to install Bun: `curl -fsSL https://bun.sh/install | bash`

## 3. tmux

Verify `tmux -V` works. claude-mux requires tmux. If missing, tell the user to install it:
- macOS: `brew install tmux`
- Linux: `apt install tmux` or equivalent

## 4. Dependencies

Run `bun install` in `${CLAUDE_PLUGIN_ROOT}` to ensure packages are up to date.

## 5. MCP server registration

Check if the tmux MCP server is already registered:

```bash
claude mcp list 2>/dev/null | grep -i tmux
```

If NOT registered, register it:

```bash
claude mcp add tmux -- bun run ${CLAUDE_PLUGIN_ROOT}/server.js
```

If already registered, check that the command path is correct (points to `${CLAUDE_PLUGIN_ROOT}/server.js`). If the path is stale (old location), remove and re-add:

```bash
claude mcp remove tmux
claude mcp add tmux -- bun run ${CLAUDE_PLUGIN_ROOT}/server.js
```

## 6. MCP server health

Smoke-test the server by sending an initialize request:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install","version":"1.0"}}}' | timeout 5 bun run ${CLAUDE_PLUGIN_ROOT}/server.js 2>/dev/null
```

If this returns a valid JSON response with `serverInfo`, the server is healthy. If it fails, read stderr for the error.

## 7. Summary

Report:
- claude-mux: version from plugin.json
- Bun: version or missing
- tmux: version or missing
- Dependencies: installed / error
- MCP server: registered + healthy / needs restart

To update: `claude plugin update claude-mux@rtd` (or whichever marketplace it was installed from), then run `/install` again.

If the MCP server was just registered or updated, tell the user to restart Claude Code for changes to take effect.
