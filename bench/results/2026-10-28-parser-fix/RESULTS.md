# Profile benchmark — 2026-10-28-parser-fix

## Totals per profile

| Profile | Runs | Passed | Mean cost | Mean Conductor tokens | Mean delegate tokens | Mean time |
|---|---|---|---|---|---|---|
| economy | 2 | 2/2 | $0.037 | 92k | 59k | 36 s |
| balanced | 2 | 2/2 | $0.042 | 93k | 179k | 85 s |
| quality | 2 | 2/2 | $0.099 | 124k | 259k | 119 s |

## Per task

| Task | Profile | Passed | Mean cost | Mean Conductor tokens | Delegations (provider/tier) | Mean time |
|---|---|---|---|---|---|---|
| review | economy | 2/2 | $0.037 | 92k | openai/standard; openai/standard | 36 s |
| review | balanced | 2/2 | $0.042 | 93k | openai/deep; openai/deep | 85 s |
| review | quality | 2/2 | $0.099 | 124k | openai/deep; openai/deep | 119 s |

## Failed checks

None.

## Notes

- Cost is what the CLIs report. Claude reports USD; Gemini and Codex report tokens only, so their cost shows as $0.
- `explain` and `review` run read-only on this repo (approvals denied). `fix` runs on a fresh copy of `bench/fixture` with approvals allowed and is scored by running its tests.
- Scores are automatic keyword and test checks, not a judgement of answer quality. Read the `answer` field in each JSON for that.
