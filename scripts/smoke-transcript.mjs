#!/usr/bin/env bun
// Standalone smoke verification for the `transcript` action.
// Run: bun scripts/smoke-transcript.mjs   (exits non-zero on any failure)
//
// Drives the pure helpers + dispatch against REAL transcripts in this repo's own
// project dir, and against synthesized temp JSONL fixtures for the dirty/edge paths.
// Never mutates anything under ~/.claude/projects.

import {
  cwdSlug, listSessionFiles, sessionPreview, transcriptList, selectSession,
  breadcrumb, flattenSession, transcriptAction, dispatch,
  HELP_ACTIONS, VALID_PARAMS, ALL_ACTIONS, PARAM_HINTS,
} from "../server.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

const REPO_DIR = `${process.env.HOME}/.claude/projects/-Users-r-repos-claude-mux-mcp`;
const SERVER_SRC = readFileSync(new URL("../server.js", import.meta.url), "utf-8");

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; }
  else { fail++; fails.push(`${name}${detail ? ` — ${detail}` : ""}`); console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`); }
}
function group(label) { console.log(`\n# ${label}`); }

// ---------------------------------------------------------------------------
// DW-1.1: registration across five seams + name describe/hint + help-on-no-target
// ---------------------------------------------------------------------------
group("DW-1.1 registration");
check("t_DW_1_1_in_ALL_ACTIONS", ALL_ACTIONS.includes("transcript"));
check("t_DW_1_1_valid_params", JSON.stringify(VALID_PARAMS.transcript) === JSON.stringify(["target", "name", "lines"]),
  JSON.stringify(VALID_PARAMS.transcript));
check("t_DW_1_1_help_entry_exists", typeof HELP_ACTIONS.transcript === "string" && HELP_ACTIONS.transcript.includes("transcript"));
check("t_DW_1_1_dispatch_case_present", SERVER_SRC.includes('case "transcript":'));
{
  const help = await dispatch("transcript", undefined, undefined, undefined, undefined, undefined);
  check("t_DW_1_1_help_on_missing_target", help === HELP_ACTIONS.transcript);
}
check("t_DW_1_1_name_describe_dualuse", /session index\/id for transcript/.test(SERVER_SRC) &&
  !/name: z\.string\(\)\.optional\(\)\.describe\("Agent name for spawn\/teammate actions only"\)/.test(SERVER_SRC));
check("t_DW_1_1_name_hint_dualuse", /transcript/.test(PARAM_HINTS.name) && !/only for worker/.test(PARAM_HINTS.name),
  PARAM_HINTS.name);
{
  // stray param -> corrective hint (validateParams path, exercised via dispatch)
  const r = await dispatch("transcript", "x:0.0", undefined, undefined, "abc", undefined);
  check("t_DW_1_1_stray_param_hint", r.includes('unexpected param "commandId"'), r.slice(0, 60));
}

// ---------------------------------------------------------------------------
// slug rule (underpins DW-1.2/1.3)
// ---------------------------------------------------------------------------
group("slug rule");
check("t_slug_dot_and_slash", cwdSlug("/Users/r/repos/claude-mux.mcp") === "-Users-r-repos-claude-mux-mcp");
check("t_slug_case_preserved", cwdSlug("/Users/r/repos/theGrid") === "-Users-r-repos-theGrid");

// ---------------------------------------------------------------------------
// DW-1.2: list mode against the REAL repo project dir
// ---------------------------------------------------------------------------
group("DW-1.2 list (real dir)");
let realFiles = [];
try { realFiles = listSessionFiles(REPO_DIR); } catch {}
check("t_DW_1_2_real_dir_has_sessions", realFiles.length >= 1, `found ${realFiles.length}`);
if (realFiles.length >= 1) {
  // newest-first invariant
  let sorted = true;
  for (let i = 1; i < realFiles.length; i++) if (realFiles[i - 1].mtime < realFiles[i].mtime) sorted = false;
  check("t_DW_1_2_list_newest_first", sorted);

  const listing = transcriptList(REPO_DIR, "/Users/r/repos/claude-mux.mcp");
  check("t_DW_1_2_has_index_1", /^1\) /m.test(listing));
  check("t_DW_1_2_row1_marked_heuristic", /1\).*\(likely you \/ current — mtime heuristic\)/.test(listing));
  check("t_DW_1_2_short_id_8char", new RegExp(`1\\) ${realFiles[0].id.slice(0, 8)}`).test(listing));
}

