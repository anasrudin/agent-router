import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ChatStore } from "./chats"
import { chatMarkdown } from "./export"
import type { DataStats } from "./protocol"

const DAY = 86_400_000

/** Bytes under a folder (files only, symlinks not followed). */
export function folderBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += folderBytes(full)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

export function dataStats(root: string, chats: ChatStore, now = Date.now()): DataStats {
  const list = chats.list()
  const archived = existsSync(path.join(root, "archive"))
    ? readdirSync(path.join(root, "archive")).filter((f) => f.endsWith(".json") && !f.endsWith(".ledger.json")).length
    : 0
  return {
    dir: root,
    bytes: folderBytes(root),
    chatBytes: folderBytes(chats.dir),
    chats: list.length,
    archived,
    olderThan30: list.filter((c) => !c.pinned && now - c.updatedAt > 30 * DAY).length,
    oldest: list.reduce<number | undefined>((min, c) => (min === undefined || c.updatedAt < min ? c.updatedAt : min), undefined),
  }
}

/**
 * Chats not used for `days` (pinned ones and the open one never), deleted or moved to `<data>/archive` (out of the
 * sidebar, still on disk). Returns how many.
 */
export function pruneChats(
  root: string,
  chats: ChatStore,
  days: number,
  mode: "archive" | "delete",
  now = Date.now(),
  /** The chat that is open: never cleared out from under the app. */
  keep?: string,
): number {
  if (!Number.isFinite(days) || days < 1) throw new Error("Pick at least 1 day.")
  const old = chats.list().filter((c) => !c.pinned && c.id !== keep && now - c.updatedAt > days * DAY)
  const archive = path.join(root, "archive")
  for (const c of old) {
    if (mode === "delete") {
      chats.delete(c.id)
      continue
    }
    mkdirSync(archive, { recursive: true })
    for (const ext of [".json", ".jsonl", ".ledger.jsonl"]) {
      const from = path.join(chats.dir, `${c.id}${ext}`)
      if (existsSync(from)) renameSync(from, path.join(archive, `${c.id}${ext}`))
    }
  }
  return old.length
}

/** Every chat (or one workspace's) as Markdown files in a new folder under `<data>/exports`. */
export function exportChats(root: string, chats: ChatStore, workspace?: string, now = new Date()): { dir: string; count: number } {
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-")
  const dir = path.join(root, "exports", stamp)
  mkdirSync(dir, { recursive: true })
  const used = new Set<string>()
  let count = 0
  for (const c of chats.list()) {
    if (workspace && path.resolve(c.workspace) !== path.resolve(workspace)) continue
    const base =
      c.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "chat"
    let name = `${new Date(c.createdAt).toISOString().slice(0, 10)}-${base}`
    for (let n = 2; used.has(name); n++) name = `${name.replace(/-\d+$/, "")}-${n}`
    used.add(name)
    writeFileSync(path.join(dir, `${name}.md`), chatMarkdown(c, chats.events(c.id)))
    count++
  }
  return { dir, count }
}
