# Review: Phase 1 - transcript action

## Executed Results (Step 0)
- Test suite: `bun scripts/smoke-transcript.mjs` → **62 passed, 0 failed** (exit 0)
- Typecheck/syntax: `node --check server.js` → exit 0 (no linter/typechecker configured — confirmed via CLAUDE.md "No tests, no linter, no build step")
- Boot probe: `timeout 2 bun server.js </dev/null` → exit 0, no stderr. Clean exit on stdin EOF is the healthy behavior for a stdio MCP server; the `import.meta.main` guard (server.js:1468) lets the smoke script import helpers without starting the transport.
- Independent flatten spot-check against the real session `~/.claude/projects/-Users-r-repos-claude-mux-mcp/4213d305*.jsonl` (846 flattened lines): no DROP shapes leaked (tool_result / thinking / command-wrapper / raw record envelope all absent); user+assistant present; all breadcrumb families present including `[tmux …]` and `[dispatched agent: …]`; `[TaskUpdate]`/`[TaskGet]` confirm the `default: [<toolName>]` branch.

## Requirement Fulfillment

### DW-1.1
PREMISE:  `transcript` registered across five seams; `VALID_PARAMS=["target","name","lines"]`; no-target returns help; `name` describe + `PARAM_HINTS.name` reflect dual use.
EVIDENCE: ALL_ACTIONS server.js:1424-1431 (line 1425 lists `"transcript"`); VALID_PARAMS:1265; dispatch case:1338-1340; HELP_ACTIONS.transcript:1180-1185; schema describe:1449; PARAM_HINTS.name:1296.
TRACE:    `dispatch("transcript", undefined, …)` → `!target` true → returns `HELP_ACTIONS.transcript`. Stray param → `validateParams` → "unexpected param" hint.
VERDICT:  PASS — smoke checks `t_DW_1_1_*` (in_ALL_ACTIONS, valid_params exact-equals, help_entry, dispatch_case, help_on_missing_target, name_describe_dualuse, name_hint_dualuse, stray_param_hint) all passed; describe line 1449 and hint 1296 contain "transcript" and drop "worker-only" language (verified by Read).

### DW-1.2
PREMISE:  `transcript target:<pane>` resolves cwd, lists project sessions newest-first with index + short id + mtime + ai-title/first-prompt/(no title) preview, row 1 marked.
EVIDENCE: `projectDirFor`:904-918; `listSessionFiles` sort `b.mtime - a.mtime`:941; `transcriptList`:988-998 (row format :994, row-1 mark :993, preview :954-985).
TRACE:    list mode → `sessionPreview` returns ai-title (970), else first plain prompt (973-983), else `(no title)` (984); row 1 gets `(likely you / current — mtime heuristic)`.
VERDICT:  PASS — smoke `t_DW_1_2_*` against the real dir (newest_first, has_index_1, row1_marked_heuristic, short_id_8char) and synth preview fallbacks (ai_title, first_prompt, no_title_fallback) all passed.

### DW-1.3
PREMISE:  `name:<index>` reads by list index, `name:<id-or-prefix>` reads by id; unambiguous match returns the flattened conversation.
EVIDENCE: `selectSession`:1002-1018 (numeric branch :1003-1009, prefix `startsWith` branch :1010-1017); `transcriptAction` wiring :1121-1125.
TRACE:    `"1"` → index 1 → files[0]; full id / unique prefix → single `startsWith` match → `{file}` → `flattenSession`.
VERDICT:  PASS — smoke `t_DW_1_3_*` (read_by_index, read_by_full_id, read_by_unique_prefix, index_matches_list_order, flatten_returns_text) all passed; independently reproduced selector resolution.

### DW-1.4
PREMISE:  Flatten keeps user/assistant text + tool_use breadcrumbs (exact mapping), excludes every DROP category, images→`[image]`, verified on a real session.
EVIDENCE: `breadcrumb`:1021-1042 (Bash/Edit/Write/Read/tmux/Agent/AskUserQuestion/default); `DROP_RECORD_TYPES`:1044-1047; `flattenSession`:1056-1110 (user text-only keep :1075-1090, assistant text+tool_use :1092-1104, thinking dropped :1101, tool_result dropped :1086); `collapseImages`:1049-1051.
TRACE:    assistant block → text→`assistant: …`, tool_use→breadcrumb, thinking→skipped; user → plain prompt kept, tool_result/command-wrapper/system-reminder dropped via `isPlainUserPrompt`/array filter.
VERDICT:  PASS — smoke breadcrumb-unit (bc_bash/trunc/edit/write/read/tmux/tmux_no_target/agent/ask/default) and drop/image synth checks all passed; my independent run on the real 846-line session confirmed zero DROP-shape leaks and every breadcrumb family present.

