import { describe, expect, test } from "bun:test"
import type { ProviderId } from "../../config/schema"
import { testConfig } from "../../test-support"
import { HealthTracker } from "../health"
import { decide, type PolicyContext, type RouteDecision, type RouteRequest, RoutingError } from "../policy"

function ctx(opts: { unhealthy?: ProviderId[]; patch?: unknown; spentUsd?: number } = {}): PolicyContext {
  const config = testConfig(opts.patch)
  const health = new HealthTracker(2)
  for (const p of opts.unhealthy ?? []) health.recordError(p, "missing_executable", "not found")
  return { config, health, selfProvider: "claude", spentUsd: opts.spentUsd ?? 0 }
}

interface Case {
  name: string
  rule: string
  req: RouteRequest
  unhealthy?: ProviderId[]
  patch?: unknown
  spentUsd?: number
  expect: Partial<RouteDecision> & { noteIncludes?: string }
}

const cases: Case[] = [
  // Defaults
  {
    name: "search goes to gemini fast",
    rule: "default",
    req: { taskClass: "search.codebase" },
    expect: { provider: "gemini", tier: "fast", agent: "scout" },
  },
  {
    name: "plan goes to claude deep",
    rule: "default",
    req: { taskClass: "plan" },
    expect: { provider: "claude", tier: "deep", model: "opus" },
  },
  { name: "trivial runs on self", rule: "default", req: { taskClass: "trivial" }, expect: { provider: "claude", agent: "conductor" } },
  // Rule 1: override
  {
    name: "override pins provider",
    rule: "override",
    req: { taskClass: "plan", override: "gemini" },
    expect: { provider: "gemini", pinned: true, candidates: ["gemini"] },
  },
  {
    name: "override cannot lower the floor",
    rule: "override+floor",
    req: { taskClass: "debug.hard", override: "openai" },
    expect: { provider: "openai", tier: "deep" },
  },
  // Rule 2: floor
  {
    name: "tier never below min_tier even if config tier is lower",
    rule: "floor",
    req: { taskClass: "plan" },
    patch: { routes: { plan: { tier: "fast", min_tier: "standard" } } },
    expect: { tier: "standard", model: "sonnet" },
  },
  {
    name: "escalation may raise the tier",
    rule: "floor",
    req: { taskClass: "search.codebase", tierAtLeast: "deep" },
    expect: { tier: "deep" },
  },
  // Rule 3: capability
  {
    name: "oversized input skips claude for gemini",
    rule: "capability",
    req: { taskClass: "plan", inputTokens: 500_000 },
    expect: { provider: "gemini", noteIncludes: "exceeds context" },
  },
  {
    name: "video goes to the backend that can read it",
    rule: "capability",
    req: { taskClass: "multimodal", media: ["video"] },
    expect: { provider: "gemini" },
  },
  {
    name: "video with gemini down has no backend",
    rule: "capability+health",
    req: { taskClass: "multimodal", media: ["video"] },
    unhealthy: ["gemini"],
    expect: {},
  },
  // Rule 4: stickiness
  {
    name: "sticky session keeps its provider and resumes",
    rule: "stickiness",
    req: { taskClass: "code.edit", sticky: { provider: "openai", sessionId: "s1" } },
    expect: { provider: "openai", resumeSessionId: "s1" },
  },
  {
    name: "sticky provider unhealthy switches without resuming",
    rule: "stickiness+health",
    req: { taskClass: "code.edit", sticky: { provider: "openai", sessionId: "s1" } },
    unhealthy: ["openai"],
    expect: { provider: "claude", resumeSessionId: undefined },
  },
  // Rule 5: independence
  {
    name: "review avoids the author (claude)",
    rule: "independence",
    req: { taskClass: "code.review", author: "claude" },
    expect: { provider: "openai" },
  },
  {
    name: "review avoids the author (openai)",
    rule: "independence",
    req: { taskClass: "code.review", author: "openai" },
    expect: { provider: "claude" },
  },
  {
    name: "review never falls back to the author",
    rule: "independence+health",
    req: { taskClass: "code.review", author: "claude" },
    unhealthy: ["openai"],
    expect: { provider: "gemini", candidates: ["gemini"] },
  },
  {
    name: "user pin on the author's provider wins, with a concern noted",
    rule: "override+independence",
    req: { taskClass: "code.review", author: "claude", override: "claude" },
    expect: { provider: "claude", noteIncludes: "not independent" },
  },
  {
    name: "author excluded even when it is the strongest reviewer",
    rule: "independence",
    req: { taskClass: "code.review", author: "openai" },
    unhealthy: ["claude", "gemini"],
    expect: {},
  },
  {
    name: "second opinion differs from primary",
    rule: "independence",
    req: { taskClass: "debug.hard" },
    expect: { provider: "claude", secondOpinion: "openai" },
  },
  // Rule 6: health
  {
    name: "unhealthy primary uses fallback",
    rule: "health",
    req: { taskClass: "search.codebase" },
    unhealthy: ["gemini"],
    expect: { provider: "claude", noteIncludes: "fallback" },
  },
  // Rule 7 / escalation config: code.edit raised to deep
  {
    name: "many files raise code.edit to deep",
    rule: "escalation",
    req: { taskClass: "code.edit", filesTouched: 9 },
    expect: { tier: "deep" },
  },
  {
    name: "risky keyword raises code.edit to deep",
    rule: "escalation",
    req: { taskClass: "code.edit", taskText: "fix the auth token refresh" },
    expect: { tier: "deep" },
  },
  {
    name: "failed attempt raises code.edit to deep",
    rule: "escalation",
    req: { taskClass: "code.edit", previousAttemptFailed: true },
    expect: { tier: "deep" },
  },
  {
    name: "plain code.edit stays standard",
    rule: "escalation",
    req: { taskClass: "code.edit", taskText: "rename a variable" },
    expect: { tier: "standard" },
  },
  // Placeholder models
  {
    name: "placeholder model falls back to CLI default",
    rule: "models",
    req: { taskClass: "search.codebase" },
    patch: { backends: { gemini: { tiers: { fast: "<gemini-flash-model>" } } } },
    expect: { model: undefined, noteIncludes: "placeholder" },
  },
  // Privacy: deny_paths per provider
  {
    name: "provider deny_paths skip that provider",
    rule: "privacy",
    req: { taskClass: "search.codebase", files: ["internal/billing/rates.ts"] },
    patch: { privacy: { provider_restrictions: { gemini: { deny_paths: ["internal/billing/**"] } } } },
    expect: { provider: "claude" },
  },
]

