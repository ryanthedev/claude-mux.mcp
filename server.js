#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, readdirSync, statSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const lastRead = new Map();
const commands = new Map();
const PROMPT_PATTERNS = [/[❯$#%>]\s*$/, /^\s*\$\s*$/, /\)\s*[❯$#%>]\s*$/];
const POLL_INTERVAL = 500;
const QUIESCE_TIME = 2000;
const MAX_WAIT = 30000;
const PAGE_SIZE = 50;
const CMD_TTL = 600000; // 10 min

// --- helpers ---

function paginate(text, page = 1, pageSize = PAGE_SIZE, { forward = false } = {}) {
  const lines = text.split("\n");
  if (lines.length <= pageSize) return text;
  const totalPages = Math.ceil(lines.length / pageSize);
  const p = Math.max(1, Math.min(page, totalPages));
  let start, end;
  if (forward) {
    // page 1 = top of output (natural order for listings)
    start = (p - 1) * pageSize;
    end = Math.min(lines.length, start + pageSize);
  } else {
    // page 1 = bottom of output (newest first, for pane captures)
    end = lines.length - (p - 1) * pageSize;
    start = Math.max(0, end - pageSize);
  }
  const slice = lines.slice(start, end);
  const order = forward ? "" : ", newest first";
  return `${slice.join("\n")}\n--- page ${p}/${totalPages} (${lines.length} lines${order}) ---${p < totalPages ? `\ntip: pass page:${p + 1} for more` : ""}`;
}

function getActivePane() {
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  try {
    return execFileSync("tmux", [
      "display-message", "-t", pane, "-p",
      "#{session_name}:#{window_index}.#{pane_index}"
    ], { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function run(...args) {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function selfHeader() {
  const me = getActivePane();
  if (!me) return "";
  return `you are here: ${me} (session: ${me.split(":")[0]})\n\n`;
}

function isNumericSession(name) {
  return /^\d+$/.test(name);
}

function peekPane(target) {
  const raw = run("capture-pane", "-t", target, "-p", "-S", "-5");
  if (!raw) return "empty";
  const lines = raw.split("\n").filter((l) => l.trim());
  return lines.length > 0 ? lines[lines.length - 1].substring(0, 60) : "empty";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capturePane(target, lines = 100) {
  return run("capture-pane", "-t", target, "-p", "-S", `-${lines}`) || "";
}

function hasPrompt(output) {
  const lastLine = output.split("\n").filter((l) => l.trim()).pop() || "";
  return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

function deltaOutput(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lastBefore = beforeLines[beforeLines.length - 1];
  const matchIdx = afterLines.lastIndexOf(lastBefore);
  if (matchIdx >= 0 && matchIdx < afterLines.length - 1) {
    return afterLines.slice(matchIdx + 1).join("\n");
  }
  if (after !== before) return after;
  return "no new output";
}

function detectShell() {
  const shell = process.env.SHELL || "";
  if (shell.includes("fish")) return "fish";
  if (shell.includes("zsh")) return "zsh";
  return "bash";
}

function exitCodeVar() {
  return detectShell() === "fish" ? "$status" : "$?";
}

function cleanupCommands() {
  const now = Date.now();
  for (const [id, cmd] of commands) {
    if (now - cmd.startTime > CMD_TTL) commands.delete(id);
  }
}

// --- actions ---

function listSessions() {
  const raw = run("list-sessions", "-F", "#{session_name}");
  if (!raw) return "error: no tmux sessions";

  const sessions = raw.split("\n");
  const named = [];
  const numbered = [];

  for (const s of sessions) {
    if (isNumericSession(s)) numbered.push(s);
    else named.push(s);
  }

  const out = [selfHeader()];

  for (const session of named) {
    out.push(`${session}/`);
    const windows = run(
      "list-windows", "-t", session, "-F",
      "#{window_index}:#{window_name}:#{window_panes}:#{?window_active,active,}"
    );
    if (!windows) continue;
    for (const w of windows.split("\n")) {
      const [id, name, panes, active] = w.split(":");
      const marker = active === "active" ? " *" : "";
      out.push(`  :${id} ${name} (${panes}p)${marker}`);
    }
  }

  if (numbered.length > 0) {
    const range = numbered.length === 1
      ? numbered[0]
      : `${numbered[0]}-${numbered[numbered.length - 1]}`;
    out.push("", `${numbered.length} unnamed sessions (${range}) — use session action to inspect`);
  }

  out.push("", "tip: use 'session' with target to inspect a specific session with pane previews");
  return out.filter(Boolean).join("\n");
}

function inspectSession(target) {
  const session = target.split(":")[0];
  const windows = run(
    "list-windows", "-t", session, "-F",
    "#{window_index}:#{window_name}:#{window_panes}:#{?window_active,active,}"
  );
  if (!windows) return `error: session '${session}' not found`;

  const out = [selfHeader(), `${session}/`];

  for (const w of windows.split("\n")) {
    const [id, name, panes, active] = w.split(":");
    const marker = active === "active" ? " *" : "";
    out.push(`  :${id} ${name} (${panes}p)${marker}`);
    const paneCount = parseInt(panes);
    for (let p = 0; p < paneCount; p++) {
      const paneTarget = `${session}:${id}.${p}`;
      const preview = peekPane(paneTarget);
      out.push(`    .${p}: ${preview}`);
    }
  }

  return out.filter(Boolean).join("\n");
}

function readPane(target, lines = 100) {
  const output = run("capture-pane", "-t", target, "-p", "-S", `-${lines}`);
  if (output === null) return `error: cannot read ${target}`;
  lastRead.set(target, { time: Date.now(), output });
  const count = output.split("\n").length;
  return `${target} (${count} lines)\n---\n${output}\n---\ntip: use watch for delta`;
}

function tailPane(target, lines = 20) {
  const output = run("capture-pane", "-t", target, "-p", "-S", `-${lines}`);
  if (output === null) return `error: cannot read ${target}`;
  // return only the last N non-empty lines, no pagination
  const allLines = output.split("\n");
  const nonEmpty = allLines.filter((l) => l.trim());
  const tail = nonEmpty.slice(-lines);
  lastRead.set(target, { time: Date.now(), output });
  return `${target} (last ${tail.length} lines)\n---\n${tail.join("\n")}`;
}

function watchPane(target, lines = 100) {
  const current = run("capture-pane", "-t", target, "-p", "-S", `-${lines}`);
  if (current === null) return `error: cannot read ${target}`;

  const prev = lastRead.get(target);
  const now = Date.now();
  lastRead.set(target, { time: now, output: current });

  if (!prev) {
    const count = current.split("\n").length;
    return `${target} (${count} lines, first watch — full output)\n---\n${current}`;
  }

  const prevLines = prev.output.split("\n");
  const currLines = current.split("\n");
  let newLines = [];
  const lastPrevLine = prevLines[prevLines.length - 1];
  const matchIdx = currLines.lastIndexOf(lastPrevLine);

  if (matchIdx >= 0 && matchIdx < currLines.length - 1) {
    newLines = currLines.slice(matchIdx + 1);
  } else if (current !== prev.output) {
    newLines = currLines;
  }

  const elapsed = Math.round((now - prev.time) / 1000);

  if (newLines.length === 0) return `${target}: no new output (${elapsed}s)`;
  return `${target} (+${newLines.length} lines, ${elapsed}s)\n---\n${newLines.join("\n")}`;
}

function sendKeys(target, text) {
  const keys = text.split(" ");
  for (const key of keys) {
    run("send-keys", "-t", target, key);
  }
  return `sent keys to ${target}: ${text}\ntip: watch to see output`;
}

function typeText(target, text) {
  run("send-keys", "-t", target, "-l", text);
  return `typed to ${target}: ${text}\ntip: use keys to add Enter or other keys after`;
}

async function waitForOutput(target, before, lines = 100) {
  const start = Date.now();
  let lastOutput = before;
  let lastChangeTime = start;

  while (Date.now() - start < MAX_WAIT) {
    await sleep(POLL_INTERVAL);
    const current = capturePane(target, lines);

    if (current !== lastOutput) {
      lastOutput = current;
      lastChangeTime = Date.now();
    }

    if (current !== before && hasPrompt(current)) {
      lastRead.set(target, { time: Date.now(), output: current });
      return `${target} (done, prompt detected)\n---\n${deltaOutput(before, current)}`;
    }

    if (Date.now() - lastChangeTime >= QUIESCE_TIME && current !== before) {
      lastRead.set(target, { time: Date.now(), output: current });
      return `${target} (done, output settled ${QUIESCE_TIME}ms)\n---\n${deltaOutput(before, current)}`;
    }
  }

  const final = capturePane(target, lines);
  lastRead.set(target, { time: Date.now(), output: final });
  return `${target} (timeout ${MAX_WAIT / 1000}s, may still be running)\n---\n${deltaOutput(before, final)}`;
}

async function sendWait(target, text, lines = 100) {
  const before = capturePane(target, lines);
  const keys = text.split(" ");
  for (const key of keys) {
    run("send-keys", "-t", target, key);
  }
  return waitForOutput(target, before, lines);
}

async function typeWait(target, text, lines = 100) {
  const before = capturePane(target, lines);
  run("send-keys", "-t", target, "-l", text);
  run("send-keys", "-t", target, "Enter");
  return waitForOutput(target, before, lines);
}

// --- CRUD ---

function newSession(name) {
  const result = run("new-session", "-d", "-s", name);
  if (result === null) return `error: could not create session '${name}'`;
  return `created session: ${name}`;
}

function killSession(target) {
  const result = run("kill-session", "-t", target);
  if (result === null) return `error: could not kill session '${target}'`;
  return `killed session: ${target}`;
}

function newWindow(target, text) {
  const session = target.split(":")[0];
  const args = ["new-window", "-t", session, "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}"];
  if (text) args.push("-n", text);
  const result = run(...args);
  if (result === null) return `error: could not create window in '${session}'`;
  const winTarget = result.trim();
  return `created window${text ? ` '${text}'` : ""}\ntarget: ${winTarget}`;
}

function killWindow(target) {
  const result = run("kill-window", "-t", target);
  if (result === null) return `error: could not kill window '${target}'`;
  return `killed window: ${target}`;
}

function splitPane(target, text) {
  const direction = text === "horizontal" ? "-v" : "-h";
  const result = run("split-window", direction, "-t", target, "-P", "-F", "#{session_name}:#{window_index}.#{pane_index}");
  if (result === null) return `error: could not split '${target}'`;
  const paneTarget = result.trim();
  return `split ${target} ${text || "vertical"}\ntarget: ${paneTarget}`;
}

function killPane(target) {
  const result = run("kill-pane", "-t", target);
  if (result === null) return `error: could not kill pane '${target}'`;
  return `killed pane: ${target}`;
}

function renameWindow(target, text) {
  const result = run("rename-window", "-t", target, text);
  if (result === null) return `error: cannot rename ${target}`;
  return `renamed ${target} -> ${text}`;
}

// --- command tracking ---

function execCommand(target, text) {
  cleanupCommands();
  const id = randomUUID().slice(0, 8);
  const startMarker = `TMUX_MCP_START_${id}`;
  const doneMarker = `TMUX_MCP_DONE_${id}`;
  const ecv = exitCodeVar();

  // echo start marker, run command, echo done marker with exit code
  const wrapped = `echo ${startMarker}; ${text}; echo ${doneMarker}_${ecv}`;

  run("send-keys", "-t", target, "-l", wrapped);
  run("send-keys", "-t", target, "Enter");

  commands.set(id, {
    target,
    command: text,
    startMarker,
    doneMarker,
    startTime: Date.now(),
  });

  return `exec ${id}: ${text}\ntarget: ${target}\ntip: use result with commandId:${id} to check output`;
}

function getResult(commandId) {
  cleanupCommands();
  const cmd = commands.get(commandId);
  if (!cmd) return `error: command '${commandId}' not found (expired after 10min?)`;

  const output = capturePane(cmd.target, 500);
  const lines = output.split("\n");

  const startIdx = lines.findIndex((l) => l.includes(cmd.startMarker));
  if (startIdx === -1) return `${commandId}: waiting (start marker not yet visible)`;

  // look for done marker
  const donePattern = new RegExp(`${cmd.doneMarker}_(\\d+)`);
  let exitCode = null;
  let doneIdx = -1;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(donePattern);
    if (match) {
      exitCode = parseInt(match[1]);
      doneIdx = i;
      break;
    }
  }

  if (doneIdx === -1) {
    // still running — show what we have so far
    const partial = lines.slice(startIdx + 1).join("\n").trim();
    const elapsed = Math.round((Date.now() - cmd.startTime) / 1000);
    return `${commandId}: running (${elapsed}s)\ncmd: ${cmd.command}\n---\n${partial || "(no output yet)"}`;
  }

  // done — extract output between markers
  const cmdOutput = lines.slice(startIdx + 1, doneIdx).join("\n").trim();
  const elapsed = Math.round((Date.now() - cmd.startTime) / 1000);

  return `${commandId}: done (${elapsed}s, exit ${exitCode})\ncmd: ${cmd.command}\n---\n${cmdOutput || "(no output)"}`;
}

// --- coordination ---
// Uses tmux global environment and named buffers for cross-session agent coordination.
// All state lives in tmux itself, so it persists across MCP server restarts
// and is visible to all agents in any session.

const AGENT_PREFIX = "MCP_AGENT_";
const MSG_PREFIX = "mcp_msg_";
const TASK_PREFIX = "MCP_TASK_";
const lastInboxCheck = { seq: 0 };

function agentRegister(name) {
  const me = getActivePane();
  if (!me) return "error: not in tmux";
  // store globally: MCP_AGENT_main:0.1=backend-api|{timestamp}
  run("set-environment", "-g", `${AGENT_PREFIX}${me}`, `${name}|${Date.now()}`);
  return `registered ${me} as "${name}"`;
}

function agentUnregister() {
  const me = getActivePane();
  if (!me) return "error: not in tmux";
  run("set-environment", "-g", "-u", `${AGENT_PREFIX}${me}`);
  return `unregistered ${me}`;
}

function agentWho() {
  const raw = run("show-environment", "-g");
  if (!raw) return "no agents registered";

  const me = getActivePane();
  const agents = [];

  for (const line of raw.split("\n")) {
    if (!line.startsWith(AGENT_PREFIX)) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const pane = line.slice(AGENT_PREFIX.length, eqIdx);
    const [name, ts] = line.slice(eqIdx + 1).split("|");
    const ago = ts ? Math.round((Date.now() - parseInt(ts)) / 1000) : null;
    const self = pane === me ? " (you)" : "";
    agents.push(`${pane}: ${name}${self}${ago ? ` (registered ${ago}s ago)` : ""}`);
  }

  if (agents.length === 0) return "no agents registered\ntip: use register to identify yourself";

  const out = [me ? `you are here: ${me}` : null, "", `${agents.length} agents:`];
  out.push(...agents);
  return out.filter(Boolean).join("\n");
}

function getAgentName(pane) {
  const raw = run("show-environment", "-g", `${AGENT_PREFIX}${pane}`);
  if (!raw || raw.startsWith("-")) return null;
  const eqIdx = raw.indexOf("=");
  if (eqIdx === -1) return null;
  return raw.slice(eqIdx + 1).split("|")[0];
}

function resolveAgent(nameOrTarget) {
  // try as literal pane target first
  const directName = getAgentName(nameOrTarget);
  if (directName) return { pane: nameOrTarget, name: directName };

  // search by registered name
  const raw = run("show-environment", "-g");
  if (!raw) return null;

  for (const line of raw.split("\n")) {
    if (!line.startsWith(AGENT_PREFIX)) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const pane = line.slice(AGENT_PREFIX.length, eqIdx);
    const name = line.slice(eqIdx + 1).split("|")[0];
    if (name === nameOrTarget) return { pane, name };
  }

  return null;
}

function nextMsgSeq() {
  // find highest existing sequence number across all buffers
  const raw = run("list-buffers", "-F", "#{buffer_name}");
  if (!raw) return 1;
  let max = 0;
  for (const name of raw.split("\n")) {
    if (!name.startsWith(MSG_PREFIX)) continue;
    const parts = name.split("_");
    const seq = parseInt(parts[parts.length - 1]);
    if (seq > max) max = seq;
  }
  return max + 1;
}

function postMessage(target, text) {
  const me = getActivePane();
  const myName = me ? (getAgentName(me) || me) : "unknown";

  // target can be an agent name (for DM) or "all" for broadcast
  const seq = nextMsgSeq();
  const ts = Date.now();
  const msg = `${ts}|${myName}|${target}|${text}`;
  const bufName = `${MSG_PREFIX}${seq}`;

  run("set-buffer", "-b", bufName, msg);
  return `posted msg ${seq} to ${target}: ${text}`;
}

function checkInbox() {
  const me = getActivePane();
  const myName = me ? (getAgentName(me) || me) : null;
  if (!myName) return "error: register first so others can message you";

  const raw = run("list-buffers", "-F", "#{buffer_name}");
  if (!raw) return "inbox empty";

  const buffers = raw.split("\n").filter((n) => n.startsWith(MSG_PREFIX)).sort((a, b) => {
    const seqA = parseInt(a.split("_").pop());
    const seqB = parseInt(b.split("_").pop());
    return seqA - seqB;
  });

  const messages = [];
  let maxSeen = lastInboxCheck.seq;

  for (const bufName of buffers) {
    const seq = parseInt(bufName.split("_").pop());
    if (seq <= lastInboxCheck.seq) continue;

    const content = run("show-buffer", "-b", bufName);
    if (!content) continue;

    const [ts, from, to, ...msgParts] = content.split("|");
    const msg = msgParts.join("|");

    // show if addressed to me, to "all", or from me
    if (to === myName || to === "all" || to === me || from === myName) {
      const ago = Math.round((Date.now() - parseInt(ts)) / 1000);
      const direction = from === myName ? `to ${to}` : `from ${from}`;
      messages.push(`[${seq}] ${direction} (${ago}s ago): ${msg}`);
    }

    if (seq > maxSeen) maxSeen = seq;
  }

  lastInboxCheck.seq = maxSeen;

  if (messages.length === 0) return "no new messages";
  return `${messages.length} new messages:\n${messages.join("\n")}`;
}

function taskLockPath(taskName) {
  return `/tmp/claude_mux_claim_${taskName}`;
}

function claimTask(text) {
  const me = getActivePane();
  const myName = me ? (getAgentName(me) || me) : "unknown";

  const lockFile = taskLockPath(text);
  try {
    writeFileSync(lockFile, myName, { flag: "wx" }); // atomic — fails if exists
  } catch {
    // lock file exists — read owner from it
    try {
      const owner = readFileSync(lockFile, "utf-8").trim();
      if (owner === myName) return `you already claimed: ${text}`;
      return `task "${text}" already claimed by ${owner}`;
    } catch {
      return `task "${text}" already claimed`;
    }
  }

  run("set-environment", "-g", `${TASK_PREFIX}${text}`, `${myName}|${Date.now()}|active`);
  return `claimed: ${text}`;
}

function completeTask(text) {
  const me = getActivePane();
  const myName = me ? (getAgentName(me) || me) : "unknown";

  // release the atomic lock file
  try { unlinkSync(taskLockPath(text)); } catch {}

  run("set-environment", "-g", `${TASK_PREFIX}${text}`, `${myName}|${Date.now()}|done`);
  return `completed: ${text}`;
}

function listTasks() {
  const raw = run("show-environment", "-g");
  if (!raw) return "no tasks";

  const tasks = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith(TASK_PREFIX)) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const taskName = line.slice(TASK_PREFIX.length, eqIdx);
    const [owner, ts, status] = line.slice(eqIdx + 1).split("|");
    const ago = ts ? Math.round((Date.now() - parseInt(ts)) / 1000) : null;
    tasks.push(`${status === "done" ? "x" : ">"} ${taskName} (${owner}, ${ago}s ago)`);
  }

  if (tasks.length === 0) return "no tasks\ntip: use claim to take a task";
  return `${tasks.length} tasks:\n${tasks.join("\n")}`;
}

// --- workers ---

function getTeamRoster() {
  // build a list of all registered agents for context injection
  const raw = run("show-environment", "-g");
  if (!raw) return [];
  const agents = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith(AGENT_PREFIX)) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const pane = line.slice(AGENT_PREFIX.length, eqIdx);
    const name = line.slice(eqIdx + 1).split("|")[0];
    agents.push({ pane, name });
  }
  return agents;
}

function coordinationPreamble(workerName, session) {
  const roster = getTeamRoster();
  const teammates = roster
    .filter((a) => a.name !== workerName)
    .map((a) => `${a.name} (${a.pane})`)
    .join(", ");

  const tlid = session ? taskListId(session) : null;

  return [
    `You are "${workerName}". You are already registered in the tmux coordination system.`,
    `You have a tmux MCP tool. Use it to coordinate with other agents.`,
    teammates ? `Other active agents: ${teammates}` : "You are the only active agent right now.",
    "",
    "Coordination protocol:",
    "- post target:\"agent-name\" text:\"message\" to message a specific agent",
    "- post target:\"all\" text:\"message\" to broadcast to everyone",
    "- inbox to check for messages from other agents",
    "- Check inbox when you're blocked or before making assumptions about another service's API",
    "- Post your API contract/interface to 'all' as soon as it's defined, before full implementation",
    "- When done, post a summary of what you built to 'all'",
    "",
    "Task management:",
    `- Your CLAUDE_CODE_TASK_LIST_ID is set to "${tlid}". All workers in this session share this task list.`,
    "- Use TaskList to see available tasks. Use TaskUpdate to claim (set owner to your name), start (in_progress), and complete tasks.",
    "- Check TaskList for unassigned tasks when you finish your current work.",
    "- Tasks may have dependencies (blocked_by). Only work on unblocked tasks.",
    "",
    "Task:",
  ].join("\n");
}

function setupWorkerHooks(workerName, workDir) {
  // create a .claude/settings.json in the work directory with inbox hook
  const hookScript = `${__dirname}/hooks/inbox-check.sh`;
  const claudeDir = `${workDir}/.claude`;
  const settingsPath = `${claudeDir}/settings.json`;

  const settings = {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: hookScript,
            },
          ],
        },
      ],
    },
  };

  try {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  } catch {
    return null;
  }
}

