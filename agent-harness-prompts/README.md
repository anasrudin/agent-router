# Agent Instructions — Multi-CLI Harness for Windows

Instruction set for a Windows agent harness that wraps **Claude Code CLI, Gemini CLI, and OpenAI Codex CLI** and routes work between them without lowering output quality.

## Contents

| File | Purpose |
|---|---|
| `prompts/conductor.md` | Main agent: operating loop, delegate-or-do, routing policy, verification, parallel work, safety |
| `prompts/agents/planner.md` | Turns requests into ordered, verifiable plans (Claude, deep) |
| `prompts/agents/architect.md` | Hard debugging and design decisions (Claude, deep; OpenAI second opinion) |
| `prompts/agents/librarian.md` | Docs, library APIs, very large inputs (Gemini) |
| `prompts/agents/scout.md` | Fast codebase search (Gemini, fast) |
| `prompts/agents/looker.md` | Screenshots, mockups, diagrams, PDFs, video (Gemini) |
| `prompts/agents/reviewer.md` | Independent review, always on a different provider from the author |
| `prompts/agents/worker.md` | Implements one scoped step and verifies it |
| `prompts/shared/delegation-protocol.md` | Brief and report formats every agent uses |
| `prompts/shared/windows.md` | PowerShell, paths, line endings, processes |
| `config/routing.yaml` | Default routing table, quality floors, escalation, limits, privacy |
| `AGENTS.md` | Instructions for coding agents building the harness itself |

## How quality is protected
1. **Quality floors** — each task class has a `min_tier`; budget can never push below it.
2. **Read big, write strong** — large or multimodal input is read by the backend that can handle it, but the writing stays on the best backend for that task, fed with distilled context plus verbatim excerpts.
3. **Stickiness** — a multi-step edit stays on one backend and session.
4. **Cross-provider review** — reviewers and second opinions always run on a different model than the author.
5. **Verify before trust** — every delegate report is checked against acceptance criteria, with tests run, before it reaches the user.
6. **Escalation ladder** — sharper brief → fallback provider → higher tier → ask the user.

## Template variables
The harness fills these at runtime: `{{HARNESS_NAME}}`, `{{WINDOWS_VERSION}}`, `{{SHELL}}`, `{{WORKSPACE_ROOT}}`, `{{SELF_PROVIDER}}`, `{{SELF_MODEL}}`, `{{BACKENDS_STATUS}}`, `{{PERMISSION_MODE}}`, `{{BUDGET}}`, `{{AGENTS_MD}}`, `{{README_SUMMARY}}`, `{{CONDITIONAL_RULES}}`, `{{AGENT_LIST}}`, `{{SKILL_LIST}}`, `{{MAX_ATTEMPTS_PER_SUBTASK}}`, `{{MAX_PARALLEL_AGENTS}}`.

## Before you use it
- Fill in the model ids in `config/routing.yaml` for each tier.
- Check the CLI flags in `routing.yaml → backends` against `claude --help`, `gemini --help`, and `codex --help` for your installed versions; they change between releases.
- Adjust the default provider per task class after running your own evals — the defaults are a reasonable starting point, not measured results.
