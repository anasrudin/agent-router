import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseDocument } from "yaml"
import { configLayers, mergeLayers, projectConfigPath, userConfigPath, validateConfig } from "../config/load"
import { layerRank } from "./layers"
import { diffCounts, lineDiff } from "./linediff"
import type { ConfigChange, DiffLine } from "./protocol"

/** Every change the app writes to a config file, newest last, so any of them can be undone. */
interface Entry {
  id: string
  file: string
  at: number
  what: string
  before: string
  after: string
  /** The file was there before the change (an empty file is not a missing one). */
  existed?: boolean
}

const KEEP = 300
const VALID_ID = /^\d{13}-[0-9a-f]{8}$/

/** Beside your own routing.yaml, so it follows AGENT_ROUTER_CONFIG_DIR like the file does. */
export function historyDir(): string {
  return path.join(path.dirname(userConfigPath()), "history")
}

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "")
/** Paths compared the way the platform does: Windows ignores case. */
const key = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))

/**
 * Write a config file atomically and remember what it held before. `remove` deletes the file
 * instead (it did not exist before the change being undone). Writing what is there does nothing.
 */
export function writeConfig(file: string, text: string, what: string, opts: { remove?: boolean; now?: number } = {}): void {
  const now = opts.now ?? Date.now()
  const existed = existsSync(file)
  const before = readText(file)
  if (opts.remove ? !existed : existed && before === text) return
  if (opts.remove) rmSync(file, { force: true })
  else {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, text, "utf8")
    renameSync(tmp, file)
  }
  const dir = historyDir()
  mkdirSync(dir, { recursive: true })
  const entry: Entry = { id: `${now}-${randomUUID().slice(0, 8)}`, file: path.resolve(file), at: now, what, before, after: text, existed }
  writeFileSync(path.join(dir, `${entry.id}.json`), JSON.stringify(entry))
  const all = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) rmSync(path.join(dir, old), { force: true })
}

function entries(): Entry[] {
  const dir = historyDir()
  if (!existsSync(dir)) return []
  const out: Entry[] = []
  for (const f of readdirSync(dir).sort().reverse()) {
    if (!f.endsWith(".json")) continue
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Entry)
    } catch {
      // A torn entry is skipped, not fatal.
    }
  }
  return out
}

/** Changes to this workspace's project file and to your own file, newest first. */
export function listHistory(workspace: string, limit = 100): ConfigChange[] {
  const project = key(projectConfigPath(workspace))
  const user = key(userConfigPath())
  return entries()
    .filter((e) => key(e.file) === project || key(e.file) === user)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      at: e.at,
      what: e.what,
      path: e.file,
      scope: key(e.file) === user ? ("user" as const) : ("project" as const),
      ...diffCounts(lineDiff(e.before, e.after)),
    }))
}

function find(id: string): Entry {
  if (!VALID_ID.test(id)) throw new Error("Unknown change.")
  const file = path.join(historyDir(), `${id}.json`)
  if (!existsSync(file)) throw new Error("That change is no longer in the history.")
  return JSON.parse(readFileSync(file, "utf8")) as Entry
}

/** What one change did. */
export function historyDiff(id: string): DiffLine[] {
  const e = find(id)
  return lineDiff(e.before, e.after)
}

/**
 * Put a file back to how it was before one change (later changes to that file are undone too,
 * since the whole file goes back). Refused when the result would not be a valid config.
 */
export function restoreHistory(workspace: string, id: string): { path: string } {
  const e = find(id)
  const project = key(projectConfigPath(workspace))
  const user = key(userConfigPath())
  if (key(e.file) !== project && key(e.file) !== user) throw new Error("That change belongs to another project.")
  // Entries written before `existed` was recorded: an empty "before" meant no file.
  const existed = e.existed ?? e.before !== ""
  // The path this workspace uses for that layer (the same file, as the platform spells it).
  const target = key(e.file) === user ? userConfigPath() : projectConfigPath(workspace)
  if (existed && e.before !== "") {
    const doc = parseDocument(e.before)
    if (doc.errors.length) throw new Error(`The earlier file is not valid YAML: ${doc.errors[0]?.message}`)
    const all = [...new Set([...configLayers(workspace), target])].sort((a, b) => layerRank(a, workspace) - layerRank(b, workspace))
    validateConfig(mergeLayers(all, { file: target, raw: doc.toJS() ?? {} }), all)
  }
  writeConfig(target, e.before, `Went back to before: ${e.what}`, { remove: !existed })
  return { path: target }
}
