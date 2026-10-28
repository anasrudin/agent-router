# Development

## Setup

```sh
npm install            # also installs Bun locally; run it as `npx bun`
npm run typecheck      # core, desktop UI and bench
npm run lint           # Biome: 2 spaces, no semicolons, line width 140
npm test               # bun test src
```

For the desktop app you also need Rust and Tauri's system packages (see the README), then `npm run desktop:dev`.

## Layout

```
src/
  cli.ts            entry point (commander)
  self.ts           how the harness launches itself (hook commands, MCP child)
  backends/         one adapter + stream parser per CLI; process.ts spawns and kills trees
  config/           schema (zod) and layered loading
  conductor/        Conductor launch: system prompt, MCP config, hook settings
  coordinator/      one delegation: attempts, watchdog, report protocol, checks, ledger, worktrees
  hooks/            Claude Code hook handlers
  lsp/              lsp-mcp: LSP client, MCP tools, language-server selection
  mcp/              router MCP server
  prompts/          prompt rendering, directory AGENTS.md rules
  router/           classify, decide, escalation ladder, health
  server/           desktop WebSocket server and settings
  desktop/          Tauri shell and web UI
agent-harness-prompts/   prompts and the shipped routing.yaml
bench/                   profile benchmark (see bench/RESULTS.md)
docs/                    these docs and screenshots
```

## Tests

Tests sit next to the code in `__tests__/` folders and run with `bun test`. No test calls a real model.

- **Adapters:** `src/backends/__tests__/adapters.test.ts` parses streams recorded from real CLI versions (`fixtures/*.jsonl`) and checks the arguments built for each mode. Re-record the fixtures when a CLI changes its output format.
- **Processes:** `fixtures/fake-cli.mjs` stands in for a CLI. It can print lines, hang, spawn grandchildren and ignore SIGTERM, which tests the process-tree kill and timeouts.
- **Delegation:** `src/test-support.ts` provides scripted backends. A scripted result can be a report, an error, `{ hang: true }` (for the watchdog's stall timer) or `{ loop: n, text }` (n identical tool calls). `testSession(backends, patch, permission)` builds a session around them.
- **MCP:** `src/mcp/__tests__/` drives the server over the SDK's in-memory transport, including background jobs.
- **LSP:** `src/lsp/__tests__/fixtures/fake-lsp.mjs` is a small language server (push or pull diagnostics), so the `lsp-mcp` tools are tested without installing real servers.

The process tests depend on timing. If one fails only under load, run it alone before changing code.

## Changing behaviour

- **Routing or ladder:** `src/router/policy.ts` and `escalation.ts`, with cases in `src/router/__tests__/`. The ladder must stay bounded by `max_attempts_per_subtask` and use each rung at most once.
- **Config keys:** add them to `src/config/schema.ts` with a default, and document them in `agent-harness-prompts/config/routing.yaml` and `docs/configuration.md`.
- **A new backend:** implement `Backend` (`src/backends/Backend.ts`): arguments per mode and permission, a parser into `BackendEvent`s, and error classification (`BackendErrorKind`), so the ladder knows which errors mean "switch now". Register it in `registry.ts` and add a recorded fixture.
- **Conductor tools:** register in `src/mcp/server.ts` and add the tool to `TOOL_PERMISSIONS`. `auto` tools are pre-allowed; `ask` tools go through approval.

## Behaviour of the wrapped CLIs

Checked on Claude Code 2.1.312, Gemini CLI 0.66.0 and Codex CLI 0.165.0. Recheck these when a CLI updates:

- Claude Code has no Grep or Glob tools. Searching is done with `grep` through Bash, which is why read-only delegates get a Bash allow list.
- Under `dontAsk`, Claude Code refuses a compound command or redirection whose extra part is not allowed.
- `--settings <file>` accepts hooks in headless runs. Stop hook input includes `last_assistant_message`, `stop_hook_active` and `session_id`, and `{"decision":"block","reason":…}` continues the turn.
- `/compact` works headless (`-p --resume`) and fires `SessionStart` with `source: "compact"`. Its `additionalContext` reaches the next turn.
- Claude Code loads `.claude/rules/*.md` itself in headless runs, including path-scoped rules.
- `PostToolUseFailure` hooks fire for failed Bash commands. An Edit whose old text is missing or not unique is rejected before any hook (`PreToolUse` included), so no hook can react to it.
- Codex runs MCP tools in `exec` only when they are annotated `readOnlyHint: true`; otherwise "MCP tool call requires approval, but approval policy is never". Its `--json` stream reports them as `mcp_tool_call` items.
- TypeScript 7 has no `tsserver.js`, so `typescript-language-server` cannot drive it; `tsc --lsp --stdio` is its language server and only supports pull diagnostics.
- Claude Code refuses long `sleep` commands on its own.
- Gemini runs headless only in trusted folders.
- The harness never reads or writes a CLI's credential store. Sign-in is each CLI's job.

## Testing the desktop app

Run GUI tests on a virtual display, not your own desktop session:

```sh
Xvfb :77 -screen 0 1400x900x24 &
env -u WAYLAND_DISPLAY DISPLAY=:77 GDK_BACKEND=x11 XDG_RUNTIME_DIR=$(mktemp -d) npm run desktop:dev
```

## Benchmark

`npx bun bench/bench.ts` runs the task suite against each profile on a fixture project. Then `npx bun bench/report.ts bench/results/<dir>` writes the summary. It uses real CLIs and costs real money. Results and method are in `bench/RESULTS.md`.
