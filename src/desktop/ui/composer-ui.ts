import { applyCompletion, type Command, type PromptHistory, type Token, tokenAt } from "./composer"

export interface ComposerOptions {
  box: HTMLTextAreaElement
  /** The listbox the menus draw in. */
  list: HTMLElement
  files: (query: string) => Promise<string[]>
  commands: () => Command[]
  history: PromptHistory
  /** After the text changes from here. */
  changed: () => void
}

interface Item {
  label: string
  detail: string
  apply: () => void
}

export function setupComposer(o: ComposerOptions) {
  let items: Item[] = []
  let active = 0
  let token: Token | undefined
  let seq = 0

  const close = () => {
    items = []
    token = undefined
    o.list.hidden = true
    o.box.removeAttribute("aria-activedescendant")
    o.box.setAttribute("aria-expanded", "false")
  }

  const draw = () => {
    o.list.replaceChildren()
    if (!items.length) {
      close()
      return
    }
    items.forEach((item, i) => {
      const row = document.createElement("div")
      row.className = `complete-row${i === active ? " active" : ""}`
      row.id = `complete-${i}`
      row.setAttribute("role", "option")
      row.setAttribute("aria-selected", String(i === active))
      const label = document.createElement("span")
      label.className = "complete-label"
      label.textContent = item.label
      const detail = document.createElement("span")
      detail.className = "complete-detail"
      detail.textContent = item.detail
      row.append(label, detail)
      // pointerdown, so the textarea keeps focus.
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault()
        item.apply()
      })
      o.list.append(row)
    })
    o.list.hidden = false
    o.box.setAttribute("aria-expanded", "true")
    o.box.setAttribute("aria-activedescendant", `complete-${active}`)
    o.list.querySelector(".active")?.scrollIntoView({ block: "nearest" })
  }

  const put = (t: Token, insert: string) => {
    const next = applyCompletion(o.box.value, o.box.selectionStart, t, insert)
    o.box.value = next.value
    o.box.setSelectionRange(next.caret, next.caret)
    close()
    o.changed()
  }

  const refresh = () => {
    const t = tokenAt(o.box.value, o.box.selectionStart)
    if (!t || o.box.selectionStart !== o.box.selectionEnd) {
      close()
      return
    }
    token = t
    const mine = ++seq
    if (t.kind === "/") {
      const q = t.query.toLowerCase()
      items = o
        .commands()
        .filter((c) => c.name.toLowerCase().startsWith(q) || (q.length > 1 && c.name.toLowerCase().includes(q)))
        .map((c) => ({
          label: `/${c.name}`,
          detail: c.hint,
          apply: () => {
            if (c.insert !== undefined) put(t, c.insert)
            else {
              put(t, "")
              o.box.value = o.box.value.replace(/^\s+$/, "")
              c.run?.()
              o.changed()
            }
          },
        }))
      active = 0
      draw()
      return
    }
    void o.files(t.query).then((files) => {
      if (mine !== seq || !token) return
      items = files.slice(0, 12).map((f) => {
        const slash = f.lastIndexOf("/")
        return { label: f.slice(slash + 1), detail: slash > 0 ? f.slice(0, slash) : "", apply: () => put(t, `@${f}`) }
      })
      active = 0
      draw()
    })
  }

  o.box.setAttribute("role", "combobox")
  o.box.setAttribute("aria-autocomplete", "list")
  o.box.setAttribute("aria-controls", o.list.id)
  o.box.setAttribute("aria-expanded", "false")
  o.box.addEventListener("input", () => {
    o.history.reset()
    refresh()
  })
  o.box.addEventListener("click", refresh)
  o.box.addEventListener("blur", () => setTimeout(close, 100))

  /** Keys the composer handles itself; true when the caller should do nothing more with the event. */
  function handleKey(e: KeyboardEvent): boolean {
    if (!o.list.hidden && items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
        draw()
        return true
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault()
        items[active]?.apply()
        return true
      }
      if (e.key === "Escape") {
        e.preventDefault()
        close()
        return true
      }
    }
    const box = o.box
    if (e.key === "ArrowUp" && !e.shiftKey && box.selectionStart === 0 && box.selectionEnd === 0) {
      const prev = o.history.up(box.value)
      if (prev === undefined) return false
      e.preventDefault()
      box.value = prev
      box.setSelectionRange(0, 0)
      o.changed()
      return true
    }
    if (e.key === "ArrowDown" && !e.shiftKey && o.history.walking && box.selectionStart === box.value.length) {
      const next = o.history.down()
      if (next === undefined) return false
      e.preventDefault()
      box.value = next
      box.setSelectionRange(next.length, next.length)
      o.changed()
      return true
    }
    return false
  }

  /** Put `@path` at the caret (an attachment, a file picked elsewhere). */
  function mention(path: string) {
    const box = o.box
    const at = box.selectionStart
    const before = box.value.slice(0, at)
    const pad = before && !/\s$/.test(before) ? " " : ""
    const text = `${pad}@${path} `
    box.value = before + text + box.value.slice(box.selectionEnd)
    box.setSelectionRange(at + text.length, at + text.length)
    box.focus()
    o.changed()
  }

  return {
    handleKey,
    close,
    mention,
    get open() {
      return !o.list.hidden
    },
  }
}

/** A File as base64, without the data: prefix. */
export function fileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
