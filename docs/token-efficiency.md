# Token and cost efficiency

How agent-router keeps tokens and spend down, what each mechanism saves, what has been measured, and how to tune it. The rule behind all of it is from Conductor's prompt: quality first, then cost. Nothing here lowers a task class's `min_tier`, weakens privacy, or skips verification.

## Where tokens go

Every agent here is a CLI (Claude Code, Codex, Gemini CLI) running a tool loop. Each tool call is one model turn, and **each turn re-sends the whole conversation so far**: the CLI's own system prompt, the role prompt, the brief, and every earlier tool result. So:

- Input grows roughly with *turns × context size*. A delegate that takes 19 turns where 4 would do pays for the context 19 times.
- Most of that re-sent input is a prompt-cache read. It is billed at a fraction of the normal price where you pay per token, and it still counts against plan limits and rate limits.
- Output is small next to input, but it is the expensive kind per token. It includes thinking/reasoning tokens.

The levers that follow fall into four groups: fewer turns, a smaller context per turn, a cheaper model for each turn, and stopping spend that no longer helps.

## Mechanisms

### Cheaper model per turn

| Mechanism | Where | Effect |
|---|---|---|
| Task classes with tiers | `routes` in `routing.yaml` | Lookups run on the fast tier (Gemini Flash, Haiku), edits on standard, only plans, hard debugging and architecture on deep. |
| Profiles | `profiles`, the **Profile** menu, `@economy` | Trade depth above each class's quality floor. Balanced cost 58% less than Quality, Economy 65% less ([benchmark](../bench/RESULTS.md)). |
| Plans | `plan`, the **Plan** menu | The backend you pay more for does the frontier work, and the other gets the overflow. |
| Conductor tier | profile `conductor.tier` | Sonnet instead of Opus is most of Balanced's saving. |
| Live quota | `limits.quota_avoid_at`, the CLIs' own usage reports | A full subscription window is skipped until it resets instead of failing a call and falling back; a nearly full one goes to the back of the line, so expensive work is not stranded mid-task when a limit hits. |

### Fewer turns

| Mechanism | Where | Effect |
|---|---|---|
| Do small work yourself | conductor.md §3 and §8 | A question or an edit under ~20 lines in a file Conductor has read never becomes a delegation. In the benchmark's `explain` and `fix` tasks no profile delegated anything. |
| Scout budget | `prompts/agents/scout.md` | 2–6 tool calls for a typical lookup. It reports as soon as every acceptance item has a location, and stops past 10. |
| Resume, don't restart | `resume` on `delegate`; ladder retries | A follow-up continues the delegate's session (Claude, Codex), which already holds what it read. A malformed report is fixed in the same session instead of a fresh attempt. |
| Project memory | `.harness/memory.md`, `remember` | Facts that would otherwise be re-scouted every chat (the real test command, where config lives) ride in Conductor's prompt and every brief. |
| Worktree setup | `worktrees.setup` | A delegate in a fresh worktree does not spend turns installing dependencies or fail the project checks for lack of them. |
| Nudge before giving up | watchdog | A stalled or looping Claude/Codex delegate is resumed with a note instead of starting over. |
| Report gate | Stop hook (Claude delegates) | A formatting slip costs one more turn, not a whole new attempt. |

### Smaller context per turn

| Mechanism | Where | Effect |
|---|---|---|
| Lean Claude tool set | `backends.claude.lean_tools` (on) | Conductor loads only Read, Edit, Write, Bash and the router's tools. Claude Code's other tool definitions cost about 14k prompt tokens on every request. This cut Conductor's Claude tokens by 32% on Economy. |
| Lean delegate prompt | `src/prompts/render.ts` | Delegates get the report half of the delegation protocol, not the brief-writing rules meant for Conductor: about 1.6k characters (~400 tokens) less on every turn of every delegate (scout 5,891 → 4,292 characters). |
| References over dumps | conductor.md §8, delegation protocol | Briefs carry `path:start-end` and verbatim excerpts of only what matters, never whole files or chat history. |
| Changed-file list | `formatResult` in `src/mcp/server.ts` | Each edit result lists the files changed during the task with `+added -removed` counts from git. Conductor reads those diffs instead of re-reading whole files. |
| Large-report cap | `src/coordinator/output.ts` | A report over 40,000 characters reaches Conductor as head and tail, with the full text saved under `.harness/outputs/`. |
| Scoped rules | `src/prompts/scoped-rules.ts` | Only the `AGENTS.md` and rule files for the brief's files are attached. |
| Context-full restart | ladder | A delegate that fills its context gets one fresh session told which files it already changed, instead of a whole new attempt elsewhere. |

### Stop spend that no longer helps