### DW-1.5
PREMISE:  Each failure path returns a readable `error: …` or skips gracefully; no exception escapes dispatch.
EVIDENCE: bad pane :906; no project dir / zero jsonl :911-916; out-of-range/zero/ambiguous :1005-1016; unreadable file try/catch :1058-1061; malformed line `continue` :1069-1070; sessionPreview read guard :958.
TRACE:    `transcriptAction("bad:…")` → `run` returns null → `error: cannot resolve cwd for bad:…`; malformed JSONL line → JSON.parse throws → caught → `continue`, rest renders.
VERDICT:  PASS — smoke `t_DW_1_5_*` (bad_pane, index_out_of_range, prefix_zero_match, prefix_ambiguous, malformed_skipped, unreadable_no_throw, unreadable_error_or_ok, no_sessions, no_throw_from_dispatch) all passed.

### DW-1.6
PREMISE:  Read output paginates newest-first via existing `paginate(forward:false)` — `transcript` NOT in the forward set; `read`/`tail` help gained a scrollback≠conversation pointer.
EVIDENCE: forward set :1455 (`action === "list" || "who" || "tasks"` — no transcript); `paginate` forward:false default :24; read help pointer :1178; tail help pointer :1179.
TRACE:    handler computes `forward=false` for transcript → `paginate` bottom-anchored "newest first" branch :34-37.
VERDICT:  PASS — smoke `t_DW_1_6_*` (not_in_forward_set, read_help_pointer, tail_help_pointer) passed; both help strings contain `action:transcript` and `scrollback` (verified by Read at 1178-1179).

**All requirements met:** YES

## Test-DW Coverage
- [x] All 6 DW items have automated checks that ran in Step 0 (test names reference DW IDs, e.g. `t_DW_1_4_*`)
- [x] All 7 listed edge cases covered (see below)
- [x] Coverage matches the stated level: standalone runnable smoke script, exit 0

Edge cases verified:
| Edge case | Evidence | Result |
|---|---|---|
| Bad pane / display fails → `error: cannot resolve cwd for <target>` | :906 / `t_DW_1_5_bad_pane` | PASS |
| No project dir / zero jsonl → `error: no transcripts for <cwd>` | :911-916 / `t_DW_1_5_no_sessions` | PASS |
| Index out of range / prefix zero / >1 → error echoes range/candidates | :1005-1016, reproduced independently | PASS |
| Malformed JSONL line skipped, rest renders, no crash | :1069-1070 / `t_DW_1_5_malformed_skipped` | PASS |
| Unreadable file → `error: cannot read <file>`, no throw | :1058-1061 / `t_DW_1_5_unreadable_*` | PASS |
| No ai-title nor string first prompt → `(no title)` | :984 / `t_DW_1_2_preview_no_title_fallback` | PASS |
| Row-1 marking labeled as mtime heuristic, not asserted as fact | :993 `(likely you / current — mtime heuristic)` | PASS |

## Dead Code
None blocking. `projectDirFor` and `sessionPreview`'s `"(unreadable)"` branch are reachable production paths. No unreachable code after early returns, no debug statements, no commented-out blocks in the transcript region (877-1126).

## Correctness Dimensions
| Dimension | Status | Evidence |
|-----------|--------|----------|
| Concurrency | N/A | Synchronous file reads (`readFileSync`/`readdirSync`/`statSync`); no shared mutable state, async, or background tasks in the transcript path. |
| Error Handling | PASS | Every I/O boundary wrapped: file read :1058, dir read :909/:924, stat :934, JSON.parse :1067/965; tmux boundary via `run` returning null :905. No empty catches that swallow bugs silently beyond the documented skip-and-continue policy (each catch has a defined recovery: error string or `continue`). No exception escaped `dispatch` (`t_DW_1_5_no_throw_from_dispatch`). |
| Resources | PASS | `readFileSync` reads whole file then releases; no open handles, locks, or connections retained. |
| Boundaries | PASS | Empty file → `(empty transcript)` :1107; empty list → error :990; index bounds checked :1005; `slice(0,80)`/`slice(0,60)` truncation; optional chaining throughout (`o?.type`, `o.message?.content`). |
| Security | PASS | Untrusted input is the pane-resolved cwd and on-disk JSONL. cwd is slugified to `[A-Za-z0-9]`+`-` (no path traversal reaches a dir name); files enumerated from a fixed `PROJECTS_ROOT` via `readdirSync`, not caller-supplied paths; selector matched against the enumerated id list (`startsWith`), not used to construct a path. No injection surface (no shell interpolation of transcript content). |

## Notes (non-blocking)
1. `breadcrumb` (server.js:1021) is a logical-cohesion switch by `toolName` — acceptable for a render-mapping dispatcher; would only warrant a table if the tool set grows large.
2. `sessionPreview` returns `"(unreadable)"` for an unreadable preview while `flattenSession` returns `error: cannot read …`. Minor inconsistency in failure surface, but both are graceful and neither is a listed requirement.
3. The `mcp__claude-mux__tmux` breadcrumb builds the string before closing `]` with a `.trimEnd()` to drop a trailing space when `target` is absent (:1034) — slightly clever but verified correct for all three cases (`list` → `[tmux list]`, with target, no action → `[tmux ?]`).

**Verdict: PASS**
