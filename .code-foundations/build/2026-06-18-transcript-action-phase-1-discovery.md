# Discovery + Design: Phase 1 - Implement the `transcript` action

## Files Found
- `server.js` (~1200 lines) — single-file MCP server. All five registration seams confirmed present at the documented line ranges.
- `docs/code-standards.md` — present; "Adding an action — the seams" section maps 1:1 to this phase.
- `~/.claude/projects/-Users-r-repos-claude-mux-mcp/4213d305-…368.jsonl` — this repo's own session (226 lines, 903K). Used as the real read/flatten fixture.
- `~/.claude/projects/-Users-r-repos-upublish/` — 131 `*.jsonl` sessions; richer multi-session dir for list-mode verification and `mcp__claude-mux__tmux` breadcrumb samples.

## Current State
- `server.js` has 32 actions through one `dispatch()` switch. Helpers: `run()` (execFileSync tmux wrapper, returns `null` on failure), `paginate(text,page,pageSize,{forward})`, `selfHeader()`. The outer tool handler (line ~1189) computes `forward = action === "list" || "who" || "tasks"` and wraps every dispatch result in `paginate()`.
- The five seams: `ALL_ACTIONS` (1162), `VALID_PARAMS` (1001), `dispatch()` switch (1064), `HELP_ACTIONS` (924), `HELP_TEXT` (879). Shared params only: `target, text, lines, commandId, name`. `name`'s `.describe()` is line 1187; `PARAM_HINTS.name` is line 1037 — both currently say "worker only".
- No `fs` read helpers beyond what's imported: `readFileSync` is already imported (line 7). `readdirSync`/`statSync` are NOT — must add to the `fs` import.

## Gaps (plan assumption vs verified reality)

| # | Plan said | Verified reality | Resolution |
|---|-----------|------------------|------------|
| 1 | slug = cwd with `/`→`-` | `/Users/r/repos/claude-mux.mcp` → `-Users-r-repos-claude-mux-mcp`. The `.` ALSO becomes `-`. Naive `/`→`-` would yield a non-existent `…claude-mux.mcp` dir. Case is preserved (`theGrid`→`-Users-r-repos-theGrid`, NOT lowercased). | Slug rule = `cwd.replace(/[^A-Za-z0-9]/g, "-")`. Verified PASS against 4 real dirs (claude-mux.mcp, upublish, theGrid, code-foundations). The plan itself flagged this with a "VERIFY" note — resolved. |
| 2 | content at record `o.content` (implied) | Message content lives at `o.message.content`; record `type` is at `o.type`; `ai-title` value is at `o.aiTitle`. | Read `o.message.content`. Confirmed against real file. |
| 3 | `run("display", …)` for cwd | `run()` calls `execFileSync("tmux", args)`; tmux command is `display-message` (existing code uses `display-message`, not `display`). `run("display-message","-t",target,"-p","#{pane_current_path}")` returns the cwd or `null`. | Use `display-message`. Real call returned `/Users/r/repos/claude-mux.mcp`. |
| 4 | `[Image: …]` collapse | Real marker form is `[Image #1]` (in user text blocks). | Collapse `/\[Image[^\]]*\]/` → `[image]`. |

No gaps block the build. All are resolved by the design below.

## Code Standards
Key conventions applied (from `docs/code-standards.md`):
- All tmux calls through `run(...)`; never shell-interpolate untrusted values (pass discrete execFileSync args).
- `error: …` string returns, never throw out of dispatch.
- Help-on-missing-params: missing `target` → return `HELP_ACTIONS.transcript`.
- Plain-text responses only; camelCase fns; terse, comment only the non-obvious.
- Reuse the six shared params — no new schema param (`name` is the selector).
- `~/.claude/` is read-only — never write there.

## Test Infrastructure
No framework, no linter (confirmed in code-standards + CLAUDE.md). Per the dispatch Test Coverage note: satisfy "executable evidence per DW" with a standalone `scripts/smoke-transcript.mjs` run via `bun scripts/smoke-transcript.mjs`, exiting non-zero on failure. To make pure helpers unit-testable, guard the `server.connect(transport)` bootstrap behind an `import.meta.main` check and `export` the helpers — keeping `bun server.js` working exactly as before. Drive list/read against the real repo project dir; synthesize temp JSONL fixtures in a self-created, self-cleaned tmp dir for dirty paths (malformed line, chmod 000, empty dir). Never mutate `~/.claude/projects`.

## DW Verification

