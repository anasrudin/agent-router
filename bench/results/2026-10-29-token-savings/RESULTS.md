# Profile benchmark — 2026-10-29-token-savings

## Totals per profile

| Profile | Runs | Passed | Mean cost | Mean Conductor tokens | Mean delegate tokens | Mean time |
|---|---|---|---|---|---|---|
| economy | 6 | 6/6 | $0.052 | 78k | 40k | 28 s |
| balanced | 6 | 6/6 | $0.085 | 91k | 76k | 43 s |
| offload | 6 | 4/6 | $0.060 | 80k | 158k | 63 s |

## By subscription

| Profile | Claude tokens | Claude cost | Codex tokens | Gemini tokens | All tokens |
|---|---|---|---|---|---|
| economy | 78k | $0.052 | 40k | 0k | 118k |
| balanced | 91k | $0.085 | 76k | 0k | 166k |
| offload | 80k | $0.060 | 158k | 0k | 238k |

## Per task

| Task | Profile | Passed | Mean cost | Mean Conductor tokens | Delegations (provider/tier) | Mean time |
|---|---|---|---|---|---|---|
| review | economy | 2/2 | $0.026 | 71k | openai/standard; openai/standard | 43 s |
| review | balanced | 2/2 | $0.068 | 85k | openai/deep; openai/deep | 82 s |
| review | offload | 0/2 | $0.025 | 62k | openai/deep; openai/deep | 81 s |
| fix | economy | 2/2 | $0.059 | 71k | none; none | 23 s |
| fix | balanced | 2/2 | $0.083 | 77k | none; none | 24 s |
| fix | offload | 2/2 | $0.093 | 100k | openai/standard; openai/standard | 48 s |
| explain | economy | 2/2 | $0.070 | 92k | none; none | 19 s |
| explain | balanced | 2/2 | $0.104 | 110k | none; none | 24 s |
| explain | offload | 2/2 | $0.062 | 78k | openai/fast; openai/fast | 59 s |

## Failed checks

- review / offload / rep 2: cites_line
- review / offload / rep 1: cites_line

## Notes

- Cost is what the CLIs report. Claude reports USD; Gemini and Codex report tokens only, so their cost shows as $0.
- `explain` and `review` run read-only on this repo (approvals denied). `fix` runs on a fresh copy of `bench/fixture` with approvals allowed and is scored by running its tests.
- Scores are automatic keyword and test checks, not a judgement of answer quality. Read the `answer` field in each JSON for that.