function cleanupWorkerHooks(workDir) {
  try {
    rmSync(`${workDir}/.claude`, { recursive: true, force: true });
  } catch {}
}

function taskListId(session) {
  return `claude-mux-${session}`;
}

function createWorkerWindow(session, workerName) {
  run("new-window", "-d", "-t", session, "-n", workerName);

  const newPane = run(
    "display-message", "-t", `${session}:${workerName}`, "-p",
    "#{session_name}:#{window_index}.#{pane_index}"
  );
  if (!newPane) return null;

  run("set-environment", "-g", `${AGENT_PREFIX}${newPane}`, `${workerName}|${Date.now()}`);

  // set agent name + shared task list ID in the pane
  const exports = [
    `export TMUX_MCP_AGENT_NAME='${workerName}'`,
    `export CLAUDE_CODE_TASK_LIST_ID='${taskListId(session)}'`,
  ].join(" && ");
  run("send-keys", "-t", newPane, "-l", exports);
  run("send-keys", "-t", newPane, "Enter");

  return newPane;
}

function spawnWorker(text, target, name) {
  const me = getActivePane();
  const session = target ? target.split(":")[0] : (me ? me.split(":")[0] : null);
  if (!session) return "error: no session context";

  const workerName = name || `worker-${randomUUID().slice(0, 8)}`;
  const newPane = createWorkerWindow(session, workerName);
  if (!newPane) return "error: could not create worker window";

  // setup hooks in a temp workspace
  const workDir = `/tmp/claude-mux-${workerName}`;
  mkdirSync(workDir, { recursive: true });
  setupWorkerHooks(workerName, workDir);

  const preamble = coordinationPreamble(workerName, session);
  const fullPrompt = `${preamble}\n${text}`;
  const escaped = fullPrompt.replace(/'/g, "'\\''");

  const chain = [
    `cd '${workDir}'`,
    `claude -p '${escaped}'`,
    `tmux set-buffer -b ${workerName}_result "$(tmux capture-pane -t ${newPane} -p -S -200)"`,
    `tmux set-environment -g -u ${AGENT_PREFIX}${newPane}`,
    `rm -rf '${workDir}'`,
    `tmux kill-window -t ${newPane}`,
  ].join(" && ");

  run("send-keys", "-t", newPane, "-l", chain);
  run("send-keys", "-t", newPane, "Enter");

  return `spawned ${workerName} in ${newPane} (one-shot, hooks injected)\ntask: ${text}\ntask list: ${taskListId(session)} (shared with all workers in session)\ntip: auto-closes when done. worker-result to read output after`;
}

function spawnWorkerPersist(text, target, name) {
  const me = getActivePane();
  const session = target ? target.split(":")[0] : (me ? me.split(":")[0] : null);
  if (!session) return "error: no session context";

  const workerName = name || `worker-${randomUUID().slice(0, 8)}`;
  const newPane = createWorkerWindow(session, workerName);
  if (!newPane) return "error: could not create worker window";

  const workDir = `/tmp/claude-mux-${workerName}`;
  mkdirSync(workDir, { recursive: true });
  setupWorkerHooks(workerName, workDir);

  const preamble = coordinationPreamble(workerName, session);
  const fullPrompt = `${preamble}\n${text}`;
  const escaped = fullPrompt.replace(/'/g, "'\\''");

  const chain = [
    `cd '${workDir}'`,
    `claude -p '${escaped}'`,
    `tmux set-buffer -b ${workerName}_result "$(tmux capture-pane -t ${newPane} -p -S -200)"`,
    `echo "--- ${workerName} done ---"`,
  ].join(" && ");

  run("send-keys", "-t", newPane, "-l", chain);
  run("send-keys", "-t", newPane, "Enter");

  return `spawned ${workerName} in ${newPane} (persistent, hooks injected)\ntask: ${text}\ntask list: ${taskListId(session)} (shared with all workers in session)\ntip: window stays open after completion. despawn to clean up`;
}

function spawnTeammate(text, target, name) {
  const me = getActivePane();
  const session = target ? target.split(":")[0] : (me ? me.split(":")[0] : null);
  if (!session) return "error: no session context";

  const workerName = name || `worker-${randomUUID().slice(0, 8)}`;
  const newPane = createWorkerWindow(session, workerName);
  if (!newPane) return "error: could not create worker window";

  // for teammates, setup hooks in the target repo if provided, else temp dir
  const workDir = target && target.includes("/") ? target : `/tmp/claude-mux-${workerName}`;
  if (!target || !target.includes("/")) {
    mkdirSync(workDir, { recursive: true });
  }
  setupWorkerHooks(workerName, workDir);

  const preamble = coordinationPreamble(workerName, session);
  const fullPrompt = `${preamble}\n${text}`;
  const escaped = fullPrompt.replace(/'/g, "'\\''");

  // interactive claude: stays alive, hooks auto-check inbox every turn
  const chain = [
    `cd '${workDir}'`,
    `claude '${escaped}'`,
  ].join(" && ");

  run("send-keys", "-t", newPane, "-l", chain);
  run("send-keys", "-t", newPane, "Enter");

  return `spawned ${workerName} in ${newPane} (interactive, hooks injected)\ntask: ${text}\ntask list: ${taskListId(session)} (shared with all workers in session)\nhooks: inbox auto-checked every turn\ntip: stays alive. type to send follow-ups, despawn to shut down`;
}

function despawnWorker(target) {
  const agent = resolveAgent(target);
  const pane = agent ? agent.pane : target;
  const agentName = agent ? agent.name : target;

  // unregister
  run("set-environment", "-g", "-u", `${AGENT_PREFIX}${pane}`);

  // clean up temp workspace and hooks
  const tmpDir = `/tmp/claude-mux-${agentName}`;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  // clean up inbox sequence tracker
  try { rmSync(`/tmp/claude_mux_inbox_${agentName}`, { force: true }); } catch {}

  // kill the window
  const window = pane.replace(/\.\d+$/, "");
  run("kill-window", "-t", window);

  return `despawned ${agentName} (${pane})`;
}

function workerResult(text) {
  // read a worker's result buffer
  const bufName = text.startsWith("worker-") ? `${text}_result` : `worker-${text}_result`;
  const content = run("show-buffer", "-b", bufName);
  if (!content) return `no result buffer for ${text} (worker may still be running)`;
  return `${text} result:\n---\n${content}`;
}

function getLayout() {
  const raw = run(
    "list-panes", "-a", "-F",
    "#{session_name}:#{window_index}.#{pane_index} #{pane_width}x#{pane_height} #{?pane_active,active,} #{pane_current_command}"
  );
  if (!raw) return "error: no panes";

  const out = [selfHeader()];

  for (const line of raw.split("\n")) {
    const [target, size, active, cmd] = line.split(" ");
    const marker = active === "active" ? " *" : "";
    out.push(`${target} ${size} ${cmd}${marker}`);
  }

  return out.filter(Boolean).join("\n");
}

// --- transcript ---
// Reads the clean conversation JSONL Claude Code writes to
// ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl — far cleaner than scraping
// rendered tmux scrollback. The on-disk schema is undocumented and version-unstable,
// so everything here is defensive: validate at the file/tmux boundary, skip unknown
// records/blocks, and never throw out of dispatch.

const PROJECTS_ROOT = `${process.env.HOME}/.claude/projects`;

// cwd -> project dir name. Verified against real dirs: both "/" and "." (and any
// non-alphanumeric) become "-"; case is preserved (theGrid -> -Users-r-repos-theGrid).
function cwdSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function shortId(id) {
  return id.slice(0, 8);
}

function fmtMtime(ms) {
  // local, second-free: "2026-06-18 14:03"
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Resolve a pane target to its project dir. Returns {dir, cwd} or an "error: …" string.
function projectDirFor(target) {
  const cwd = run("display-message", "-t", target, "-p", "#{pane_current_path}");
  if (!cwd) return `error: cannot resolve cwd for ${target}`;
  const dir = `${PROJECTS_ROOT}/${cwdSlug(cwd)}`;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return `error: no transcripts for ${cwd}`;
  }
  if (!entries.some((e) => e.endsWith(".jsonl"))) {
    return `error: no transcripts for ${cwd}`;
  }
  return { dir, cwd };
}

// Enumerate *.jsonl in a project dir, newest mtime first.
// Returns [{file, id, mtime}] (mtime in ms). Unstattable files are skipped.
function listSessionFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const file = `${dir}/${name}`;
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    files.push({ file, id: name.slice(0, -".jsonl".length), mtime });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

const CMD_WRAPPERS = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>|^<system-reminder>/;

// Is this a plain user prompt (not a slash-command expansion / system reminder)?
function isPlainUserPrompt(s) {
  return typeof s === "string" && s.trim() !== "" && !CMD_WRAPPERS.test(s.trim());
}

// Extract a one-line preview for a session file: ai-title || first plain prompt || "(no title)".
// Defensive: malformed lines skipped; reads the whole file once.
function sessionPreview(file) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return "(unreadable)";
  }
  let firstPrompt = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) {
      return o.aiTitle.trim();
    }
    if (firstPrompt === null && o?.type === "user") {
      const c = o.message?.content;
      if (isPlainUserPrompt(c)) {
        firstPrompt = c.trim();
      } else if (Array.isArray(c)) {
        const t = c.find((b) => b?.type === "text" && isPlainUserPrompt(b.text));
        if (t) firstPrompt = t.text.trim();
      }
    }
  }
  if (firstPrompt) return firstPrompt.replace(/\s+/g, " ").slice(0, 80);
  return "(no title)";
}

