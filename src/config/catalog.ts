import { readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { BackendOptions, ModelOption } from "../backends/Backend"
import { ASSETS_ROOT } from "./load"
import { isPlaceholderModel, type ProviderId, Tier } from "./schema"

const CatalogModel = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  /** Efforts this model accepts; the provider's list when absent. */
  efforts: z.array(z.string()).optional(),
  /** The tier this model suits, for suggestions. */
  tier: Tier.optional(),
})

const Catalog = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string(),
  providers: z.record(z.string(), z.object({ efforts: z.array(z.string()), models: z.array(CatalogModel) })),
})
export type Catalog = z.infer<typeof Catalog>

export const CATALOG_PATH = path.join(ASSETS_ROOT, "config", "models.json")

let cached: Catalog | undefined

/** The shipped model catalog (config/models.json). */
export function loadCatalog(file = CATALOG_PATH): Catalog {
  if (file === CATALOG_PATH && cached) return cached
  const catalog = Catalog.parse(JSON.parse(readFileSync(file, "utf8")))
  if (file === CATALOG_PATH) cached = catalog
  return catalog
}

/** The catalog's models for one provider, as model options. */
export function catalogOptions(provider: ProviderId, catalog = loadCatalog()): BackendOptions & { models: ModelOption[] } {
  const entry = catalog.providers[provider] ?? { efforts: [], models: [] }
  return {
    models: entry.models.map((m) => ({
      id: m.id,
      description: m.description ?? m.label,
      reasoning: m.efforts,
      source: "catalog",
      tier: m.tier,
    })),
    reasoningLevels: entry.efforts,
    supportsTrustOverride: provider === "gemini",
  }
}

/**
 * Detected models first (they are what this CLI and account can run), with the catalog's
 * descriptions and tiers filled in. `authoritative`: the detection lists everything the account
 * may use (Codex), so catalog-only models are left out rather than offered and failing later.
 */
export function mergeDetected(
  provider: ProviderId,
  detected: BackendOptions | undefined,
  options: { authoritative: boolean; catalog?: Catalog },
): BackendOptions {
  const fromCatalog = catalogOptions(provider, options.catalog)
  if (!detected?.models.length) return fromCatalog
  const known = new Map(fromCatalog.models.map((m) => [m.id, m]))
  const models: ModelOption[] = detected.models.map((m) => {
    const c = known.get(m.id)
    return { ...m, description: m.description ?? c?.description, reasoning: m.reasoning ?? c?.reasoning, tier: c?.tier, source: "detected" }
  })
  if (!options.authoritative) {
    const seen = new Set(models.map((m) => m.id))
    models.push(...fromCatalog.models.filter((m) => !seen.has(m.id)))
  }
  return {
    models,
    reasoningLevels: detected.reasoningLevels.length ? detected.reasoningLevels : fromCatalog.reasoningLevels,
    supportsTrustOverride: detected.supportsTrustOverride,
  }
}

const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200"

/**
 * Gemini CLI has no model-list command, but with an API key in the environment the API lists the
 * models this key may call. The key goes to Google, which is who it belongs to, in a header.
 */
export async function detectGeminiModels(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<BackendOptions | undefined> {
  const key = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY
  if (!key) return undefined
  try {
    const res = await fetcher(GEMINI_MODELS_URL, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return undefined
    const doc = (await res.json()) as { models?: { name?: string; description?: string; supportedGenerationMethods?: string[] }[] }
    const models: ModelOption[] = (doc.models ?? [])
      .filter((m) => m.name?.startsWith("models/gemini-") && m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => ({ id: (m.name as string).slice("models/".length), description: m.description?.split(". ")[0] }))
    return models.length ? { models, reasoningLevels: [], supportsTrustOverride: true } : undefined
  } catch {
    return undefined
  }
}

export interface TierCheck {
  tier: Tier
  model: string
  problem: string
  /** A model from the list that suits this tier, when there is one. */
  suggestion?: string
}

/** Configured tier models and efforts that the known models say will not work. */
export function checkTiers(
  tiers: Record<Tier, string>,
  reasoning: Partial<Record<Tier, string>>,
  options: BackendOptions,
  authoritative: boolean,
): TierCheck[] {
  const problems: TierCheck[] = []
  for (const tier of Tier.options) {
    const model = tiers[tier]
    const suggestion = options.models.find((m) => m.tier === tier)?.id ?? options.models[0]?.id
    if (isPlaceholderModel(model)) {
      problems.push({ tier, model, problem: "not set; the CLI default model runs", suggestion })
      continue
    }
    const known = options.models.find((m) => m.id === model)
    if (!known) {
      // Without authoritative detection an unknown id may still be valid (a new model, a full id).
      if (authoritative) problems.push({ tier, model, problem: "not offered on this account", suggestion })
      continue
    }
    const effort = reasoning[tier]
    const efforts = known.reasoning ?? options.reasoningLevels
    if (effort && efforts.length && !efforts.includes(effort)) {
      problems.push({ tier, model, problem: `reasoning "${effort}" is not one of ${efforts.join(", ")}` })
    }
  }
  return problems
}
