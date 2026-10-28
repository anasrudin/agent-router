# Architecture

agent-router wraps three coding CLIs (Claude Code, Gemini CLI, Codex CLI) behind one routing policy. The harness never calls a model API itself: every model call is a child process of one of those CLIs, so authentication, billing and sandboxing stay each CLI's job.

## Components

| Component | Code | Role |
|---|---|---|
| CLI | `src/cli.ts` | Entry point: Conductor (headless or interactive), `doctor`, `route`, `delegate`, `serve`, and the hidden `mcp` and `hook` commands. |
| Conductor | `src/conductor/run.ts` | Starts Claude Code with the Conductor system prompt, the router MCP server and the hook settings. |
| Router MCP server | `src/mcp/server.ts` | Tools Conductor calls: `delegate`, `route`, `backends`, `check_diff`, `delegation_status`, `delegation_result`, `cancel_delegation`, plus the internal `approve` permission-prompt tool. |
| Routing policy | `src/router/` | `classify.ts` (task-class guess, `@` keywords), `policy.ts` (`decide()`: provider, tier, model), `escalation.ts` (the ladder), `health.ts` (which backends are usable). |
| Coordinator | `src/coordinator/` | Runs one delegation: brief rendering, attempts, watchdog, report parsing and verification, worktrees, project checks, ledger. |
| Backends | `src/backends/` | One adapter per CLI: argument building, permission mapping and a stream parser into common `BackendEvent`s. `process.ts` spawns the CLIs and kills whole process trees. |
| Prompts | `agent-harness-prompts/`, `src/prompts/` | Conductor and agent prompts, the delegation protocol, and variable rendering. `scoped-rules.ts` adds directory `AGENTS.md` files to briefs. |
| Desktop server | `src/server/` | `serve`: a WebSocket server on `127.0.0.1` with a random token. It runs Conductor turns for the app, relays delegation events and approval prompts, and reads and writes model settings. |
| Desktop app | `src/desktop/` | Tauri shell (`src-tauri/`) and the web UI (`ui/`). The release build compiles the core into a sidecar binary. |
| Hooks | `src/hooks/` | Claude Code hook handlers, run as `agent-router hook …` by the CLI itself. |

## A request, end to end

```
user request
  │  parseOverrides(): @provider pins, /route lines, @profile, ultrawork
  ▼
Conductor  (claude -p --resume … --mcp-config … --settings …)
  │  decides what to delegate, writes a brief per subtask
  ▼  MCP stdio
router MCP server  ── delegate(task_class, brief, background?) ──┐
  │                                                              │
  │  decide(): route → provider, tier, model                     │ background: job id now,
  │  per-provider slot (max_parallel_per_provider)               │ result via delegation_result
  ▼                                                              │
attempt loop (src/coordinator/delegate.ts)  ◄────────────────────┘
  │  render brief + directory rules → backend.run()
  │  watchdog: stall timer, identical-tool-call counter
  │  report gate (Claude): Stop hook until the report is well-formed
  │  parseReport() + verify → ok, or nextStep() picks the next rung
  ▼
project checks (edit mode, done/partial) → findings
  ▼
formatted result (capped at 40k chars) → Conductor → final answer
```

Each Conductor turn starts its own MCP server process. Background jobs belong to that process, so they are cancelled when the turn ends; Conductor's prompt tells it to collect them first.

## Delegation lifecycle