// Render the newest-first numbered session list for a project dir.
function transcriptList(dir, cwd) {
  const files = listSessionFiles(dir);
  if (files.length === 0) return `error: no transcripts for ${cwd}`;
  const out = [`transcripts for ${cwd} (${files.length}, newest first):`];
  files.forEach((f, i) => {
    const mark = i === 0 ? "  (likely you / current — mtime heuristic)" : "";
    out.push(`${i + 1}) ${shortId(f.id)}  ${fmtMtime(f.mtime)}  ${sessionPreview(f.file)}${mark}`);
  });
  out.push("", "tip: read one with name:<index> or name:<sessionId-prefix>");
  return out.join("\n");
}

// Resolve a selector (1-based index or full/prefix sessionId) against the
// newest-first file list. Returns {file} or an "error: …" string.
function selectSession(files, selector) {
  if (/^\d+$/.test(selector)) {
    const idx = parseInt(selector, 10);
    if (idx < 1 || idx > files.length) {
      return `error: index ${idx} out of range (valid 1-${files.length})`;
    }
    return { file: files[idx - 1].file };
  }
  const matches = files.filter((f) => f.id.startsWith(selector));
  if (matches.length === 0) {
    return `error: no session matches "${selector}". candidates: ${files.map((f) => shortId(f.id)).join(", ")}`;
  }
  if (matches.length > 1) {
    return `error: "${selector}" is ambiguous. candidates: ${matches.map((f) => shortId(f.id)).join(", ")}`;
  }
  return { file: matches[0].file };
}

