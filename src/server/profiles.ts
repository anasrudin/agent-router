import { DEFAULT_CONFIG_PATH, loadConfig, mergeLayers, validateConfig } from "../config/load"
import { PROVIDERS, type ProviderId, TIERS, type Tier } from "../config/schema"
import { editLayer } from "./layers"
import type { ProfileRow, SettingsScope } from "./protocol"
import { prune } from "./settings"

export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,30}$/

/** Every profile in effect (all layers merged), the default one, and which ones ship with the harness. */
export function readProfiles(workspace: string): { profiles: ProfileRow[]; defaultProfile?: string; classes: string[] } {
  const { config } = loadConfig(workspace, null)
  // The shipped layer alone, to tell built-in profiles (which can be changed, not deleted) from yours.
  const shipped = new Set(Object.keys(validateConfig(mergeLayers([DEFAULT_CONFIG_PATH]), [DEFAULT_CONFIG_PATH]).profiles))
  const profiles = Object.entries(config.profiles).map(([name, p]): ProfileRow => {
    const routes = p.overlay.routes ?? {}
    return {
      name,
      label: p.label,
      description: p.description,
      tier: p.conductor.tier,
      reasoning: p.conductor.reasoning ?? "",
      guidance: p.guidance,
      routeTiers: Object.fromEntries(Object.entries(routes).flatMap(([c, r]) => (r.tier ? [[c, r.tier]] : []))) as Record<string, Tier>,
      routePrimary: Object.fromEntries(Object.entries(routes).flatMap(([c, r]) => (r.primary ? [[c, r.primary]] : []))) as Record<
        string,
        ProviderId
      >,
      builtIn: shipped.has(name),
    }
  })
  return { profiles, defaultProfile: config.default_profile, classes: Object.keys(config.routes) }
}

/** Write a profile's fields to one layer: only what differs from the layers below; other overlay keys are kept. */
export function saveProfile(workspace: string, scope: SettingsScope, row: ProfileRow): { path: string } {
  if (!PROFILE_NAME.test(row.name)) throw new Error("A profile name is lowercase letters, digits and dashes, starting with a letter.")
  if (!row.label.trim()) throw new Error("A profile needs a label.")
  if (!TIERS.includes(row.tier)) throw new Error(`"${row.tier}" is not a tier`)
  return editLayer(workspace, scope, (_doc, inherited, { set }) => {
    const was = inherited.profiles[row.name]
    const base = ["profiles", row.name]
    set([...base, "label"], row.label.trim(), was?.label)
    set([...base, "description"], row.description.trim(), was?.description)
    set([...base, "conductor", "tier"], row.tier, was?.conductor.tier)
    set([...base, "conductor", "reasoning"], row.reasoning.trim() || undefined, was?.conductor.reasoning)
    set([...base, "guidance"], row.guidance, was?.guidance ?? "")
    const classes = new Set([...Object.keys(row.routeTiers), ...Object.keys(row.routePrimary), ...Object.keys(was?.overlay.routes ?? {})])
    for (const c of classes) {
      if (!inherited.routes[c]) throw new Error(`Unknown task class ${c}`)
      const old = was?.overlay.routes?.[c]
      const tier = row.routeTiers[c]
      if (tier && !TIERS.includes(tier)) throw new Error(`${c}: "${tier}" is not a tier`)
      const floor = inherited.routes[c]?.min_tier as Tier
      if (tier && TIERS.indexOf(tier) < TIERS.indexOf(floor)) throw new Error(`${c}: a profile cannot go below the ${floor} floor`)
      const primary = row.routePrimary[c]
      if (primary && !PROVIDERS.includes(primary)) throw new Error(`${c}: "${primary}" is not a backend`)
      set([...base, "overlay", "routes", c, "tier"], tier, old?.tier)
      set([...base, "overlay", "routes", c, "primary"], primary, old?.primary)
    }
  })
}

/** Remove a profile you added in this layer. Built-in profiles cannot be deleted, only changed. */
export function deleteProfile(workspace: string, scope: SettingsScope, name: string): { path: string } {
  return editLayer(workspace, scope, (doc, inherited) => {
    if (!doc.hasIn(["profiles", name])) throw new Error(`${name} is not defined in this ${scope === "user" ? "user" : "project"} file.`)
    doc.deleteIn(["profiles", name])
    prune(doc, ["profiles"])
    if (inherited.default_profile === name || doc.getIn(["default_profile"]) === name) doc.deleteIn(["default_profile"])
  })
}

export function setDefaultProfile(workspace: string, scope: SettingsScope, name: string): { path: string } {
  return editLayer(workspace, scope, (_doc, inherited, { set }) => {
    const { config } = loadConfig(workspace, null)
    if (!config.profiles[name]) throw new Error(`No profile named ${name}`)
    set(["default_profile"], name, inherited.default_profile)
  })
}
