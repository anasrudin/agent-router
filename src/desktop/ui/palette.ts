/**
 * The command palette (Mod+K): commands, this chat's threads and every saved chat by title,
 * then chats whose messages match, from the server.
 */
export interface PaletteItem {
  group: string
  label: string
  detail?: string
  keys?: string
  run: () => void
}

export interface PaletteOptions {
  dialog: HTMLDialogElement
  input: HTMLInputElement
  list: HTMLElement
  items: () => PaletteItem[]
  /** Matches in chat messages, for a query of two letters or more. */
  search: (query: string) => Promise<PaletteItem[]>
}

const matches = (item: PaletteItem, q: string) => `${item.label} ${item.detail ?? ""} ${item.group}`.toLowerCase().includes(q)

export function setupPalette(o: PaletteOptions) {
  let shown: PaletteItem[] = []
  let active = 0
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const draw = () => {
    o.list.replaceChildren()
    let group = ""
    if (!shown.length) {
      const empty = document.createElement("div")
      empty.className = "palette-empty"
      empty.textContent = o.input.value.trim() ? "Nothing matches." : "Type to search chats and commands."
      o.list.append(empty)
    }
    shown.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group
        const head = document.createElement("div")
        head.className = "palette-group"
        head.textContent = group
        head.setAttribute("role", "presentation")
        o.list.append(head)
      }
      const row = document.createElement("div")
      row.className = `palette-row${i === active ? " active" : ""}`
      row.id = `palette-${i}`
      row.setAttribute("role", "option")
      row.setAttribute("aria-selected", String(i === active))
      const text = document.createElement("span")
      text.className = "palette-text"
      const label = document.createElement("span")
      label.className = "palette-label"
      label.textContent = item.label
      text.append(label)
      if (item.detail) {
        const detail = document.createElement("span")
        detail.className = "palette-detail"
        detail.textContent = item.detail
        text.append(detail)
      }
      row.append(text)
      if (item.keys) {
        const keys = document.createElement("kbd")
        keys.textContent = item.keys
        row.append(keys)
      }
      row.addEventListener("click", () => choose(i))
      row.addEventListener("pointermove", () => {
        if (active === i) return
        active = i
        draw()
      })
      o.list.append(row)
    })
    o.input.setAttribute("aria-activedescendant", shown.length ? `palette-${active}` : "")
    o.list.querySelector(".active")?.scrollIntoView({ block: "nearest" })
  }

  const update = () => {
    const q = o.input.value.trim().toLowerCase()
    const local = o.items().filter((it) => !q || matches(it, q))
    shown = local
    active = 0
    draw()
    clearTimeout(timer)
    if (q.length < 2) return
    const mine = ++seq
    timer = setTimeout(() => {
      void o.search(q).then((found) => {
        if (mine !== seq) return
        const seen = new Set(shown.map((s) => `${s.group}:${s.label}`))
        shown = [...shown, ...found.filter((f) => !seen.has(`Chats:${f.label}`))]
        draw()
      })
    }, 150)
  }

  function choose(i: number) {
    const item = shown[i]
    if (!item) return
    close()
    item.run()
  }

  function close() {
    clearTimeout(timer)
    seq++
    if (o.dialog.open) o.dialog.close()
  }

  o.input.addEventListener("input", update)
  o.input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!shown.length) return
      active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length
      draw()
    } else if (e.key === "Enter") {
      e.preventDefault()
      choose(active)
    }
  })
  // A click on the backdrop (the dialog element itself, outside its box) closes it.
  o.dialog.addEventListener("click", (e) => {
    if (e.target === o.dialog) close()
  })

  return {
    open() {
      o.input.value = ""
      update()
      if (!o.dialog.open) o.dialog.showModal()
      o.input.focus()
    },
    close,
    /** Filters changed: show the list again for the same query. */
    refresh: update,
  }
}
