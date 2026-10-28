# Routing profile benchmark

Run on 2026-10-28 on Linux with Claude Code 2.1.312, Codex 0.165.0 (gpt-6-luna) and Gemini CLI 0.66.0 (free tier).
Each task ran twice under each profile through `agent-router serve`, the same path the desktop app uses.

Reproduce with `npx bun bench/bench.ts`, then `npx bun bench/report.ts bench/results/<dir>`.

## Result

| Profile | Runs | Passed | Mean cost | vs Quality | Conductor tokens | Delegate tokens | Mean time |
|---|---|---|---|---|---|---|---|
| quality | 6 | 6/6 | $0.195 | — | 151k | 86k | 62 s |
| balanced | 6 | 6/6 | $0.081 | −58% | 112k | 60k | 43 s |
| economy | 6 | 6/6 | $0.068 | −65% | 114k | 20k | 26 s |

`explain` and `fix` come from [`results/2026-10-28`](results/2026-10-28/RESULTS.md). `review` comes from
[`results/2026-10-28-parser-fix`](results/2026-10-28-parser-fix/RESULTS.md), re-run after the parser bug below was fixed.
Cost covers Claude only. Codex and Gemini report tokens but not dollars, so delegate cost is counted in tokens.

## Tasks

| Task | Workspace | What it measures | Pass condition |
|---|---|---|---|
| `explain` | this repo, read-only | Code reading and accurate references | names `nextStep`, cites `escalation.ts` lines, invents no function names, names an untested edge case |
| `fix` | fresh copy of `bench/fixture`, edits allowed | A small two-bug fix | `node --test` passes and the test files are unchanged |
| `review` | this repo, read-only | Cross-model delegation | a non-Claude model reviewed, the answer cites a line and says whether Conductor agrees |

## What the numbers say

- **Every profile passed every task.** These tasks don't separate the profiles on correctness. They are small enough that Sonnet does them as well as Opus.
- **Balanced cost 58% less than Quality.** Most of that is the Conductor model: Sonnet instead of Opus, on 25% fewer tokens.
- **Economy was cheapest, but its reviews were weaker.** It reviews on the standard tier. In one of its two runs the reviewer cited a doc comment as the bug, and Conductor rejected the finding. Deep-tier reviews under Quality and Balanced found the fallback-before-tier-up bug (`escalation.ts:61-64`) in 2 of 4 runs. The other two found a minor issue or nothing.
- **Nothing delegated in `explain` or `fix`.** Every profile did these itself, as the "do small lookups yourself" rule intends. Delegation savings on large multi-step tasks are not measured here.

## Versus a single model, no router

On 2026-10-29 the same tasks ran on one CLI directly, 2 runs each ([`results/2026-10-29-baseline`](results/2026-10-29-baseline/RESULTS.md)).
`claude -p` got the same read-only tools as a read-only Claude delegate (plus edits and `node` on `fix`); `codex exec` ran in its read-only or workspace-write sandbox.
On `review` a lone model cannot ask another one, so it reviews the file itself (`soloPrompt`) and the `delegated_to_other_model` check is skipped.
Reproduce with `npx bun bench/baseline.ts`, then `npx bun bench/report.ts bench/results/<dir>`.

| Setup | Passed | Mean cost | Mean tokens per task (all backends) | Mean time |
|---|---|---|---|---|
| Router, quality | 6/6 | $0.195 | 237k | 62 s |
| Router, balanced | 6/6 | $0.081 | 172k | 43 s |
| Claude Opus alone | 6/6 | $0.216 | 144k | 31 s |
| Router, economy | 6/6 | $0.068 | 133k | 26 s |
| Claude Sonnet alone | 6/6 | $0.068 | 104k | 17 s |
| Codex alone | 6/6 | — (plan limits) | 67k | 20 s |