| DW-ID | Done-When Item | Status | Test Cases |
|-------|---------------|--------|------------|
| DW-1.1 | `transcript` registered across all five seams; no-`target` returns help; `name` `.describe()` + `PARAM_HINTS.name` updated for dual use | COVERED | `t_DW_1_1_registered_all_seams` (assert `ALL_ACTIONS`/`VALID_PARAMS.transcript=["target","name","lines"]`/`HELP_ACTIONS.transcript` exist), `t_DW_1_1_help_on_missing_target` (dispatch `transcript` no target → help string), `t_DW_1_1_name_describe_dualuse` (grep server.js source: `name` describe + `PARAM_HINTS.name` no longer "only for worker"), `t_DW_1_1_stray_param_hint` (transcript + `commandId` → corrective hint) |
| DW-1.2 | `transcript target:<pane>` lists project sessions newest-first by mtime: index + shortId + mtime + ai-title/first-prompt/`(no title)`; row 1 marked `(likely you / current)` | COVERED | `t_DW_1_2_list_newest_first` (against real repo dir: rows sorted mtime desc, index 1..n), `t_DW_1_2_row1_marked_heuristic` (row 1 contains `(likely you / current)` and label says heuristic, not asserted), `t_DW_1_2_preview_fallbacks` (synth fixtures: ai-title present→title; absent→first prompt; neither→`(no title)`) |
| DW-1.3 | `name:<n>` reads by 1-based list index; `name:<id-or-prefix>` reads by id; unambiguous match → flattened conversation | COVERED | `t_DW_1_3_read_by_index` (real dir, `name:1` flattens), `t_DW_1_3_read_by_full_id`, `t_DW_1_3_read_by_unique_prefix` (8-char prefix → same session), `t_DW_1_3_index_matches_list_order` (index N == list row N) |
| DW-1.4 | Flatten keeps user/assistant text + tool_use breadcrumbs per mapping; excludes every DROP category; verified vs real repo session | COVERED | `t_DW_1_4_keeps_text_and_breadcrumbs` (real session: contains `user:`/`assistant:` lines + `[ran: …]`, `[edited …]`/`[wrote …]`, `[read …]`, `[tmux … …]`, `[dispatched agent: …]`, `[asked user]`), `t_DW_1_4_drops_noise` (no `tool_result`, no `thinking`, no `<command-name>`/`system-reminder`, no raw `permission-mode`/`file-history-snapshot` text leaks), `t_DW_1_4_image_collapse` (`[Image #1]`→`[image]`), `t_DW_1_4_breadcrumb_mapping_unit` (synth blocks → exact breadcrumb per tool) |
| DW-1.5 | Each failure path returns readable `error: …` or skips gracefully; no exception escapes dispatch | COVERED | `t_DW_1_5_bad_pane` (cwd unresolvable → `error: cannot resolve cwd for <target>`), `t_DW_1_5_no_project_dir` / `t_DW_1_5_zero_jsonl` (→ `error: no transcripts for <cwd>`), `t_DW_1_5_index_out_of_range` (echoes valid range), `t_DW_1_5_prefix_zero_match` & `t_DW_1_5_prefix_ambiguous` (echoes candidates), `t_DW_1_5_malformed_line_skipped` (corrupt line in temp copy → rest still renders), `t_DW_1_5_unreadable_file` (chmod 000 temp → `error: cannot read <file>`; perms restored), `t_DW_1_5_no_throw` (wrap every failure dispatch in try/catch; assert no throw) |
| DW-1.6 | Read output paginated newest-first via existing `paginate()` (`forward:false`); `read`/`tail` help gains pointer that scrollback ≠ conversation → use `transcript` | COVERED | `t_DW_1_6_not_in_forward_set` (assert handler `forward` expr excludes `transcript`; source-grep), `t_DW_1_6_paginates_newest_first` (long flattened text through `paginate(...,{forward:false})` → page footer `newest first`, page 1 = tail), `t_DW_1_6_help_pointer` (`HELP_ACTIONS.read` and `.tail` contain a transcript pointer line) |

**All items COVERED:** YES (6 DW-IDs in prompt; 6 in table — count matches).

## Design Decisions

### Cohesion (cc-routine-and-class-design)
One public entry `transcriptAction(target, name, lines)` orchestrating named single-operation helpers — temporal/orchestration cohesion at the entry (ACCEPT: it delegates), functional cohesion in each helper:

| Routine | Params | Operation (one) | Cohesion |
|---------|--------|-----------------|----------|
| `transcriptAction(target, name)` | 2 | dispatch list vs read by `name` presence; resolve cwd→dir first | Orchestration (delegates) — ACCEPT |
| `cwdSlug(cwd)` → string | 1 | map cwd to project-dir name (`/[^A-Za-z0-9]/g`→`-`) | Functional |
| `projectDirFor(target)` → `{dir,cwd}` \| error-string | 1 | resolve pane→cwd→dir, validate existence | Functional |
| `listSessionFiles(dir)` → `[{file,id,mtime}]` | 1 | enumerate `*.jsonl`, sort mtime desc | Functional |
| `sessionPreview(file)` → string | 1 | ai-title ‖ first-prompt ‖ `(no title)` | Functional |
| `transcriptList(dir, cwd)` → string | 2 | render the numbered list + caller mark | Functional (uses the two above) |
| `selectSession(files, name)` → `{file}` \| error-string | 2 | index-or-prefix resolution | Functional |
| `flattenSession(file)` → string | 1 | read+flatten records to prose/breadcrumbs | Functional |
| `breadcrumb(toolName, input)` → string | 2 | tool_use → one breadcrumb line | Functional (logical-flag risk noted below) |

