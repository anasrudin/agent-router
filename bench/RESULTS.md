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
