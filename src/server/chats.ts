import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChatEvent, ChatHit, ChatMeta, ServerMessage } from "./protocol"

/** Where the desktop app keeps its chats: the platform's per-user data folder. */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.AGENT_ROUTER_DATA_DIR) return env.AGENT_ROUTER_DATA_DIR
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
  const base =
    platform === "win32"
      ? (env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"))
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : (env.XDG_DATA_HOME ?? path.join(home, ".local", "share"))
  return path.join(base, "agent-router")
}

const VALID_ID = /^[0-9a-f-]{8,64}$/

/** What a message says in words, for search. */
function messageText(msg: ServerMessage): string {
  switch (msg.type) {
    case "turn.started":
      return msg.prompt
    case "conductor":
      return msg.event.type === "text" ? msg.event.text : ""
    case "delegation.started":
      return msg.task
    case "delegation.finished":
      return msg.summary.report
    default:
      return ""
  }
}

function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + length + 60)
  const body = text.slice(start, end).replace(/\s+/g, " ").trim()
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`
}

/**
 * The desktop app's chats on disk, one pair of files each: `<id>.json` (title, workspace, the
 * Conductor session to resume) and `<id>.jsonl` (every message the UI was sent, with its time),
 * so a chat reopens after a restart exactly as it was shown. Its delegation ledger sits beside them.
 */
export class ChatStore {
  constructor(readonly dir: string) {}

  private file(id: string, ext: string): string | undefined {
    return VALID_ID.test(id) ? path.join(this.dir, `${id}${ext}`) : undefined
  }

  private write(meta: ChatMeta) {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file(meta.id, ".json") as string, JSON.stringify(meta, null, 2))
  }

  create(workspace: string, title: string, now = Date.now()): ChatMeta {
    const meta: ChatMeta = { id: randomUUID(), workspace, title, createdAt: now, updatedAt: now, pinned: false, turns: 0 }
    this.write(meta)
    return meta
  }

  get(id: string): ChatMeta | undefined {
    const file = this.file(id, ".json")
    if (!file || !existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, "utf8")) as ChatMeta
    } catch {
      return undefined
    }
  }

  /** Pinned first, then the most recently used. */
  list(): ChatMeta[] {
    if (!existsSync(this.dir)) return []
    const chats = readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.get(f.slice(0, -5)))
      .filter((c): c is ChatMeta => c !== undefined)
    return chats.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  }

  update(
    id: string,
    patch: Partial<Pick<ChatMeta, "title" | "pinned" | "sessionId" | "updatedAt" | "turns" | "runIn">>,
  ): ChatMeta | undefined {
    const meta = this.get(id)
    if (!meta) return undefined
    const next = { ...meta, ...patch }
    this.write(next)
    return next
  }

  append(id: string, msg: ServerMessage, at = Date.now()): void {
    const file = this.file(id, ".jsonl")
    if (!file) return
    mkdirSync(this.dir, { recursive: true })
    appendFileSync(file, `${JSON.stringify({ at, msg })}\n`)
    // The list's order and counts change when a turn starts; other messages leave the meta alone.
    if (msg.type === "turn.started") {
      const meta = this.get(id)
      if (meta) this.write({ ...meta, updatedAt: at, turns: meta.turns + 1 })
    }
  }

  events(id: string): ChatEvent[] {
    const file = this.file(id, ".jsonl")
    if (!file || !existsSync(file)) return []
    const out: ChatEvent[] = []
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as ChatEvent)
      } catch {
        // A line cut off by a crash; the rest of the chat is still good.
      }
    }
    return out
  }

  ledgerPath(id: string): string {
    mkdirSync(this.dir, { recursive: true })
    return this.file(id, ".ledger.jsonl") ?? path.join(this.dir, "invalid.ledger.jsonl")
  }

  delete(id: string): void {
    for (const ext of [".json", ".jsonl", ".ledger.jsonl"]) {
      const file = this.file(id, ext)
      if (file) rmSync(file, { force: true })
    }
  }

  /** Chats whose title or messages contain `query` (any case), newest first, with where it matched. */
  search(query: string, limit = 20): ChatHit[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: ChatHit[] = []
    for (const chat of this.list().sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (hits.length >= limit) break
      const inTitle = chat.title.toLowerCase().indexOf(q)
      if (inTitle >= 0) {
        hits.push({ chat, snippet: chat.title })
        continue
      }
      for (const { msg } of this.events(chat.id)) {
        const text = messageText(msg)
        const at = text.toLowerCase().indexOf(q)
        if (at >= 0) {
          hits.push({ chat, snippet: snippet(text, at, q.length) })
          break
        }
      }
    }
    return hits
  }
}
