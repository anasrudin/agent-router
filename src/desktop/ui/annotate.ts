import { type Annotation, MARK_LABELS, type Mark, type NoteSource } from "./annotations"

/**
 * Select text in a file or a thread's report and a small toolbar offers Ghostex's marks: Looks
 * good, Clarify, Needs tests, or a note of your own. The notes collect above the composer.
 */
export interface AnnotatorOptions {
  root: HTMLElement
  bar: HTMLElement
  /** Where the selection is, or undefined where notes do not apply. */
  sourceFor: (range: Range) => NoteSource | undefined
  add: (note: Annotation) => void
}

let counter = 0

export function setupAnnotator(o: AnnotatorOptions) {
  let pending: { source: NoteSource; quote: string } | undefined

  const hide = () => {
    o.bar.hidden = true
    pending = undefined
  }

  const commit = (mark: Mark, note?: string) => {
    if (!pending) return
    o.add({ id: `n-${++counter}`, source: pending.source, quote: pending.quote, mark, note })
    getSelection()?.removeAllRanges()
    hide()
  }

  const draw = () => {
    o.bar.replaceChildren()
    for (const mark of ["good", "clarify", "tests"] as Mark[]) {
      const b = document.createElement("button")
      b.type = "button"
      b.className = `note-mark mark-${mark}`
      b.textContent = MARK_LABELS[mark]
      b.addEventListener("click", () => commit(mark))
      o.bar.append(b)
    }
    const note = document.createElement("button")
    note.type = "button"
    note.className = "note-mark"
    note.textContent = "Note…"
    note.addEventListener("click", () => {
      const input = document.createElement("input")
      input.className = "note-input"
      input.placeholder = "Your note, then Enter"
      input.setAttribute("aria-label", "Your note")
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) commit("note", input.value)
        if (e.key === "Escape") hide()
      })
      o.bar.replaceChildren(input)
      input.focus()
    })
    o.bar.append(note)
  }

  const check = () => {
    const sel = getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      if (!o.bar.contains(document.activeElement)) hide()
      return
    }
    const range = sel.getRangeAt(0)
    if (!o.root.contains(range.commonAncestorContainer)) return
    const quote = sel.toString().trim()
    const source = quote.length > 1 ? o.sourceFor(range) : undefined
    if (!source) {
      hide()
      return
    }
    pending = { source, quote }
    draw()
    o.bar.hidden = false
    const r = range.getBoundingClientRect()
    const b = o.bar.getBoundingClientRect()
    const top = r.top - b.height - 8 > 8 ? r.top - b.height - 8 : r.bottom + 8
    const left = Math.min(Math.max(8, r.left + r.width / 2 - b.width / 2), window.innerWidth - b.width - 8)
    o.bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }

  o.root.addEventListener("mouseup", () => setTimeout(check, 0))
  o.root.addEventListener("keyup", (e) => {
    if (e.shiftKey) check()
  })
  document.addEventListener("pointerdown", (e) => {
    if (!o.bar.hidden && !o.bar.contains(e.target as Node) && !o.root.contains(e.target as Node)) hide()
  })
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !o.bar.hidden) hide()
  })
  /** Offer the marks for something that is not a text selection (a shape in a drawing), next to `rect`. */
  const offer = (source: NoteSource, quote: string, rect: DOMRect) => {
    pending = { source, quote }
    draw()
    o.bar.hidden = false
    const b = o.bar.getBoundingClientRect()
    const top = rect.top - b.height - 8 > 8 ? rect.top - b.height - 8 : rect.bottom + 8
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - b.width / 2), window.innerWidth - b.width - 8)
    o.bar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
    o.bar.querySelector<HTMLElement>("button")?.focus()
  }
  return { hide, offer }
}

/** The file lines a selection covers: file-viewer rows (data-line) or preview blocks (data-line to data-end). */
export function fileLines(range: Range): { start: number; end: number } | undefined {
  const at = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>("[data-line]")
  const a = at(range.startContainer)
  const b = at(range.endContainer)
  if (!a || !b) return undefined
  const lines = [a, b].flatMap((x) => [Number(x.dataset.line), Number(x.dataset.end ?? x.dataset.line)])
  return { start: Math.min(...lines), end: Math.max(...lines) }
}
