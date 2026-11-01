# Profile benchmark — 2026-11-01-conductor-base-cost

## Totals per profile

| Profile | Runs | Passed | Mean cost | Mean Conductor tokens | Mean delegate tokens | Mean time |
|---|---|---|---|---|---|---|
| economy | 6 | 6/6 | $0.052 | 65k | 63k | 29 s |

## By subscription

| Profile | Claude tokens | Claude cost | Codex tokens | Gemini tokens | All tokens |
|---|---|---|---|---|---|
| economy | 65k | $0.052 | 63k | 0k | 128k |

## Per task

| Task | Profile | Passed | Mean cost | Mean Conductor tokens | Delegations (provider/tier) | Mean time |
|---|---|---|---|---|---|---|
| review | economy | 2/2 | $0.027 | 52k | openai/standard; openai/standard | 50 s |
| fix | economy | 2/2 | $0.055 | 65k | none; none | 18 s |
| explain | economy | 2/2 | $0.076 | 78k | none; none | 18 s |

## Failed checks

None.

## Notes

- Cost is what the CLIs report. Claude reports USD; Gemini and Codex report tokens only, so their cost shows as $0.
- `explain` and `review` run read-only on this repo (approvals denied). `fix` runs on a fresh copy of `bench/fixture` with approvals allowed and is scored by running its tests.
- Scores are automatic keyword and test checks, not a judgement of answer quality. Read the `answer` field in each JSON for that.
