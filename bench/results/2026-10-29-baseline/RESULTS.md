# Profile benchmark — 2026-10-29-baseline

## Totals per profile

| Profile | Runs | Passed | Mean cost | Mean Conductor tokens | Mean delegate tokens | Mean time |
|---|---|---|---|---|---|---|
| solo-sonnet | 6 | 6/6 | $0.068 | 104k | 0k | 17 s |
| solo-opus | 6 | 6/6 | $0.216 | 144k | 0k | 31 s |
| solo-codex | 6 | 6/6 | $0.000 | 67k | 0k | 20 s |

## Per task

| Task | Profile | Passed | Mean cost | Mean Conductor tokens | Delegations (provider/tier) | Mean time |
|---|---|---|---|---|---|---|
| review | solo-sonnet | 2/2 | $0.059 | 66k | none; none | 19 s |
| review | solo-opus | 2/2 | $0.194 | 145k | none; none | 43 s |
| review | solo-codex | 2/2 | $0.000 | 48k | none; none | 15 s |
| fix | solo-sonnet | 2/2 | $0.073 | 145k | none; none | 15 s |
| fix | solo-opus | 2/2 | $0.140 | 105k | none; none | 19 s |
| fix | solo-codex | 2/2 | $0.000 | 95k | none; none | 29 s |
| explain | solo-sonnet | 2/2 | $0.073 | 101k | none; none | 15 s |
| explain | solo-opus | 2/2 | $0.313 | 181k | none; none | 30 s |
| explain | solo-codex | 2/2 | $0.000 | 58k | none; none | 17 s |

## Failed checks

None.

## Notes

- Cost is what the CLIs report. Claude reports USD; Gemini and Codex report tokens only, so their cost shows as $0.
- `explain` and `review` run read-only on this repo (approvals denied). `fix` runs on a fresh copy of `bench/fixture` with approvals allowed and is scored by running its tests.
- Scores are automatic keyword and test checks, not a judgement of answer quality. Read the `answer` field in each JSON for that.