group("DW-1.2 preview fallbacks (synth)");
const tmp = mkdtempSync(`${tmpdir()}/mux-smoke-`);
function writeSession(name, records) {
  const p = `${tmp}/${name}`;
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
{
  const withTitle = writeSession("11111111-aaaa.jsonl", [
    { type: "user", message: { content: "hello there" } },
    { type: "ai-title", aiTitle: "My Generated Title" },
  ]);
  check("t_DW_1_2_preview_ai_title", sessionPreview(withTitle) === "My Generated Title");

  const promptOnly = writeSession("22222222-bbbb.jsonl", [
    { type: "user", message: { content: "first real prompt here" } },
  ]);
  check("t_DW_1_2_preview_first_prompt", sessionPreview(promptOnly) === "first real prompt here");

  const cmdWrapped = writeSession("33333333-cccc.jsonl", [
    { type: "user", message: { content: "<command-name>/clear</command-name>" } },
    { type: "user", message: { content: "<system-reminder>noise</system-reminder>" } },
  ]);
  check("t_DW_1_2_preview_no_title_fallback", sessionPreview(cmdWrapped) === "(no title)", sessionPreview(cmdWrapped));
}

// ---------------------------------------------------------------------------
// DW-1.3: read by index / full id / unique prefix; index matches list order
// ---------------------------------------------------------------------------
group("DW-1.3 selection");
if (realFiles.length >= 1) {
  const byIdx = selectSession(realFiles, "1");
  check("t_DW_1_3_read_by_index", typeof byIdx === "object" && byIdx.file === realFiles[0].file);

  const fullId = realFiles[0].id;
  const byFull = selectSession(realFiles, fullId);
  check("t_DW_1_3_read_by_full_id", typeof byFull === "object" && byFull.file === realFiles[0].file);

  const prefix = fullId.slice(0, 8);
  const byPrefix = selectSession(realFiles, prefix);
  // prefix unique in the real dir (single session) -> resolves; if multi, ensure it points at a real file
  check("t_DW_1_3_read_by_unique_prefix", typeof byPrefix === "object" && byPrefix.file.includes(prefix));

  check("t_DW_1_3_index_matches_list_order",
    realFiles.length < 2 || selectSession(realFiles, "2").file === realFiles[1].file);

  const flat = flattenSession(realFiles[0].file);
  check("t_DW_1_3_flatten_returns_text", typeof flat === "string" && flat.length > 0 && !flat.startsWith("error:"));
}

// ---------------------------------------------------------------------------
// DW-1.4: flatten keeps text + breadcrumbs, drops noise. Real session + unit.
// ---------------------------------------------------------------------------
group("DW-1.4 flatten (real session)");
if (realFiles.length >= 1) {
  const flat = flattenSession(realFiles[0].file);
  check("t_DW_1_4_keeps_user", /(^|\n)user: /.test(flat));
  check("t_DW_1_4_keeps_assistant", /(^|\n)assistant: /.test(flat));
  // The repo's own session ran Bash, Read, Edit/Write, tmux mcp, Agent, AskUserQuestion (verified in discovery)
  check("t_DW_1_4_breadcrumb_ran", /\[ran: /.test(flat));
  check("t_DW_1_4_breadcrumb_read_or_edit", /\[read |\[edited |\[wrote /.test(flat));
  check("t_DW_1_4_breadcrumb_asked", /\[asked user\]/.test(flat));
  // DROP categories must not leak as serialized blocks/records. (The bare WORDS
  // "tool_result"/"thinking" can legitimately appear in human prose — e.g. this
  // very design discussion — so we assert no serialized block/record shape leaks,
  // and prove content-drop separately with synth fixtures below.)
  check("t_DW_1_4_no_tool_result_block", !/"type"\s*:\s*"tool_result"/.test(flat) && !/^\s*\[?\s*\{?\s*"tool_use_id"/m.test(flat));
  check("t_DW_1_4_no_thinking_block", !/"type"\s*:\s*"thinking"/.test(flat) && !/"signature"\s*:/.test(flat));
  check("t_DW_1_4_no_command_wrapper", !/<command-name>|<system-reminder>|<local-command-stdout>/.test(flat));
  check("t_DW_1_4_no_permission_mode_leak", !/"type"\s*:\s*"permission-mode"/.test(flat) && !/"type"\s*:\s*"file-history-snapshot"/.test(flat));
  // No serialized JSONL record leaked verbatim (a dropped/unknown record passed through raw
  // would still carry its message+content envelope). Bare bracketed prose is fine.
  check("t_DW_1_4_no_raw_record_leak", !/"message"\s*:\s*\{[^\n]*"content"/.test(flat));
}

group("DW-1.4 breadcrumb mapping (unit)");
check("bc_bash", breadcrumb("Bash", { command: "ls -la /tmp && echo done" }) === "[ran: ls -la /tmp && echo done]");
check("bc_bash_trunc", breadcrumb("Bash", { command: "x".repeat(200) }).length <= "[ran: ]".length + 60);
check("bc_edit", breadcrumb("Edit", { file_path: "/a/b/server.js" }) === "[edited server.js]");
check("bc_write", breadcrumb("Write", { file_path: "/a/b/notes.md" }) === "[wrote notes.md]");
check("bc_read", breadcrumb("Read", { file_path: "/a/b/c.txt" }) === "[read c.txt]");
check("bc_tmux", breadcrumb("mcp__claude-mux__tmux", { action: "read", target: "main:0.0" }) === "[tmux read main:0.0]");
check("bc_tmux_no_target", breadcrumb("mcp__claude-mux__tmux", { action: "list" }) === "[tmux list]");
check("bc_agent", breadcrumb("Agent", { description: "Review plan" }) === "[dispatched agent: Review plan]");
check("bc_ask", breadcrumb("AskUserQuestion", {}) === "[asked user]");
check("bc_default", breadcrumb("SomeOtherTool", {}) === "[SomeOtherTool]");

group("DW-1.4 image collapse + drop (synth)");
{
  const s = writeSession("44444444-dddd.jsonl", [
    { type: "user", message: { content: "look at this [Image #1] please" } },
    { type: "permission-mode", mode: "x" },
    { type: "file-history-snapshot" },
    { type: "assistant", message: { content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "here is the answer" },
      { type: "tool_use", name: "Bash", input: { command: "echo hi" } },
    ] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "stdout noise" }] } },
  ]);
  const flat = flattenSession(s);
  check("t_DW_1_4_image_collapse", /\[image\]/.test(flat) && !/\[Image #1\]/.test(flat), flat);
  check("t_DW_1_4_drops_thinking_text", !/secret reasoning/.test(flat));
  check("t_DW_1_4_drops_tool_result_content", !/stdout noise/.test(flat));
  check("t_DW_1_4_keeps_assistant_text", /assistant: here is the answer/.test(flat));
  check("t_DW_1_4_keeps_breadcrumb", /\[ran: echo hi\]/.test(flat));
  // newest-first ordering: the assistant text/breadcrumb (later record) appears before the user prompt (earlier)
  check("t_DW_1_4_newest_first_order", flat.indexOf("[ran: echo hi]") < flat.indexOf("user: look at this"));
}

// ---------------------------------------------------------------------------
// DW-1.5: failure paths return readable error / skip gracefully; no throw
// ---------------------------------------------------------------------------
group("DW-1.5 failure paths");
// bad pane: target whose display-message fails -> run() returns null
{
  const r = transcriptAction("no-such-session-zzz:99.99", undefined);
  check("t_DW_1_5_bad_pane", typeof r === "string" && r.startsWith("error: cannot resolve cwd for"), r);
}
// out-of-range index / zero-match / ambiguous (use synth file list)
{
  const files = [
    { file: "/x/aaaa1111.jsonl", id: "aaaa1111-1111", mtime: 3 },
    { file: "/x/aaaa2222.jsonl", id: "aaaa2222-2222", mtime: 2 },
    { file: "/x/bbbb3333.jsonl", id: "bbbb3333-3333", mtime: 1 },
  ];
  const oor = selectSession(files, "999");
  check("t_DW_1_5_index_out_of_range", typeof oor === "string" && oor.includes("out of range") && oor.includes("1-3"), oor);
  const zero = selectSession(files, "zzzz");
  check("t_DW_1_5_prefix_zero_match", typeof zero === "string" && zero.startsWith("error:") && zero.includes("candidates"), zero);
  const amb = selectSession(files, "aaaa");
  check("t_DW_1_5_prefix_ambiguous", typeof amb === "string" && amb.includes("ambiguous") && amb.includes("aaaa1111") && amb.includes("aaaa2222"), amb);
}
// malformed JSONL line -> skipped, rest renders
{
  const p = `${tmp}/55555555-eeee.jsonl`;
  writeFileSync(p,
    JSON.stringify({ type: "user", message: { content: "before bad line" } }) + "\n" +
    "{ this is not valid json at all ]]]\n" +
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "after bad line" }] } }) + "\n");
  const flat = flattenSession(p);
  check("t_DW_1_5_malformed_skipped", flat.includes("before bad line") && flat.includes("after bad line"), flat);
}
// unreadable file -> error, no throw
{
  const p = `${tmp}/66666666-ffff.jsonl`;
  writeFileSync(p, JSON.stringify({ type: "user", message: { content: "secret" } }) + "\n");
  chmodSync(p, 0o000);
  let r, threw = false;
  try { r = flattenSession(p); } catch { threw = true; }
  chmodSync(p, 0o600); // restore so cleanup works
  // root can read despite 0o000; only assert error-or-clean, never a throw
  check("t_DW_1_5_unreadable_no_throw", !threw, "flattenSession threw");
  check("t_DW_1_5_unreadable_error_or_ok", typeof r === "string" && (r.startsWith("error: cannot read") || r.includes("secret") || r === "(empty transcript)"), r);
}
// no project dir / zero jsonl via projectDirFor against a synth empty dir is covered indirectly:
// transcriptList on an empty dir returns the no-transcripts error
{
  const emptyDir = `${tmp}/emptyproj`;
  mkdirSync(emptyDir, { recursive: true });
  const r = transcriptList(emptyDir, "/some/cwd");
  check("t_DW_1_5_no_sessions", r === "error: no transcripts for /some/cwd", r);
}
// no throw escapes dispatch for any bad input
{
  let threw = false;
  try {
    await dispatch("transcript", "bad:0.0", undefined, undefined, undefined, "999");
    await dispatch("transcript", "bad:0.0", undefined, undefined, undefined, undefined);
  } catch { threw = true; }
  check("t_DW_1_5_no_throw_from_dispatch", !threw);
}

// ---------------------------------------------------------------------------
// DW-1.6: NOT in forward set (paginates newest-first) + read/tail help pointer
// ---------------------------------------------------------------------------
group("DW-1.6 pagination + help pointer");
check("t_DW_1_6_not_in_forward_set",
  /forward = action === "list" \|\| action === "who" \|\| action === "tasks"/.test(SERVER_SRC) &&
  !/forward[\s\S]{0,80}transcript/.test(SERVER_SRC.match(/const forward = .*/)?.[0] || ""));
check("t_DW_1_6_read_help_pointer", /action:transcript/.test(HELP_ACTIONS.read) && /scrollback/i.test(HELP_ACTIONS.read));
check("t_DW_1_6_tail_help_pointer", /action:transcript/.test(HELP_ACTIONS.tail) && /scrollback/i.test(HELP_ACTIONS.tail));

// ---------------------------------------------------------------------------
// bun server.js still boots (import.meta.main guard didn't break the bootstrap)
// ---------------------------------------------------------------------------
group("server boots unchanged");
{
  // Start the server, feed it nothing, kill quickly. A syntax/boot error exits non-zero fast.
  let booted = true;
  try {
    const child = execFileSync("bash", ["-c",
      `timeout 1 bun ${new URL("../server.js", import.meta.url).pathname} </dev/null >/dev/null 2>&1; ec=$?; [ $ec -eq 124 ] && echo OK || ([ $ec -eq 0 ] && echo OK || echo "EXIT:$ec")`,
    ], { encoding: "utf-8" }).trim();
    booted = child === "OK";
    if (!booted) console.error("server boot probe:", child);
  } catch (e) { booted = false; console.error("boot probe error", e.message); }
  check("t_server_boots", booted);
}

// cleanup
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) { console.error("FAILURES:\n" + fails.map((f) => " - " + f).join("\n")); process.exit(1); }
process.exit(0);
