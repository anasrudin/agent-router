import type { BackendErrorKind } from "../backends/events"
import { maxTier, type ProviderId, type Tier, tierAbove } from "../config/schema"

export type AttemptOutcome = "ok" | "backend_error" | "report_failed" | "blocked"

export interface Attempt {
  provider: ProviderId
  tier: Tier
  outcome: AttemptOutcome
  errorKind?: BackendErrorKind
  message?: string
}

export type NextStep =
  | { action: "retry"; provider: ProviderId; tier: Tier; reason: string }
  | { action: "fallback"; provider: ProviderId; tier: Tier; reason: string }
  | { action: "tier_up"; provider: ProviderId; tier: Tier; reason: string }
  | { action: "stop"; reason: string }

/** The backend, not the brief, is the problem: retrying the same backend cannot help. */
const SWITCH_IMMEDIATELY: ReadonlySet<BackendErrorKind> = new Set([
  "missing_executable",
  "not_authenticated",
  "untrusted_workspace",
  "rate_limited",
  "context_overflow",
])

/** Retrying the same backend with a sharper brief cannot fix these, but the backend may still serve a higher tier. */
const SKIP_RETRY: ReadonlySet<BackendErrorKind> = new Set(["timeout", "stalled", "tool_loop"])

export interface LadderInput {
  history: Attempt[]
  /** Providers that can serve the request, in preference order (from the routing decision). */
  candidates: ProviderId[]
  pinned: boolean
  maxAttempts: number
}

/**
 * conductor.md §4 rule 7: retry with a sharper brief → fallback provider → higher tier → ask the user.
 * Each rung is used once per subtask, so the ladder reaches tier-up within the default four attempts
 * however many providers are configured. Pure, so every rung is table-tested.
 */
export function nextStep({ history, candidates, pinned, maxAttempts }: LadderInput): NextStep {
  const last = history.at(-1)
  if (!last) throw new Error("nextStep needs at least one attempt")
  if (last.outcome === "ok") return { action: "stop", reason: "succeeded" }
  if (last.outcome === "blocked") return { action: "stop", reason: "delegate is blocked and needs input from Conductor or the user" }
  if (last.errorKind === "cancelled") return { action: "stop", reason: "cancelled" }
  if (history.length >= maxAttempts) return { action: "stop", reason: `reached max attempts (${maxAttempts})` }

  const deadProviders = new Set(history.filter((a) => a.errorKind && SWITCH_IMMEDIATELY.has(a.errorKind)).map((a) => a.provider))
  const alive = candidates.filter((p) => !deadProviders.has(p))
  const tried = (p: ProviderId, t: Tier) => history.some((a) => a.provider === p && a.tier === t)
  const lastIsDead = deadProviders.has(last.provider)
  const highest = history.reduce<Tier>((t, a) => maxTier(t, a.tier), "fast")
  const retried = history.some((a, i) => i > 0 && a.provider === history[i - 1]?.provider && a.tier === history[i - 1]?.tier)
  const switched = history.some((a, i) => i > 0 && a.provider !== history[i - 1]?.provider)
  const attemptsLeft = maxAttempts - history.length

  const fallbackAt = (t: Tier) => (pinned ? undefined : alive.find((p) => p !== last.provider && !tried(p, t)))
  const higher = tierAbove(highest)
  const tierUp = higher ? alive.find((p) => !tried(p, higher)) : undefined
  const switchStep = (p: ProviderId, t: Tier): NextStep => ({
    action: "fallback",
    provider: p,
    tier: t,
    reason: `switch from ${last.provider} to ${p}`,
  })
  const tierUpStep = (p: ProviderId, t: Tier): NextStep => ({
    action: "tier_up",
    provider: p,
    tier: t,
    reason: `raise tier ${highest} → ${t}`,
  })

  // A dead backend cannot run anything: move to a live one at the same tier, or go straight up.
  if (lastIsDead) {
    const other = fallbackAt(last.tier)
    if (other) return switchStep(other, last.tier)
  } else if (!retried && !(last.errorKind && SKIP_RETRY.has(last.errorKind))) {
    // With one attempt left, a retry would spend it on the backend that just failed; a later rung changes more.
    const laterRung = (!switched && fallbackAt(last.tier)) || tierUp
    if (attemptsLeft > 1 || !laterRung) {
      return { action: "retry", provider: last.provider, tier: last.tier, reason: "retry once with a sharper brief" }
    }
  }
  if (!switched) {
    const fallback = fallbackAt(last.tier)
    if (fallback) return switchStep(fallback, last.tier)
  }
  if (higher && tierUp) return tierUpStep(tierUp, higher)
  // Top tier reached (or nothing above it is live): any live provider not yet tried there still gets a turn.
  const remaining = fallbackAt(highest)
  if (remaining) return switchStep(remaining, highest)
  return { action: "stop", reason: "escalation ladder exhausted; ask the user" }
}
