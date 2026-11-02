import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Document, parseDocument } from "yaml"
import { configLayers, mergeLayers, projectConfigPath, userConfigPath, validateConfig } from "../config/load"
import type { RoutingConfig } from "../config/schema"
import type { SettingsScope } from "./protocol"
import { layerRank, prune } from "./settings"

export function layerFile(workspace: string, scope: SettingsScope): string {
  return scope === "user" ? userConfigPath() : projectConfigPath(workspace)
}

/**
 * Edit one config layer (the project's or yours) like the Models dialog does: `edit` gets the YAML
 * document (comments kept) and the config the layers below give, writes only what should differ,
 * and nothing is saved that would leave the merged config invalid.
 */
export function editLayer(
  workspace: string,
  scope: SettingsScope,
  edit: (
    doc: Document,
    inherited: RoutingConfig,
    helpers: { set: (keys: (string | number)[], value: unknown, was: unknown) => void },
  ) => void,
): { path: string } {
  const file = layerFile(workspace, scope)
  const all = [...new Set([...configLayers(workspace), file])].sort((a, b) => layerRank(a, workspace) - layerRank(b, workspace))
  const below = all.slice(0, all.indexOf(file))
  const inherited = validateConfig(mergeLayers(below), below)
  const doc = existsSync(file) ? parseDocument(readFileSync(file, "utf8")) : new Document({})
  if (doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0]?.message}`)
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  const set = (keys: (string | number)[], value: unknown, was: unknown) => {
    if (JSON.stringify(value) !== JSON.stringify(was)) doc.setIn(keys, value)
    else if (doc.hasIn(keys)) doc.deleteIn(keys)
    for (let depth = keys.length - 1; depth > 0; depth--) prune(doc, keys.slice(0, depth))
  }
  edit(doc, inherited, { set })
  validateConfig(mergeLayers(all, { file, raw: doc.toJS() ?? {} }), all)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, String(doc), "utf8")
  renameSync(tmp, file)
  return { path: file }
}
