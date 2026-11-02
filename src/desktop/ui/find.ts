/**
 * Find in the chat (Mod+F): every match in the transcript marked, the current one scrolled to,
 * Enter and Shift+Enter to step, Escape to close. Folded work opens when a match is inside it.
 */
export interface FindOptions {
  bar: HTMLElement
  input: HTMLInputElement
  count: HTMLElement
  prev: HTMLButtonElement
  next: HTMLButtonElement
  close: HTMLButtonElement
  root: HTMLElement
}

export function setupFind(o: FindOptions) {
  let hits: HTMLElement[] = []
  let current = -1

  const clear = () => {
    const parents = new Set<Node>()
    for (const mark of o.root.querySelectorAll("mark.find-hit")) {
      const parent = mark.parentNode
      if (!parent) continue
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark)
      parents.add(parent)
    }
    for (const p of parents) p.normalize()
    hits = []
    current = -1
  }

  const show = () => {
    hits.forEach((h, i) => {
      h.classList.toggle("current", i === current)
    })
    o.count.textContent = !o.input.value ? "" : hits.length ? `${current + 1} of ${hits.length}` : "No results"
    const hit = hits[current]
    if (!hit) return
    for (let d = hit.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true
    hit.scrollIntoView({ block: "center" })
  }

  const search = () => {
    clear()
    const q = o.input.value.toLowerCase()
    if (!q) {
      show()
      return
    }
    const walker = document.createTreeWalker(o.root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        (n.parentElement as HTMLElement).closest("button, textarea, input, svg") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    const nodes: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
    for (const node of nodes) {
      const value = node.nodeValue ?? ""
      const lower = value.toLowerCase()
      let at = lower.indexOf(q)
      if (at < 0) continue
      const frag = document.createDocumentFragment()
      let from = 0
      while (at >= 0) {
        frag.append(value.slice(from, at))
        const mark = document.createElement("mark")
        mark.className = "find-hit"
        mark.textContent = value.slice(at, at + q.length)
        frag.append(mark)
        hits.push(mark)
        from = at + q.length
        at = lower.indexOf(q, from)
      }
      frag.append(value.slice(from))
      node.replaceWith(frag)
    }
    current = hits.length ? 0 : -1
    show()
  }

  const step = (by: number) => {
    if (!hits.length) return
    current = (current + by + hits.length) % hits.length
    show()
  }

  const close = () => {
    clear()
    o.bar.hidden = true
    o.count.textContent = ""
  }

  o.input.addEventListener("input", search)
  o.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })
  o.prev.addEventListener("click", () => step(-1))
  o.next.addEventListener("click", () => step(1))
  o.close.addEventListener("click", close)

  return {
    open() {
      o.bar.hidden = false
      o.input.focus()
      o.input.select()
      if (o.input.value) search()
    },
    close,
    /** Before the transcript is rebuilt: marks would point at removed nodes. */
    reset: () => {
      if (!o.bar.hidden) close()
    },
  }
}
