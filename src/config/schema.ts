import { z } from "zod"

export const PROVIDERS = ["claude", "gemini", "openai"] as const
export const ProviderId = z.enum(PROVIDERS)
export type ProviderId = z.infer<typeof ProviderId>

export const TIERS = ["fast", "standard", "deep"] as const
export const Tier = z.enum(TIERS)
export type Tier = z.infer<typeof Tier>

export const MediaKind = z.enum(["image", "pdf", "audio", "video"])
export type MediaKind = z.infer<typeof MediaKind>

export const BackendConfig = z.object({
  executable: z.string().min(1),
  tiers: z.object({ fast: z.string(), standard: z.string(), deep: z.string() }),
  strengths: z.array(z.string()).default([]),
  max_context_tokens: z.number().int().positive(),
  multimodal: z.array(MediaKind).default([]),
  /** Reasoning effort per tier, for CLIs that take one (claude --effort, codex model_reasoning_effort). */
  reasoning: z.object({ fast: z.string().optional(), standard: z.string().optional(), deep: z.string().optional() }).default({}),
  /** Let the CLI run in workspaces it has not been told to trust (Gemini only). */
  trust_workspace: z.boolean().default(false),
  /**
   * Claude only: load just the built-in tools the harness uses (`--tools`). Claude Code's other
   * tool definitions cost about 14k prompt tokens on every request (measured on 2.1.312).
   */
  lean_tools: z.boolean().default(true),
  extra_args: z.array(z.string()).default([]),
})
export type BackendConfig = z.infer<typeof BackendConfig>

export const RouteConfig = z.object({
  agent: z.string(),
  primary: z.union([ProviderId, z.literal("self"), z.literal("auto_not_author")]),
  tier: Tier,
  min_tier: Tier,
  fallback: z.array(ProviderId).default([]),
  /** true: always ask for an independent review; "when_escalated": only when the work was raised to deep tier. */
  review: z.union([z.boolean(), z.literal("when_escalated")]).default(false),
  second_opinion: ProviderId.optional(),
})
export type RouteConfig = z.infer<typeof RouteConfig>

const Reasoning = z.object({ fast: z.string().optional(), standard: z.string().optional(), deep: z.string().optional() })

/**
 * What a profile may change. Deliberately excludes `min_tier`, privacy and budget: a profile
 * trades cost for depth above the quality floor, never below it.
 */
