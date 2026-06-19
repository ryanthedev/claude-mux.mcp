# Code Standards — claude-mux

Derived by scanning `server.js` (single-file MCP server, ~1200 lines). These are the *actual* conventions in the code, for LLM consumers writing changes here.

## Shape

- **One file:** `server.js`. One MCP tool `tmux`; every capability is an `action` enum value dispatched through one `switch`.
- **Runtime:** Bun, ESM, top-level `await`. Sole dependency `@modelcontextprotocol/sdk`. No build, no linter, no tests today.
- **Responses are plain text.** Every action returns a string. No JSON payloads to the model.

## Adding an action — the seams (all in `server.js`)

A new action touches exactly these, in this order:

1. **Implementation fn** — a named function returning a string (e.g. `readPane`, `tailPane`). Group it near related functions.
2. **`HELP_ACTIONS.<action>`** (~line 924) — multi-line usage string: `name: one-liner\n  params: …\n  example: action:… target:…`. Returned when required params are missing.
3. **`VALID_PARAMS.<action>`** (~line 1001) — array of the params this action legitimately accepts. `validateParams` rejects any *other* provided param with a corrective hint. Only the shared param names exist: `target, text, lines, commandId, name`.
4. **`dispatch()` case** (~line 1064) — guard required params (`if (!target) return HELP_ACTIONS.<action>;`), then call the impl fn. `async` only if the fn awaits.
5. **`ALL_ACTIONS`** (~line 1162) — add the string; this feeds `z.enum(...)` so the param schema picks it up automatically.

No new top-level schema params unless unavoidable — reuse the existing six. (`name` is currently described as worker-only; reusing it elsewhere means updating its `.describe()` and the `PARAM_HINTS.name` message.)

## Conventions

- **tmux calls go through `run(...)`** (`execFileSync` wrapper, 5s timeout, returns trimmed stdout or `null` on failure). Never shell out directly; never interpolate untrusted values into a shell string.
- **Pagination via `paginate(text, page, pageSize, {forward})`.** `forward:true` = page 1 is the top (listings: `list`, `who`, `tasks`). Default `forward:false` = page 1 is the bottom / newest-first (pane captures: `read`, `watch`). The outer tool handler (~line 1189) decides `forward` by action name and always wraps the dispatch result. `PAGE_SIZE = 50`.
- **Error returns, not throws.** On failure return a `error: …` string the model can read (see `readPane`: `error: cannot read ${target}`). Don't let exceptions escape dispatch.
- **Help-on-missing-params.** Missing a required param returns that action's `HELP_ACTIONS` entry rather than erroring.
- **Self-awareness.** The server knows its own pane (`$TMUX_PANE`) and annotates listings (`you are here:`) so the model avoids reading itself.
- **Naming:** camelCase functions; action names are lowercase, hyphenated when multi-word (`new-window`, `spawn-persist`).
- **No comments unless non-obvious.** The code is terse and self-describing; match that density.

## Gotchas

- `keys` splits on spaces (key tokens); `type` uses tmux `-l` for literal text. Don't conflate.
- Paths/values that reach tmux or the shell must be passed as discrete `execFileSync` args, never concatenated.
- Reading files under `~/.claude/` is read-only territory — never write there.
