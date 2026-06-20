#!/usr/bin/env bun
// Smoke verification for the `meta` action (Phase 1).
// Run: bun scripts/smoke-meta.mjs   (exits non-zero on any failure)
//
// The repo has no test framework by design; this standalone script is the
// executable evidence for every DW item. It drives `meta` against the LIVE
// tmux server on this box (read-only — it NEVER mutates tmux state), unit-tests
// the pure `formatMeta` helper with synthetic tmux -F strings for the dirty
// paths, and uses `git diff` to prove the regression guard.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  dispatch,
  formatMeta,
  metaAction,
  ALL_ACTIONS,
  VALID_PARAMS,
  HELP_ACTIONS,
} from "../server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const TAB = "\t";

let failures = 0;
let passes = 0;
function ok(name) { passes++; console.log(`  PASS  ${name}`); }
function fail(name, detail) {
  failures++;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}
function check(name, cond, detail) { cond ? ok(name) : fail(name, detail); }

function tmux(...args) {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DW-1.6 + edge cases — pure formatter on synthetic tmux -F strings (dirty paths)
// These run first: no tmux dependency, and they prove no exception escapes.
// ---------------------------------------------------------------------------
console.log("\n[unit] formatMeta dirty paths (DW-1.6, edge cases)");

// empty / null list-sessions -> error, no throw
try {
  check("null sessions -> 'error: no tmux sessions'",
    formatMeta(null, "W\tx\t0\tn\t1\t1") === "error: no tmux sessions");
  check("empty sessions -> 'error: no tmux sessions'",
    formatMeta("", "W\tx\t0\tn\t1\t1") === "error: no tmux sessions");
  check("whitespace-only / no S rows -> 'error: no tmux sessions'",
    formatMeta("garbage line without prefix", null) === "error: no tmux sessions");
} catch (e) {
  fail("formatMeta empty/null path threw", String(e));
}

// session whose list-windows is null -> S row present, its W rows absent, rest intact
try {
  const s = ["S\talpha\t100\t1\t50", "S\tbeta\t200\t0\t60"].join("\n");
  const out = formatMeta(s, null);
  const lines = out.split("\n");
  check("null windows -> both S rows present",
    lines.includes("S\talpha\t100\t1\t50") && lines.includes("S\tbeta\t200\t0\t60"));
  check("null windows -> zero W rows",
    lines.filter((l) => l.startsWith("W" + TAB)).length === 0);
  check("null windows -> S rows precede (no extra lines)", lines.length === 2);
} catch (e) {
  fail("formatMeta null-windows path threw", String(e));
}

// window name containing a space AND a ':' round-trips verbatim in its tab field
try {
  const s = "S\tmain\t100\t1\t50";
  const wname = "my : weird window";
  const w = `W\tmain\t0\t${wname}\t123\t1`;
  const out = formatMeta(s, w);
  const wRow = out.split("\n").find((l) => l.startsWith("W" + TAB));
  const cols = wRow.split(TAB);
  check("window name with space+colon round-trips intact", cols[3] === wname,
    `got: ${JSON.stringify(cols[3])}`);
  check("W row arity is 6 with spaced/colon name", cols.length === 6);
} catch (e) {
  fail("formatMeta name-roundtrip path threw", String(e));
}

// formatter ignores stray non-S/non-W lines (defensive: footer/warning lines)
try {
  const out = formatMeta("S\tmain\t1\t1\t1\nstray tmux warning", "W\tmain\t0\tn\t1\t1\nblah");
  check("formatter drops stray non-prefixed lines",
    out === "S\tmain\t1\t1\t1\nW\tmain\t0\tn\t1\t1");
} catch (e) {
  fail("formatMeta stray-line path threw", String(e));
}

// ---------------------------------------------------------------------------
// DW-1.1 — registration across all five seams + forward set + dispatch returns dump
// ---------------------------------------------------------------------------
console.log("\n[reg] registration seams (DW-1.1)");
const serverSrc = readFileSync(resolve(repo, "server.js"), "utf-8");

check("seam: ALL_ACTIONS includes 'meta'", ALL_ACTIONS.includes("meta"));
check("seam: VALID_PARAMS.meta === []",
  Array.isArray(VALID_PARAMS.meta) && VALID_PARAMS.meta.length === 0);
check("seam: HELP_ACTIONS.meta present", typeof HELP_ACTIONS.meta === "string" && HELP_ACTIONS.meta.length > 0);
check("seam: HELP_TEXT has a meta line", /\n\s+meta\s+/.test(serverSrc));
check("seam: dispatch has a 'meta' case", /case "meta":/.test(serverSrc));
check("seam: forward set includes meta",
  /const forward =[^\n;]*action === "meta"/.test(serverSrc));

// dispatch("meta") returns the dump (S/W rows), NOT the help text.
const dump = await dispatch("meta");
check("dispatch('meta') returns S/W rows, not help",
  /^[SW]\t/m.test(dump) && dump !== HELP_ACTIONS.meta && !dump.startsWith("meta:"),
  `got: ${dump.slice(0, 80)}`);

// stray param -> corrective hint (validateParams path via dispatch)
const stray = await dispatch("meta", undefined, "oops");
check("stray param 'text' on meta -> corrective hint",
  stray.startsWith("error: unexpected param \"text\" for meta"),
  `got: ${stray.slice(0, 80)}`);

// ---------------------------------------------------------------------------
// Live tmux assertions (DW-1.2, DW-1.3, DW-1.5)
// ---------------------------------------------------------------------------
console.log("\n[live] meta against live tmux (DW-1.2 / DW-1.3 / DW-1.5)");
const liveSessions = tmux("list-sessions");
if (!liveSessions) {
  console.log("  (no live tmux server — live assertions skipped; dirty/regression paths still gate)");
} else {
  const live = metaAction();
  const lines = live.split("\n");
  const sRows = lines.filter((l) => l.startsWith("S" + TAB));
  const wRows = lines.filter((l) => l.startsWith("W" + TAB));

  const expectS = liveSessions.split("\n").filter(Boolean).length;
  const expectW = tmux("list-windows", "-a").split("\n").filter(Boolean).length;

  check(`DW-1.2: S-row count == list-sessions count (${expectS})`,
    sRows.length === expectS, `got ${sRows.length}`);
  check(`DW-1.3: W-row count == list-windows -a count (${expectW})`,
    wRows.length === expectW, `got ${wRows.length}`);

  check("DW-1.2: every S row has arity 5",
    sRows.every((r) => r.split(TAB).length === 5));
  check("DW-1.3: every W row has arity 6",
    wRows.every((r) => r.split(TAB).length === 6));

  check("DW-1.3: S rows precede W rows (session order block)",
    lines.findIndex((l) => l.startsWith("W" + TAB)) > lines.findIndex((l) => l.startsWith("S" + TAB)) || wRows.length === 0);

  // DW-1.5: S-row name/activity/attached triple == acceptance -F, exactly.
  const accept = tmux("list-sessions", "-F", "#{session_name} #{session_activity} #{session_attached}")
    .split("\n").filter(Boolean).sort();
  const mine = sRows.map((r) => {
    const c = r.split(TAB);            // S, name, activity, attached, created
    return `${c[1]} ${c[2]} ${c[3]}`;
  }).sort();
  check("DW-1.5: S-row name/activity/attached triple matches acceptance -F exactly",
    JSON.stringify(mine) === JSON.stringify(accept),
    `mine[0]=${mine[0]} accept[0]=${accept[0]}`);
}

// ---------------------------------------------------------------------------
// DW-1.4 — regression: listSessions()/inspectSession() source unchanged; list has no S/W rows
// ---------------------------------------------------------------------------
console.log("\n[regress] backward-compat guard (DW-1.4)");
function diffTouchesFn(fnName) {
  // Pull the diff for server.js and look for any +/- line that falls inside the
  // named function. Cheap heuristic: scan added/removed lines for the fn name or
  // its known body tokens. The authoritative signal is "did any changed hunk
  // alter the function body" — we approximate by checking the fn name does not
  // appear on any changed (+/-) line.
  let diff;
  try {
    diff = execFileSync("git", ["diff", "HEAD", "--", "server.js"], { cwd: repo, encoding: "utf-8" });
  } catch {
    diff = "";
  }
  const changed = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l));
  return changed.some((l) => l.includes(fnName));
}
check("DW-1.4: no changed diff line references listSessions", !diffTouchesFn("function listSessions"));
check("DW-1.4: no changed diff line references inspectSession", !diffTouchesFn("function inspectSession"));