- **The router uses more tokens than a single model.** Every profile used more than Sonnet alone (+28% to +128%), and Codex alone used the fewest. In `explain` and `fix` nothing was delegated, so the difference is Conductor's own prompt and tools.
- **Its cost saving against Opus comes from the Conductor model.** Balanced and Economy are 63-69% cheaper than Opus alone, but Sonnet alone costs the same as Economy with fewer tokens.
- **Not measured:** answer quality beyond the automatic checks, and large tasks where delegation (for example to Gemini's 1M-token context) might pay off. The baseline ran a day after the router runs, when `escalation.ts` had been fixed, so the `review` target differed slightly.

## After the token-saving changes

Run on 2026-10-29 ([`results/2026-10-29-token-savings`](results/2026-10-29-token-savings/RESULTS.md)), same tasks, 2 runs each, after three changes:
a lean Claude tool set (`lean_tools`: Conductor loads Read, Edit, Write and Bash instead of Claude Code's full set, about 14k fewer prompt tokens per request),
Codex session resume, and the new Offload profile (Claude plans and verifies; Codex and Gemini read and edit; Conductor has no Edit or Write tool).
Means per task. Claude tokens include Conductor; Codex tokens are delegates on the ChatGPT plan.

| Setup | Passed | Claude tokens | Claude cost | Codex tokens | All tokens |
|---|---|---|---|---|---|
| Codex alone | 6/6 | — | — | 67k | 67k |
| Claude Sonnet alone | 6/6 | 104k | $0.068 | — | 104k |
| Economy, before | 6/6 | 114k | $0.068 | 20k | 133k |
| **Economy, after** | 6/6 | **78k** | **$0.052** | 40k | 118k |
| Balanced, before | 6/6 | 112k | $0.081 | 60k | 172k |
| **Balanced, after** | 6/6 | **91k** | $0.085 | 76k | 166k |
| **Offload** | 4/6 | 80k | $0.060 | 158k | 238k |

- **The lean tool set is the main saving.** Conductor used 32% fewer Claude tokens on Economy and 19% fewer on Balanced. Economy now costs less on Claude than Sonnet alone ($0.052 vs $0.068) and uses 25% fewer Claude tokens, with Codex doing the independent review. Balanced's cost did not move: one `explain` run cost $0.133, and n = 2.
- **All tokens are still above a single model.** Economy's 118k is 13% over Sonnet alone (was +28%), and Codex alone, at 67k, is still the leanest.
- **Offload moves work, it does not shrink it.** On `explain` it used 29% fewer Claude tokens than Balanced (78k vs 110k) by sending the lookup to Codex. On `fix`, briefing Codex and checking its work cost Claude more than doing the two-line fix itself (100k vs Economy's 71k), and the Codex delegate read 111k–128k tokens. It pays off when Claude's plan is the scarce one and the ChatGPT plan has room, and on tasks bigger than these.
- **Offload's two `review` failures are the checker, not the answer.** `escalation.ts` has been fixed since the task was written, and the Codex reviewer reported no defect, so there was no line to cite. Balanced and Economy reviewers flagged minor points with lines.
- **Gemini was rate-limited** (free tier) in both Offload `explain` runs, so Codex did the lookups. Offload's `explain` and `review` ran before Conductor's Edit and Write tools were removed; `fix` was re-run after, since it delegated nothing until then.

## Bug found by the benchmark (fixed)

The first `review` runs failed in 3 of 6 cases. Codex's reports were rejected as malformed, and the router fell back to Gemini, which was out of quota. The reports were in fact well-formed. The reviewer format puts `### Verdict` / `### Findings` under `## Result`, and `parseReport` treated every heading as a new section, so Result came out empty. Only the protocol section names end a section now (`src/coordinator/protocol.ts`, with a regression test). All 10 Codex reports recorded during the run parse correctly with the fix, and the re-run passed 6/6 with each delegation succeeding on its first attempt.

## Ladder findings to look at

Reviewers and `explain` answers raised these about `src/router/escalation.ts`. Items 1, 3 and 4 are fixed and covered by tests in `src/router/__tests__/escalation.test.ts`. Item 2 is by design: `max_attempts_per_subtask` is the policy and 4 is only its default. A Codex review of the new ladder found no defects.

1. **Fallback runs before tier-up** (`:61-64`). With three candidates, attempts go to claude, claude again, then openai and gemini, and the 4-attempt cap stops before the deep tier is tried. It is the top finding in 3 final answers across both runs.
2. **`max_attempts` above 4 is not capped** (`:47`). The schema accepts any value.
3. **`max_attempts: 2` spends both attempts on the same backend** (`:58`), so it never falls back.
4. **`timeout` and `failed` get a same-backend retry**, and no `nextStep` test covers either.

## Caveats

- n = 2 per cell, and the tasks are small. Treat the percentages as indicative.
- Gemini was on the free tier and mostly out of quota, so it hardly appears.
- Pass/fail is automatic. Answer quality was spot-read by hand, not graded systematically. Every answer is in the JSON files.
- `results/2026-10-28-pilot` holds the first single-run comparison: Quality $0.32 and Balanced $0.19 on the `explain` prompt.