describe("decide()", () => {
  for (const c of cases) {
    test(`[${c.rule}] ${c.name}`, () => {
      const context = ctx({ unhealthy: c.unhealthy, patch: c.patch, spentUsd: c.spentUsd })
      if (Object.keys(c.expect).length === 0) {
        expect(() => decide(context, c.req)).toThrow(RoutingError)
        return
      }
      const { noteIncludes, ...fields } = c.expect
      const decision = decide(context, c.req)
      for (const [key, value] of Object.entries(fields)) expect(decision[key as keyof RouteDecision]).toEqual(value as never)
      if (noteIncludes) expect(decision.notes.join(" | ")).toContain(noteIncludes)
    })
  }
})

describe("decide() refusals", () => {
  const refusals: [string, RouteRequest, Parameters<typeof ctx>[0], string][] = [
    ["unknown class", { taskClass: "nope" }, {}, "unknown_class"],
    ["review without author", { taskClass: "code.review" }, {}, "needs_author"],
    ["pinned provider is down", { taskClass: "plan", override: "openai" }, { unhealthy: ["openai"] }, "pinned_unavailable"],
    ["never_send file", { taskClass: "plan", files: ["config/.env.local"] }, {}, "privacy"],
    ["budget spent", { taskClass: "plan" }, { patch: { budget: { session_usd: 1 } }, spentUsd: 1.5 }, "budget"],
    ["everything down", { taskClass: "plan" }, { unhealthy: ["claude", "gemini", "openai"] }, "no_backend"],
  ]
  for (const [name, req, options, kind] of refusals) {
    test(name, () => {
      try {
        decide(ctx(options), req)
        throw new Error("expected RoutingError")
      } catch (error) {
        expect(error).toBeInstanceOf(RoutingError)
        expect((error as RoutingError).kind).toBe(kind as RoutingError["kind"])
      }
    })
  }
})