// One tool_use block -> one breadcrumb line.
function breadcrumb(toolName, input) {
  const i = input || {};
  const base = (p) => (typeof p === "string" ? p.split("/").pop() : "?");
  switch (toolName) {
    case "Bash":
      return `[ran: ${String(i.command ?? "").replace(/\s+/g, " ").slice(0, 60)}]`;
    case "Edit":
      return `[edited ${base(i.file_path)}]`;
    case "Write":
      return `[wrote ${base(i.file_path)}]`;
    case "Read":
      return `[read ${base(i.file_path)}]`;
    case "mcp__claude-mux__tmux":
      return `[tmux ${i.action ?? "?"} ${i.target ?? ""}`.trimEnd() + "]";
    case "Agent":
      return `[dispatched agent: ${String(i.description ?? "").slice(0, 60)}]`;
    case "AskUserQuestion":
      return "[asked user]";
    default:
      return `[${toolName}]`;
  }
}

const DROP_RECORD_TYPES = new Set([
  "mode", "permission-mode", "last-prompt", "file-history-snapshot",
  "attachment", "system", "summary", "ai-title",
]);

function collapseImages(s) {
  return s.replace(/\[Image[^\]]*\]/g, "[image]");
}

// Read + flatten a session file to prose + breadcrumbs, NEWEST FIRST.
// Returns the flattened text or an "error: …" string. Skips malformed lines and
// unknown record/block types silently — a single bad line never aborts the read.
function flattenSession(file) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return `error: cannot read ${file}`;
  }
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue; // skip malformed line, keep going
    }
    const type = o?.type;
    if (!type || DROP_RECORD_TYPES.has(type)) continue;

    if (type === "user") {
      const c = o.message?.content;
      if (typeof c === "string") {
        if (isPlainUserPrompt(c)) lines.push(`user: ${collapseImages(c.trim())}`);
        continue;
      }
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "text" && isPlainUserPrompt(b.text)) {
            lines.push(`user: ${collapseImages(b.text.trim())}`);
          }
          // tool_result and other user blocks are dropped
        }
      }
      continue;
    }

    if (type === "assistant") {
      const c = o.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type === "text" && b.text?.trim()) {
          lines.push(`assistant: ${collapseImages(b.text.trim())}`);
        } else if (b?.type === "tool_use") {
          lines.push(breadcrumb(b.name, b.input));
        }
        // thinking and unknown blocks are dropped
      }
      continue;
    }
    // unknown record type: skip silently
  }
  if (lines.length === 0) return "(empty transcript)";
  lines.reverse(); // newest first
  return lines.join("\n");
}

