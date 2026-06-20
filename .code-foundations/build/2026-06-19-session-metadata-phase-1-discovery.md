# Discovery + Design: Phase 1 - Implement the `meta` action

## Files Found
- `server.js` (~1470 lines) — the single-file MCP server. Holds `run()`, `listSessions()`/`inspectSession()`, the five registration seams, the forward-pagination line, the McpServer identity, and the `export { … }` block guarded by `import.meta.main`.
- `package.json` — version `0.7.0`.
- `.claude-plugin/plugin.json` — version `0.7.0`.
- `README.md` — Actions table (to receive a `meta` row).
- `docs/code-standards.md` — present; conventions applied.
- `scripts/` — exists; will hold `scripts/smoke-meta.mjs`.

## Current State
- `run(...args)` (server.js:57) wraps `execFileSync("tmux", …)`, returns trimmed stdout or `null` on failure. All tmux access goes through it.
- `listSessions()` (server.js:127) returns `error: no tmux sessions` when `run()` is null — the exact mirror text the plan wants.
- The v0.7.0 transcript action is the structural template: impl fn + 5 seams. `transcript` dispatch case at 1338, VALID_PARAMS at 1265, HELP_ACTIONS at 1180, HELP_TEXT line at 1136, ALL_ACTIONS at 1425.
- Forward-pagination line (server.js:1455): `const forward = action === "list" || action === "who" || action === "tasks";`
- McpServer identity (server.js:1436): `new McpServer({ name: "claude-mux", version: "0.7.0" })`.
- `export { … }` block (server.js:1462) already exists and is the documented seam for the smoke script; `import.meta.main` guard already present (1468).

## Gaps
- None blocking. The plan assumptions all hold against the live code and tmux server (see below). `meta` is not an existing action name — no collision.

## Code Standards
Key conventions applied (docs/code-standards.md):
- tmux access only through `run(...)`; never shell out directly; pass discrete args.
- Plain-text string responses; `error: …` returns, never throw out of `dispatch`.
- Help-on-missing-params; but `meta` takes no params, so the dispatch case calls the impl unconditionally.
- camelCase fns; lowercase action names. Terse, comment-light.
- Five seams added in order: impl fn, HELP_ACTIONS, VALID_PARAMS, dispatch case, ALL_ACTIONS (+ HELP_TEXT line and forward set per this plan).

## Test Infrastructure
No test framework (confirmed in code-standards). Executable evidence = standalone `scripts/smoke-meta.mjs` run via `bun scripts/smoke-meta.mjs`, exit non-zero on failure. It imports helpers from `server.js` (which does not start the transport, thanks to `import.meta.main`). Live-tmux assertions + synthetic-string unit tests for dirty paths + a `git diff` regression guard.

## Live tmux probe (riskiest-assumption validation)
- `list-windows -a -F "…#{session_name}…"` **DOES** expose `#{session_name}` on this box. So the single-call path is viable; no per-session fallback needed for the happy path. I will still keep the formatter resilient (a `null` windows result is tolerated by the unit test path).
- 13 sessions, 21 windows live. Window names contain emoji and `.` (`🤖 2.1.183`) — preserved verbatim in their tab field.
- `session_attached` is the raw client count (`1`, `0`) — matches the acceptance `-F` exactly.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `meta` registered across all five seams + added to `forward` set; invoking returns dump not help | COVERED | smoke T1: `dispatch("meta")` returns S/W rows; assert `meta` ∈ ALL_ACTIONS, VALID_PARAMS.meta == [], HELP_ACTIONS.meta present, HELP_TEXT contains `meta`, server.js forward line contains `"meta"`; stray param `text` → corrective hint |
| DW-1.2 | one `S\t…` row per session incl. numbered, 5 tab cols | COVERED | smoke T2: S-row count == `tmux list-sessions \| wc -l`; each S row splits to arity 5 |
| DW-1.3 | one `W\t…` row per window, 6 tab cols, session order | COVERED | smoke T2: W-row count == `tmux list-windows -a \| wc -l`; each W splits to arity 6; W rows after S rows |
| DW-1.4 | `listSessions()`/`inspectSession()` source unchanged; `list` has no S/W rows | COVERED | smoke T4: `git diff` shows zero changed lines in those two fn bodies; `dispatch("list")` output contains no `S\t`/`W\t` |
| DW-1.5 | live S-row name/activity/attached == `tmux list-sessions -F "#{session_name} #{session_activity} #{session_attached}"` | COVERED | smoke T3: build the triple set from S rows and from the acceptance `-F`; assert exact set equality |
| DW-1.6 | no-tmux/zero-session → readable `error: …`, no throw; failed `list-windows` still yields S row | COVERED | smoke T6: formatter on empty/null sessions → `error: no tmux sessions`, no throw; session with null windows → S present, its W absent, others intact; window name with space/`:` round-trips |
| DW-1.7 | version 0.8.0 in 3 files; README documents `meta` + columns | COVERED | smoke T5: grep `0.8.0` in package.json, plugin.json, server.js McpServer; README has `meta` row naming S/W columns |

