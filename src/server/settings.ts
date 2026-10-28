import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Document, isMap, parseDocument } from "yaml"
import type { BackendOptions } from "../backends/Backend"
import { createBackends } from "../backends/registry"
import { configLayers, loadConfig, mergeLayers, projectConfigPath, userConfigPath, validateConfig } from "../config/load"
import { PROVIDERS, type ProviderId, type RoutingConfig, TIERS, type Tier } from "../config/schema"
import type { ModelTest, SettingsScope, SettingsSnapshot, SettingsValues } from "./protocol"

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
function prune(doc: Document, keys: (string | number)[]): void {
  for (let depth = keys.length; depth > 0; depth--) {
    const node = doc.getIn(keys.slice(0, depth))
    if (isMap(node) && node.items.length === 0) doc.deleteIn(keys.slice(0, depth))
  }
}

export interface SaveResult {
  path: string
  /** Settings that a higher-priority file overrides, so the saved value does not take effect. */
  shadowed: string[]
  snapshot: SettingsSnapshot
}

/**
 * Write the model settings to one config layer. Only values that differ from the layers below
 * are written, so the file keeps inheriting everything else; comments in the file survive.
 */
export function saveSettings(workspace: string, scope: SettingsScope, values: SettingsValues): SaveResult {
  checkValues(values)
  const file = scope === "user" ? userConfigPath() : projectConfigPath(workspace)
  const all = [...new Set([...configLayers(workspace), file])].sort((a, b) => layerRank(a, workspace) - layerRank(b, workspace))
  const below = all.slice(0, all.indexOf(file))
  const inherited = toSettings(validateConfig(mergeLayers(below), below))

  const doc = existsSync(file) ? parseDocument(readFileSync(file, "utf8")) : new Document({})
  if (doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0]?.message}`)
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  const setOrInherit = (keys: string[], value: unknown, inheritedValue: unknown) => {
    if (value !== inheritedValue) doc.setIn(keys, value)
    else if (doc.hasIn(keys)) doc.deleteIn(keys)
  }
  for (const p of PROVIDERS) {
    for (const t of TIERS) {
      setOrInherit(["backends", p, "tiers", t], values[p].tiers[t].trim(), inherited[p].tiers[t])
      setOrInherit(["backends", p, "reasoning", t], values[p].reasoning[t].trim(), inherited[p].reasoning[t])
    }
    setOrInherit(["backends", p, "trust_workspace"], values[p].trustWorkspace, inherited[p].trustWorkspace)
    prune(doc, ["backends", p, "tiers"])
    prune(doc, ["backends", p, "reasoning"])
  }
  prune(doc, ["backends"])

  // Refuse to write anything that would leave the merged config invalid.
  validateConfig(mergeLayers(all, { file, raw: doc.toJS() ?? {} }), all)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, String(doc), "utf8")
  renameSync(tmp, file)

  const snapshot = readSettings(workspace)
  const shadowed: string[] = []
  for (const p of PROVIDERS) {
    for (const t of TIERS) {
      if (snapshot.values[p].tiers[t] !== values[p].tiers[t].trim()) shadowed.push(`${p} ${t} model`)
      if (snapshot.values[p].reasoning[t] !== values[p].reasoning[t].trim()) shadowed.push(`${p} ${t} reasoning`)
    }
    if (snapshot.values[p].trustWorkspace !== values[p].trustWorkspace) shadowed.push(`${p} trust`)
  }
  return { path: file, shadowed, snapshot }
}

function layerRank(file: string, workspace: string): number {
  if (file === projectConfigPath(workspace)) return 2
  if (file === userConfigPath()) return 1
  return 0
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
