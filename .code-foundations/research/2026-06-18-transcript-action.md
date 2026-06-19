# Research: `transcript` action for claude-mux

> Add a `transcript` action to `server.js` that reads a Claude Code session's real JSONL transcript from disk, so agents stop scraping tmux scrollback to recover prior-session work.

- **Date:** 2026-06-18
- **Status:** confirmed (ready for `/code-foundations:plan`)
- **Repo:** `claude-mux.mcp` (`server.js`, single-file MCP server)

## Open questions

None blocking. One accepted limitation (see Mapping). Render order chosen as newest-first for tool consistency despite the narrative-reading tradeoff.

---

## Problem

On session resume, agents try to reconstruct earlier work by paginating tmux pane **scrollback** via the `read` action (50-line pages, newest-first). Scrollback is rendered TUI output: dominated by `/context` dumps, collapsed tool calls (`Called claude-mux 3 times`), and hard-capped by tmux's `history-limit`. The agent pages 1→9, finds only noise, and eventually concludes "the full transcript exists on disk." It is correct — and has no action to read it, so it falls back to scraping pixels.

The clean conversation already lives on disk as structured JSONL. The fix is to give claude-mux a first-class action that reads it.

## Grounded facts (verified against live transcripts)

| Fact | Evidence |
|---|---|
| Transcripts live at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | `-Users-r-repos-upublish/f3e57337-….jsonl` |
| cwd-slug = absolute cwd with `/` → `-` | `/Users/r/repos/upublish` → `-Users-r-repos-upublish` |
| One cwd dir holds **many** sessions (10+ for upublish) | `ls -lt` on the dir |
| **Resume creates a NEW jsonl** — prior work is an older file | distinct sessionIds, mtime-ordered |
| Each line is one JSON object with a `type` field | `user`, `assistant`, `attachment`, `mode`, `permission-mode`, `last-prompt`, `ai-title`, `file-history-snapshot`, `system`, `summary` |
| `ai-title` record gives a Claude-generated human title per session | `{"type":"ai-title","aiTitle":"Review unpublish:0 branch changes with mux","sessionId":"…"}` |
| `assistant` content is a block array; `tool_use` blocks carry `name` + `input` | confirmed shapes per tool below |
| `user` content is a string (real prompt) or block array (incl. `tool_result`) | confirmed |
| Slash-command expansions / `/context` dumps appear as user strings with `<command-*>` / `system-reminder` tags | the noise the agent kept hitting in scrollback |

## Confirmed requirements

### R1 — Two modes under one `transcript` action

| Mode | Trigger | Returns |
|---|---|---|
| **List** | `target` only | All sessions in the pane's cwd, newest-first |
| **Read** | `target` + session selector | One session's flattened conversation, paginated |

### R2 — Pane → cwd mapping (accepted limitation)

- Resolve cwd via `tmux display -t <target> -p '#{pane_current_path}'`, then slugify (`/`→`-`) to the project dir.
- **`target` resolves to a cwd, not a unique session.** Two panes sharing a cwd are indistinguishable; "current session" can only mean *newest file by mtime*. This is a hard limit of the data — accepted, not engineered around.

### R3 — List mode

- List every `.jsonl` in the cwd dir, **newest-first by mtime**.
- Per row: short index, session-id (short form ok), mtime, and a preview = **`ai-title` + first user prompt** (fall back to first prompt if no `ai-title`; fall back to `ai-title` only if no prose prompt).
- **Mark the newest as `(likely you / current)`** so the agent skips it and reads the prior one. Show all — do not auto-hide.

### R4 — Read mode

- **Selector accepts either** a list index (`1`, `2`, …) **or** a sessionId (full UUID or prefix). Resolve index against the same newest-first ordering List mode shows.
- Flatten to **prose + action breadcrumbs**, **newest-first**, run through the existing `paginate()` (newest-first mode, like `read`/`watch`).
  - *Tradeoff noted:* newest-first is awkward for reading a session as a narrative, but chosen for consistency with the existing pane-read paging convention.

#### Keep
- `user` text turns → `user: <text>`
- `assistant` text turns → `assistant: <text>`
- `assistant` `tool_use` blocks → one-line breadcrumb of **what was done**:
  - `Bash` → `[ran: <command, ~60 chars>]`
  - `Edit`/`Write` → `[edited <basename>]` / `[wrote <basename>]`
  - `Read` → `[read <basename>]`
  - `mcp__claude-mux__tmux` → `[tmux <action> <target>]`
  - `Agent` → `[dispatched agent: <description>]`
  - `AskUserQuestion` → `[asked user]`
  - anything else → `[<toolName>]`

#### Drop (the noise)
- Block types: `tool_result`, assistant `thinking`
- Record types: `mode`, `permission-mode`, `last-prompt`, `file-history-snapshot`, `attachment`, `system`, `summary` (`ai-title` is consumed for listing, not rendered)
- `user` strings whose content is a `<command-name>` / `<local-command-stdout>` / `<command-message>` / `system-reminder` wrapper (slash-command expansions, `/context` dumps)
- Collapse image refs `[Image: …]` → `[image]`

### R5 — Conventions (match existing server)

- Plain-text responses, reuse `paginate(...)` and `PAGE_SIZE`.
- Add `HELP_ACTIONS.transcript` entry; returned when called with missing/ambiguous params.
- Add to `VALID_PARAMS` — accepts `target`, a session selector param, `lines`, `page`, `pageSize`. Reject stray params with the usual corrective hint.
- Add a one-line pointer in `read`/`tail` help: scrollback ≠ conversation; use `transcript` to recover prior-session work.

## Out of scope

- True pane→session binding (matching the running `claude` PID to its sessionId) — not derivable from cwd; explicitly deferred.
- Editing/summarizing transcripts, cross-session search, or cleanup of old jsonl files.
- Changing the existing scrollback `read`/`watch`/`tail` behavior beyond the one help-text pointer.

## Riskiest assumptions to validate in build

1. **cwd slug algorithm** is exactly `/`→`-` for all real paths (trailing slash, dots, leading slash). Verify against several project dirs before trusting it.
2. **mtime ordering** reliably reflects recency on resume (vs. ctime / a session reopened later writing to an old file).
3. Transcript **schema stability** across Claude Code versions — type names (`ai-title`, `tool_use` shapes) are not a documented contract; guard with defensive parsing and skip-unknown.

## Next

```
/code-foundations:plan .code-foundations/research/2026-06-18-transcript-action.md
```