export const ProfileOverlay = z
  .object({
    routes: z
      .record(
        z.string(),
        z
          .object({
            /** Which backend leads. Changes who does the work, never the quality floor (`min_tier`). */
            primary: ProviderId.optional(),
            tier: Tier.optional(),
            fallback: z.array(ProviderId).optional(),
            review: z.union([z.boolean(), z.literal("when_escalated")]).optional(),
            second_opinion: ProviderId.nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    backends: z.partialRecord(ProviderId, z.object({ reasoning: Reasoning.optional() }).strict()).optional(),
    escalation: z
      .object({
        to_deep_when: z
          .object({
            files_touched_gt: z.number().int().nonnegative().optional(),
            task_mentions: z.array(z.string()).optional(),
            classes: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        max_attempts_per_subtask: z.number().int().min(2).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const Profile = z.object({
  label: z.string(),
  description: z.string(),
  /** The tier and effort Conductor itself runs at, on its own backend. */
  conductor: z.object({
    tier: Tier,
    reasoning: z.string().optional(),
    /** Conductor's built-in Claude Code tools when `lean_tools` is on; leave out Edit and Write to make it delegate every change. */
    tools: z.array(z.string()).optional(),
  }),
  /** Extra operating rules appended to Conductor's prompt ({{CONDITIONAL_RULES}}). */
  guidance: z.string().default(""),
  overlay: ProfileOverlay.default({}),
})
export type Profile = z.infer<typeof Profile>

export const PlanSchema = z
  .object({
    claude: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(3.5), z.literal(4)]).optional(),
    openai: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(3.5), z.literal(4)]).optional(),
    gemini_requests_per_day: z.number().int().nonnegative().optional(),
  })
  .strict()

export const RoutingConfig = z.object({
  backends: z.object({ claude: BackendConfig, gemini: BackendConfig, openai: BackendConfig }),
  routes: z.record(z.string(), RouteConfig),
  escalation: z
    .object({
      to_deep_when: z
        .object({
          files_touched_gt: z.number().int().nonnegative().default(5),
          previous_attempt_failed: z.boolean().default(true),
          task_mentions: z.array(z.string()).default([]),
          /** Task classes these triggers can raise to deep tier. */
          classes: z.array(z.string()).default(["code.edit"]),
        })
        .default({ files_touched_gt: 5, previous_attempt_failed: true, task_mentions: [], classes: ["code.edit"] }),
      max_attempts_per_subtask: z.number().int().positive().default(4),
    })
    .default({
      to_deep_when: { files_touched_gt: 5, previous_attempt_failed: true, task_mentions: [], classes: ["code.edit"] },
      max_attempts_per_subtask: 4,
    }),
  limits: z
    .object({
      max_parallel_agents: z.number().int().positive().default(3),
      max_parallel_per_provider: z.number().int().positive().default(2),
      /** Per-backend override of max_parallel_per_provider (set from your plan). */
      parallel_per_provider: z.partialRecord(ProviderId, z.number().int().positive()).default({}),
      parallel_writers_need_worktree: z.boolean().default(true),
      delegate_timeout_seconds: z.number().int().positive().default(900),
      delegate_stall_seconds: z.number().int().positive().default(300),
      max_identical_tool_calls: z.number().int().min(2).default(12),
      backend_unhealthy_after_errors: z.number().int().positive().default(2),
    })
    .default({
      max_parallel_agents: 3,
      max_parallel_per_provider: 2,
      parallel_per_provider: {},
      parallel_writers_need_worktree: true,
      delegate_timeout_seconds: 900,
      delegate_stall_seconds: 300,
      max_identical_tool_calls: 12,
      backend_unhealthy_after_errors: 2,
    }),
  budget: z
    .object({
      session_usd: z.number().positive().nullable().default(null),
      warn_at_fraction: z.number().min(0).max(1).default(0.8),
    })
    .default({ session_usd: null, warn_at_fraction: 0.8 }),
  privacy: z
    .object({
      never_send: z.array(z.string()).default([]),
      provider_restrictions: z.record(z.string(), z.object({ deny_paths: z.array(z.string()).default([]) })).default({}),
    })
    .default({ never_send: [], provider_restrictions: {} }),
  /** Project checks run after every edit-mode delegation, where the permission mode allows commands. */
  checks: z
    .object({
      commands: z.array(z.string().min(1)).default([]),
      timeout_seconds: z.number().int().positive().default(600),
    })
    .default({ commands: [], timeout_seconds: 600 }),
  /** Code navigation for delegates through language servers (agent-router lsp-mcp). */
  lsp: z
    .object({
      enabled: z.boolean().default(true),
      /** Added to the built-in list; an entry with a built-in's name replaces it. */
      servers: z
        .array(
          z.object({
            name: z.string().min(1),
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
            extensions: z.array(z.string().regex(/^\./)).min(1),
          }),
        )
        .default([]),
    })
    .default({ enabled: true, servers: [] }),
  /** Your subscriptions: a preset name (claude-heavy, chatgpt-heavy, split) or tiers per provider. */
  plan: z.union([z.string(), PlanSchema]).optional(),
  /** Set from the plan when the config is loaded: Conductor's highest tier. */
  conductor_max_tier: Tier.optional(),
  /** Set from the plan when the config is loaded; not written in files. */
  active_plan: PlanSchema.optional(),
  profiles: z.record(z.string(), Profile).default({}),
  default_profile: z.string().optional(),
  /** Set from the chosen profile when the config is loaded; not written in files. */
  active_profile: z.string().optional(),
})
export type RoutingConfig = z.infer<typeof RoutingConfig>

const TIER_RANK: Record<Tier, number> = { fast: 0, standard: 1, deep: 2 }

export function maxTier(...tiers: Tier[]): Tier {
  return tiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a))
}

export function tierAbove(tier: Tier): Tier | undefined {
  return TIERS[TIER_RANK[tier] + 1]
}

/** "<gemini-pro-model>" style values mean "not filled in yet": the CLI default applies. */
export function isPlaceholderModel(model: string): boolean {
  return /^<.*>$/.test(model.trim()) || model.trim() === ""
}
