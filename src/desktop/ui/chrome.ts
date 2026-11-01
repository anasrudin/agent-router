/**
 * Window chrome shared by every view: popovers that open from a button, and tooltips drawn the
 * way Ghostex draws them (8px radius, darker than menus, after a short delay) in place of the
 * browser's own title bubbles.
 */

let openPanel: { button: HTMLButtonElement; panel: HTMLElement } | undefined

export function closePopovers(returnFocus = false) {
  if (!openPanel) return
  const { button, panel } = openPanel
  openPanel = undefined
  panel.hidden = true
  button.setAttribute("aria-expanded", "false")
  if (returnFocus) button.focus()
}

/** One popover open at a time; it closes on a click outside, on Escape, and when its button is pressed again. */
export function popover(button: HTMLButtonElement, panel: HTMLElement, onOpen?: () => void) {
  button.addEventListener("click", () => {
    if (openPanel?.panel === panel) {
      closePopovers()
      return
    }
    closePopovers()
    onOpen?.()
    panel.hidden = false
    button.setAttribute("aria-expanded", "true")
    openPanel = { button, panel }
    panel.querySelector<HTMLElement>("select, button, [tabindex]")?.focus()
  })
}

document.addEventListener("pointerdown", (e) => {
  if (!openPanel) return
  const target = e.target as Node
  if (!openPanel.panel.contains(target) && !openPanel.button.contains(target)) closePopovers()
})
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPanel) {
    e.preventDefault()
    closePopovers(true)
  }
})

const TOOLTIP_DELAY_MS = 450

/**
 * Every element with a `title` gets the styled tooltip instead of the native one. The text moves
 * to `data-tip` (so the browser stops drawing its own), and an icon-only control that has no
 * accessible name of its own gets it as its `aria-label`.
 */
export function installTooltips(tip: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: HTMLElement | undefined

  const take = (node: HTMLElement): string => {
    const title = node.getAttribute("title")
    if (title) {
      node.dataset.tip = title
      node.removeAttribute("title")
      if (!node.hasAttribute("aria-label") && !node.textContent?.trim()) node.setAttribute("aria-label", title)
    }
    return node.dataset.tip ?? ""
  }

  const hide = () => {
    clearTimeout(timer)
    current = undefined
    tip.hidden = true
  }

  const show = (node: HTMLElement) => {
    const text = take(node)
    if (!text) return
    tip.textContent = text
    tip.hidden = false
    const r = node.getBoundingClientRect()
    const t = tip.getBoundingClientRect()
    const below = r.bottom + 6 + t.height < window.innerHeight
    const top = below ? r.bottom + 6 : r.top - 6 - t.height
    const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8)
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  }

  const schedule = (node: HTMLElement) => {
    if (node === current) return
    hide()
    current = node
    take(node)
    timer = setTimeout(() => current === node && show(node), TOOLTIP_DELAY_MS)
  }

  const owner = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>("[title], [data-tip]") ?? undefined

  document.addEventListener("pointerover", (e) => {
    const node = owner(e.target)
    if (node) schedule(node)
    else if (current) hide()
  })
  document.addEventListener("focusin", (e) => {
    const node = owner(e.target)
    if (node?.matches(":focus-visible")) schedule(node)
  })
  for (const type of ["pointerdown", "keydown", "focusout", "wheel"]) document.addEventListener(type, hide, true)
  window.addEventListener("blur", hide)
}
