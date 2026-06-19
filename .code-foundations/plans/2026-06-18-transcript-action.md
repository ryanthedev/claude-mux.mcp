# Plan: `transcript` action for claude-mux

**Created:** 2026-06-18
**Status:** in-progress
**Started:** 2026-06-18
**Current Phase:** 1
**Complexity:** simple

---

## Context

**Problem:** Agents resuming work scrape tmux scrollback (noisy, capped, rendered TUI output) to recover prior-session context and thrash through paginated `read` calls. The clean conversation already exists as JSONL on disk (`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`) but claude-mux has no action to read it.

**Success:** A `transcript` action that (1) lists a pane's cwd sessions newest-first with an `ai-title`+prompt preview and marks the caller, and (2) reads a chosen session (by list index or sessionId) as flattened prose + action breadcrumbs, newest-first, paginated — dropping `tool_result`/`thinking`/command-expansion noise.

Seeded from `.code-foundations/research/2026-06-18-transcript-action.md` (confirmed). Conventions in `docs/code-standards.md`.

## Constraints

- Single-file additive change to `server.js`. No new dependencies, no build/test scaffolding introduced.
- Reuse existing patterns: `run()` for tmux calls, `paginate()` for output, `HELP_ACTIONS`/`VALID_PARAMS` for registration, plain-text string responses, `error: …` returns (never throw out of `dispatch`).
- Reuse the `name` top-level param as the session selector — no new schema param. Update `name`'s `.describe()` and `PARAM_HINTS.name` so it's no longer "worker-only" (e.g. `name is the agent name for spawn/teammate, or a session index/id for transcript`).
- Read-only access to `~/.claude/projects`. Never write there.
- Defensive parsing of an **undocumented** transcript schema: robustness lean (internal tool) — validate at the file/tmux boundary, skip malformed lines, degrade gracefully, surface readable errors.

---

## Implementation Phases

### Phase 1: Implement the `transcript` action
**Skills:** code-foundations:cc-defensive-programming, code-foundations:cc-routine-and-class-design
**Gate:** Standard

**Goal:** Add one `transcript` action to `server.js` with list and read modes, wired through the existing dispatch/help/validation seams and reading real session JSONL from disk.

**Scope:**
- IN: new helper fns (resolve pane→cwd, slugify→project dir, list sessions, read+flatten a session, tool_use→breadcrumb); the five registration seams; one help-text pointer added to `read`/`tail`.
- IN: mode dispatch by presence of the selector (`name` absent → list; present → read).
- OUT: true pane→session PID binding (deferred — not derivable from cwd); cross-session search; transcript cleanup/editing; any change to existing `read`/`watch`/`tail` capture behavior beyond the help pointer.

**Design notes (grounded in live data):**
- cwd via `run("display", "-t", target, "-p", "#{pane_current_path}")`; project dir = cwd with `/`→`-` (verify against a real dir, incl. leading slash / trailing slash).
- List: enumerate `*.jsonl` in the project dir, sort by mtime desc. Row = `index) <shortId>  <mtime>  <ai-title || first-user-prompt || "(no title)">`. Mark row 1 `(likely you / current)`.
- `ai-title` comes from a `{"type":"ai-title","aiTitle":…}` record; first prompt = first `user` record whose content is a plain string and is not a `<command-*>`/`system-reminder` wrapper.
- Read selector (`name`): integer → index into the same newest-first list; else treat as full or prefix sessionId (prefix must be unambiguous).
- Flatten KEEP: `user` text → `user: …`; `assistant` text → `assistant: …`; `assistant` `tool_use` → breadcrumb by tool name: `Bash`→`[ran: <cmd ~60c>]`, `Edit`/`Write`→`[edited|wrote <basename>]`, `Read`→`[read <basename>]`, `mcp__claude-mux__tmux`→`[tmux <action> <target>]`, `Agent`→`[dispatched agent: <description>]`, `AskUserQuestion`→`[asked user]`, else `[<toolName>]`.
- Flatten DROP: `tool_result` blocks, assistant `thinking` blocks, `user` strings that are `<command-name>`/`<local-command-stdout>`/`<command-message>`/`system-reminder` wrappers, and record types `mode`/`permission-mode`/`last-prompt`/`file-history-snapshot`/`attachment`/`system`/`summary`. Collapse `[Image: …]` → `[image]`. Skip unknown record/block types silently.
- Output ordering: newest-first; let the existing handler paginate with `forward:false` (transcript is NOT added to the `list||who||tasks` forward set). List output is one line/session and normally fits one page.

