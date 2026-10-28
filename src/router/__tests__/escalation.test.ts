import { describe, expect, test } from "bun:test"
import type { ProviderId } from "../../config/schema"
import { type Attempt, type NextStep, nextStep } from "../escalation"

const fail = (provider: ProviderId, tier: Attempt["tier"] = "standard", errorKind?: Attempt["errorKind"]): Attempt => ({
  provider,
  tier,
  outcome: errorKind ? "backend_error" : "report_failed",
  errorKind,
})

const cases: [string, Attempt[], { candidates?: ProviderId[]; pinned?: boolean; max?: number }, Partial<NextStep>][] = [
  ["first soft failure retries same backend", [fail("claude")], {}, { action: "retry", provider: "claude", tier: "standard" }],
  [
    "second failure switches to fallback",
    [fail("claude"), fail("claude")],
    {},
    { action: "fallback", provider: "openai", tier: "standard" },
  ],
  [
    "fallback failing raises tier on primary",
    [fail("claude"), fail("claude"), fail("openai")],
    {},
    { action: "tier_up", provider: "claude", tier: "deep" },
  ],
  [
    "missing executable skips the retry",
    [fail("claude", "standard", "missing_executable")],
    {},
    { action: "fallback", provider: "openai" },
  ],
  ["rate limit skips the retry", [fail("claude", "standard", "rate_limited")], {}, { action: "fallback", provider: "openai" }],
  [
    "dead primary is not used for tier-up",
    [fail("claude", "standard", "not_authenticated"), fail("openai"), fail("openai")],
    {},
    { action: "tier_up", provider: "openai", tier: "deep" },
  ],
  [
    "pinned provider never falls back",
    [fail("claude"), fail("claude")],
    { pinned: true },
    { action: "tier_up", provider: "claude", tier: "deep" },
  ],
  [
    "pinned and dead stops",
    [fail("claude", "standard", "missing_executable")],
    { pinned: true, candidates: ["claude"] },
    { action: "stop" },
  ],
  ["already deep and no fallback stops", [fail("claude", "deep"), fail("claude", "deep")], { candidates: ["claude"] }, { action: "stop" }],
  ["max attempts stops", [fail("claude"), fail("claude"), fail("openai"), fail("claude", "deep")], { max: 4 }, { action: "stop" }],
  // Each rung runs once, so tier-up is reached within four attempts however many providers there are.
  [
    "with three providers, tier-up comes before a second fallback",
    [fail("claude"), fail("claude"), fail("openai")],
    { candidates: ["claude", "openai", "gemini"] },
    { action: "tier_up", provider: "claude", tier: "deep" },
  ],
  [
    "a dead deep attempt hands the deep tier to a live provider",
    [fail("claude"), fail("claude"), fail("openai"), fail("claude", "deep", "rate_limited")],
    { max: 5 },
    { action: "fallback", provider: "openai", tier: "deep" },
  ],
  [
    "the top tier still tries the other providers when attempts remain",
    [fail("claude"), fail("claude"), fail("openai"), fail("claude", "deep")],
    { max: 6, candidates: ["claude", "openai", "gemini"] },
    { action: "fallback", provider: "openai", tier: "deep" },
  ],
  [
    "a fallback chosen because the primary is dead still gets its retry",
    [fail("claude", "standard", "not_authenticated"), fail("openai")],
    {},
    { action: "retry", provider: "openai", tier: "standard" },
  ],
  ["a two-attempt budget falls back instead of retrying", [fail("claude")], { max: 2 }, { action: "fallback", provider: "openai" }],
  [
    "a two-attempt budget still retries when nothing else could run",
    [fail("claude", "deep")],
    { max: 2, candidates: ["claude"] },
    { action: "retry", provider: "claude", tier: "deep" },
  ],
  ["a timeout skips the same-brief retry", [fail("claude", "standard", "timeout")], {}, { action: "fallback", provider: "openai" }],
  [
    "a timed-out backend can still serve the higher tier",
    [fail("claude", "standard", "timeout"), fail("openai"), fail("openai")],
    {},
    { action: "tier_up", provider: "claude", tier: "deep" },
  ],
  ["a generic CLI failure retries once", [fail("claude", "standard", "failed")], {}, { action: "retry", provider: "claude" }],
  [
    "max attempts above four are honoured",
    [fail("claude"), fail("claude"), fail("openai"), fail("claude", "deep")],
    { max: 5 },
    { action: "fallback", provider: "openai", tier: "deep" },
  ],
  ["blocked stops for input", [{ provider: "claude", tier: "standard", outcome: "blocked" }], {}, { action: "stop" }],
  ["cancelled stops", [fail("claude", "standard", "cancelled")], {}, { action: "stop" }],
  ["success stops", [{ provider: "claude", tier: "standard", outcome: "ok" }], {}, { action: "stop" }],
]

describe("nextStep() — retry → fallback → tier up → ask", () => {
  for (const [name, history, opts, expected] of cases) {
    test(name, () => {
      const step = nextStep({
        history,
        candidates: opts.candidates ?? ["claude", "openai"],
        pinned: opts.pinned ?? false,
        maxAttempts: opts.max ?? 4,
      })
      expect(step).toMatchObject(expected)
    })
  }
})
