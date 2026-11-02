import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Card, CardColumn } from "./protocol"

export const COLUMNS: CardColumn[] = ["todo", "doing", "review", "done"]

const key = (workspace: string) => createHash("sha1").update(workspace.replace(/\\/g, "/").replace(/\/+$/, "")).digest("hex").slice(0, 16)

/**
 * A Kanban board per workspace (Ghostex's Kanban): cards in four columns, their order the array's.
 * A card that ran remembers its chat, so the board opens it.
 */
export class BoardStore {
  constructor(readonly dir: string) {}

  private file(workspace: string) {
    return path.join(this.dir, `${key(workspace)}.json`)
  }

  get(workspace: string): Card[] {
    const file = this.file(workspace)
    if (!existsSync(file)) return []
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { cards: Card[] }).cards ?? []
    } catch {
      return []
    }
  }

  private save(workspace: string, cards: Card[]) {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.file(workspace), JSON.stringify({ workspace, cards }, null, 2))
  }

  upsert(workspace: string, card: Partial<Card> & { title?: string }, now = Date.now()): Card {
    const cards = this.get(workspace)
    const old = card.id ? cards.find((c) => c.id === card.id) : undefined
    const column = card.column && COLUMNS.includes(card.column) ? card.column : (old?.column ?? "todo")
    const next: Card = {
      id: old?.id ?? randomUUID(),
      title: (card.title ?? old?.title ?? "").trim().slice(0, 300) || "Untitled",
      notes: (card.notes ?? old?.notes ?? "").slice(0, 20_000),
      column,
      chatId: card.chatId === null ? undefined : (card.chatId ?? old?.chatId),
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    }
    this.save(workspace, old ? cards.map((c) => (c === old ? next : c)) : [...cards, next])
    return next
  }

  remove(workspace: string, id: string): void {
    this.save(
      workspace,
      this.get(workspace).filter((c) => c.id !== id),
    )
  }

  /** Put a card in `column` at `index` among that column's cards. */
  move(workspace: string, id: string, column: CardColumn, index: number, now = Date.now()): boolean {
    if (!COLUMNS.includes(column)) return false
    const cards = this.get(workspace)
    const card = cards.find((c) => c.id === id)
    if (!card) return false
    const rest = cards.filter((c) => c !== card)
    const moved = { ...card, column, updatedAt: now }
    const inColumn = rest.filter((c) => c.column === column)
    const at = Math.max(0, Math.min(inColumn.length, Math.floor(index)))
    // Insert before the card now at that position in the column, or after the column's last card.
    const before = inColumn[at]
    const pos = before ? rest.indexOf(before) : inColumn.length ? rest.indexOf(inColumn.at(-1) as Card) + 1 : rest.length
    this.save(workspace, [...rest.slice(0, pos), moved, ...rest.slice(pos)])
    return true
  }
}