| Mechanism | Where | Effect |
|---|---|---|
| Delegate token budget | `budget.delegate_tokens` (off by default) | Once a subtask's attempts have used this many tokens, a failed attempt ends the ladder instead of escalating to a dearer tier. CLIs report usage only when an attempt ends, so a running attempt is never cut off. |
| Session budget | `budget.session_usd` | New delegations are refused once the session's reported spend reaches the cap. |
| Escalation ladder | `escalation.max_attempts_per_subtask` | Retry, fallback, tier-up, ask, each used once. A dead backend (signed out, rate-limited, untrusted folder) is skipped without a retry. |
| Watchdog | `limits.delegate_stall_seconds`, `limits.max_identical_tool_calls` | A silent or looping delegate is stopped long before the 15-minute timeout. |

## Measuring it

### Honest counts

- **Input** counts every prompt-side token, cache reads included, so providers compare like for like. Each delegation result, and telemetry, also gives the cached part (`cached_tokens`). Claude reports `cache_read_input_tokens`, Codex `cached_input_tokens`, Gemini `cached`.
- **Output** includes thinking. Gemini's `output_tokens` leaves thinking out, though `total_tokens` includes it and Gemini bills it as output, so the adapter uses `total_tokens − input_tokens`.
- **Cost** is only what a CLI reports. Claude reports dollars. Codex and Gemini report tokens only, so their spend shows as tokens.
- A resumed Codex thread reports its running total. The harness subtracts the earlier total, so each delegation counts only its own share.

### Where to see it

- **Delegation result** (what Conductor reads): cost, input tokens with the cached part, output tokens, attempts, and changed files.
- **Desktop app**: each thread shows its tokens and cost in the detail panel. The line under the composer shows the chat's total spend, tokens and running threads.
- **Telemetry stream**: set `telemetry: { events_file: .harness/events.jsonl }` and every delegation writes `dispatch`, `update`, `merge` and `halt` lines with provider, model, tier, worktree, files and `budget { input_tokens, cached_tokens, output_tokens, cost_usd, cap_tokens }`. See [configuration](configuration.md#telemetry).
- **Benchmark**: `npx bun bench/bench.ts` and `bench/baseline.ts`, then `bench/report.ts`. Results are in [bench/RESULTS.md](../bench/RESULTS.md).

## Case study: a 378k-token lookup (2026-11-01)

A Conductor turn asked one Gemini scout where `budget.delegate_tokens` is read. It answered correctly but reported 377,857 input tokens. Gemini's own session log showed:

| | |
|---|---|
| Model turns | 19. The answer was complete after turn 4 (55k input tokens). |
| Input per turn | 12.6k growing to 28k, re-sent each turn |
| Cache reads | 296,639 (79%) |
| Uncached input | 81,218 |
| Thinking | 4,720, not counted before the fix |
| Output | 934 |

The scout found both locations in three tool calls, then spent 15 more turns re-checking them from other angles and reading whole files (`telemetry.ts`, `load.ts`, `cli.ts`). About 85% of the tokens went on over-verification. A short reproduction with a minimal brief used 22.8k tokens in 3 tool calls.

Changes that followed: the scout budget, the lean delegate prompt, thinking counted as output, and cached tokens reported separately. Gemini's daily quota ran out during the investigation, so the effect on Gemini has not been re-measured yet. The same lookup on Claude Haiku (the fallback) took 21k tokens, $0.0028 and 20 s. Two later runs in the desktop app (Economy, scouts on Haiku after Gemini was rate-limited) cost $0.039 for two parallel lookups and $0.024 for one, Conductor included.

Gemini CLI can cap turns with `model.maxSessionTurns` in its settings, but hitting the cap ends the run with an error and no answer, so the harness does not use it.

## What has not been measured

- Answer quality beyond automatic checks.
- Large multi-step tasks, where delegation (for example to Gemini's 1M-token context) might pay off more than on the benchmark's small tasks.
- The router against a single model on tokens: on the small benchmark tasks the router still uses more tokens in total than Sonnet alone (Economy +13%) and Codex alone used the fewest. On Claude alone, Economy uses 25% fewer tokens than Sonnet alone and costs less ($0.052 vs $0.068 per task).

## Tuning checklist

1. Pick a profile. Economy for routine work, Balanced when reviews matter, Quality for risky changes. Use `@economy` per request.
2. Set your `plan`, so the backend with spare paid capacity takes the volume.
3. Set `budget.delegate_tokens` (for example `200000`) to cap runaway subtasks, and `budget.session_usd` to cap a session.
4. Keep `lean_tools` on.
5. Turn on `telemetry.events_file` for a while and look for delegations with many turns or a high `input_tokens` against a small `output_tokens`. That pattern is over-exploration.
6. Give Gemini a paid tier, or trust the workspace (`trust_workspace: true`), so cheap lookups do not fall back to a dearer backend.