// Entry point. name absent -> list mode; present -> read mode.
function transcriptAction(target, name) {
  const resolved = projectDirFor(target);
  if (typeof resolved === "string") return resolved; // error
  const { dir, cwd } = resolved;

  if (name === undefined || name === null || name === "") {
    return transcriptList(dir, cwd);
  }
  const files = listSessionFiles(dir);
  if (files.length === 0) return `error: no transcripts for ${cwd}`;
  const picked = selectSession(files, String(name));
  if (typeof picked === "string") return picked; // error
  return flattenSession(picked.file);
}

// --- help ---

const HELP_TEXT = `tmux actions:
  list                overview of all sessions (paginated, check all pages)
  session target      inspect one session with pane previews
  tail  target        DEFAULT: quick look at screen (last 20 lines, no pagination)
  read  target        full history capture (lines: depth, default 100)
  watch target        new output since last read (delta)
  transcript target   prior-session conversation from disk (clean, not scrollback). name: session index/id to read one
  type  target text   DEFAULT: literal text input — preserves spaces and newlines
  typewait target text  DEFAULT: type + Enter + wait for output — use for running commands
  exec  target text   run command with tracking (returns commandId)
  result commandId    check tracked command output + exit code
  keys  target text   TUI only: key sequences (space-separated tokens like Escape C-c Enter)
  keyswait target text  TUI only: send keys + wait for output
  new-session text    create session (text = name)
  kill-session target kill a session
  new-window target   create window (target = session, text = optional name)
  kill-window target  kill a window
  split target        split pane (text = horizontal|vertical, default vertical)
  kill-pane target    kill a pane
  rename target text  rename a window
  layout              all panes with sizes and commands

  coordination (cross-session):
  register text       identify yourself by name
  unregister          remove your registration
  who                 list all registered agents
  post target text    message an agent or "all" (target = agent name)
  inbox               check new messages
  claim text          claim a tmux-local task (lightweight, no dependencies)
  complete text       mark a tmux-local task done
  tasks               list tmux-local tasks

  workers (spawned workers also share a Claude Code Tasks API list per session):
  spawn text          one-shot claude -p worker (auto-closes when done)
  spawn-persist text  one-shot claude -p worker (window stays open)
  teammate text       interactive claude session (stays alive, can coordinate)
  despawn target      kill a worker and clean up
  worker-result text  read a completed worker's captured output

  all spawn/teammate accept: text (task), target (session), name (agent name)

IMPORTANT: prefer type/typewait for most input. keys splits text on spaces into separate key tokens — it destroys prose, commands, and anything with spaces or newlines. use keys/keyswait ONLY for TUI key sequences (Escape, Enter, C-c, arrow keys).
target format: session:window.pane (e.g. main:0.0)
pagination: page and pageSize work on all actions. list/who/tasks paginate forward (page 1 = top). read/watch paginate newest-first (page 1 = bottom).
call any action without required params for help`;

