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

export type MenuItem = { label: string; run: () => void; danger?: boolean } | "separator"

let menuEl: HTMLElement | undefined
let menuReturn: HTMLElement | undefined

export function closeMenu(returnFocus = false) {
  if (!menuEl || menuEl.hidden) return
  menuEl.hidden = true
  // A list that re-renders replaces its rows; find the same control again by its key.
  const key = menuReturn?.dataset.focusKey
  const target = menuReturn?.isConnected || !key ? menuReturn : document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)
  if (returnFocus) target?.focus()
  menuReturn = undefined
}

/**
 * A context menu at a point (a right-click) or under an element (the row's More button, or the
 * keyboard's menu key). Arrow keys move, Enter picks, Escape and Tab close; focus goes back to
 * `returnTo` when it closes from the keyboard.
 */
export function openMenu(items: MenuItem[], at: { x: number; y: number } | HTMLElement, returnTo: HTMLElement, label: string) {
  closePopovers()
  if (!menuEl) {
    menuEl = document.createElement("div")
    menuEl.className = "popover context-menu"
    menuEl.setAttribute("role", "menu")
    menuEl.hidden = true
    menuEl.addEventListener("keydown", (e) => {
      const rows = [...(menuEl as HTMLElement).querySelectorAll<HTMLButtonElement>("button")]
      const i = rows.indexOf(document.activeElement as HTMLButtonElement)
      const go = (n: number) => rows[(n + rows.length) % rows.length]?.focus()
      if (e.key === "ArrowDown") go(i + 1)
      else if (e.key === "ArrowUp") go(i - 1)
      else if (e.key === "Home") go(0)
      else if (e.key === "End") go(rows.length - 1)
      else if (e.key === "Escape" || e.key === "Tab") closeMenu(true)
      else return
      e.preventDefault()
      e.stopPropagation()
    })
    document.body.append(menuEl)
  }
  const menu = menuEl
  menu.setAttribute("aria-label", label)
  menu.replaceChildren()
  for (const item of items) {
    if (item === "separator") {
      menu.append(Object.assign(document.createElement("div"), { className: "menu-sep", role: "separator" }))
      continue
    }
    const b = document.createElement("button")
    b.type = "button"
    b.className = item.danger ? "menu-row danger" : "menu-row"
    b.setAttribute("role", "menuitem")
    b.tabIndex = -1
    b.textContent = item.label
    b.addEventListener("click", () => {
      closeMenu(true)
      item.run()
    })
    menu.append(b)
  }
  menuReturn = returnTo
  menu.style.transform = "translate(0, 0)"
  menu.hidden = false
  const m = menu.getBoundingClientRect()
  let x: number
  let y: number
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect()
    x = r.right - m.width
    y = r.bottom + 4
    if (y + m.height > window.innerHeight - 8) y = r.top - 4 - m.height
  } else {
    x = at.x
    y = at.y
    if (y + m.height > window.innerHeight - 8) y = at.y - m.height
  }
  x = Math.min(Math.max(8, x), window.innerWidth - m.width - 8)
  y = Math.max(8, y)
  menu.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
  menu.querySelector<HTMLButtonElement>("button")?.focus()
}

document.addEventListener("pointerdown", (e) => {
  if (menuEl && !menuEl.hidden && !menuEl.contains(e.target as Node)) closeMenu()
})
window.addEventListener("blur", () => closeMenu())
window.addEventListener("resize", () => closeMenu())

/** Brief confirmation beside a control ("Copied"), also read out by screen readers. */
export function flash(node: HTMLElement, text: string) {
  const key = node.dataset.focusKey
  if (!node.isConnected && key) node = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) ?? node
  const tip = document.getElementById("tooltip")
  const live = document.getElementById("announce")
  if (live) live.textContent = text
  if (!tip) return
  tip.textContent = text
  tip.hidden = false
  const r = node.getBoundingClientRect()
  const t = tip.getBoundingClientRect()
  const left = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8)
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(r.bottom + 6)}px)`
  setTimeout(() => {
    if (tip.textContent === text) tip.hidden = true
  }, 1200)
}
