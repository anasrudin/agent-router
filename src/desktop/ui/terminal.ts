import type { ClientMessage, ServerMessage, TerminalInfo } from "../../server/protocol"

/**
 * The terminal dock under the chat: tabs of real terminals (a shell in the chat's folder, or
 * Conductor's own session in the Claude Code CLI, as Ghostex keeps the raw CLI one key away).
 * xterm.js loads the first time the dock opens. Terminals live in the core, so they survive a
 * reload of the window; their scrollback comes back on attach.
 */
interface View {
  term: import("@xterm/xterm").Terminal
  fit: import("@xterm/addon-fit").FitAddon
  el: HTMLElement
}

export interface DockOptions {
  dock: HTMLElement
  tabs: HTMLElement
  body: HTMLElement
  send: (m: ClientMessage) => void
  request: (m: ClientMessage & { requestId: string }) => Promise<ServerMessage>
  nextId: () => string
  workspace: () => string
  /** The composer's text, handed to the CLI when Conductor's session opens there. */
  draft: () => string
  report: (message: string) => void
}

let xterm: Promise<[typeof import("@xterm/xterm"), typeof import("@xterm/addon-fit")]> | undefined

function theme() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: v("--color-terminal"),
    foreground: v("--color-ink"),
    cursor: v("--color-focus"),
    selectionBackground: v("--color-selected"),
  }
}

export function setupDock(o: DockOptions) {
  const views = new Map<string, View>()
  /** Terminals waiting for their scrollback: live output before it is already in it. */
  const attaching = new Set<string>()
  let list: TerminalInfo[] = []
  let active: string | undefined

  const fitActive = () => {
    const v = active ? views.get(active) : undefined
    if (!v || o.dock.hidden) return
    v.fit.fit()
    o.send({ type: "term.resize", id: active as string, cols: v.term.cols, rows: v.term.rows })
  }
  new ResizeObserver(() => requestAnimationFrame(fitActive)).observe(o.body)

  async function view(id: string): Promise<View> {
    const have = views.get(id)
    if (have) return have
    xterm ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
    const [{ Terminal }, { FitAddon }] = await xterm
    const el = document.createElement("div")
    el.className = "term-view"
    el.hidden = true
    o.body.append(el)
    const css = getComputedStyle(document.documentElement)
    const term = new Terminal({
      fontFamily: css.getPropertyValue("--font-mono"),
      fontSize: 13,
      cursorBlink: true,
      theme: theme(),
      allowProposedApi: false,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    term.onData((data) => o.send({ type: "term.input", id, data }))
    const v = { term, fit, el }
    views.set(id, v)
    attaching.add(id)
    o.send({ type: "term.attach", id })
    return v
  }

  function drawTabs() {
    o.tabs.replaceChildren()
    for (const t of list) {
      const tab = document.createElement("div")
      tab.className = `dock-tab${t.id === active ? " active" : ""}${t.running ? "" : " exited"}`
      const b = document.createElement("button")
      b.type = "button"
      b.className = "dock-tab-label"
      b.setAttribute("role", "tab")
      b.setAttribute("aria-selected", String(t.id === active))
      b.textContent = t.running ? t.title : `${t.title} (exited)`
      b.title = `${t.command}\n${t.cwd}`
      b.addEventListener("click", () => void select(t.id))
      const x = document.createElement("button")
      x.type = "button"
      x.className = "icon-btn dock-tab-close"
      x.title = "Close terminal"
      x.setAttribute("aria-label", `Close ${t.title}`)
      x.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>`
      x.addEventListener("click", () => o.send({ type: "term.close", id: t.id }))
      tab.append(b, x)
      o.tabs.append(tab)
    }
  }

  async function select(id: string) {
    active = id
    drawTabs()
    const v = await view(id)
    for (const [key, other] of views) other.el.hidden = key !== id
    requestAnimationFrame(() => {
      fitActive()
      v.term.focus()
    })
  }

  async function open(kind: "shell" | "conductor") {
    const workspace = o.workspace()
    if (!workspace) {
      o.report("Choose a workspace folder first.")
      return
    }
    reveal()
    const v0 = active ? views.get(active) : undefined
    const msg = await o.request({
      type: "term.open",
      requestId: o.nextId(),
      workspace,
      kind,
      cols: v0?.term.cols ?? 100,
      rows: v0?.term.rows ?? 20,
      draft: kind === "conductor" ? o.draft() : undefined,
    })
    if (msg.type !== "term.opened") return
    if (msg.error || !msg.terminal) {
      o.report(msg.error ?? "Could not open a terminal.")
      return
    }
    if (!list.some((t) => t.id === msg.terminal?.id)) list = [...list, msg.terminal]
    await select(msg.terminal.id)
  }

  function reveal() {
    o.dock.hidden = false
    document.querySelector("#toggle-dock")?.setAttribute("aria-pressed", "true")
  }

  function show(on: boolean) {
    o.dock.hidden = !on
    document.querySelector("#toggle-dock")?.setAttribute("aria-pressed", String(on))
    if (on && !list.length) void open("shell")
    else if (on && active) void select(active)
    else if (on && list[0]) void select(list[0].id)
  }

  return {
    toggle: () => show(Boolean(o.dock.hidden)),
    show,
    open,
    onMessage(msg: ServerMessage): boolean {
      switch (msg.type) {
        case "terminals":
          list = msg.items
          for (const id of [...views.keys()])
            if (!list.some((t) => t.id === id)) {
              views.get(id)?.term.dispose()
              views.get(id)?.el.remove()
              views.delete(id)
            }
          if (active && !list.some((t) => t.id === active)) {
            active = list.at(-1)?.id
            if (active) void select(active)
          }
          drawTabs()
          if (!list.length && !o.dock.hidden) show(false)
          return true
        case "term.output":
          if (!attaching.has(msg.id)) views.get(msg.id)?.term.write(msg.data)
          return true
        case "term.scrollback":
          attaching.delete(msg.id)
          views.get(msg.id)?.term.write(msg.data)
          return true
        case "term.exit": {
          views.get(msg.id)?.term.write(`\r\n\x1b[2m[exited${msg.code === null ? "" : ` with code ${msg.code}`}]\x1b[0m\r\n`)
          return true
        }
        default:
          return false
      }
    },
  }
}