const HELP_ACTIONS = {
  session: "session: inspect one session with pane previews\n  params: target (session name)\n  example: action:session target:main",
  read: "read: capture pane output\n  params: target (session:win.pane), lines (default 100)\n  example: action:read target:main:0.0\n  note: this is rendered scrollback, NOT the conversation. to recover prior-session work, use action:transcript (reads the clean JSONL on disk).",
  tail: "tail: last N lines, no pagination — quick look at recent output\n  params: target (session:win.pane), lines (default 20)\n  example: action:tail target:main:0.0 lines:30\n  note: this is rendered scrollback, NOT the conversation. to recover prior-session work, use action:transcript (reads the clean JSONL on disk).",
  transcript: `transcript: prior-session conversation, read from Claude's clean JSONL on disk (not noisy tmux scrollback)
  params: target (pane — resolves its cwd), name (optional: session index from the list, or a sessionId/prefix)
  no name -> lists the cwd's sessions newest-first with a title preview; row 1 is the likely caller (mtime heuristic)
  with name -> reads that session as flattened user/assistant prose + action breadcrumbs, newest first, paginated
  example: action:transcript target:main:0.0           (list)
  example: action:transcript target:main:0.0 name:2    (read 2nd-newest)`,
  watch: "watch: delta since last read\n  params: target (session:win.pane), lines (default 100)\n  example: action:watch target:main:0.0",
  type: `type: literal text — use this by default for typing anything
  params: target (session:win.pane), text (literal string)
  preserves spaces. no Enter appended.
  example: action:type target:main:0.0 text:echo "hello world"
  tip: follow with keys Enter to execute, or use typewait instead`,
  typewait: `typewait: type text + Enter, wait for output — use this by default for running commands
  params: target (session:win.pane), text (literal string), lines (default 100)
  waits up to 30s. detects shell prompt or output quiesce (2s stable)
  example: action:typewait target:main:0.0 text:npm test`,
  keys: `keys: TUI key sequences (space-separated tokens) — ONLY for special keys, NEVER for regular text
  params: target (session:win.pane), text (keys)
  WARNING: splits text on every space. "echo hello" becomes two separate keys "echo" and "hello". use type/typewait for commands and prose.
  Enter is NOT auto-appended. each space-separated token is a key name.
  examples:
    interrupt:      text:"C-c"
    TUI navigation: text:"Down Down Enter"
    vim quit:       text:"Escape :q! Enter"
    confirm:        text:"Enter"
  special keys: Enter, Escape, Space, Tab, Up, Down, Left, Right, C-c, C-d, C-z, BSpace
  tip: for regular commands and text, use type or typewait instead`,
  keyswait: `keyswait: send TUI key tokens + wait — only for TUI interactions
  params: target (session:win.pane), text (space-separated keys), lines (default 100)
  waits up to 30s. detects shell prompt or output quiesce (2s stable)
  example: action:keyswait target:main:0.0 text:Down Down Enter
  tip: for regular commands, use typewait instead`,
  exec: `exec: run command with marker-based tracking
  params: target (session:win.pane), text (command to run)
  returns a commandId — use 'result' action to check status/output/exit code
  better than keyswait for long-running commands
  example: action:exec target:main:0.0 text:npm test`,
  result: `result: check tracked command status
  params: commandId (from exec response)
  returns: status (running/done), exit code, output
  commands expire after 10 min
  example: action:result commandId:a1b2c3d4`,
  "new-session": "new-session: create a new tmux session\n  params: text (session name)\n  example: action:new-session text:my-project",
  "kill-session": "kill-session: kill a session\n  params: target (session name)\n  example: action:kill-session target:old-project",
  "new-window": "new-window: create a window\n  params: target (session), text (optional window name)\n  example: action:new-window target:main text:dev-server",
  "kill-window": "kill-window: kill a window\n  params: target (session:window)\n  example: action:kill-window target:main:3",
  split: "split: split a pane\n  params: target (session:win.pane), text (horizontal|vertical, default vertical)\n  example: action:split target:main:0.0 text:horizontal",
  "kill-pane": "kill-pane: kill a pane\n  params: target (session:win.pane)\n  example: action:kill-pane target:main:0.1",
  rename: "rename: rename a window\n  params: target (session:win), text (new name)\n  example: action:rename target:main:0 text:dev-server",
  register: "register: identify yourself by name\n  params: text (your name/role)\n  example: action:register text:backend-api",
  unregister: "unregister: remove your registration\n  no params needed",
  who: "who: list all registered agents across all sessions\n  no params needed",
  post: `post: message another agent or broadcast
  params: target (agent name or "all"), text (message)
  messages work across sessions
  example: action:post target:frontend text:API schema changed, check /sessions`,
  inbox: "inbox: check new messages addressed to you or broadcast\n  no params needed\n  tip: register first so others can reach you by name",
  claim: "claim: take ownership of a tmux-local task (lightweight, no dependencies)\n  params: text (task name)\n  example: action:claim text:fix-session-timeouts\n  tip: for structured tasks with dependencies, use Claude's TaskList/TaskUpdate API instead",
  complete: "complete: mark a tmux-local task done\n  params: text (task name)\n  example: action:complete text:fix-session-timeouts",
  tasks: "tasks: list tmux-local tasks with owner and status\n  no params needed\n  tip: spawned workers also share a Claude Code Tasks API list per session",
  spawn: `spawn: one-shot claude -p worker, auto-closes when done
  params: text (task), target (optional session), name (optional agent name)
  auto-injects coordination preamble with team roster and messaging protocol
  example: action:spawn text:add Team model to user-service name:user-service
  tip: worker knows its name and teammates. posts/checks inbox automatically`,
  "spawn-persist": `spawn-persist: one-shot claude -p, window stays open
  params: text (task), target (optional session), name (optional agent name)
  example: action:spawn-persist text:review test coverage name:test-reviewer`,
  teammate: `teammate: interactive claude session that stays alive
  params: text (task), target (optional session), name (optional agent name)
  stays alive for ongoing coordination. can receive follow-ups via type action.
  use for: long-lived agents that need to check inbox, respond to messages, iterate
  example: action:teammate text:own the API gateway, coordinate with user-service name:api-gateway`,
  despawn: "despawn: kill a worker and clean up its registration\n  params: target (worker name or pane target)\n  example: action:despawn target:user-service",
  "worker-result": "worker-result: read a completed worker's captured output\n  params: text (worker name)\n  example: action:worker-result text:user-service",
};