// Stronger guard: the exact source bytes of both fns are byte-for-byte equal to HEAD.
function fnBody(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return null;
  // walk braces from the first { after the signature
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
let headSrc = "";
try {
  headSrc = execFileSync("git", ["show", "HEAD:server.js"], { cwd: repo, encoding: "utf-8" });
} catch { /* ignore */ }
for (const sig of ["function listSessions()", "function inspectSession(target)"]) {
  const now = fnBody(serverSrc, sig);
  const was = fnBody(headSrc, sig);
  check(`DW-1.4: ${sig} byte-for-byte unchanged vs HEAD`,
    was !== null && now !== null && was === now);
}

// list output carries no S\t / W\t rows
const listOut = await dispatch("list");
check("DW-1.4: list output has no S\\t / W\\t tab rows",
  !/^S\t/m.test(listOut) && !/^W\t/m.test(listOut));

// ---------------------------------------------------------------------------
// DW-1.7 — version 0.8.0 in three files; README documents meta + columns
// ---------------------------------------------------------------------------
console.log("\n[version] 0.8.0 + README docs (DW-1.7)");
const pkg = JSON.parse(readFileSync(resolve(repo, "package.json"), "utf-8"));
const plugin = JSON.parse(readFileSync(resolve(repo, ".claude-plugin/plugin.json"), "utf-8"));
check("DW-1.7: package.json version 0.8.0", pkg.version === "0.8.0", pkg.version);
check("DW-1.7: plugin.json version 0.8.0", plugin.version === "0.8.0", plugin.version);
check("DW-1.7: server.js McpServer identity version 0.8.0",
  /new McpServer\(\{ name: "claude-mux", version: "0\.8\.0" \}\)/.test(serverSrc));

const readme = readFileSync(resolve(repo, "README.md"), "utf-8");
check("DW-1.7: README has a `meta` Actions row", /\|\s*`meta`\s*\|/.test(readme));
check("DW-1.7: README meta row documents S/W column contract",
  /session_activity/.test(readme) && /session_attached/.test(readme) &&
  /window_index/.test(readme) && /window_active/.test(readme));

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(48)}`);
console.log(`smoke-meta: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
process.exit(0);