1. **Routing.** `decide()` reads the task class's route (`primary`, `tier`, `min_tier`, `fallback`) and applies the active profile overlay, escalation triggers (files touched, risk words, previous failure), privacy restrictions, author exclusion for `code.review`, and pins. Unhealthy backends are skipped.
2. **Brief.** `renderBrief()` turns the brief fields into the delegation-protocol format and appends the `AGENTS.md` files found between each relevant file and the workspace root (4k characters per file, 12k in total).
3. **Attempt.** The adapter builds the CLI arguments for the mode (read-only, run-commands, edit) and the harness permission mode, and the process runs under an `AbortController` tied to the request.
4. **Watchdog.** Every event re-arms a stall timer (`delegate_stall_seconds`). A run of identical tool calls (same name, same input with keys sorted) up to `max_identical_tool_calls` trips it as well. A trip aborts the attempt with error kind `stalled` or `tool_loop`.
5. **Report.** `parseReport()` splits the final message into the protocol sections (Status, Result, Changes, Evidence, Confidence, Open question, Risks). Only those names end a section, so reviewers may use their own sub-headings. A malformed or failed report becomes an attempt error.
6. **Escalation.** `nextStep()` picks the next rung (see below) or stops.
7. **Checks.** After an edit-mode delegation that ended `done` or `partial`, `checks.commands` run in the workspace (or the delegate's worktree). Failures are added as `reject` findings.
8. **Result.** The report, routing metadata, findings and check results are formatted for Conductor. Text over 40,000 characters is cut to its head and tail, and the full report is saved under `.harness/outputs/`.

## Escalation ladder

`src/router/escalation.ts`, within `max_attempts_per_subtask`:

1. **Retry** once on the same provider and tier with a sharper brief. This rung is skipped for `timeout`, `stalled` and `tool_loop`, and when only one attempt is left and a later rung exists.
2. **Fallback** once to the first live fallback provider at the same tier.
3. **Tier up** on the first live provider not yet tried at the higher tier.
4. **Any untried provider** at the highest tier.
5. **Stop** and report to Conductor, which asks the user.

Errors that mean the backend cannot work right now (not installed, signed out, rate-limited, untrusted folder, context full) mark the provider dead for the session. The ladder then switches at once instead of retrying.

## Permissions

The harness has three modes (`default`, `acceptEdits`, `bypass`), mapped per CLI in each adapter. For Claude delegates (`claudePermissionArgs` in `src/backends/claude/index.ts`):

| Delegate mode | Harness mode | Claude Code flags |
|---|---|---|
| read-only, run-commands | any | `dontAsk`, edit tools disallowed, Bash limited to `grep`, `ls`, `cat`, `head`, `tail`, `wc` |
| edit | `acceptEdits` | `acceptEdits`, Bash limited to the read-only list plus `checks.commands` |
| edit | `bypass` | `bypassPermissions` |
| any | any | `Agent` and `Task` disallowed: all delegation goes through the router |

`rg`, `git`, `find` and `sed` are left out of the read-only list on purpose, because they have options that can run other programs (`rg --pre`, git pager and fsmonitor, `find -exec`). Claude Code refuses compound commands and redirections whose extra part is not allowed.

In headless runs nobody can answer a permission prompt, so Conductor is started with `--permission-prompt-tool mcp__router__approve`. In the CLI, `approve` answers by policy. Under `serve`, it forwards the prompt to the desktop app as an **Allow / Deny** card.

## Hooks

Claude Code runs hook commands from a `--settings` file the harness writes to a temporary folder. The command is the harness itself (`selfCommand()` in `src/self.ts`: the Bun runtime plus `src/cli.ts`, or the compiled binary alone).

| Hook | Where | What it does |
|---|---|---|
| `Stop` → `hook report-gate` | Claude delegates | Blocks the stop while `last_assistant_message` is not a well-formed report, at most twice per session. |
| `SessionStart` (matcher `compact`) → `hook compact-context` | Conductor | Returns the chat's delegation ledger as `additionalContext`, so session ids, worktrees and running jobs survive compaction. |

Hook handlers fail open: an error lets Claude Code continue rather than blocking the turn.

## Delegation ledger

`src/coordinator/ledger.ts`. Each chat gets a JSON-lines file in the OS temp folder (`agent-router-ledgers/chat-<uuid>.jsonl`). The MCP server appends `started`, `finished` and `failed` entries. When a new MCP server starts (one per turn), entries still marked `started` belong to a turn that ended, and are closed as interrupted. `ledgerContext()` renders running jobs and the last 25 finished ones, with the `resume` arguments for each delegate session.

## Desktop app

```
Tauri shell ── spawns ──► agent-router serve --port 0  (prints port + token)
     │                         │
  web UI ◄── WebSocket ───────►│── per turn: claude -p --resume … (Conductor)
                               │       └── MCP child ── bridge (HTTP) ──► serve
                               │                 delegation.* events, approval.request
```

Messages are typed in `src/server/protocol.ts`. The client sends `start`, `cancel`, `reset`, `approval` and `settings.*`. The server answers with `turn.started` (including the active mode), `conductor` events, `delegation.*`, `approval.request`, `turn.finished` and `settings.*`. Closing the app closes the core's stdin, which cancels Conductor and every delegate.
