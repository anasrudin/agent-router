import type { Card, CardColumn, ChatMeta, ClientMessage } from "../../server/protocol"
import { type MenuItem, openMenu } from "./chrome"
import { sortable } from "./drag"

/**
 * The workspace's Kanban board (Ghostex's Kanban plugin): To do, Doing, Review, Done. A card runs
 * as a new chat (it moves to Doing, and to Review when its turn ends) and opens that chat after.
 * Cards move by drag, by their menu, or with Alt+arrow keys.
 */
export const COLUMNS: { id: CardColumn; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "Doing" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
]

export interface BoardOptions {
  root: HTMLElement
  send: (m: ClientMessage) => void
  workspace: () => string
  chats: () => ChatMeta[]
  /** Start the card as a new chat; false if it cannot run now. */
  run: (card: Card) => boolean
  openChat: (id: string) => void
}

export function setupBoard(o: BoardOptions) {
  let cards: Card[] = []
  let editing: string | undefined

  const upsert = (card: Partial<Card>) => o.send({ type: "board.upsert", workspace: o.workspace(), card })
  const move = (id: string, column: CardColumn, index: number) =>
    o.send({ type: "board.move", workspace: o.workspace(), id, column, index })

  function cardMenu(card: Card, anchor: HTMLElement): MenuItem[] {
    const items: MenuItem[] = []
    if (card.column !== "doing") items.push({ label: card.chatId ? "Run again as a new chat" : "Run as a chat", run: () => o.run(card) })
    if (card.chatId) items.push({ label: "Open its chat", run: () => o.openChat(card.chatId as string) })
    items.push(
      {
        label: "Edit",
        run: () => {
          editing = card.id
          draw()
        },
      },
      "separator",
    )
    for (const c of COLUMNS) if (c.id !== card.column) items.push({ label: `Move to ${c.label}`, run: () => move(card.id, c.id, 0) })
    items.push("separator", {
      label: "Delete card",
      danger: true,
      run: () => o.send({ type: "board.remove", workspace: o.workspace(), id: card.id }),
    })
    void anchor
    return items
  }

  function editor(card: Partial<Card> & { column: CardColumn }, done: () => void): HTMLElement {
    const form = document.createElement("form")
    form.className = "card-edit"
    const title = document.createElement("input")
    title.className = "card-field"
    title.value = card.title ?? ""
    title.placeholder = "What should be done?"
    title.setAttribute("aria-label", "Card title")
    const notes = document.createElement("textarea")
    notes.className = "card-field"
    notes.value = card.notes ?? ""
    notes.rows = 3
    notes.placeholder = "Details for Conductor (optional)"
    notes.setAttribute("aria-label", "Card details")
    const save = document.createElement("button")
    save.type = "submit"
    save.className = "primary small"
    save.textContent = card.id ? "Save" : "Add card"
    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.className = "ghost small"
    cancel.textContent = "Cancel"
    cancel.addEventListener("click", done)
    form.addEventListener("submit", (e) => {
      e.preventDefault()
      if (!title.value.trim()) return
      upsert({ id: card.id, title: title.value, notes: notes.value, column: card.column })
      done()
    })
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        done()
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit()
    })
    const buttons = document.createElement("div")
    buttons.className = "buttons"
    buttons.append(save, cancel)
    form.append(title, notes, buttons)
    requestAnimationFrame(() => title.focus())
    return form
  }

  function cardEl(card: Card): HTMLElement {
    if (editing === card.id)
      return editor(card, () => {
        editing = undefined
        draw()
      })
    const el = document.createElement("article")
    el.className = "kanban-card"
    el.dataset.id = card.id
    el.tabIndex = 0
    el.setAttribute("aria-label", `${card.title}. Alt+arrows move it.`)
    const title = document.createElement("div")
    title.className = "kanban-title"
    title.textContent = card.title
    el.append(title)
    if (card.notes.trim()) {
      const notes = document.createElement("div")
      notes.className = "kanban-notes"
      notes.textContent = card.notes
      el.append(notes)
    }
    const foot = document.createElement("div")
    foot.className = "kanban-foot"
    const chat = card.chatId ? o.chats().find((c) => c.id === card.chatId) : undefined
    if (chat) {
      const link = document.createElement("button")
      link.type = "button"
      link.className = "ghost small"
      link.textContent = "Open chat"
      link.title = chat.title
      link.addEventListener("click", () => o.openChat(chat.id))
      foot.append(link)
    } else if (card.column === "todo") {
      const run = document.createElement("button")
      run.type = "button"
      run.className = "ghost small"
      run.textContent = "Run"
      run.title = "Start this card as a new chat"
      run.addEventListener("click", () => o.run(card))
      foot.append(run)
    }
    const spacer = document.createElement("span")
    spacer.className = "spacer"
    const more = document.createElement("button")
    more.type = "button"
    more.className = "icon-btn"
    more.title = "Card actions"
    more.setAttribute("aria-label", "Card actions")
    more.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>`
    more.addEventListener("click", () => openMenu(cardMenu(card, more), more, more, "Card actions"))
    foot.append(spacer, more)
    el.append(foot)
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      openMenu(cardMenu(card, el), { x: e.clientX, y: e.clientY }, el, "Card actions")
    })
    el.addEventListener("keydown", (e) => {
      if (!e.altKey || !/^Arrow/.test(e.key)) return
      e.preventDefault()
      const col = COLUMNS.findIndex((c) => c.id === card.column)
      const inCol = cards.filter((c) => c.column === card.column)
      const i = inCol.indexOf(card)
      if (e.key === "ArrowUp") move(card.id, card.column, Math.max(0, i - 1))
      else if (e.key === "ArrowDown") move(card.id, card.column, i + 1)
      else {
        const next = COLUMNS[col + (e.key === "ArrowLeft" ? -1 : 1)]
        if (next) move(card.id, next.id, 0)
      }
      focusAfter = card.id
    })
    return el
  }

  let adding: CardColumn | undefined
  let focusAfter: string | undefined

  function draw() {
    o.root.replaceChildren()
    const grid = document.createElement("div")
    grid.className = "kanban"
    for (const col of COLUMNS) {
      const section = document.createElement("section")
      section.className = "kanban-col"
      section.setAttribute("aria-label", col.label)
      const head = document.createElement("header")
      head.className = "kanban-head"
      const inCol = cards.filter((c) => c.column === col.id)
      head.append(
        Object.assign(document.createElement("h2"), { textContent: col.label }),
        Object.assign(document.createElement("span"), { className: "muted", textContent: String(inCol.length) }),
      )
      const list = document.createElement("div")
      list.className = "kanban-list"
      list.dataset.column = col.id
      for (const c of inCol) list.append(cardEl(c))
      section.append(head, list)
      if (adding === col.id)
        section.append(
          editor({ column: col.id }, () => {
            adding = undefined
            draw()
          }),
        )
      else {
        const add = document.createElement("button")
        add.type = "button"
        add.className = "kanban-add"
        add.textContent = "Add a card"
        add.addEventListener("click", () => {
          adding = col.id
          draw()
        })
        section.append(add)
      }
      grid.append(section)
    }
    o.root.append(grid)
    if (focusAfter) {
      o.root.querySelector<HTMLElement>(`.kanban-card[data-id="${CSS.escape(focusAfter)}"]`)?.focus()
      focusAfter = undefined
    }
  }

  sortable(o.root, {
    lists: () => [...o.root.querySelectorAll<HTMLElement>(".kanban-list")],
    item: ".kanban-card",
    drop: (id, list, index) => move(id, list.dataset.column as CardColumn, index),
  })

  return {
    load() {
      const ws = o.workspace()
      if (ws) o.send({ type: "board.get", workspace: ws })
      draw()
    },
    set(workspace: string, next: Card[]) {
      if (workspace !== o.workspace()) return
      cards = next
      draw()
    },
    cards: () => cards,
    draw,
  }
}
