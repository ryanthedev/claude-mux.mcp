# claude-mux.mcp

MCP server for tmux. Gives Claude Code terminal control and multi-agent coordination through tmux sessions.

## Install

```bash
claude plugin add claude-mux@rtd
```

Then run `/install` inside Claude Code to verify dependencies and register the MCP server. It checks for bun and tmux, installs packages, and smoke-tests the server.

To update:

```bash
claude plugin update claude-mux@rtd
```

Then run `/install` again to verify everything is current.

### Requirements

- [tmux](https://github.com/tmux/tmux) — `brew install tmux` on macOS, `apt install tmux` on Linux
- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`

### Manual install (development)

If you're working on the server itself, add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "bun",
      "args": ["/path/to/claude-mux.mcp/server.js"]
    }
  }
}
```

## Actions

### Observe

| Action | What it does |
|--------|-------------|
| `list` | All sessions. Named ones show windows; numbered ones get a one-line summary. |
| `session` | One session in detail, previewing each pane's last visible line. |
| `read` | Capture pane output. `lines` sets history depth (default 100). |
| `tail` | Last N lines, no pagination. Quick look at what just happened. |
| `watch` | Delta since last read. Only new lines come back. |
| `transcript` | Read a pane's prior Claude Code sessions from the on-disk JSONL — not scrollback. No `name`: lists the cwd's sessions newest-first with a title preview. With `name` (list index or session id): the flattened conversation, tool calls reduced to one-line breadcrumbs. |
| `layout` | Every pane across all sessions with dimensions and running process. |
| `meta` | Authoritative machine-parseable metadata for dashboards (no params). Tab-delimited rows, row-type letter in column 0 — one `S` row per session (named **and** numbered, no collapsing) and one `W` row per window. `S\t<session_name>\t<session_activity>\t<session_attached>\t<session_created>`; `W\t<session_name>\t<window_index>\t<window_name>\t<window_activity>\t<window_active 0\|1>`. Epochs are raw seconds; `session_attached` is the raw client count (`>0` = attached). TAB is the sole delimiter (window names may contain spaces and `:`). |

### Act

| Action | What it does |
|--------|-------------|
| `type` | Literal text, spaces preserved. No Enter appended. |
| `typewait` | Type literal text + Enter, then wait. One call for "run this and show me what happened." |
| `keys` | Space-separated key tokens: `Escape :q! Enter`, `C-c`, `Down Down Enter`. |
| `keyswait` | Send keys, poll until prompt appears or output settles. Returns the delta. |
| `exec` | Wrap a command in start/done markers, return a `commandId`. Non-blocking. |
| `result` | Check a tracked command's status, exit code, and output by `commandId`. |

### Manage

| Action | What it does |
|--------|-------------|
| `new-session` | Create a session. |
| `kill-session` | Kill a session. |
| `new-window` | Create a window in a session. Returns the target for subsequent calls. |
| `kill-window` | Kill a window. |
| `split` | Split a pane. Returns the new pane target. `text: "horizontal"` or `"vertical"` (default). |
| `kill-pane` | Kill a pane. |
| `rename` | Rename a window. |

### Coordinate

Cross-session agent messaging and task ownership. All state lives in tmux global environment and named buffers.

| Action | What it does |
|--------|-------------|
| `register` | Identify yourself by name. Stored globally so other agents can find you. |
| `unregister` | Remove your registration. |
| `who` | List all registered agents across all sessions. |
| `post` | Message an agent by name, or `"all"` for broadcast. |
| `inbox` | Check for new messages. |
| `claim` | Take a task. Atomic file lock prevents two agents from claiming the same one. |
| `complete` | Mark a task done, release the lock. |
| `tasks` | List all tasks with owner and status. |

### Workers

Spawn Claude Code instances as coordinating agents. Each worker gets a name, a team roster, and auto-injected inbox hooks so messages arrive without polling.

| Action | What it does |
|--------|-------------|
| `spawn` | One-shot `claude -p`. Auto-closes when done, captures output to a tmux buffer. |
| `spawn-persist` | Same, but the window stays open for inspection. |
| `teammate` | Interactive `claude` session. Stays alive for ongoing coordination. |
| `despawn` | Kill a worker, clean up registration and temp files. |
| `worker-result` | Read a completed worker's captured output. |

## Design notes

**Plain text responses.** `list` returns indented text, not nested JSON. Fewer tokens, easier for the model to parse.

**Self-awareness.** The server reads `$TMUX_PANE` on startup and reports `you are here: main:0.1` in listings so the model knows which pane is itself.

**`type` vs `keys`.** `keys` splits on spaces — each token is a tmux key name. Good for `Escape :q! Enter`, destroys prose. `type` sends literal text with spaces intact.

**`exec`/`result` for long commands.** `typewait` blocks up to 30 seconds. `exec` drops start/done markers, returns a `commandId` immediately, and `result` checks on it later. Auto-detects zsh, bash, or fish.

**Completion detection.** `keyswait` and `typewait` poll every 500ms. Shell prompt means done. Output unchanged for 2s means settled. 30s timeout ceiling.

**Atomic task claiming.** `claim` uses `O_EXCL` file creation so two agents racing for the same task can't both win.

## License

MIT
