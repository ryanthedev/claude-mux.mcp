# Plan: `meta` action — expose tmux session metadata

**Created:** 2026-06-19
**Status:** complete
**Started:** 2026-06-19
**Completed:** 2026-06-19
**Complexity:** simple

---

## Context

**Problem:** claude-mux's `list`/`session` actions expose only session/window **names** (`list-sessions -F "#{session_name}"`, `server.js:128`), so consumers can't get `session_activity` or `session_attached` from the MCP and are forced to guess — theGrid's dashboard guessed attached state and got **12 of 13 sessions wrong**. `list` also collapses numbered sessions, so they get no per-session line at all.

**Success:** A new additive `meta` action emits authoritative, machine-parseable per-session and per-window metadata (every session, named + numbered), letting the dashboard rank sessions AND windows by recency and retire its `tmux list-sessions -F` workaround. Existing actions are byte-for-byte unchanged.

Seeded from `.code-foundations/research/2026-06-19-session-metadata.md` (confirmed). Surface (new `meta` action, leave `list`/`session` untouched) and field set (sessions + per-window activity) confirmed by user. Conventions in `docs/code-standards.md`.

## Constraints

- **Backward compatibility is the top priority.** `list`, `session`, `layout`, and every other existing action keep their exact current output. The change is purely additive — no edits to `listSessions()`/`inspectSession()`.
- Single-file change to `server.js`, mirroring the v0.7.0 transcript-action style: implementation fn + the five registration seams, `run()` for tmux, plain-text response, `error: …` returns (never throw out of `dispatch`).
- Output is tab-delimited with a leading row-type letter (see contract). Tab is the sole delimiter — tmux window names allow spaces/colons but never tabs.
- `session_attached` is emitted as the **raw tmux count** (so it matches the acceptance `-F` exactly; `>0` ⇒ attached). Epochs are raw integers. `window_active` ∈ {0,1}.
- Version bump v0.7.0 → v0.8.0 (`package.json`, `.claude-plugin/plugin.json`, `server.js` McpServer identity) and README Actions-table entry, per repo convention.

---

## Implementation Phases

### Phase 1: Implement the `meta` action
**Skills:** code-foundations:cc-defensive-programming, code-foundations:cc-routine-and-class-design
**Gate:** Standard

**Goal:** Add one additive `meta` action to `server.js` that emits authoritative tab-delimited per-session (`S`) and per-window (`W`) tmux metadata for every session, wired through the existing registration seams, with existing actions untouched.

**Scope:**
- IN: new helper fn(s) (gather sessions + windows via `run("list-sessions"/"list-windows", -F, …)`, format rows); the five registration seams (`ALL_ACTIONS`, `VALID_PARAMS.meta = []`, `dispatch` case, `HELP_ACTIONS.meta`, `HELP_TEXT` line); add `meta` to the handler's forward-pagination set; README Actions-table row; version bump to 0.8.0 in the three files.
- OUT: any change to `list`/`session`/`layout` output shape; pane-level metadata; filtering/sorting/ranking in the MCP (consumers rank).

**Output contract (the seam consumers depend on):**
```
S\t<session_name>\t<session_activity>\t<session_attached>\t<session_created>
W\t<session_name>\t<window_index>\t<window_name>\t<window_activity>\t<window_active>
```
- One `S` row per session (named AND numbered — NO collapsing), in tmux session order.
- One `W` row per window, carrying its `session_name`, grouped after/with its session in session order.
- `session_activity`/`session_created`/`window_activity` = raw epoch seconds; `session_attached` = raw tmux client count; `window_active` = `#{?window_active,1,0}`.
- Fetch sessions with a single `list-sessions -F "S\t#{session_name}\t#{session_activity}\t#{session_attached}\t#{session_created}"` and windows per session (or globally) with `list-windows -F "W\t#{session_name}\t#{window_index}\t#{window_name}\t#{window_activity}\t#{?window_active,1,0}"`. Prefer `list-windows -a` (all windows, one call) if it yields `#{session_name}`, falling back to per-session calls.

**Edge cases:**
- No tmux server / zero sessions / `run()` returns null or empty → `error: no tmux sessions` (mirror `listSessions()` line 129); no exception escapes `dispatch`.
- `list-windows` returns null for a session → skip that session's `W` rows but still emit its `S` row (don't abort the whole dump).
- Window name containing spaces or `:` → preserved verbatim in its tab field (the reason tab is the delimiter).
- A field tmux can't resolve on an older version → row still emits; an empty column is acceptable, a crash is not.

**Produces:** Complete `meta` action (single phase — no downstream consumer). External contract = the `S`/`W` row schema above.