// --- param validation ---

const VALID_PARAMS = {
  list: [],
  session: ["target"],
  read: ["target", "lines"],
  tail: ["target", "lines"],
  watch: ["target", "lines"],
  transcript: ["target", "name", "lines"],
  keys: ["target", "text"],
  type: ["target", "text"],
  keyswait: ["target", "text", "lines"],
  typewait: ["target", "text", "lines"],
  exec: ["target", "text"],
  result: ["commandId"],
  "new-session": ["text"],
  "kill-session": ["target"],
  "new-window": ["target", "text"],
  "kill-window": ["target"],
  split: ["target", "text"],
  "kill-pane": ["target"],
  rename: ["target", "text"],
  layout: [],
  register: ["text"],
  unregister: [],
  who: [],
  post: ["target", "text"],
  inbox: [],
  claim: ["text"],
  complete: ["text"],
  tasks: [],
  spawn: ["text", "target", "name"],
  "spawn-persist": ["text", "target", "name"],
  teammate: ["text", "target", "name"],
  despawn: ["target"],
  "worker-result": ["text"],
};

const PARAM_HINTS = {
  name: 'name is the agent name for spawn/spawn-persist/teammate, or a session index/id for transcript — did you mean text?',
  commandId: 'commandId is only for the result action',
};

