/**
 * Drag to reorder with the pointer (a press, a few pixels of movement, then the item follows), so
 * it works in every webview whatever the native drag-and-drop does. Lists can share a group to
 * drag between them (Kanban columns). The keyboard alternative is the caller's (Alt+arrows).
 */
export interface SortableOptions {
  /** Where an item can land; each is a list of items. */
  lists: () => HTMLElement[]
  item: string
  handle?: string
  /** The item was dropped in `list` at `index` (among that list's items, the dragged one excluded). */
  drop: (id: string, list: HTMLElement, index: number) => void
}

export function sortable(root: HTMLElement, o: SortableOptions) {
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    const grip = o.handle ? target.closest<HTMLElement>(o.handle) : target
    const item = grip?.closest<HTMLElement>(o.item)
    if (!item || !root.contains(item) || (!o.handle && target.closest("button, input, textarea, a, select"))) return
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    let placeholder: HTMLElement | undefined
    const rect = item.getBoundingClientRect()

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
        dragging = true
        item.setPointerCapture(e.pointerId)
        placeholder = document.createElement("div")
        placeholder.className = "drag-placeholder"
        placeholder.style.height = `${rect.height}px`
        item.after(placeholder)
        item.classList.add("dragging")
        item.style.width = `${rect.width}px`
      }
      item.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`
      // The list under the pointer, and the item it should go before.
      const list = o.lists().find((l) => {
        const r = l.getBoundingClientRect()
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top - 24 && ev.clientY <= r.bottom + 24
      })
      if (!list || !placeholder) return
      const siblings = [...list.querySelectorAll<HTMLElement>(o.item)].filter((x) => x !== item)
      const before = siblings.find((s) => {
        const r = s.getBoundingClientRect()
        return ev.clientY < r.top + r.height / 2
      })
      if (before) before.before(placeholder)
      else list.append(placeholder)
    }
    const up = () => {
      root.removeEventListener("pointermove", move)
      root.removeEventListener("pointerup", up)
      root.removeEventListener("pointercancel", up)
      if (!dragging || !placeholder) return
      const list = placeholder.parentElement as HTMLElement
      const index = [...list.children].filter((c) => (c.matches(o.item) && c !== item) || c === placeholder).indexOf(placeholder)
      placeholder.remove()
      item.classList.remove("dragging")
      item.style.transform = ""
      item.style.width = ""
      // A click would follow the drag; swallow it.
      item.addEventListener("click", (c) => c.stopPropagation(), { capture: true, once: true })
      const id = item.dataset.id
      if (id) o.drop(id, list, index)
    }
    root.addEventListener("pointermove", move)
    root.addEventListener("pointerup", up)
    root.addEventListener("pointercancel", up)
  })
}
