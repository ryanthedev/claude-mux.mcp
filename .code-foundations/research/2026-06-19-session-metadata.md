# Research: expose tmux session metadata via a `meta` action

> Add a new `meta` action to claude-mux that emits authoritative per-session and per-window tmux metadata, so downstream consumers (theGrid's tmux dashboard) stop guessing attached state and retire their `tmux list-sessions -F` workaround.

- **Date:** 2026-06-19
- **Status:** confirmed (ready for `/code-foundations:plan`)
- **Repo:** `claude-mux.mcp` (`server.js`, single-file Bun MCP server, currently v0.7.0)
- **Brief:** `/tmp/claude-mux-fix-brief.md`

## Open questions

None blocking. Surface and field-set confirmed by user. Exact column order is proposed below and owned by plan/build.

---

## Problem

`server.js` `listSessions()` (line 128) runs `list-sessions -F "#{session_name}"` — **name only**. `inspectSession()` likewise emits only window names/pane counts/active markers. Neither exposes per-session metadata. Consequences:

- Consumers can't get `session_activity` (last-activity epoch) or `session_attached` (clients attached) from the MCP — they shell out to `tmux list-sessions -F` separately, or have an LLM **guess**. theGrid's dashboard guessed `attached` and got **12 of 13 sessions wrong** (reported attached sessions as unattached).
- `list` **collapses unnamed/numbered sessions** into a count + range (lines 156-161), so numbered sessions get *no* per-session line at all — a dashboard ranking them can't see them individually.

## Confirmed decisions (user)

| Decision | Choice | Rationale |
|---|---|---|
| **Surface** | New `meta` action; leave `list`/`session` untouched | Backward-compat is the priority — existing consumers parse the current text format; a new action is purely additive, zero regression risk, and covers every session including numbered ones. |
| **Field set** | Sessions **+** per-window activity | Lets the dashboard rank both sessions AND windows by recency and retire the workaround entirely. |
| **Per session** | `session_activity`, `session_attached`, `session_created` | activity + attached are the minimum; created is a cheap, useful ranking tiebreak. |
| **Per window** | `window_activity`, `window_active` | dashboard ranks windows too. |
| **Shape** | One stable, machine-parseable line per row | Direct `-F` replacement; consumer splits on a fixed delimiter. |

## Grounded facts (verified on this machine)

| Fact | Evidence |
|---|---|
| All requested fields resolve via tmux `-F` | `tmux list-sessions -F "#{session_name}|#{session_activity}|#{session_attached}|#{session_created}"` → `_config|1781921304|1|1781753913` |
| `session_attached` is a **client count** (int), not a bool | tmux semantics; `1` observed. `>0` ⇒ attached. Emit the raw value so it matches the acceptance `-F` exactly; consumer booleanizes. |
| `session_activity` / `session_created` / `window_activity` are **epoch seconds** | tmux format vars |
| `window_active` is a flag | emit via `#{?window_active,1,0}` |
| tmux session names forbid `:` and `.`; window names allow spaces and `:` but **never tabs** | tmux naming rules — drives delimiter choice |
| `list`/`session` already parse `list-windows -F` colon-delimited | `server.js:144-152`, `:170-180` — existing fragile pattern, NOT to be reused for the machine contract |

## Proposed output contract (`meta` action)

Tab-delimited (`\t`), one row per entity, leading **row-type letter** so consumers parse only data rows and ignore the pagination footer or any blank/tip lines:

```
S\t<session_name>\t<session_activity>\t<session_attached>\t<session_created>
W\t<session_name>\t<window_index>\t<window_name>\t<window_activity>\t<window_active>
```

- `S` rows: every session (named **and** numbered — no collapsing).
- `W` rows: every window, carrying its `session_name` for association, in session order.
- Epochs are raw integers; `session_attached` is the raw tmux count; `window_active` ∈ {0,1}.
- **Tab** is the sole field delimiter (window names may contain spaces/colons but never tabs). Row-type letter is column 0.
- A single leading `# ` comment line documenting the column order is acceptable (consumer skips `#`); plan/build decides whether to include it.

This is a one-call, authoritative replacement for `tmux list-sessions -F "#{session_name} #{session_activity} #{session_attached}"` plus window ranking.

## Constraints

- **Backward compatibility is the top priority.** `list`, `session`, and every other existing action keep their exact current output. The change is purely additive.
- Bun runtime; mirror the v0.7.0 transcript-action style: implementation fn + the five registration seams (`ALL_ACTIONS`, `VALID_PARAMS`, `dispatch` case, `HELP_ACTIONS`, `HELP_TEXT`), plain-text response, `run()` for tmux, `error: …` returns (never throw out of `dispatch`).
- Version bump + changelog per repo convention (v0.7.0 → v0.8.0; bump `package.json`, `.claude-plugin/plugin.json`, `server.js` McpServer identity; document in README Actions table).
- `meta` paginates **forward** (page 1 = top, like `list`/`who`/`tasks`) — add it to the handler's forward set.

## Out of scope

- Any change to `list`/`session`/`layout` output shape.
- Pane-level metadata (only session + window requested).
- Filtering/sorting in the MCP — consumers rank; `meta` just emits authoritative rows in session order.

## Riskiest assumptions to validate in build

1. **No `meta` action name collision** and `meta` slots cleanly into all five registration seams (verify against current `server.js`).
2. **tmux field availability** across versions — guard against an empty/`null` `run()` result (no tmux server, zero sessions) with a readable `error:`.
3. **Acceptance parity:** the `S`-row `name/activity/attached` columns must match `tmux list-sessions -F "#{session_name} #{session_activity} #{session_attached}"` exactly for the same sessions.

## Next

```
/code-foundations:plan .code-foundations/research/2026-06-19-session-metadata.md
```