function validateParams(action, { target, text, lines, commandId, name }) {
  const valid = VALID_PARAMS[action];
  if (!valid) return null;
  const provided = { target, text, lines, commandId, name };
  for (const [param, value] of Object.entries(provided)) {
    if (value !== undefined && !valid.includes(param)) {
      const hint = PARAM_HINTS[param] || `${param} is not used by ${action}`;
      return `error: unexpected param "${param}" for ${action}. ${hint}\n\n${HELP_ACTIONS[action] || ""}`;
    }
  }
  return null;
}

// --- dispatch ---

async function dispatch(action, target, text, lines, commandId, name) {
  if (!action) {
    return selfHeader() + HELP_TEXT;
  }

  const paramError = validateParams(action, { target, text, lines, commandId, name });
  if (paramError) return paramError;

  switch (action) {
    case "list":
      return listSessions();
    case "session":
      if (!target) return HELP_ACTIONS.session;
      return inspectSession(target);
    case "read":
      if (!target) return HELP_ACTIONS.read;
      return readPane(target, lines);
    case "tail":
      if (!target) return HELP_ACTIONS.tail;
      return tailPane(target, lines);
    case "watch":
      if (!target) return HELP_ACTIONS.watch;
      return watchPane(target, lines);
    case "transcript":
      if (!target) return HELP_ACTIONS.transcript;
      return transcriptAction(target, name);
    case "keys":
      if (!target || !text) return HELP_ACTIONS.keys;
      return sendKeys(target, text);
    case "type":
      if (!target || !text) return HELP_ACTIONS.type;
      return typeText(target, text);
    case "keyswait":
      if (!target || !text) return HELP_ACTIONS.keyswait;
      return await sendWait(target, text, lines);
    case "typewait":
      if (!target || !text) return HELP_ACTIONS.typewait;
      return await typeWait(target, text, lines);
    case "exec":
      if (!target || !text) return HELP_ACTIONS.exec;
      return execCommand(target, text);
    case "result":
      if (!commandId) return HELP_ACTIONS.result;
      return getResult(commandId);
    case "new-session":
      if (!text) return HELP_ACTIONS["new-session"];
      return newSession(text);
    case "kill-session":
      if (!target) return HELP_ACTIONS["kill-session"];
      return killSession(target);
    case "new-window":
      if (!target) return HELP_ACTIONS["new-window"];
      return newWindow(target, text);
    case "kill-window":
      if (!target) return HELP_ACTIONS["kill-window"];
      return killWindow(target);
    case "split":
      if (!target) return HELP_ACTIONS.split;
      return splitPane(target, text);
    case "kill-pane":
      if (!target) return HELP_ACTIONS["kill-pane"];
      return killPane(target);
    case "rename":
      if (!target || !text) return HELP_ACTIONS.rename;
      return renameWindow(target, text);
    case "layout":
      return getLayout();
    case "register":
      if (!text) return HELP_ACTIONS.register;
      return agentRegister(text);
    case "unregister":
      return agentUnregister();
    case "who":
      return agentWho();
    case "post":
      if (!target || !text) return HELP_ACTIONS.post;
      return postMessage(target, text);
    case "inbox":
      return checkInbox();
    case "claim":
      if (!text) return HELP_ACTIONS.claim;
      return claimTask(text);
    case "complete":
      if (!text) return HELP_ACTIONS.complete;
      return completeTask(text);
    case "tasks":
      return listTasks();
    case "spawn":
      if (!text) return HELP_ACTIONS.spawn;
      return spawnWorker(text, target, name);
    case "spawn-persist":
      if (!text) return HELP_ACTIONS["spawn-persist"];
      return spawnWorkerPersist(text, target, name);
    case "teammate":
      if (!text) return HELP_ACTIONS.teammate;
      return spawnTeammate(text, target, name);
    case "despawn":
      if (!target) return HELP_ACTIONS.despawn;
      return despawnWorker(target);
    case "worker-result":
      if (!text) return HELP_ACTIONS["worker-result"];
      return workerResult(text);
    default:
      return `unknown action: ${action}\n\n${HELP_TEXT}`;
  }
}

// --- server ---

const ALL_ACTIONS = [
  "list", "session", "tail", "read", "watch", "transcript",
  "type", "typewait", "exec", "result",
  "keys", "keyswait",
  "new-session", "kill-session", "new-window", "kill-window",
  "split", "kill-pane",
  "rename", "layout",
  "register", "unregister", "who", "post", "inbox",
  "claim", "complete", "tasks",
  "spawn", "spawn-persist", "teammate", "despawn", "worker-result",
];

const server = new McpServer({ name: "claude-mux", version: "0.7.0" });

server.tool(
  "tmux",
  "Tmux control. Workflow: list → see sessions/your pane → act. Use typewait to run commands (types text + Enter + waits). Use type for text without Enter. Use keys ONLY for special keys (Escape, C-c, arrows) — keys splits on spaces. Use tail to check output. new-window returns the target to use. Call with no args for full usage.",
  {
    action: z.enum(ALL_ACTIONS).optional().describe("The tmux action to perform"),
    target: z.string().optional().describe("Pane target as session:window.pane (e.g. myproject:0.0). For new-window: session name. Returned by list, session, new-window."),
    text: z.string().optional().describe("For type/typewait: literal text to type. For keys/keyswait: space-separated key tokens. For new-window: window name. For new-session: session name."),
    lines: z.union([z.number(), z.string().transform(Number)]).optional().describe("Number of lines to capture (default varies by action)"),
    page: z.union([z.number(), z.string().transform(Number)]).optional(),
    pageSize: z.union([z.number(), z.string().transform(Number)]).optional(),
    commandId: z.string().optional().describe("Command ID returned by exec action"),
    name: z.string().optional().describe("Agent name for spawn/spawn-persist/teammate, or a session index/id for transcript."),
  },
  async ({ action, target, text, lines, page, pageSize, commandId, name }) => {
    const p = Number(page) || 1;
    const ps = Number(pageSize) || PAGE_SIZE;
    const result = await dispatch(action, target, text, lines, commandId, name);
    const forward = action === "list" || action === "who" || action === "tasks";
    return { content: [{ type: "text", text: paginate(result, p, ps, { forward }) }] };
  }
);

// Exported for the standalone smoke script. Importing this module must NOT start
// the stdio transport, so the bootstrap is guarded by import.meta.main.
export {
  cwdSlug, projectDirFor, listSessionFiles, sessionPreview, transcriptList,
  selectSession, breadcrumb, flattenSession, transcriptAction, dispatch,
  HELP_ACTIONS, VALID_PARAMS, ALL_ACTIONS, PARAM_HINTS,
};

if (import.meta.main) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
