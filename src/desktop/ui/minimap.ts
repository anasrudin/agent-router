/**
 * The minimap rail beside the chat (Ghostex's): a tick for each request, marks for threads that
 * need you, failures and questions, and a box for what is on screen. Click to jump.
 */
const MARKS: [selector: string, kind: string][] = [
  [".msg-user", "request"],
  [".agent-card:has(.pill.blocked), .agent-card:has(.pill.partial)", "needs"],
  [".agent-card:has(.pill.error), .agent-card:has(.pill.failed), .error", "error"],
  [".questions:not(.answered), .approval:not(.answered)", "question"],
  [".side-card, .catchup-card", "aside"],
]

export function setupMinimap(scroller: HTMLElement, rail: HTMLElement) {
  const view = document.createElement("div")
  view.className = "minimap-view"
  let frame: number | undefined
  let markersDirty = true

  const draw = () => {
    frame = undefined
    const total = scroller.scrollHeight
    const shown = scroller.clientHeight
    rail.hidden = total <= shown * 1.5
    if (rail.hidden) return
    const h = rail.clientHeight
    if (markersDirty) {
      markersDirty = false
      rail.replaceChildren(view)
      const base = scroller.getBoundingClientRect().top - scroller.scrollTop
      for (const [selector, kind] of MARKS) {
        for (const node of scroller.querySelectorAll<HTMLElement>(selector)) {
          if (node.closest("[hidden]")) continue
          const top = node.getBoundingClientRect().top - base
          const tick = document.createElement("button")
          tick.type = "button"
          tick.className = `minimap-tick ${kind}`
          tick.style.transform = `translateY(${Math.round((top / total) * h)}px)`
          tick.tabIndex = -1
          tick.setAttribute("aria-hidden", "true")
          tick.addEventListener("click", (e) => {
            e.stopPropagation()
            node.scrollIntoView({ block: "start" })
          })
          rail.append(tick)
        }
      }
    }
    view.style.transform = `translateY(${Math.round((scroller.scrollTop / total) * h)}px)`
    view.style.height = `${Math.max(12, Math.round((shown / total) * h))}px`
  }
  const schedule = (markers = false) => {
    if (markers) markersDirty = true
    if (frame === undefined) frame = requestAnimationFrame(draw)
  }

  let mutationTimer: ReturnType<typeof setTimeout> | undefined
  new MutationObserver(() => {
    clearTimeout(mutationTimer)
    mutationTimer = setTimeout(() => schedule(true), 150)
  }).observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "class", "hidden"] })
  new ResizeObserver(() => schedule(true)).observe(scroller)
  scroller.addEventListener("scroll", () => schedule(), { passive: true })
  rail.addEventListener("click", (e) => {
    const r = rail.getBoundingClientRect()
    const at = (e.clientY - r.top) / r.height
    scroller.scrollTop = at * scroller.scrollHeight - scroller.clientHeight / 2
  })
  schedule(true)
}