All routines ≤2 params (PASS, well under 7). No classes/inheritance introduced — plain functions matching the file's existing style, so the LSP/containment checks are N/A. `breadcrumb()` is a `switch (toolName)` selecting one of several formatters — borderline *logical* cohesion, but each case is a trivial single-line format of the same input shape (a tool_use block) at one abstraction level; acceptable as a lookup/format function rather than unrelated operations. Documented here per "ACCEPT w/caution".

### Defensive programming (cc-defensive-programming)
The JSONL file and tmux output are **external input** (cross-process, undocumented/unstable schema) → barricade at the file/tmux boundary; validate and degrade, never throw:
- `run()` already returns `null` on tmux failure → treat `null`/empty cwd as `error: cannot resolve cwd for <target>`.
- Project dir missing or zero `*.jsonl` → `error: no transcripts for <cwd>` (wrap `readdirSync` in try/catch; ENOENT is an expected runtime condition, not a bug → error-handling, not assertion).
- Per-line `JSON.parse` in its own try/catch → skip malformed line, continue (do NOT abort the read). A non-JSON line must never crash dispatch.
- `readFileSync` of a session file wrapped in try/catch → `error: cannot read <file>` (covers chmod 000 / EACCES).
- Selector resolution: out-of-range index echoes the valid range; prefix matching 0 or >1 echoes candidates — all readable `error:` strings.
- Every block/record handler uses optional chaining + type guards and silently skips unknown shapes (robustness lean — internal tool; correctness of any single line is not safety-critical, availability of the rest of the transcript is what matters).
- No executable code inside assertions (we use no assertions here — every failure mode is an anticipated runtime condition, so all are error-handled, per the assertion-vs-error-handling table).

### Flatten contract (verified against real schema)
- Record at `o.type`; message at `o.message`; content at `o.message.content` (string or array of blocks).
- KEEP: `user` text→`user: …`; `assistant` text→`assistant: …`; `assistant` `tool_use`→`breadcrumb(name,input)`.
- Breadcrumbs: `Bash`→`[ran: <cmd≤60c>]`; `Edit`/`Write`→`[edited <basename>]`/`[wrote <basename>]`; `Read`→`[read <basename>]`; `mcp__claude-mux__tmux`→`[tmux <action> <target>]`; `Agent`→`[dispatched agent: <description>]`; `AskUserQuestion`→`[asked user]`; else `[<toolName>]`.
- DROP: `tool_result` blocks, assistant `thinking` blocks, `user` strings wrapped in `<command-name>`/`<local-command-stdout>`/`<command-message>`/`system-reminder`, and record types `mode`/`permission-mode`/`last-prompt`/`file-history-snapshot`/`attachment`/`system`/`summary`. Collapse `[Image…]`→`[image]`. Unknown types skipped silently.

### Pagination
`transcriptAction` returns the full listed/flattened text; the existing handler paginates it. `transcript` is NOT added to the `forward` set, so it paginates `forward:false` (newest-first, page 1 = bottom) like `read` — exactly DW-1.6. Flatten output is emitted newest-first (reverse record order) so newest content lands on page 1.

### Testability seam
Guard `await server.connect(transport)` behind `if (import.meta.main)` and `export` the pure helpers (`cwdSlug`, `listSessionFiles`, `sessionPreview`, `breadcrumb`, `flattenSession`, `selectSession`, `transcriptList`). `bun server.js` (main) still connects the transport unchanged; `import` from the smoke script does not start stdio.

## Prerequisites
- [x] `server.js` and all five seams exist at documented lines
- [x] Real session JSONL fixtures exist (repo dir + upublish dir)
- [x] `readFileSync` already imported; will add `readdirSync`, `statSync` to the `fs` import
- [x] Slug rule verified against 4 real dirs
- [x] tmux MCP tool name `mcp__claude-mux__tmux` confirmed in real transcripts
- [x] `bun` available for the smoke script

## Recommendation
BUILD. All gaps resolved against live data; no plan-blocking discrepancy. Implement `transcript` additively across the five seams plus the `name` describe/hint update and the `read`/`tail` help pointer, then validate with `scripts/smoke-transcript.mjs`.