**Done when:**
- [ ] DW-1.1: `meta` is registered across all five seams (`ALL_ACTIONS`, `VALID_PARAMS.meta = []`, `dispatch` case, `HELP_ACTIONS.meta`, `HELP_TEXT` line) and added to the handler's `forward` pagination set; invoking `meta` returns the metadata dump (not help).
- [ ] DW-1.2: Output contains one `S\t…` row per session — including numbered/unnamed sessions (no collapsing) — with columns `name, session_activity, session_attached, session_created`, tab-delimited.
- [ ] DW-1.3: Output contains one `W\t…` row per window with columns `session_name, window_index, window_name, window_activity, window_active(0/1)`, tab-delimited, in session order.
- [ ] DW-1.4: `listSessions()` and `inspectSession()` source is unmodified and their output is byte-for-byte identical to pre-change (regression guard); `list` output contains no `S`/`W` tab rows.
- [ ] DW-1.5: For the live tmux server, the `S`-row `name/activity/attached` columns match `tmux list-sessions -F "#{session_name} #{session_activity} #{session_attached}"` exactly (same sessions, same values).
- [ ] DW-1.6: No-tmux-server / zero-session path returns a readable `error: …` and no exception escapes `dispatch`; a session whose `list-windows` fails still yields its `S` row.
- [ ] DW-1.7: Version is 0.8.0 in `package.json`, `.claude-plugin/plugin.json`, and `server.js` McpServer identity; README Actions table documents `meta` and its column contract.

---

## Test Coverage

**Level:** Manual smoke verification at 100% of done-when items. The repo has no test framework (confirmed in `docs/code-standards.md`); introducing one is out of scope. Bun is available. Verification runs a standalone `scripts/smoke-meta.mjs` (run via `bun scripts/smoke-meta.mjs`) that exercises the action against the live tmux server and unit-tests the row-formatting helper with synthetic `run` output for the dirty paths. Do not mutate real tmux state.

## Test Plan

- [ ] T1 (DW-1.1): `meta` registered — invoking it returns row output; stray param (e.g. `text`) → corrective hint; `meta` is in the forward-pagination set.
- [ ] T2 (DW-1.2 / DW-1.3): against live tmux, every session yields an `S` row (assert count == `tmux list-sessions | wc -l`, including numbered sessions) and every window yields a `W` row (assert count == `tmux list-windows -a | wc -l`); columns tab-split to the documented arity (5 for S, 6 for W).
- [ ] T3 (DW-1.5): diff the `S`-row `name/activity/attached` triples against `tmux list-sessions -F "#{session_name} #{session_activity} #{session_attached}"` — exact match.
- [ ] T4 (DW-1.4, regression): the real guard is a **git diff** showing `listSessions()`/`inspectSession()` source is untouched (zero lines changed in those fns). Additionally, capture `list`/`session` output and confirm it contains no `S\t`/`W\t` tab rows. Do NOT hardcode the exact `list` format as a pass condition — DW-1.4 requires only "identical to pre-change", so an unchanged-source diff is the authoritative check.
- [ ] T5 (DW-1.7): grep version = 0.8.0 in all three files; README Actions table contains a `meta` row naming the columns.
- [ ] **Dirty T6 (DW-1.6):** feed the formatter a synthetic empty/`null` `list-sessions` result → `error: no tmux sessions`, no throw; feed a session whose `list-windows` returns null → `S` row present, `W` rows for it absent, rest of dump intact; a window name containing a space/colon round-trips intact in its tab field.

---

## Notes

- **Riskiest assumptions** (validate during build): no `meta` name collision and clean fit into all five seams; `list-windows -a` exposes `#{session_name}` (else fall back to per-session window calls); tmux field availability across versions (guard null `run()`); acceptance parity on the `S`-row triple.
- Pagination: `meta` joins `list`/`who`/`tasks` in the forward set (page 1 = top). Sessions+windows for a typical box fit one page; the row-type letter lets consumers ignore any pagination footer.
- Contract stability: the `S`/`W` column order is the consumer-facing contract — additions must append columns, never reorder.

---

## Execution Log

### Phase 1: Implement the `meta` action (Gate: Standard)
- [x] BUILD: Discovery + design + implementation (stub → implement → validate) complete
- [x] REVIEW: Verification passed (independent post-gate, all 7 DW + 4 edge cases, 33/33 smoke assertions; live S-row triple 13/13 exact match re-confirmed)
- [x] Committed
Commit: 4a9ed18
Summary: Added the additive `meta` action to server.js — emits tab-delimited `S` rows (every session incl. numbered, no collapsing) and `W` rows (every window in session order) with session_activity/attached/created and window_activity/active. Pure `formatMeta()` + `metaAction()` I/O entry, run() validated at the barricade (null→`error: no tmux sessions`, no throw). listSessions/inspectSession byte-for-byte unchanged. v0.8.0 bump + README contract. Verified by `scripts/smoke-meta.mjs`.
