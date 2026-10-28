import type { ProviderId, RoutingConfig, Tier } from "./schema"

/**
 * Subscription tiers by monthly price. Tiers 1–3 cost the same on both; 3.5 and 4 are what heavy
 * users pay in total (several seats or top-ups) and differ slightly per provider.
 */
export const PLAN_TIERS = [0, 1, 2, 3, 3.5, 4] as const
export type PlanTier = (typeof PLAN_TIERS)[number]

const MONTHLY_USD: Record<"claude" | "openai", Record<PlanTier, number>> = {
  claude: { 0: 0, 1: 20, 2: 40, 3: 200, 3.5: 255, 4: 466 },
  openai: { 0: 0, 1: 20, 2: 40, 3: 200, 3.5: 266, 4: 477 },
}

export interface Plan {
  /** 0 means no subscription: that backend is not used. */
  claude?: PlanTier
  openai?: PlanTier
  /** Gemini is metered by requests; 1000/day is the free tier. 0 means not used. */
  gemini_requests_per_day?: number
}

/** The three ways people usually split their spend. */
export const PLAN_PRESETS: Record<string, { label: string; plan: Plan }> = {
  "claude-heavy": { label: "Claude-heavy", plan: { claude: 4, openai: 1, gemini_requests_per_day: 1000 } },
  "chatgpt-heavy": { label: "ChatGPT-heavy", plan: { claude: 1, openai: 4, gemini_requests_per_day: 1000 } },
  split: { label: "Split", plan: { claude: 3.5, openai: 3.5, gemini_requests_per_day: 1000 } },
}

/** One side has the frontier capacity when it pays at least this much more than the other. */
const FRONTIER_RATIO = 1.5

export function monthlyUsd(plan: Plan, provider: "claude" | "openai"): number | undefined {
  const tier = plan[provider]
  return tier === undefined ? undefined : MONTHLY_USD[provider][tier]
}

/** Whether the plan rules a backend out (an explicit 0). Unset means unknown, so it stays usable. */
export function excludedByPlan(plan: Plan | undefined, provider: ProviderId): boolean {
  if (!plan) return false
  if (provider === "gemini") return plan.gemini_requests_per_day === 0
  return plan[provider] === 0
}

/** The backend with clearly more paid capacity, which should do the frontier (deep) work. */
export function frontierProvider(plan: Plan): "claude" | "openai" | undefined {
  const c = monthlyUsd(plan, "claude") ?? 0
  const o = monthlyUsd(plan, "openai") ?? 0
  if (c > 0 && c >= o * FRONTIER_RATIO) return "claude"
  if (o > 0 && o >= c * FRONTIER_RATIO) return "openai"
  return undefined
}

/** Concurrent delegates a subscription comfortably carries before hitting its rate limits. */
function parallelFor(usd: number): number {
  return usd >= 400 ? 3 : usd >= 200 ? 2 : 1
}

/**
 * What a plan changes, as a config overlay over the merged files:
 * - routes led by Claude or Codex go to the frontier backend first, with the other as fallback;
 * - a second opinion is never the backend that did the work;
 * - Conductor (always Claude) stays off the top tier on a small Claude plan;
 * - each backend runs as many delegates at once as its plan carries, unless you set that yourself.
 */
export function planOverlay(config: RoutingConfig, plan: Plan, options: { keepParallel?: boolean } = {}): Record<string, unknown> {
  const frontier = frontierProvider(plan)
  const other: ProviderId = frontier === "claude" ? "openai" : "claude"
  const usable = (p: ProviderId) => !excludedByPlan(plan, p)
  const routes: Record<string, Record<string, unknown>> = {}
  for (const [name, route] of Object.entries(config.routes)) {
    if (route.primary !== "claude" && route.primary !== "openai") continue
    const primary = frontier && usable(frontier) ? frontier : route.primary
    const fallback = [...new Set<ProviderId>([route.primary as ProviderId, ...route.fallback, ...(frontier ? [other] : [])])].filter(
      (p) => p !== primary && usable(p),
    )
    const patch: Record<string, unknown> = {}
    if (primary !== route.primary) patch.primary = primary
    if (fallback.join() !== route.fallback.join()) patch.fallback = fallback
    if (route.second_opinion && (route.second_opinion === primary || !usable(route.second_opinion))) {
      const alternative = (["openai", "claude", "gemini"] as const).find((p) => p !== primary && usable(p))
      patch.second_opinion = alternative ?? null
    }
    if (Object.keys(patch).length) routes[name] = patch
  }

  const parallel: Partial<Record<ProviderId, number>> = {}
  for (const p of ["claude", "openai"] as const) {
    const usd = monthlyUsd(plan, p)
    if (usd) parallel[p] = parallelFor(usd)
  }
  if (plan.gemini_requests_per_day) parallel.gemini = plan.gemini_requests_per_day >= 1000 ? 2 : 1

  const claudeUsd = monthlyUsd(plan, "claude")
  const conductorMax: Tier | undefined = claudeUsd !== undefined && claudeUsd <= 40 ? "standard" : undefined
  return {
    routes,
    ...(options.keepParallel ? {} : { limits: { parallel_per_provider: parallel } }),
    ...(conductorMax ? { conductor_max_tier: conductorMax } : {}),
  }
}

/** "Claude $466/mo · ChatGPT $20/mo · Gemini 1000 req/day; frontier work on Claude". */
export function describePlan(plan: Plan): string {
  const usd = (p: "claude" | "openai", label: string) => {
    const v = monthlyUsd(plan, p)
    return v === undefined ? [] : [v ? `${label} $${v}/mo` : `no ${label}`]
  }
  const gemini =
    plan.gemini_requests_per_day === undefined
      ? []
      : [plan.gemini_requests_per_day ? `Gemini ${plan.gemini_requests_per_day} req/day` : "no Gemini"]
  const frontier = frontierProvider(plan)
  const lead = frontier ? `frontier work on ${frontier === "claude" ? "Claude" : "ChatGPT/Codex"}` : "frontier work split as routed"
  return `${[...usd("claude", "Claude"), ...usd("openai", "ChatGPT"), ...gemini].join(" · ")}; ${lead}`
}