**All items COVERED:** YES (7 DW-IDs in prompt, 7 rows here)

## Design Decisions

Applying cc-routine-and-class-design (functional cohesion, ≤7 params) and cc-defensive-programming (validate external input at the barricade, error-return not throw, no empty catch).

**Two routines, split by cohesion — not one `metaDump()` that gathers AND formats:**

1. **`formatMeta(sessionsRaw, windowsRaw)`** — pure, no side effects, no tmux. Takes the two raw `run()` strings (or `null`) and returns the final dump string or `error: no tmux sessions`. This is the *testable barricade*: the smoke script feeds it synthetic dirty inputs. It owns all the edge-case logic:
   - `null`/empty `sessionsRaw` → `error: no tmux sessions` (mirrors `listSessions()` line 129).
   - `null`/empty `windowsRaw` → emit S rows only (every session still gets its line); no W rows. This also covers "a session whose `list-windows` fails" because with the single `-a` call a global null means no W rows at all, and the per-`S` rows survive.
   - It does NOT re-split window fields — the raw `W\t…` lines already carry the correct tab layout straight from tmux `-F`, so window names with spaces/`:` are preserved verbatim. The formatter only filters to lines beginning with `W\t` (defensive: ignore any stray tmux warning lines that lack the row-type prefix) and concatenates S rows then W rows.
   - Parameters: 2 (PASS). Cohesion: functional — "format the meta dump".

2. **`metaAction()`** — the dispatch entry. Calls `run("list-sessions", "-F", S_FORMAT)` and `run("list-windows", "-a", "-F", W_FORMAT)`, then `return formatMeta(s, w)`. Side-effecting (does I/O) but delegates all logic; cohesion: functional ("produce the meta dump"). 0 params.

This split satisfies the test-coverage requirement (the pure formatter is unit-testable with synthetic strings) and the barricade rule: `run()` output is external input — `formatMeta` validates it (null/empty/missing-prefix) before trusting it. No assertions used (all conditions are anticipated runtime states of an external boundary, not programmer bugs) — consistent with the assertion-vs-error-handling table.

**Format strings (tmux does the row-type prefix and tab layout):**
- `S_FORMAT = "S\t#{session_name}\t#{session_activity}\t#{session_attached}\t#{session_created}"`
- `W_FORMAT = "W\t#{session_name}\t#{window_index}\t#{window_name}\t#{window_activity}\t#{?window_active,1,0}"`

Real tabs are embedded in the JS string literals (`\t`) so `execFileSync` passes a literal-tab format to tmux. tmux substitutes fields; a tab can never appear inside a tmux field value, so the row-type letter at column 0 + tab delimiter is unambiguous.

**Output ordering:** S rows (in tmux session order from `list-sessions`) first, then all W rows (in `list-windows -a` order, which is session order). Consumers key W rows by their `session_name` column regardless of grouping — the contract permits "S rows then W rows". This is simplest and avoids re-parsing/regrouping (concision: let tmux's native ordering stand).

**Pagination:** add `meta` to the forward set so page 1 = top (S rows first), consistent with `list`/`who`/`tasks`.

## Prerequisites
- [x] Required files exist
- [x] `bun` + `@modelcontextprotocol/sdk` available in worktree
- [x] `import.meta.main` guard + export block already present (v0.7.0)
- [x] `list-windows -a` exposes `#{session_name}` on this box (probed) — single-call path viable

## Recommendation
BUILD. Add `formatMeta` + `metaAction`, wire the five seams + forward set, bump versions, add README row, write `scripts/smoke-meta.mjs`. `listSessions()`/`inspectSession()` untouched.
