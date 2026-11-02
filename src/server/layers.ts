import { existsSync, readFileSync } from "node:fs"
import { Document, isMap, parseDocument } from "yaml"
import { configLayers, mergeLayers, projectConfigPath, userConfigPath, validateConfig } from "../config/load"
import type { RoutingConfig } from "../config/schema"
import { writeConfig } from "./confighistory"
import { lineDiff } from "./linediff"
import type { DiffLine, SettingsScope } from "./protocol"

export function layerFile(workspace: string, scope: SettingsScope): string {
  return scope === "user" ? userConfigPath() : projectConfigPath(workspace)
}

/** Shipped defaults first, then yours, then the project's. */
export function layerRank(file: string, workspace: string): number {
  if (file === projectConfigPath(workspace)) return 2
  if (file === userConfigPath()) return 1
  return 0
}

/** Remove maps left empty along `keys`, deepest first, so a file never keeps `routes: {}`. */
export function prune(doc: Document, keys: (string | number)[]): void {
  for (let depth = keys.length; depth > 0; depth--) {
    const node = doc.getIn(keys.slice(0, depth))
    if (isMap(node) && node.items.length === 0) doc.deleteIn(keys.slice(0, depth))
  }
}

export interface LayerWrite {
  /** Compute the change and its diff, write nothing. */
  preview?: boolean
  /** What the change was, for the history (e.g. "Advanced: 2 settings"). */
  what?: string
}

export interface LayerResult {
  path: string
  /** The change to the file, line by line (always set; empty when nothing changes). */
  diff: DiffLine[]
}

/**
 * Edit one config layer (the project's or yours): `edit` gets the YAML document (comments kept)
 * and the config the layers below give, and writes only what should differ. Nothing is saved that
 * would leave the merged config invalid, and every write goes into the config history.
 */
export function editLayer(
  workspace: string,
  scope: SettingsScope,
  edit: (
    doc: Document,
    inherited: RoutingConfig,
    helpers: { set: (keys: (string | number)[], value: unknown, was: unknown) => void },
  ) => void,
  opts: LayerWrite = {},
): LayerResult {
  const file = layerFile(workspace, scope)
  const all = [...new Set([...configLayers(workspace), file])].sort((a, b) => layerRank(a, workspace) - layerRank(b, workspace))
  const below = all.slice(0, all.indexOf(file))
  const inherited = validateConfig(mergeLayers(below), below)
  const before = existsSync(file) ? readFileSync(file, "utf8") : ""
  const doc = before ? parseDocument(before) : new Document({})
  if (doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0]?.message}`)
  if (doc.contents === null) doc.contents = doc.createNode({}) as never
  const set = (keys: (string | number)[], value: unknown, was: unknown) => {
    if (JSON.stringify(value) !== JSON.stringify(was)) doc.setIn(keys, value)
    else if (doc.hasIn(keys)) doc.deleteIn(keys)
    for (let depth = keys.length - 1; depth > 0; depth--) prune(doc, keys.slice(0, depth))
  }
  edit(doc, inherited, { set })
  validateConfig(mergeLayers(all, { file, raw: doc.toJS() ?? {} }), all)
  // A file the change left empty is written as {} rather than removed: it existed or was asked for.
  const after = String(doc)
  const diff = lineDiff(before, after)
  if (!opts.preview) writeConfig(file, after, opts.what ?? "Settings")
  return { path: file, diff }
}