**Edge cases:**
- Pane target invalid / `display` fails → `error: cannot resolve cwd for <target>`.
- Project dir absent or zero `*.jsonl` → `error: no transcripts for <cwd>`.
- Selector index out of range, or sessionId prefix that matches zero / >1 files → `error:` echoing the valid range / candidates.
- Malformed JSONL line → skip it and continue (do not abort the whole read); a line that isn't JSON must not crash dispatch.
- Session with neither `ai-title` nor a plain-string first prompt → preview falls back to `(no title)`.
- Caller marking is an mtime heuristic — label it as such, don't assert it.

**Produces:** Complete `transcript` action (single phase — no downstream consumer).

**Done when:**
- [ ] DW-1.1: `transcript` is registered across all five seams (`ALL_ACTIONS`, `VALID_PARAMS` = `["target","name","lines"]`, `dispatch` case, `HELP_ACTIONS.transcript`); calling it with no `target` returns its help string. `name`'s `.describe()` and `PARAM_HINTS.name` updated to reflect dual use.
- [ ] DW-1.2: `transcript target:<pane>` (no `name`) resolves the pane's cwd, lists that project dir's sessions newest-first by mtime with index + short sessionId + mtime + `ai-title`/first-prompt/`(no title)` preview, and marks row 1 `(likely you / current)`.
- [ ] DW-1.3: `transcript target:<pane> name:<n>` reads by list index, and `name:<sessionId-or-prefix>` reads by id; an unambiguous match returns that session's flattened conversation.
- [ ] DW-1.4: Flatten output keeps user/assistant text + tool_use breadcrumbs per the mapping above and excludes every DROP category; verified against a real session file from this repo's own project dir.
- [ ] DW-1.5: Each failure path (bad pane, no project dir, no sessions, out-of-range index, ambiguous/zero-match id, unreadable file, malformed line) returns a readable `error: …` or skips gracefully — no exception escapes `dispatch`.
- [ ] DW-1.6: Read output is paginated newest-first via the existing `paginate()` (`forward:false`), and `read`/`tail` help gains a one-line pointer that scrollback ≠ conversation; use `transcript` to recover prior-session work.

---

## Test Coverage

**Level:** Manual smoke verification at 100% of done-when items. The repo has no test framework (confirmed in `docs/code-standards.md`); introducing one is out of scope. Verification runs the action against real transcripts in `~/.claude/projects/-Users-r-repos-claude-mux-mcp/` and the richer `-Users-r-repos-upublish/` dir.

## Test Plan

- [ ] T1 (DW-1.1): `action:transcript` with no target → returns `HELP_ACTIONS.transcript`. Passing a stray param (e.g. `commandId`) → corrective hint.
- [ ] T2 (DW-1.2): `action:transcript target:<this-pane>` → newest-first list, row 1 marked current, previews populated from `ai-title`/first prompt.
- [ ] T3 (DW-1.3, happy): read by index `name:2` and by sessionId prefix → same session, flattened.
- [ ] T4 (DW-1.4): grep the read output to confirm no `tool_result`/thinking/`<command-name>` noise leaks and breadcrumbs render (e.g. `[ran: …]`, `[edited …]`).
- [ ] T5 (DW-1.6): point a long session at a small `pageSize` → paginates newest-first with the page footer; `read`/`tail` help shows the pointer.
- [ ] **Dirty T6 (DW-1.5):** `target:` of a pane whose cwd has no project dir → `error: no transcripts …`; `name:999` → out-of-range error; `name:<ambiguous-prefix>` → candidate list; a hand-corrupted line in a temp copy → skipped, rest of transcript still renders; a `chmod 000` temp copy → `error: cannot read …` (restore perms after). No throw escapes dispatch.

---

## Notes

- **Riskiest assumptions** (validate during build): exact cwd→slug rule (`/`→`-`) across real paths; mtime reliably reflects recency on resume; transcript schema (`ai-title`, `tool_use` shapes, record `type` names) is stable across Claude Code versions — guard all three with skip-unknown defensive parsing.
- `name` as selector slightly overloads a worker-oriented param; acceptable per constraints (no new schema param). The `.describe()`/`PARAM_HINTS` update keeps the corrective-hint system honest.
- Pagination direction is fixed per-action; transcript optimizes for read mode (newest-first). List mode is short enough that this rarely matters; if a cwd ever holds >50 sessions the oldest page-break is a known, low-impact edge.

---

## Execution Log
_To be filled during /code-foundations:build_
