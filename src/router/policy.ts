import { excludedByPlan } from "../config/plans"
import { isPlaceholderModel, type MediaKind, maxTier, PROVIDERS, type ProviderId, type RoutingConfig, type Tier } from "../config/schema"
import type { HealthTracker } from "./health"

export interface RouteRequest {
  taskClass: string
  /** Rule 1: `@claude`, `/route`, or a project rule pins the provider. */
  override?: ProviderId
  /** Rule 5: who wrote the work under review. Required for `auto_not_author` routes. */
  author?: ProviderId
  /** Rule 4: continue an existing delegate session on the same backend. */
  sticky?: { provider: ProviderId; sessionId: string }
  /** Rule 3: rough size of what the delegate must read. */
  inputTokens?: number
  media?: MediaKind[]
  /** Workspace-relative paths the brief will expose to the delegate. */
  files?: string[]
  filesTouched?: number
  taskText?: string
  previousAttemptFailed?: boolean
  /** Providers already tried and given up on for this subtask. */
  exclude?: ProviderId[]
  /** Escalation may raise the tier; nothing may lower it. */
  tierAtLeast?: Tier
}

export interface RouteDecision {
  taskClass: string
  agent: string
  provider: ProviderId
  tier: Tier
  /** Undefined when the config still holds a placeholder: the CLI default model runs. */
  model?: string
  /** Every provider that could serve this request, in preference order. `provider` is first. */
  candidates: ProviderId[]
  /** True when the user pinned the provider; escalation must not switch away from it. */
  pinned: boolean
  resumeSessionId?: string
  secondOpinion?: ProviderId
  reviewRequired: boolean
  notes: string[]
}

export type RoutingErrorKind = "unknown_class" | "no_backend" | "pinned_unavailable" | "privacy" | "budget" | "needs_author"

export class RoutingError extends Error {
  constructor(
    readonly kind: RoutingErrorKind,
    message: string,
  ) {
    super(message)
    this.name = "RoutingError"
  }
}

export interface PolicyContext {
  config: RoutingConfig
  health: HealthTracker
  selfProvider: ProviderId
  spentUsd: number
}

/** Preference order when a reviewer must differ from the author: strongest reviewers first. */
function reviewOrder(config: RoutingConfig): ProviderId[] {
  return [...PROVIDERS].sort(
    (a, b) => Number(config.backends[b].strengths.includes("code.review")) - Number(config.backends[a].strengths.includes("code.review")),
  )
}

export function matchesAny(file: string, patterns: string[]): string | undefined {
  const normalised = file.replaceAll("\\", "/")
  return patterns.find((pattern) => new Bun.Glob(pattern).match(normalised))
}

/** Why `provider` cannot serve this request, or undefined if it can. */
function unfitReason(ctx: PolicyContext, provider: ProviderId, req: RouteRequest): string | undefined {
  const backend = ctx.config.backends[provider]
  if (!ctx.health.isHealthy(provider)) {
    return `unhealthy (${ctx.health.snapshot()[provider].reason ?? "errors"})`
  }
  if (req.exclude?.includes(provider)) return "already tried for this subtask"
  if (excludedByPlan(ctx.config.active_plan, provider)) return "not in your plan (no subscription)"
  const denied = ctx.config.privacy.provider_restrictions[provider]?.deny_paths ?? []
  for (const file of req.files ?? []) {
    const hit = matchesAny(file, denied)
    if (hit) return `privacy: ${file} matches deny_paths ${hit}`
  }
  if (req.inputTokens !== undefined && req.inputTokens > backend.max_context_tokens) {
    return `input ~${req.inputTokens} tokens exceeds context ${backend.max_context_tokens}`
  }
  const unreadable = (req.media ?? []).filter((m) => !backend.multimodal.includes(m))
  if (unreadable.length) return `cannot read ${unreadable.join(", ")}`
  return undefined
}

function shouldEscalateToDeep(config: RoutingConfig, req: RouteRequest): string | undefined {
  const when = config.escalation.to_deep_when
  if (req.filesTouched !== undefined && req.filesTouched > when.files_touched_gt) {
    return `touches ${req.filesTouched} files (> ${when.files_touched_gt})`
  }
  if (when.previous_attempt_failed && req.previousAttemptFailed) return "previous attempt failed"
  const text = req.taskText?.toLowerCase() ?? ""
  const word = when.task_mentions.find((w) => new RegExp(`\\b${w.toLowerCase()}\\b`).test(text))
  return word ? `task mentions "${word}"` : undefined
}

