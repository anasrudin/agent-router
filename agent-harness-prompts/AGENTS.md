# AGENTS.md — Building {{HARNESS_NAME}}

Instructions for any coding agent (Claude Code, Gemini CLI, Codex CLI) working **on the harness codebase itself**. The runtime prompts the harness gives its own agents live in `prompts/`.

## What we are building
A Windows-native agent harness with a CLI (terminal UI) and a desktop app. Its core feature is **wrapping three existing CLIs — Claude Code, Gemini CLI, and OpenAI Codex CLI — and routing and delegating work between them without lowering output quality.** The architecture is modelled on a Claude-Code-style layout (tools, commands, query engine, coordinator, skills, plugins, MCP, permissions).

## Non-negotiables
1. **Quality over cost.** Routing must respect each task class's `min_tier` in `config/routing.yaml`. No silent downgrades.
2. **Windows first.** Every feature must work in PowerShell 7 on Windows 10/11 without WSL. CI runs on `windows-latest`; Linux/macOS are secondary.
3. **Backends are adapters.** Nothing outside `src/backends/` may know a CLI's flags, output format, or session model.
4. **One contract between agents:** the brief and report formats in `prompts/shared/delegation-protocol.md`. Adapters translate to and from it.
5. **Permissions on every tool call**, including tool calls made inside wrapped CLIs where the CLI exposes a hook or approval mode.

## Directory layout (additions to the base structure)

```
src/
├── backends/                  # One adapter per wrapped CLI
│   ├── Backend.ts             # interface: detect(), health(), run(brief) → AsyncIterable<Event>, resume(), cancel()
│   ├── claude/                # spawns `claude -p ... --output-format stream-json`
│   ├── gemini/                # spawns `gemini -p ... --output-format json`
│   ├── openai/                # spawns `codex exec ... --json`
│   └── events.ts              # normalised event schema (text, tool_call, tool_result, usage, error, done)
├── router/
│   ├── classify.ts            # request → task classes
│   ├── policy.ts              # applies routing.yaml rules in priority order (see conductor.md §4)
│   ├── health.ts              # per-backend health + rate-limit state
│   └── escalation.ts          # retry → fallback → tier up → ask user
├── coordinator/
│   ├── delegate.ts            # builds briefs, dispatches, collects reports
│   ├── verify.ts              # runs acceptance checks on reports
│   └── worktrees.ts           # isolates parallel writers
├── prompts/                   # loads prompts/*.md, renders {{VARIABLES}}
└── desktop/                   # desktop shell (Tauri or Electron) sharing the core via the server/ mode
```

## Backend adapter rules
- Spawn CLIs with `child_process.spawn` (no `shell: true`); pass arguments as an array so Windows quoting is correct.
- Pass long prompts through **stdin or a temp file**, never the command line — Windows limits command lines to ~32k characters.
- Parse streamed output line by line; tolerate partial lines and non-JSON noise (banners, update notices).
- Normalise usage/cost into `events.ts` so `cost-tracker.ts` works across providers.
- Detect: missing executable, not logged in, rate limit, context overflow. Map each to a typed error the router understands.
- Kill the whole process tree on cancel (`taskkill /T /F /PID <pid>` on Windows), not just the parent.
- Never read or write the CLIs' own credential stores. Auth is each CLI's job; `/doctor` only checks status.
- Pin and record the CLI versions the adapter is tested against; warn when the installed version differs.

## Tech stack
Bun, TypeScript (strict), React + Ink for the terminal UI, Commander.js, Zod v4 for config schemas, ripgrep, MCP SDK, LSP. Auth secrets go in **Windows Credential Manager** (not macOS Keychain).

## Commands
```powershell
bun install
bun run dev            # run the CLI from source
bun run typecheck
bun run lint
bun test
bun run build          # bundles with feature flags
```

## Coding rules
- Read a file before editing it. Match existing patterns.
- Every new tool or command gets a Zod input schema, a permission declaration, and tests.
- Every router rule gets a table-driven test in `router/__tests__/` covering the override, floor, capability, stickiness, independence, health, and escalation cases.
- Adapters get contract tests using recorded CLI output fixtures from all three CLIs.
- Use `path.win32`-safe code: `path.join`, never string concatenation with `/`.
- Do not weaken or skip tests to make them pass. Do not add dependencies without saying why in the PR.
- Keep comments for *why*, not *what changed*.

## Definition of done
Builds, type-checks, lints, and tests pass on Windows; the router change (if any) has tests; `/doctor` reports correctly with each backend present and absent.
