# Profile benchmark — 2026-10-28

## Totals per profile

| Profile | Runs | Passed | Mean cost | Mean Conductor tokens | Mean delegate tokens | Mean time |
|---|---|---|---|---|---|---|
| economy | 6 | 5/6 | $0.072 | 114k | 44k | 37 s |
| balanced | 6 | 5/6 | $0.088 | 117k | 81k | 52 s |
| quality | 6 | 5/6 | $0.200 | 140k | 110k | 80 s |

## Per task

| Task | Profile | Passed | Mean cost | Mean Conductor tokens | Delegations (provider/tier) | Mean time |
|---|---|---|---|---|---|---|
| review | economy | 1/2 | $0.051 | 91k | gemini/standard; openai/standard | 69 s |
| review | balanced | 1/2 | $0.062 | 109k | gemini/deep; openai/deep | 115 s |
| review | quality | 1/2 | $0.113 | 92k | gemini/deep; openai/deep | 175 s |
| fix | economy | 2/2 | $0.087 | 113k | none; none | 19 s |
| fix | balanced | 2/2 | $0.090 | 115k | none; none | 18 s |
| fix | quality | 2/2 | $0.198 | 144k | none; none | 26 s |
| explain | economy | 2/2 | $0.079 | 137k | none; none | 24 s |
| explain | balanced | 2/2 | $0.112 | 127k | none; none | 25 s |
| explain | quality | 2/2 | $0.289 | 185k | none; none | 40 s |

## Failed checks

- review / economy / rep 1: cites_line, states_agreement
- review / balanced / rep 1: states_agreement
- review / quality / rep 2: cites_line, states_agreement

## Notes

- Cost is what the CLIs report. Claude reports USD; Gemini and Codex report tokens only, so their cost shows as $0.
- `explain` and `review` run read-only on this repo (approvals denied). `fix` runs on a fresh copy of `bench/fixture` with approvals allowed and is scored by running its tests.
- Scores are automatic keyword and test checks, not a judgement of answer quality. Read the `answer` field in each JSON for that.
