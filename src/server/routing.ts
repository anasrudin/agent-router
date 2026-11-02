import { createBackends } from "../backends/registry"
import { loadConfig, projectConfigPath, userConfigPath } from "../config/load"
import { PROVIDERS, type ProviderId, TIERS, type Tier } from "../config/schema"
import { Session } from "../coordinator/session"
import { guessTaskClass } from "../router/classify"
import { decide, explainDecision } from "../router/policy"
import { editLayer, type LayerResult } from "./layers"
import type { RouteEdit, RouteRow, RouteTest, SettingsScope } from "./protocol"

const PROVIDER_NAME: Record<ProviderId, string> = { claude: "Claude", gemini: "Gemini", openai: "Codex" }

/** The routes in effect (all layers merged), one row per task class, in the config's order. */
export function readRouting(workspace: string): { routes: RouteRow[]; profiles: string[]; paths: Record<SettingsScope, string> } {
  const { config } = loadConfig(workspace, null)
  return {
    routes: Object.entries(config.routes).map(([taskClass, r]) => ({
      taskClass,
      agent: r.agent,
      primary: r.primary,
      fallback: [...r.fallback],
      tier: r.tier,
      minTier: r.min_tier,
    })),
    profiles: Object.keys(config.profiles),
    paths: { user: userConfigPath(), project: projectConfigPath(workspace) },
  }
}

function checkEdit(e: RouteEdit, minTier: Tier): void {
  const primaries: string[] = [...PROVIDERS, "self", "auto_not_author"]
  if (!primaries.includes(e.primary)) throw new Error(`${e.taskClass}: "${e.primary}" is not a backend`)
  for (const f of e.fallback) if (!PROVIDERS.includes(f)) throw new Error(`${e.taskClass}: "${f}" is not a backend`)
  if (!TIERS.includes(e.tier)) throw new Error(`${e.taskClass}: "${e.tier}" is not a tier`)
  if (TIERS.indexOf(e.tier) < TIERS.indexOf(minTier))
    throw new Error(`${e.taskClass}: its tier cannot go below ${minTier} (the quality floor)`)
}

/**
 * Write route edits to one layer: only what differs from the layers below, comments kept, and
 * nothing that would leave the merged config invalid (the same rules as the Models dialog).
 */
export function saveRouting(workspace: string, scope: SettingsScope, edits: RouteEdit[], opts: { preview?: boolean } = {}): LayerResult {
  return editLayer(
    workspace,
    scope,
    (_doc, config, { set }) => {
      for (const e of edits) {
        const base = config.routes[e.taskClass]
        if (!base) throw new Error(`Unknown task class ${e.taskClass}`)
        checkEdit(e, base.min_tier)
        const keys = ["routes", e.taskClass]
        set([...keys, "primary"], e.primary, base.primary)
        set(
          [...keys, "fallback"],
          e.fallback.filter((f) => f !== e.primary),
          base.fallback,
        )
        set([...keys, "tier"], e.tier, base.tier)
      }
    },
    { preview: opts.preview, what: `Routing: ${edits.length} task${edits.length === 1 ? "" : "s"}` },
  )
}

/** A dry run: where a request would go now (health and profile included), and why. */
export async function testRoute(workspace: string, text: string, taskClass?: string, profile?: string): Promise<RouteTest> {
  const { config } = loadConfig(workspace, profile ?? null)
  const session = new Session({ workspace, config, backends: createBackends(config), selfProvider: "claude", permission: "default" })
  await session.detectBackends()
  const cls = taskClass || guessTaskClass(text)
  try {
    const d = decide(session, { taskClass: cls, taskText: text })
    return { taskClass: cls, provider: d.provider, tier: d.tier, model: d.model, agent: d.agent, why: explainDecision(config, d, profile) }
  } catch (e) {
    // Say what the router saw, so a refusal is explained like a choice is.
    const health = session.health.snapshot()
    const why = PROVIDERS.filter((p) => !health[p]?.installed).map(
      (p) => `${PROVIDER_NAME[p]} is not available: ${health[p]?.reason ?? "not found"}.`,
    )
    return { taskClass: cls, error: e instanceof Error ? e.message : String(e), why }
  }
}
