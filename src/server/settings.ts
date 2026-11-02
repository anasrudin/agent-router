import type { BackendOptions } from "../backends/Backend"
import { createBackends } from "../backends/registry"
import { loadConfig, projectConfigPath, userConfigPath } from "../config/load"
import { PROVIDERS, type ProviderId, type RoutingConfig, TIERS, type Tier } from "../config/schema"
import { editLayer } from "./layers"
import type { DiffLine, ModelTest, SettingsScope, SettingsSnapshot, SettingsValues } from "./protocol"

export { layerRank, prune } from "./layers"
export type { SettingsScope, SettingsValues } from "./protocol"

function toSettings(config: RoutingConfig): SettingsValues {
  return Object.fromEntries(
    PROVIDERS.map((p) => {
      const b = config.backends[p]
      return [
        p,
        {
          tiers: { ...b.tiers },
          reasoning: Object.fromEntries(TIERS.map((t) => [t, b.reasoning[t] ?? ""])) as Record<Tier, string>,
          trustWorkspace: b.trust_workspace,
        },
      ]
    }),
  ) as SettingsValues
}

export function readSettings(workspace: string): SettingsSnapshot {
  const { config, sources } = loadConfig(workspace, null)
  return { workspace, values: toSettings(config), sources, paths: { user: userConfigPath(), project: projectConfigPath(workspace) } }
}

const MODEL_ID = /^[A-Za-z0-9][\w.:/@-]*$/

function checkValues(values: SettingsValues): void {
  for (const p of PROVIDERS) {
    for (const t of TIERS) {
      const model = values[p].tiers[t].trim()
      if (!MODEL_ID.test(model)) throw new Error(`${p} ${t}: "${model}" is not a model id`)
      const effort = values[p].reasoning[t].trim()
      if (effort && !/^[a-z]+$/.test(effort)) throw new Error(`${p} ${t}: "${effort}" is not a reasoning level`)
    }
  }
}

/** Remove maps an edit left empty, so an override file never carries `tiers: {}` noise. */

export interface SaveResult {
  path: string
  /** Settings that a higher-priority file overrides, so the saved value does not take effect. */
  shadowed: string[]
  snapshot: SettingsSnapshot
  diff: DiffLine[]
}

/**
 * Write the model settings to one config layer. Only values that differ from the layers below
 * are written, so the file keeps inheriting everything else; comments in the file survive.
 * With `preview`, nothing is written: the result's diff says what would change.
 */
export function saveSettings(
  workspace: string,
  scope: SettingsScope,
  values: SettingsValues,
  opts: { preview?: boolean } = {},
): SaveResult {
  checkValues(values)
  const { path: file, diff } = editLayer(
    workspace,
    scope,
    (_doc, inheritedConfig, { set }) => {
      const inherited = toSettings(inheritedConfig)
      for (const p of PROVIDERS) {
        for (const t of TIERS) {
          set(["backends", p, "tiers", t], values[p].tiers[t].trim(), inherited[p].tiers[t])
          set(["backends", p, "reasoning", t], values[p].reasoning[t].trim(), inherited[p].reasoning[t])
        }
        set(["backends", p, "trust_workspace"], values[p].trustWorkspace, inherited[p].trustWorkspace)
      }
    },
    { preview: opts.preview, what: "Models" },
  )
  const snapshot = readSettings(workspace)
  const shadowed: string[] = []
  if (!opts.preview)
    for (const p of PROVIDERS) {
      for (const t of TIERS) {
        if (snapshot.values[p].tiers[t] !== values[p].tiers[t].trim()) shadowed.push(`${p} ${t} model`)
        if (snapshot.values[p].reasoning[t] !== values[p].reasoning[t].trim()) shadowed.push(`${p} ${t} reasoning`)
      }
      if (snapshot.values[p].trustWorkspace !== values[p].trustWorkspace) shadowed.push(`${p} trust`)
    }
  return { path: file, shadowed, snapshot, diff }
}

const optionsCache = new Map<string, Promise<BackendOptions>>()

/** Model and effort choices per backend. Cached per executable: listing models can spawn the CLI. */
export function backendOptions(workspace: string): Promise<Record<ProviderId, BackendOptions>> {
  const { config } = loadConfig(workspace, null)
  const backends = createBackends(config)
  return Promise.all(
    PROVIDERS.map(async (p) => {
      const key = `${p}:${config.backends[p].executable}`
      if (!optionsCache.has(key)) optionsCache.set(key, backends[p].options())
      return [p, await (optionsCache.get(key) as Promise<BackendOptions>)] as const
    }),
  ).then((entries) => Object.fromEntries(entries) as Record<ProviderId, BackendOptions>)
}

/** One tiny real call, so a model id is proven to work on this account before anyone relies on it. */
export async function testModel(
  workspace: string,
  provider: ProviderId,
  model: string,
  reasoning: string,
  trustWorkspace: boolean,
): Promise<ModelTest> {
  const { config } = loadConfig(workspace, null)
  config.backends[provider].trust_workspace = trustWorkspace
  const backend = createBackends(config)[provider]
  const started = Date.now()
  let ok = false
  let detail = "no response"
  for await (const event of backend.run({
    prompt: "Reply with exactly: ok",
    model: model.trim(),
    reasoning: reasoning.trim() || undefined,
    cwd: workspace,
    mode: "read-only",
    permission: "default",
    timeoutMs: 120_000,
  })) {
    if (event.type === "done") {
      ok = true
      detail = `replied "${event.text.trim().slice(0, 60)}"`
    } else if (event.type === "error") {
      detail = `${event.error.kind}: ${event.error.message.slice(0, 400)}`
    }
  }
  return { ok, detail, ms: Date.now() - started }
}
