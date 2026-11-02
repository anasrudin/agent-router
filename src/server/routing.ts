import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Document, parseDocument } from "yaml"
import { createBackends } from "../backends/registry"
import { configLayers, loadConfig, mergeLayers, projectConfigPath, userConfigPath, validateConfig } from "../config/load"
import { PROVIDERS, TIERS, type Tier } from "../config/schema"
import { Session } from "../coordinator/session"
import { guessTaskClass } from "../router/classify"
import { decide, explainDecision } from "../router/policy"
import type { RouteEdit, RouteRow, RouteTest, SettingsScope } from "./protocol"
import { layerRank, prune } from "./settings"

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
export function saveRouting(workspace: string, scope: SettingsScope, edits: RouteEdit[]): { path: string } {
  const file = scope === "user" ? userConfigPath() : projectConfigPath(workspace)
  const all = [...new Set([...configLayers(workspace), file])].sort((a, b) => layerRank(a, workspace) - layerRank(b, workspace))
  const below = all.slice(0, all.indexOf(file))
  const inherited = validateConfig(mergeLayers(below), below).routes
  const doc = existsSync(file) ? parseDocument(readFileSync(file, "utf8")) : new Document({})
  if (doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0]?.message}`)
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  for (const e of edits) {
    const base = inherited[e.taskClass]
    if (!base) throw new Error(`Unknown task class ${e.taskClass}`)
    checkEdit(e, base.min_tier)
    const keys = ["routes", e.taskClass]
    const set = (k: string, value: unknown, was: unknown) => {
      if (JSON.stringify(value) !== JSON.stringify(was)) doc.setIn([...keys, k], value)
      else if (doc.hasIn([...keys, k])) doc.deleteIn([...keys, k])
    }
    set("primary", e.primary, base.primary)
    set(
      "fallback",
      e.fallback.filter((f) => f !== e.primary),
      base.fallback,
    )
    set("tier", e.tier, base.tier)
    prune(doc, keys)
  }
  prune(doc, ["routes"])
  validateConfig(mergeLayers(all, { file, raw: doc.toJS() ?? {} }), all)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, String(doc), "utf8")
  renameSync(tmp, file)
  return { path: file }
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
    return { taskClass: cls, error: e instanceof Error ? e.message : String(e), why: [] }
  }
}