/** Apply conductor.md §4 routing rules, in priority order, to one request. */
export function decide(ctx: PolicyContext, req: RouteRequest): RouteDecision {
  const route = ctx.config.routes[req.taskClass]
  if (!route) {
    throw new RoutingError("unknown_class", `Unknown task class "${req.taskClass}". Known: ${Object.keys(ctx.config.routes).join(", ")}`)
  }
  const notes: string[] = []

  for (const file of req.files ?? []) {
    const hit = matchesAny(file, ctx.config.privacy.never_send)
    if (hit) throw new RoutingError("privacy", `${file} matches privacy.never_send pattern ${hit}; it may not leave the machine`)
  }

  const cap = ctx.config.budget.session_usd
  if (cap !== null && ctx.spentUsd >= cap) {
    throw new RoutingError(
      "budget",
      `Session budget $${cap} is spent ($${ctx.spentUsd.toFixed(2)}). The quality floor cannot be met within budget; ask the user.`,
    )
  }

  // Build the ordered candidate list. The first rule that applies decides the order.
  let preferred: ProviderId[]
  let pinned = false
  if (req.override) {
    preferred = [req.override]
    pinned = true
    notes.push(`user override: ${req.override}`)
  } else if (route.primary === "auto_not_author") {
    if (!req.author) throw new RoutingError("needs_author", `${req.taskClass} must run on a provider other than the author; pass author`)
    preferred = reviewOrder(ctx.config).filter((p) => p !== req.author)
  } else {
    const primary = route.primary === "self" ? ctx.selfProvider : route.primary
    preferred = [primary, ...route.fallback.filter((p) => p !== primary)]
    if (req.sticky && preferred.includes(req.sticky.provider)) {
      preferred = [req.sticky.provider, ...preferred.filter((p) => p !== req.sticky?.provider)]
    }
  }
  // Rule 1 outranks rule 5: a user who pins the author's own provider gets it, with the concern on record.
  if (pinned && req.author === req.override && route.primary === "auto_not_author") {
    notes.push(`concern: ${req.override} is also the author, so this review is not independent`)
  }

  const candidates: ProviderId[] = []
  for (const p of preferred) {
    const reason = unfitReason(ctx, p, req)
    if (reason) notes.push(`skip ${p}: ${reason}`)
    else candidates.push(p)
  }
  // Rule 3: if every listed backend lacks the capability, any healthy backend that has it may do the reading.
  if (candidates.length === 0 && !pinned && route.primary !== "auto_not_author") {
    for (const p of PROVIDERS) {
      if (preferred.includes(p) || p === req.author) continue
      if (!unfitReason(ctx, p, req)) {
        candidates.push(p)
        notes.push(`capability fit: using ${p}, outside this class's listed backends`)
      }
    }
  }
  const provider = candidates[0]
  if (!provider) {
    if (pinned) {
      throw new RoutingError("pinned_unavailable", `Pinned provider ${req.override} cannot run this: ${notes.join("; ")}`)
    }
    throw new RoutingError("no_backend", `No backend can run ${req.taskClass}: ${notes.join("; ")}`)
  }
  if (route.primary !== "auto_not_author" && !pinned && provider !== preferred[0]) {
    notes.push(`fallback: ${provider} instead of ${preferred[0]}`)
  }

  // Rule 2: the floor is absolute. Escalation can only raise the tier.
  const deepReason = ctx.config.escalation.to_deep_when.classes.includes(req.taskClass) ? shouldEscalateToDeep(ctx.config, req) : undefined
  if (deepReason) notes.push(`tier raised to deep: ${deepReason}`)
  const tier = maxTier(route.tier, route.min_tier, req.tierAtLeast ?? "fast", deepReason ? "deep" : "fast")

  const rawModel = ctx.config.backends[provider].tiers[tier]
  const model = isPlaceholderModel(rawModel) ? undefined : rawModel
  if (!model) notes.push(`${provider}.tiers.${tier} is a placeholder; the CLI default model runs`)

  const secondOpinion =
    route.second_opinion && route.second_opinion !== provider && ctx.health.isHealthy(route.second_opinion)
      ? route.second_opinion
      : route.second_opinion
        ? PROVIDERS.find((p) => p !== provider && ctx.health.isHealthy(p))
        : undefined

  return {
    taskClass: req.taskClass,
    agent: route.agent,
    provider,
    tier,
    model,
    candidates,
    pinned,
    resumeSessionId: req.sticky?.provider === provider ? req.sticky.sessionId : undefined,
    secondOpinion,
    // "when_escalated": the risk signals that raised the tier are the ones that justify paying for a review.
    reviewRequired: route.review === true || (route.review === "when_escalated" && deepReason !== undefined),
    notes,
  }
}
