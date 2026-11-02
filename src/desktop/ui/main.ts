import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import type { PermissionMode } from "../../backends/Backend"
import type { QuotaSnapshot, QuotaWindow } from "../../backends/events"
import type { ProviderId } from "../../config/schema"
import type {
  BackendStatus,
  BudgetState,
  Card,
  ChatMeta,
  ClientMessage,
  DelegationBrief,
  DelegationSummary,
  IdeState,
  ProfileInfo,
  ProfileRow,
  PromptTemplate,
  QueuedPrompt,
  RouteRow,
  Schedule,
  ServerMessage,
  ThreadCheckpoint,
  UsageSummary,
  WireEvent,
  WorktreeList,
  WorktreePreview,
} from "../../server/protocol"
import { fileLines, setupAnnotator } from "./annotate"
import { type Annotation, formatAnnotations, MARK_LABELS } from "./annotations"
import { setupAppearance } from "./appearance"
import { setupBoard } from "./board"
import { renderChart } from "./chart"
import { closePopovers, flash, installTooltips, type MenuItem, openMenu, overlayScrollbar, popover } from "./chrome"
import { type Command, expandTemplate, PromptHistory } from "./composer"
import { fileBase64, setupComposer } from "./composer-ui"
import { type DiffFile, formatReview, parseUnifiedDiff, type ReviewComment } from "./diff"
import { sortable } from "./drag"
import { createEditor, type EditorHandle } from "./editor"
import { parseDrawing, renderDrawing } from "./excalidraw"
import { type FileContent, linkifyFileRefs, renderFileView } from "./fileview"
import { setupFind } from "./find"
import { agentLogoSvg } from "./icons"
import { escapeHtml, renderMarkdown, renderMarkdownBlocks, resultLine } from "./markdown"
import { setupMinimap } from "./minimap"
import { notifyIfAway } from "./notify"
import { type PaletteItem, setupPalette } from "./palette"
import { renderBrowser, renderFileTree } from "./panels"
import { type Answer, formatAnswers, letter, type QuestionForm, splitQuestions } from "./questions"
import { createSettings } from "./settings"
import { canSpeak, chime, toggleSpeech } from "./speech"
import { setupDock } from "./terminal"
import { activityLine, editStats, outputTail, toolDetail, toolLabel } from "./tools"

interface ServerInfo {
  url: string
  token: string
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const log = $<HTMLElement>("log")
const promptBox = $<HTMLTextAreaElement>("prompt")
const sendButton = $<HTMLButtonElement>("send")
const permissionSelect = $<HTMLSelectElement>("permission")
const profileSelect = $<HTMLSelectElement>("profile")
const planSelect = $<HTMLSelectElement>("plan")
const banner = $<HTMLDivElement>("banner")

const PROVIDER_LABEL: Record<ProviderId, string> = { claude: "Claude", gemini: "Gemini", openai: "Codex" }
/** The name a request uses to pin a backend (@codex, /route … codex). */
const PROVIDER_KEYWORD: Record<ProviderId, string> = { claude: "claude", gemini: "gemini", openai: "codex" }

/** A read-only thread's brief again, pinned to another backend, without Conductor; the two compare side by side. */
function rerunThread(t: Thread, provider: ProviderId) {
  if (!t.brief || !state.workspace) return
  send({
    type: "thread.rerun",
    workspace: state.workspace,
    threadId: t.id,
    taskClass: t.taskClass,
    brief: t.brief,
    provider,
    permission: permissionSelect.value as PermissionMode,
    profile: profileSelect.value || undefined,
  })
  flash($("chat-title"), `Running it again on ${PROVIDER_LABEL[provider]}`)
}

/** Per-viewer conveniences only; with storage blocked (or full) they last until the window closes. */
const memory = new Map<string, string>()
const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`agent-router.${key}`) ?? memory.get(key) ?? null
    } catch {
      return memory.get(key) ?? null
    }
  },
  set(key: string, value: string) {
    memory.set(key, value)
    try {
      localStorage.setItem(`agent-router.${key}`, value)
    } catch {}
  },
  remove(key: string) {
    memory.delete(key)
    try {
      localStorage.removeItem(`agent-router.${key}`)
    } catch {}
  },
  json<T>(key: string, fallback: T): T {
    try {
      return (JSON.parse(prefs.get(key) ?? "null") as T) ?? fallback
    } catch {
      return fallback
    }
  },
}

const state = {
  socket: undefined as WebSocket | undefined,
  workspace: prefs.get("workspace") ?? "",
  running: false,
  turnEl: undefined as HTMLElement | undefined,
  /** This turn's "Worked for" fold: Conductor's own work, folded once the turn ends. */
  fold: undefined as { el: HTMLDetailsElement; body: HTMLElement; started: number; tools: number; activity: string } | undefined,
  /** Tool rows by their call id, so a result finds its row. */
  tools: new Map<string, HTMLElement>(),
  threads: new Map<string, Thread>(),
  /** The thread open in the detail panel; undefined shows Conductor's chat alone. */
  selected: undefined as string | undefined,
  /** The chat's first request, which names it in the sidebar. */
  chatTitle: "",
  backends: undefined as BackendStatus | undefined,
  /** Live subscription usage, newest report per backend. */
  quota: {} as QuotaSnapshot,
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  /** The saved chat on screen (and the one requests go to); undefined for a new chat before its first request. */
  chat: undefined as ChatMeta | undefined,
  chats: [] as ChatMeta[],
  /** While a reopened chat's messages are drawn: no notifications, and times come from the record. */
  replaying: false,
  replayAt: undefined as number | undefined,
  /** The connection's greeting is pending: reopen the chat that was on screen. */
  greeting: false,
  /** A file open in the side panel, in place of a thread. */
  file: undefined as
    | {
        path: string
        line?: number
        endLine?: number
        content?: FileContent & { image?: string }
        view: "source" | "preview" | "image" | "drawing"
      }
    | undefined,
  /** The sidebar row being renamed. */
  renaming: undefined as string | undefined,
  /** While replaying a long chat, its older turns go here, folded behind "Show earlier turns". */
  earlier: undefined as HTMLElement | undefined,
  queue: [] as QueuedPrompt[],
  queuePaused: false,
  /** Notes made on files and reports, waiting to be sent. */
  notes: [] as Annotation[],
  /** Where a new chat will run, picked before its first request. */
  newChatRun: { mode: "here" } as { mode: "here" } | { mode: "new"; base: string } | { mode: "existing"; path: string },
  worktrees: undefined as WorktreeList | undefined,
  schedules: [] as Schedule[],
  /** The side panel's view when no thread or file is open in it. */
  panel: undefined as "files" | "browser" | "chat" | undefined,
  /** Another chat, read beside the open one (the side panel's chat view). */
  refChat: undefined as { id: string; title: string; text?: string; error?: string } | undefined,
  ide: { state: "missing", canInstall: false } as IdeState,
  browser: { url: "", nonce: 0 },
  files: undefined as string[] | undefined,
  fileFilter: "",
  openDirs: new Set<string>(),
  view: "chat" as View,
  /** A board card started as a chat, waiting for that chat's id. */
  runningCard: undefined as string | undefined,
  budget: undefined as BudgetState | undefined,
  version: "",
  templates: [] as PromptTemplate[],
  /** The last request sent, to send again past a budget ("Send anyway"). */
  lastStart: undefined as Extract<ClientMessage, { type: "start" }> | undefined,
}

/** The folder the chat works in: its worktree when it runs in one, else the workspace. */
const runDir = () => state.chat?.runIn ?? state.workspace

/** Where top-level transcript items go: the chat, or the folded "earlier turns" while replaying a long chat. */
const top = () => state.earlier ?? log

/** Now, or the recorded time of the message being replayed. */
const now = () => state.replayAt ?? Date.now()
const notify = (title: string, body: string) => {
  if (!state.replaying) notifyIfAway(title, body)
}
const savedChat = prefs.get("chat")

function el(tag: string, className?: string, html?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

function append(node: HTMLElement, parent: HTMLElement = state.turnEl ?? top()) {
  $("empty")?.remove()
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120
  parent.append(node)
  if (nearBottom) log.scrollTop = log.scrollHeight
}

function send(message: ClientMessage) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message))
  else showBanner("Not connected to the agent-router core.")
}

/** The banner above the composer, optionally with one action (such as Send anyway). */
function showBanner(text: string | undefined, action?: { label: string; run: () => void }) {
  banner.hidden = !text
  $("banner-text").textContent = text ?? ""
  const b = $<HTMLButtonElement>("banner-action")
  b.hidden = !action
  b.textContent = action?.label ?? ""
  b.onclick = action
    ? () => {
        showBanner(undefined)
        action.run()
      }
    : null
}

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** Cost is only what the CLIs report (Claude does; Gemini and Codex report tokens only). */
function addUsage(usd: number | undefined, input = 0, output = 0) {
  state.costUsd += usd ?? 0
  state.tokensIn += input
  state.tokensOut += output
  const cost = $("cost")
  cost.replaceChildren(
    Object.assign(el("span"), { textContent: `$${state.costUsd.toFixed(4)}` }),
    Object.assign(el("span"), { textContent: `${compact(state.tokensIn + state.tokensOut)} tokens` }),
  )
  cost.title = `Reported this session: $${state.costUsd.toFixed(4)}, ${state.tokensIn.toLocaleString()} input (cache reads included) and ${state.tokensOut.toLocaleString()} output tokens. Gemini and Codex do not report cost.`
}

function setRunning(running: boolean) {
  state.running = running
  updateSendButton()
  renderSidebar()
  renderStrip()
  renderQueue(state.queue, state.queuePaused)
}

/** While a turn runs the button stops it, unless there is text to queue behind it. */
function updateSendButton() {
  const stop = state.running && !promptBox.value.trim()
  sendButton.classList.toggle("stop", stop)
  sendButton.title = stop ? "Stop" : state.running ? "Queue: runs when the current turn ends" : "Send"
  sendButton.setAttribute("aria-label", sendButton.title)
}

// ── Prompt queue ────────────────────────────────────────────────────────

const ICON = {
  up: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>`,
  close: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>`,
  edit: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3-8 8H2.5v-3z" /></svg>`,
  play: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z" /></svg>`,
  grip: `<svg class="grip-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="4" r=".9" /><circle cx="10" cy="4" r=".9" /><circle cx="6" cy="8" r=".9" /><circle cx="10" cy="8" r=".9" /><circle cx="6" cy="12" r=".9" /><circle cx="10" cy="12" r=".9" /></svg>`,
  speak: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6h2.5l3.5-3v10l-3.5-3H2.5zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9" /></svg>`,
}

function iconButton(icon: string, label: string, run: () => void, cls = "icon-btn"): HTMLButtonElement {
  const b = el("button", cls, icon) as HTMLButtonElement
  b.type = "button"
  b.title = label
  b.setAttribute("aria-label", label)
  b.addEventListener("click", run)
  return b
}

/**
 * Requests waiting for the turn, as Ghostex shows its queue: drag (or Alt+arrows) to reorder,
 * Edit takes one back into the composer, Play stops the turn and runs it now.
 */
function renderQueue(items: QueuedPrompt[], paused: boolean) {
  state.queue = items
  state.queuePaused = paused
  const box = $("queue")
  const focusKey = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("#queue [data-focus-key]")?.dataset.focusKey
  box.replaceChildren()
  box.hidden = !items.length
  if (paused) {
    const head = el("div", "queue-paused")
    head.append(Object.assign(el("span"), { textContent: "Queue paused after Stop." }))
    const resume = el("button", "ghost small") as HTMLButtonElement
    resume.type = "button"
    resume.textContent = "Resume"
    resume.addEventListener("click", () => items[0] && send({ type: "queue.send", id: items[0].id }))
    head.append(resume)
    box.append(head)
  }
  const list = el("div", "queue-list")
  items.forEach((item, i) => {
    const row = el("div", "queue-row")
    row.dataset.id = item.id
    row.tabIndex = 0
    row.dataset.focusKey = `q:${item.id}`
    row.setAttribute("aria-label", `Queued ${i + 1} of ${items.length}: ${item.prompt}. Alt+arrows reorder.`)
    const label = el("span", "queue-text")
    label.textContent = item.prompt
    label.title = item.prompt
    const grip = el("span", "queue-grip", ICON.grip)
    grip.title = "Drag to reorder"
    row.append(
      grip,
      Object.assign(el("span", "queue-num"), { textContent: String(i + 1) }),
      label,
      iconButton(ICON.edit, "Edit: back to the composer", () => {
        send({ type: "queue.take", id: item.id })
        promptBox.value = promptBox.value.trim() ? `${promptBox.value}\n${item.prompt}` : item.prompt
        promptBox.focus()
        updateSendButton()
      }),
      ...(state.running
        ? [iconButton(ICON.play, "Stop the turn and run this now", () => send({ type: "queue.interrupt", id: item.id }))]
        : []),
      iconButton(ICON.up, i === 0 ? "Send now when idle" : "Send next", () => send({ type: "queue.send", id: item.id })),
      iconButton(ICON.close, "Remove from queue", () => send({ type: "queue.remove", id: item.id })),
    )
    row.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
      e.preventDefault()
      send({ type: "queue.move", id: item.id, to: i + (e.key === "ArrowUp" ? -1 : 1) })
    })
    list.append(row)
  })
  box.append(list)
  if (focusKey) box.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus()
}

// ── Workspace and backends ──────────────────────────────────────────────

function setWorkspace(dir: string) {
  const changed = !samePath(dir, state.workspace)
  state.workspace = dir
  prefs.set("workspace", dir)
  if (dir) {
    rememberWorkspace(dir)
    if (changed) setGroupOpen(dir, true)
  }
  showWorkspacePath(dir)
  if (dir) send({ type: "status", workspace: dir })
  renderSidebar()
  if (changed) {
    state.files = undefined
    if (state.view === "board") board.load()
  }
  // On first connect too, not only when the folder changes.
  if (changed || !state.worktrees) loadWorktrees()
  if (dir) send({ type: "templates.list", workspace: dir })
}

function showWorkspacePath(dir: string) {
  const name = dir ? folderName(dir) : ""
  $("workspace-path").textContent = "Open folder…"
  $("crumb-workspace").textContent = name || "No folder"
  $("crumb-workspace").title = dir
}

function renderProfiles(profiles: ProfileInfo[], defaultProfile: string | undefined) {
  const saved = prefs.get("profile")
  profileSelect.replaceChildren()
  for (const p of profiles) {
    const option = new Option(p.name === defaultProfile ? `${p.label} (default)` : p.label, p.name)
    option.title = p.description
    profileSelect.add(option)
  }
  const chosen = profiles.find((p) => p.name === saved)?.name ?? defaultProfile ?? profiles[0]?.name ?? ""
  profileSelect.value = chosen
  profileSelect.title = profiles.find((p) => p.name === chosen)?.description ?? ""
  renderModeSummary()
}

/** Presets plus "as configured" (the config's own plan, or none); the choice is remembered per machine. */
function renderPlans(plans: ProfileInfo[], configured: string | undefined) {
  const saved = prefs.get("plan") ?? ""
  planSelect.replaceChildren(new Option(configured ? "As configured" : "None set", ""))
  ;(planSelect.options[0] as HTMLOptionElement).title = configured ?? "No plan: routing as configured, no plan-based limits"
  for (const p of plans) {
    const option = new Option(p.label, p.name)
    option.title = p.description
    planSelect.add(option)
  }
  planSelect.value = plans.some((p) => p.name === saved) ? saved : ""
  planSelect.title = planSelect.selectedOptions[0]?.title ?? ""
  renderModeSummary()
}

/** "5h 72%, resets Sat 14:10" */
function describeWindow(w: QuotaWindow): string {
  const reset = w.resetsAt
    ? `, resets ${new Date(w.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : ""
  return `${w.label} ${Math.round(w.usedFraction * 100)}%${w.limited ? " (limit reached)" : ""}${reset}`
}

/** Windows whose reset time has passed count as empty again. */
function currentWindows(p: ProviderId): QuotaWindow[] {
  const now = Date.now()
  return (state.quota[p]?.windows ?? []).map((w) =>
    w.resetsAt !== undefined && w.resetsAt <= now ? { ...w, usedFraction: 0, limited: false, resetsAt: undefined } : w,
  )
}

function recordQuota(p: ProviderId, windows: QuotaWindow[]) {
  // A replayed chat's old windows are history, not the account's usage now.
  if (state.replaying) return
  state.quota[p] = { windows, at: Date.now() }
  if (state.backends) renderBackends(state.backends)
}

function renderBackends(status: BackendStatus) {
  state.backends = status
  for (const p of Object.keys(status.quota ?? {}) as ProviderId[]) {
    const known = status.quota[p]
    if (known && known.at > (state.quota[p]?.at ?? 0)) state.quota[p] = known
  }
  const box = $("backends")
  box.replaceChildren()
  for (const p of Object.keys(status.health) as ProviderId[]) {
    const h = status.health[p]
    const windows = currentWindows(p)
    const fullest = windows.reduce<QuotaWindow | undefined>((a, w) => (!a || w.usedFraction > a.usedFraction ? w : a), undefined)
    const level = !fullest ? "" : fullest.limited || fullest.usedFraction >= 0.9 ? "bad" : fullest.usedFraction >= 0.7 ? "warn" : "ok"
    const chip = el(
      "span",
      "chip",
      `<span class="dot ${h.healthy ? "ok" : "bad"}"></span><span class="chip-name">${PROVIDER_LABEL[p]}</span>${
        fullest ? `<span class="chip-quota ${level}">${Math.round(fullest.usedFraction * 100)}%</span>` : ""
      }`,
    )
    const detail = h.healthy
      ? `${status.executables[p]} ${h.version ?? ""}`.trim()
      : `${status.executables[p]}: ${h.reason ?? "unavailable"}`
    const usage = windows.length ? `\nUsage: ${windows.map(describeWindow).join("; ")}` : ""
    // The name hides on narrow windows, so the tooltip and the accessible name carry it too.
    chip.title = `${PROVIDER_LABEL[p]}: ${detail}${usage}`
    chip.setAttribute("aria-label", chip.title)
    box.append(chip)
  }
  if (!status.health.claude.healthy)
    showBanner("Conductor runs on Claude Code, which is not available. Install it and sign in, then reopen the app.")
  renderStatusbar()
  renderSidebar()
}

/**
 * The line under the composer, as Ghostex's: Claude's usage windows (Conductor runs on it), the
 * chat's spend, its threads, and the branch with its uncommitted lines.
 */
function renderStatusbar() {
  const quota = $("quota")
  quota.replaceChildren()
  const windows = currentWindows("claude")
  for (const w of windows) {
    const level = w.limited || w.usedFraction >= 0.9 ? "bad" : w.usedFraction >= 0.7 ? "warn" : ""
    const item = el("span", `quota-window ${level}`)
    item.append(
      Object.assign(el("span", "muted"), { textContent: w.label }),
      document.createTextNode(` ${Math.round(w.usedFraction * 100)}%`),
    )
    item.title = `Claude ${describeWindow(w)}`
    quota.append(item)
  }
  const git = $("git")
  git.replaceChildren()
  const g = state.backends?.git
  if (g) {
    git.append(
      Object.assign(el("span", "branch"), {
        innerHTML: `<svg class="branch-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" /></svg>`,
      }),
    )
    ;(git.querySelector(".branch") as HTMLElement).append(document.createTextNode(g.branch))
    if (g.added || g.removed)
      git.append(
        Object.assign(el("span", "add mono"), { textContent: `+${g.added}` }),
        Object.assign(el("span", "del mono"), { textContent: `−${g.removed}` }),
      )
    git.title = `${g.branch}: ${g.files} file${g.files === 1 ? "" : "s"} changed, not committed`
  }
}

// ── Conductor turn rendering ────────────────────────────────────────────

const describeTool = toolDetail
/** Tools whose output is worth a look in the transcript; a Read's output is just the file. */
const OUTPUT_TOOLS = new Set(["Bash", "Grep", "Glob", "WebFetch", "WebSearch"])

/** A Markdown block of a reply: rendered, its source kept for Copy, its file references clickable. */
function mdBlock(text: string): HTMLElement {
  const block = el("div", "md", renderMarkdown(text))
  block.dataset.source = text
  linkifyFileRefs(block, openFile, (url) => openUrl(url))
  resolveImages(block)
  pageCards(block)
  return block
}

/** Pictures in replies: workspace images load as data URLs; a click opens them large. */
function resolveImages(root: HTMLElement) {
  for (const img of root.querySelectorAll<HTMLImageElement>("img[data-src]")) {
    const src = img.dataset.src as string
    img.removeAttribute("data-src")
    img.tabIndex = 0
    img.setAttribute("role", "button")
    img.title = `${img.alt || src} (click to enlarge)`
    const show = () => img.src && openLightbox(img.src, img.alt || src)
    img.addEventListener("click", show)
    img.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault()
        show()
      }
    })
    void loadImage(src).then((url) => {
      if (url) img.src = url
      else img.replaceWith(Object.assign(el("span", "muted"), { textContent: `(picture not found: ${src})` }))
    })
  }
}

const imageCache = new Map<string, Promise<string | undefined>>()
function loadImage(path: string): Promise<string | undefined> {
  const key = `${runDir()}::${path}`
  let p = imageCache.get(key)
  if (!p) {
    p = request({ type: "file.image", requestId: nextRequestId(), workspace: runDir(), path }).then((m) =>
      m.type === "file.imaged" ? m.dataUrl : undefined,
    )
    imageCache.set(key, p)
  }
  return p
}

function openLightbox(src: string, alt: string) {
  const box = $<HTMLDialogElement>("lightbox")
  box.querySelector("img")?.remove()
  const img = document.createElement("img")
  img.src = src
  img.alt = alt
  box.prepend(img)
  if (!box.open) box.showModal()
}

/** An HTML page a reply points at gets a card that opens its preview (Ghostex's page cards). */
function pageCards(block: HTMLElement) {
  const seen = new Set<string>()
  for (const link of block.querySelectorAll<HTMLButtonElement>(".file-link")) {
    const path = /^(\S+\.html?)(:\d+)?$/i.exec(link.textContent ?? "")?.[1]
    if (!path || seen.has(path)) continue
    seen.add(path)
    const card = el("button", "page-card") as HTMLButtonElement
    card.type = "button"
    card.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 5.5h12" /></svg>`
    card.append(
      Object.assign(el("span", "page-name"), { textContent: path.slice(path.lastIndexOf("/") + 1) }),
      Object.assign(el("span", "muted"), { textContent: "Open the page" }),
    )
    card.title = `Preview ${path}`
    card.addEventListener("click", () => openFile(path, undefined, undefined, "preview"))
    block.append(card)
  }
}

function copyButton(text: () => string, label: string): HTMLButtonElement {
  const b = el("button", "icon-btn msg-action") as HTMLButtonElement
  b.type = "button"
  b.title = label
  b.setAttribute("aria-label", label)
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M10.5 5V3.5A1 1 0 0 0 9.5 2.5h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1H5" /></svg>`
  b.addEventListener("click", () => copyText(text(), b))
  return b
}

/** The line under a message: its time and a Copy button. */
function messageMeta(at: number, text: () => string, label: string, extra: HTMLElement[] = []): HTMLElement {
  const meta = el("div", "msg-meta")
  const time = document.createElement("time")
  time.dateTime = new Date(at).toISOString()
  time.textContent = clock(at)
  time.title = new Date(at).toLocaleString()
  meta.append(time, copyButton(text, label), ...extra)
  return meta
}

/** Read aloud, where the webview has a voice. */
function speakButton(text: () => string): HTMLElement[] {
  if (!canSpeak()) return []
  const b = iconButton(ICON.speak, "Read aloud", () => toggleSpeech(text(), b), "icon-btn msg-action")
  b.setAttribute("aria-pressed", "false")
  return [b]
}

/** A sound for the moments that want you (Ghostex's sound notifications), when turned on. */
function sound(kind: "done" | "attention") {
  if (!state.replaying && prefs.get("sound") === "on") chime(kind)
}

/**
 * The pinned working strip above the composer (Ghostex's): what Conductor is doing now and each
 * running thread's latest step, in view however far the chat is scrolled. A thread opens on click.
 */
function renderStrip() {
  trayStatus()
  const strip = $("strip")
  const running = [...state.threads.values()].filter((t) => !t.summary && !t.error)
  strip.hidden = !state.running || state.replaying
  if (strip.hidden) return
  const now = el("span", "strip-now")
  now.append(el("span", "spinner"), Object.assign(el("span", "strip-text"), { textContent: `${state.fold?.activity ?? "Starting"}…` }))
  const chips = running.map((t) => {
    const chip = el("button", "strip-thread") as HTMLButtonElement
    chip.type = "button"
    const last = t.activity.at(-1)
    chip.title = `${t.agent} on ${PROVIDER_LABEL[t.provider]}: ${t.task}${last ? `\nNow: ${last.text}` : ""}`
    chip.append(glyph(t.provider), Object.assign(el("span", "strip-text"), { textContent: last ? last.text : taskTitle(t.task) }))
    chip.addEventListener("click", () => selectThread(t.id))
    return chip
  })
  strip.replaceChildren(now, ...chips)
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "chat"

/** Save to Markdown (Ghostex's): a chat rendered from its record, or a thread's report, where the save dialog says. */
async function saveMarkdown(name: string, payload: { chatId?: string; text?: string }) {
  const path = await save({ defaultPath: `${runDir() || "."}/${slug(name)}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] })
  if (!path) return
  const msg = await request({ type: "export.save", requestId: nextRequestId(), path, ...payload })
  if (msg.type !== "export.saved") return
  if (msg.error) showBanner(msg.error)
  else flash($("chat-title"), `Saved to ${path}`)
}

const LONG_PROMPT = { lines: 10, chars: 900 }

/** The user's request as a bubble; a long one is clamped with Show more, as Ghostex folds long prompts. */
function userMessage(prompt: string, at: number): HTMLElement {
  const wrap = el("div", "msg msg-user")
  const bubble = el("div", "user")
  bubble.textContent = prompt
  wrap.append(bubble)
  if (prompt.split("\n").length > LONG_PROMPT.lines || prompt.length > LONG_PROMPT.chars) {
    bubble.classList.add("clamped")
    const more = el("button", "ghost small more") as HTMLButtonElement
    more.type = "button"
    more.textContent = "Show more"
    more.setAttribute("aria-expanded", "false")
    more.addEventListener("click", () => {
      const open = bubble.classList.toggle("expanded")
      more.textContent = open ? "Show less" : "Show more"
      more.setAttribute("aria-expanded", String(open))
    })
    wrap.append(more)
  }
  // Attached pictures show as thumbnails under the request.
  const pictures = [...prompt.matchAll(/(?:^|\s)@(\S+\.(?:png|jpe?g|gif|webp|bmp|svg))/gi)].map((m) => m[1] as string)
  if (pictures.length) {
    const strip = el("div", "thumbs")
    for (const path of pictures) {
      const img = document.createElement("img")
      img.className = "md-img thumb"
      img.dataset.src = path
      img.alt = path.slice(path.lastIndexOf("/") + 1)
      strip.append(img)
    }
    wrap.append(strip)
    resolveImages(strip)
  }
  wrap.append(messageMeta(at, () => prompt, "Copy request"))
  return wrap
}

/*
 * A turn always reads in the same order, whatever order its events come in:
 *   1. the fold: Conductor's own text and tool calls while it works ("Worked for Ns" once done),
 *   2. the delegation cards,
 *   3. the reply (the text after the last tool call, moved out of the fold at the end), then any
 *      question form or error.
 * Both the fold and the cards' group are created on first use and put in their place.
 */

/** The turn's fold, created with Conductor's first text or tool call (Ghostex: one per turn, its work collapsed). */
function turnFold() {
  if (state.fold) return state.fold
  const fold = document.createElement("details")
  fold.className = "turn-fold"
  fold.open = true
  const summary = document.createElement("summary")
  const body = el("div", "fold-body")
  fold.append(summary, body)
  $("empty")?.remove()
  if (state.turnEl) state.turnEl.prepend(fold)
  else append(fold)
  state.fold = { el: fold, body, started: now(), tools: 0, activity: "Thinking" }
  renderFoldSummary(state.fold, false)
  return state.fold
}

/** The turn's delegation cards, kept together right after the fold. */
function turnCards(): HTMLElement {
  const turn = state.turnEl
  if (!turn) return log
  const existing = turn.querySelector<HTMLElement>(":scope > .turn-cards")
  if (existing) return existing
  const cards = el("div", "turn-cards")
  const fold = turn.querySelector(":scope > .turn-fold")
  if (fold) fold.after(cards)
  else turn.prepend(cards)
  return cards
}

function renderFoldSummary(f: NonNullable<typeof state.fold>, done: boolean) {
  const summary = f.el.querySelector("summary") as HTMLElement
  const secs = Math.max(1, Math.round((now() - f.started) / 1000))
  const running = [...state.threads.values()].filter((t) => !t.summary && !t.error).length
  // While it works, the line says what it is doing now (Ghostex's working strip).
  const live = running && /^(Thinking|Delegating)/.test(f.activity) ? `Waiting on ${running} thread${running > 1 ? "s" : ""}` : f.activity
  if (!done) queueMicrotask(renderStrip)
  summary.replaceChildren(
    ...(done ? [] : [el("span", "spinner")]),
    Object.assign(el("span", `fold-title${done ? "" : " live"}`), {
      textContent: done ? `Worked for ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`}` : `${live}…`,
    }),
    ...(f.tools ? [Object.assign(el("span", "count-pill"), { textContent: `${f.tools} tool call${f.tools === 1 ? "" : "s"}` })] : []),
  )
}

/** At the turn's end: fold the work away and keep the final reply below it, where it is read. */
function closeFold() {
  const f = state.fold
  if (!f) return
  state.fold = undefined
  // The reply is every text block after the last tool call; it goes below the cards.
  const reply: Element[] = []
  for (let node = f.body.lastElementChild; node?.classList.contains("md"); node = node.previousElementSibling) reply.unshift(node)
  const turn = state.turnEl
  if (turn && reply.length) {
    const anchor = turn.querySelector(":scope > .turn-cards") ?? f.el
    anchor.after(...reply)
    const text = () => reply.map((b) => (b as HTMLElement).dataset.source ?? b.textContent ?? "").join("\n\n")
    ;(reply.at(-1) as Element).after(messageMeta(now(), text, "Copy reply", speakButton(text)))
  }
  // A turn that only talked has nothing left to fold.
  if (!f.body.childElementCount) {
    f.el.remove()
    return
  }
  renderFoldSummary(f, true)
  f.el.open = false
}

/** One tool call in the fold: what it is, what it touched, an edit's +/- lines; its result fills in later. */
function toolRow(name: string, input: unknown, id?: string): HTMLElement {
  const row = el("div", "tool")
  row.dataset.tool = name
  const head = el("div", "tool-head")
  head.append(
    Object.assign(el("span", "name"), { textContent: toolLabel(name) }),
    Object.assign(el("span", "tool-detail mono"), { textContent: describeTool(input), title: describeTool(input) }),
  )
  const stats = editStats(name, input)
  if (stats) {
    const s = el("span", "tool-stats mono")
    s.append(
      Object.assign(el("span", "add"), { textContent: `+${stats.added}` }),
      Object.assign(el("span", "del"), { textContent: `−${stats.removed}` }),
    )
    head.append(s)
  }
  row.append(head)
  if (id) state.tools.set(id, row)
  return row
}

function toolResult(ok: boolean, id: string | undefined, output: string | undefined) {
  const body = state.fold?.body
  const row = (id ? state.tools.get(id) : undefined) ?? [...(body?.querySelectorAll<HTMLElement>(".tool:not([data-done])") ?? [])][0]
  if (!row) return
  row.dataset.done = ok ? "ok" : "failed"
  if (!ok) {
    const head = row.querySelector(".tool-head") as HTMLElement
    head.append(Object.assign(el("span", "tool-failed"), { textContent: "failed" }))
  }
  if (output && (OUTPUT_TOOLS.has(row.dataset.tool ?? "") || !ok)) {
    const tail = outputTail(output)
    const box = document.createElement("details")
    box.className = "tool-output"
    const sum = document.createElement("summary")
    sum.textContent = tail.more ? "Output, last lines" : "Output"
    const pre = el("pre", "mono")
    pre.textContent = tail.text
    box.append(sum, pre)
    // A failure shows its output straight away: that is where the reason is.
    box.open = !ok
    row.append(box)
  }
}

function conductorEvent(event: WireEvent) {
  switch (event.type) {
    case "text":
      for (const seg of splitQuestions(event.text)) {
        if (seg.kind === "markdown") {
          append(mdBlock(seg.text), state.turnEl ? turnFold().body : top())
          if (state.fold) {
            state.fold.activity = "Writing"
            renderFoldSummary(state.fold, false)
          }
        } else {
          append(renderQuestionForm(seg.form))
          notify("agent-router: Conductor has questions", seg.form.title ?? seg.form.questions[0]?.question ?? "")
        }
      }
      return
    case "tool_call": {
      const fold = turnFold()
      // Delegations get their own card from the router; showing the raw call too would duplicate it.
      if (event.name.startsWith("mcp__router__")) {
        fold.activity = /delegate/.test(event.name) ? "Delegating" : `Checking (${toolLabel(event.name)})`
        renderFoldSummary(fold, false)
        return
      }
      append(toolRow(event.name, event.input, event.id), fold.body)
      fold.tools += 1
      fold.activity = activityLine(event.name, event.input)
      renderFoldSummary(fold, false)
      return
    }
    case "tool_result":
      toolResult(event.ok, event.id, event.output)
      return
    case "usage":
      addUsage(event.costUsd, event.inputTokens, event.outputTokens)
      return
    case "quota":
      // Conductor runs on Claude.
      recordQuota("claude", event.windows)
      return
    case "error":
      append(el("div", "error", escapeHtml(event.message)))
      return
    default:
      return
  }
}

// ── Question forms: Conductor asks, the answers go back as the next request ──

function renderQuestionForm(form: QuestionForm): HTMLElement {
  const card = el("article", "card questions")
  const answers: Record<string, Answer> = Object.fromEntries(form.questions.map((q) => [q.id, { picked: [] }]))
  card.append(Object.assign(el("h4"), { textContent: form.title ?? "Conductor asks" }))
  const controls: (HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement)[] = []
  form.questions.forEach((q, qi) => {
    const block = el("section", "question")
    block.append(Object.assign(el("p", "question-text"), { textContent: `${qi + 1}. ${q.question}` }))
    const a = answers[q.id] as Answer
    const buttons: HTMLButtonElement[] = []
    q.choices.forEach((c, ci) => {
      const b = el("button", "choice") as HTMLButtonElement
      b.type = "button"
      b.setAttribute("aria-pressed", "false")
      b.append(
        Object.assign(el("span", "choice-letter"), { textContent: letter(ci) }),
        Object.assign(el("span", "choice-label"), { textContent: c.label }),
      )
      if (c.recommended) b.append(Object.assign(el("span", "choice-rec"), { textContent: "recommended" }))
      if (c.description) b.append(Object.assign(el("span", "choice-desc"), { textContent: c.description }))
      b.addEventListener("click", () => {
        a.skipped = false
        if (q.multiple) a.picked = a.picked.includes(c.label) ? a.picked.filter((l) => l !== c.label) : [...a.picked, c.label]
        else a.picked = a.picked[0] === c.label ? [] : [c.label]
        for (const [i, other] of buttons.entries()) other.setAttribute("aria-pressed", String(a.picked.includes(q.choices[i]?.label ?? "")))
        skip.setAttribute("aria-pressed", "false")
      })
      buttons.push(b)
      controls.push(b)
      block.append(b)
    })
    const own = document.createElement(q.choices.length ? "input" : "textarea") as HTMLInputElement | HTMLTextAreaElement
    own.className = "question-own"
    own.placeholder = q.choices.length ? "Other (your own answer)" : "Your answer"
    if (own instanceof HTMLTextAreaElement) own.rows = 2
    own.addEventListener("input", () => {
      a.other = own.value
      if (own.value.trim()) {
        a.skipped = false
        skip.setAttribute("aria-pressed", "false")
      }
    })
    controls.push(own)
    const skip = el("button", "ghost small skip") as HTMLButtonElement
    skip.type = "button"
    skip.textContent = "Skip"
    skip.setAttribute("aria-pressed", "false")
    skip.addEventListener("click", () => {
      a.skipped = !a.skipped
      skip.setAttribute("aria-pressed", String(a.skipped))
    })
    controls.push(skip)
    const row = el("div", "question-own-row")
    row.append(own, skip)
    block.append(row)
    card.append(block)
  })
  const footer = el("div", "buttons")
  const submit = el("button", "primary") as HTMLButtonElement
  submit.type = "button"
  submit.textContent = "Send answers"
  const hint = Object.assign(el("span", "muted"), { textContent: "Unanswered questions are left to Conductor's judgement." })
  submit.addEventListener("click", () => {
    if (!startRequest(formatAnswers(form, answers))) return
    for (const c of [...controls, submit]) c.disabled = true
    card.classList.add("answered")
    hint.textContent = state.running ? "Sent: queued behind the current turn." : "Sent."
  })
  controls.push(submit)
  footer.append(submit, hint)
  card.append(footer)
  // Ghostex's keys: a letter picks that choice in the question holding focus (the first one
  // otherwise), Mod+Enter sends. Typing in an answer field is left alone.
  card.tabIndex = -1
  card.addEventListener("keydown", (e) => {
    if (card.classList.contains("answered")) return
    const target = e.target as HTMLElement
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      submit.click()
      return
    }
    if (target.matches("input, textarea") || e.metaKey || e.ctrlKey || e.altKey || !/^[a-z]$/i.test(e.key)) return
    const block = target.closest(".question") ?? card.querySelector(".question")
    const choice = block?.querySelectorAll<HTMLButtonElement>(".choice")[e.key.toLowerCase().charCodeAt(0) - 97]
    if (!choice) return
    e.preventDefault()
    choice.click()
    choice.focus()
  })
  return card
}

// ── Threads: one per delegation, in the sidebar, the chat and the detail panel ──

interface Thread {
  id: string
  /** Why the router sent it here, in plain lines. */
  why?: string[]
  /** Conductor's brief, for running it again elsewhere. */
  brief?: DelegationBrief
  /** The thread this one re-ran on another backend. */
  rerunOf?: string
  agent: string
  taskClass: string
  mode: string
  task: string
  provider: ProviderId
  model?: string
  tier: string
  status: string
  startedAt: number
  finishedAt?: number
  tokens: number
  activity: { who: string; text: string }[]
  summary?: DelegationSummary
  error?: string
  /** The thread's one-line card in the transcript. */
  chatRow?: HTMLElement
  /** The thread's diff between its checkpoints, once loaded. */
  diff?: { files: DiffFile[]; truncated: boolean; error?: string }
  diffRequested?: boolean
  /** Review comments not yet sent to Conductor. */
  comments: ReviewComment[]
  /** Lines picked for the next comment. */
  selection?: { file: string; side: "new" | "old"; start: number; end: number }
  draft?: string
  /** The detail panel's tab for this thread. */
  tab?: DetailTab
  /** "confirm" while the Revert button asks to be pressed again; the outcome once done. */
  revert?: "confirm" | { ok: boolean; message: string }
  /** Bringing a worktree thread's work in: last preview, the action awaiting a second press, the last outcome. */
  wt?: {
    preview?: WorktreePreview
    confirm?: "apply" | "remove" | "force"
    result?: { ok: boolean; message: string }
    busy?: boolean
    applied?: boolean
    gone?: boolean
  }
}

const threadsNav = $<HTMLElement>("threads")
const detail = $<HTMLElement>("detail")

function age(from: number, to = now()): string {
  const s = Math.max(0, Math.round((to - from) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

function statusText(t: Thread): string {
  if (t.error) return `Error: ${t.error}`
  if (!t.summary) return `Running on ${PROVIDER_LABEL[t.provider]} (${t.tier})`
  const line = resultLine(t.summary.report)
  switch (t.summary.status) {
    case "done":
      return `Done: ${line}`
    case "blocked":
      return `Needs you: ${line}`
    case "partial":
      return `Partly done: ${line}`
    default:
      return `Failed: ${t.summary.stopReason || line}`
  }
}

function glyph(provider: ProviderId): HTMLElement {
  const g = el("span", `glyph ${provider}`, agentLogoSvg(provider))
  g.title = PROVIDER_LABEL[provider]
  return g
}

const PEOPLE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5.5" cy="5.5" r="2" /><circle cx="11" cy="6" r="1.6" /><path d="M1.8 13a3.7 3.7 0 0 1 7.4 0M9.5 12.5a3 3 0 0 1 5 0" /></svg>`
const STATUS_WORDS: Record<string, string> = {
  running: "Working",
  done: "Done",
  partial: "Partly done",
  blocked: "Needs you",
  error: "Error",
  failed: "Failed",
}

function statusMark(status: string): HTMLElement {
  // A dot that carries live state; its word is in the tooltip and the accessible name.
  const mark = el("span", `mark s-${status}`)
  const word = STATUS_WORDS[status] ?? status
  mark.title = word
  mark.setAttribute("role", "img")
  mark.setAttribute("aria-label", word)
  return mark
}

const MORE_ICON = `<svg class="row-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>`
const STOP_ICON = `<svg class="row-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>`

/** A small icon button for a row's hover actions. */
function rowAction(icon: string, label: string, run: (button: HTMLButtonElement) => void): HTMLButtonElement {
  const b = el("button", "row-action", icon) as HTMLButtonElement
  b.type = "button"
  b.title = label
  b.setAttribute("aria-label", label)
  b.addEventListener("click", (e) => {
    e.stopPropagation()
    run(b)
  })
  return b
}

/**
 * A sidebar row as Ghostex draws one: the row itself is the button that opens it; on hover or
 * keyboard focus its actions replace the trailing details, and right-click (or the menu key)
 * opens the same actions as a menu.
 */
function sidebarItem(
  row: HTMLButtonElement,
  actions: HTMLButtonElement[],
  menu: () => MenuItem[],
  label: string,
  key: string,
): HTMLElement {
  const item = el("div", "tree-item")
  row.dataset.focusKey = `${key}:row`
  for (const a of actions) a.dataset.focusKey = `${key}:${a.getAttribute("aria-label")}`
  const bar = el("span", "row-actions")
  bar.append(...actions)
  item.append(row, bar)
  item.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    // The menu key and Shift+F10 send a contextmenu event with no pointer position.
    const fromKeyboard = e.clientX === 0 && e.clientY === 0
    openMenu(menu(), fromKeyboard ? row : { x: e.clientX, y: e.clientY }, row, label)
  })
  return item
}

function copyText(text: string, near: HTMLElement) {
  navigator.clipboard.writeText(text).then(
    () => flash(near, "Copied"),
    () => flash(near, "Could not copy"),
  )
}

/** Put a question about a thread in the composer, for Conductor to answer with the thread in view. */
function askAbout(t: Thread) {
  const task = t.task.length > 160 ? taskTitle(t.task) : t.task.trim().replace(/\.$/, "")
  promptBox.value = `About the thread "${task}" (${t.agent} on ${PROVIDER_LABEL[t.provider]}): `
  promptBox.focus()
  promptBox.setSelectionRange(promptBox.value.length, promptBox.value.length)
  updateSendButton()
}

function threadMenu(t: Thread, row: HTMLElement): MenuItem[] {
  const sum = t.summary
  const items: MenuItem[] = [
    { label: "Open thread", run: () => selectThread(t.id) },
    { label: "Ask Conductor about it", run: () => askAbout(t) },
    "separator",
    { label: "Copy task", run: () => copyText(t.task, row) },
  ]
  if (sum?.report)
    items.push(
      { label: "Copy report", run: () => copyText(sum.report, row) },
      {
        label: "Save report as Markdown…",
        run: () => void saveMarkdown(taskTitle(t.task), { text: `# ${taskTitle(t.task)}\n\n${sum.report}\n` }),
      },
    )
  const others = (Object.keys(PROVIDER_LABEL) as ProviderId[]).filter((p) => p !== t.provider)
  if (t.brief?.mode === "read-only" && t.finishedAt)
    items.push("separator", ...others.map((p): MenuItem => ({ label: `Run again on ${PROVIDER_LABEL[p]}`, run: () => rerunThread(t, p) })))
  else if (t.brief && t.finishedAt)
    items.push(
      "separator",
      ...others.map(
        (p): MenuItem => ({
          label: `Ask Conductor to redo it on ${PROVIDER_LABEL[p]}`,
          run: () => {
            promptBox.value = `/route ${t.taskClass} ${PROVIDER_KEYWORD[p]}\nRedo the thread "${taskTitle(t.task)}" on ${PROVIDER_LABEL[p]}, with the same brief, and compare its result with the first one.`
            promptBox.focus()
            updateSendButton()
          },
        }),
      ),
    )
  const worktree = sum?.worktree
  if (worktree && !t.wt?.gone)
    items.push("separator", {
      label: "Preview worktree merge",
      run: () => {
        t.tab = "changes"
        selectThread(t.id)
        worktreeAction(t, worktree, "preview")
      },
    })
  const revertible = sum?.checkpoint?.after && !t.wt?.gone && !(typeof t.revert === "object" && t.revert.ok)
  if (revertible)
    items.push("separator", {
      label: "Revert thread…",
      danger: true,
      // The panel still asks for a second press before anything changes.
      run: () => {
        t.revert = "confirm"
        t.tab = "changes"
        selectThread(t.id)
        detail.querySelector(".changes-bar")?.scrollIntoView({ block: "nearest" })
      },
    })
  return items
}

const CHAT_ICON = `<svg class="row-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7.5h-6.5l-3 2.5V11h-1.5z" /></svg>`
const CROWN_ICON = `<svg class="crown" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5h12M2.5 11 1.8 5l3.6 2.6L8 3l2.6 4.6L14.2 5l-.7 6z" /></svg>`
const FOLDER_ICON = `<svg class="row-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>`
const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>`

/** Paths compared as the server would: separators and a trailing slash do not matter. */
const pathKey = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "")
const samePath = (a: string, b: string) => pathKey(a) === pathKey(b)
const folderName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir

/** Folders opened before, newest first, so their chats stay one click away. */
function recentWorkspaces(): string[] {
  return prefs.json<string[]>("workspaces", [])
}
function rememberWorkspace(dir: string) {
  prefs.set("workspaces", JSON.stringify([dir, ...recentWorkspaces().filter((d) => !samePath(d, dir))].slice(0, 8)))
}
function forgetWorkspace(dir: string) {
  prefs.set("workspaces", JSON.stringify(recentWorkspaces().filter((d) => !samePath(d, dir))))
}
/** Which workspace groups are open: the current one by default, others closed. */
function groupOpen(dir: string): boolean {
  const saved = prefs.json<Record<string, boolean>>("groups", {})[pathKey(dir)]
  return saved ?? samePath(dir, state.workspace)
}
function setGroupOpen(dir: string, open: boolean) {
  prefs.set("groups", JSON.stringify({ ...prefs.json<Record<string, boolean>>("groups", {}), [pathKey(dir)]: open }))
}
const showAll = new Set<string>()

function currentChatMenu(row: HTMLElement): MenuItem[] {
  const items: MenuItem[] = [{ label: "Show conversation", run: () => selectThread(undefined) }]
  if (state.running) items.push({ label: "Stop the turn", danger: true, run: () => send({ type: "cancel" }) })
  if (state.chat) items.push("separator", ...chatActions(state.chat, row))
  items.push("separator", { label: "New chat", run: () => newChat() })
  return items
}

/** Pin, rename, copy and delete: the same for every saved chat. */
function chatActions(c: ChatMeta, row: HTMLElement): MenuItem[] {
  return [
    { label: c.pinned ? "Unpin" : "Pin", run: () => send({ type: "chat.update", id: c.id, pinned: !c.pinned }) },
    {
      label: "Rename…",
      run: () => {
        state.renaming = c.id
        renderSidebar()
      },
    },
    { label: "Copy title", run: () => copyText(c.title, row) },
    { label: "Save as Markdown…", run: () => void saveMarkdown(c.title, { chatId: c.id }) },
    "separator",
    {
      label: "Delete chat…",
      danger: true,
      // A second, explicit choice before anything is deleted.
      run: () =>
        openMenu(
          [
            {
              label: `Delete "${c.title.length > 40 ? `${c.title.slice(0, 39)}…` : c.title}"`,
              danger: true,
              run: () => send({ type: "chat.delete", id: c.id }),
            },
            { label: "Keep it", run: () => {} },
          ],
          row,
          row,
          "Delete this chat?",
        ),
    },
  ]
}

function chatMenu(c: ChatMeta, row: HTMLElement): MenuItem[] {
  return [
    { label: "Open chat", run: () => openChat(c) },
    { label: "Read beside this chat", run: () => openBeside(c) },
    "separator",
    ...chatActions(c, row),
  ]
}

/** Another chat in the side panel, read-only, beside the one you work in (a split view). */
function openBeside(c: ChatMeta) {
  if (!leaveEditor(() => openBeside(c))) return
  const ref: NonNullable<typeof state.refChat> = { id: c.id, title: c.title }
  state.refChat = ref
  state.panel = "chat"
  state.selected = undefined
  state.file = undefined
  detail.hidden = false
  renderSidebar()
  renderDetail()
  void request({ type: "chat.markdown", requestId: nextRequestId(), id: c.id }).then((m) => {
    if (m.type !== "chat.markdowned" || state.refChat !== ref) return
    ref.text = m.text
    ref.error = m.error
    if (state.panel === "chat") renderDetail()
  })
}

function renderChatBeside() {
  const ref = state.refChat
  const g = $("detail-glyph")
  g.className = "glyph file"
  g.innerHTML = CHAT_ICON.replace("row-icon", "file-icon")
  $("detail-title").textContent = ref?.title ?? "Chat"
  $("detail-tabs").hidden = true
  const body = $("detail-body")
  body.replaceChildren()
  if (!ref) return
  const bar = el("div", "file-bar")
  bar.append(Object.assign(el("span", "muted"), { textContent: "Read-only, beside the open chat" }))
  const target = state.chats.find((c) => c.id === ref.id)
  if (target) bar.append(textButton("Switch to it", "ghost small", () => openChat(target)))
  body.append(bar)
  if (ref.error) body.append(Object.assign(el("div", "error"), { textContent: ref.error }))
  else if (!ref.text) body.append(Object.assign(el("div", "muted"), { textContent: "Loading the chat…" }))
  // Its first line is the title, already in the header.
  else body.append(mdBlock(ref.text.replace(/^# .*\n+/, "")))
}

function openChat(c: ChatMeta) {
  if (state.chat?.id === c.id) {
    selectThread(undefined)
    return
  }
  if (state.running) {
    showBanner("Stop the running turn before opening another chat.")
    return
  }
  send({ type: "chat.open", id: c.id })
}

function renderSidebar() {
  const list = [...state.threads.values()]
  // The tree is rebuilt every second while threads run; keep keyboard focus where it was.
  const focusKey = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("#threads [data-focus-key]")?.dataset.focusKey
  const scroll = threadsNav.scrollTop
  threadsNav.replaceChildren()
  const dirs: string[] = []
  const add = (d: string) => {
    if (d && !dirs.some((x) => samePath(x, d))) dirs.push(d)
  }
  add(state.workspace)
  const space = activeSpace()
  for (const d of recentWorkspaces()) add(d)
  for (const c of state.chats) add(c.workspace)
  // A space shows its own folders (and the one you are in).
  if (space)
    for (let i = dirs.length - 1; i >= 0; i--)
      if (!samePath(dirs[i] as string, state.workspace) && !space.folders.some((f) => samePath(f, dirs[i] as string))) dirs.splice(i, 1)
  if (space) for (const f of space.folders) add(f)
  for (const dir of dirs) renderGroup(dir, list)
  threadsNav.scrollTop = scroll
  if (focusKey) threadsNav.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus()
  if (state.renaming) threadsNav.querySelector<HTMLInputElement>(".rename")?.focus()
  const running = list.filter((t) => !t.summary && !t.error).length
  $("status-threads").textContent = list.length
    ? `${list.length} thread${list.length > 1 ? "s" : ""}${running ? `, ${running} running` : ""}`
    : ""
}

/** A workspace: its row (name, uncommitted +/- for the current one), then its pinned chats and sessions. */
function renderGroup(dir: string, threads: Thread[]) {
  const current = samePath(dir, state.workspace)
  const open = groupOpen(dir)
  const head = el("button", `tree-row group${current ? " current" : ""}`) as HTMLButtonElement
  head.type = "button"
  head.setAttribute("aria-expanded", String(open))
  head.title = dir
  head.innerHTML = `${CHEVRON}${FOLDER_ICON}<span class="row-title"></span>`
  ;(head.querySelector(".row-title") as HTMLElement).textContent = folderName(dir)
  const git = current ? state.backends?.git : undefined
  if (git && (git.added || git.removed)) {
    const stats = el("span", "row-tail git-stats mono")
    stats.append(
      Object.assign(el("span", "add"), { textContent: `+${git.added}` }),
      Object.assign(el("span", "del"), { textContent: `−${git.removed}` }),
    )
    stats.title = `${git.files} file${git.files === 1 ? "" : "s"} changed on ${git.branch}, not committed`
    head.append(stats)
  }
  head.addEventListener("click", () => {
    setGroupOpen(dir, !open)
    renderSidebar()
  })
  const key = `ws:${pathKey(dir)}`
  const groupMenu = (): MenuItem[] => {
    const items: MenuItem[] = [{ label: current ? "New chat" : "New chat in this folder", run: () => newChat(dir) }]
    items.push({ label: "Copy path", run: () => copyText(dir, head) })
    const sp = spaceItems(dir)
    if (sp.length) items.push("separator", ...sp)
    if (!current && !state.chats.some((c) => samePath(c.workspace, dir)))
      items.push("separator", {
        label: "Remove from sidebar",
        run: () => {
          forgetWorkspace(dir)
          renderSidebar()
        },
      })
    return items
  }
  const more = rowAction(MORE_ICON, "Folder actions", (b) => openMenu(groupMenu(), b, b, "Folder actions"))
  threadsNav.append(sidebarItem(head, [more], groupMenu, "Folder actions", key))
  if (!open) return

  const chats = state.chats.filter((c) => samePath(c.workspace, dir))
  if (state.chat && current && !chats.some((c) => c.id === state.chat?.id)) chats.unshift(state.chat)
  const pinned = chats.filter((c) => c.pinned)
  const rest = chats.filter((c) => !c.pinned)
  if (!chats.length) {
    threadsNav.append(Object.assign(el("div", "tree-note muted"), { textContent: current ? "No chats yet" : "No saved chats" }))
    return
  }
  if (pinned.length) {
    threadsNav.append(Object.assign(el("div", "tree-label"), { textContent: "Pinned" }))
    for (const c of pinned) renderChatRow(c, threads)
  }
  if (rest.length) {
    if (pinned.length) threadsNav.append(Object.assign(el("div", "tree-label"), { textContent: "Sessions" }))
    const limit = showAll.has(key) ? rest.length : 12
    // The open chat always shows, however far down the list it is.
    const visible = rest.filter((c, i) => i < limit || c.id === state.chat?.id)
    for (const c of visible) renderChatRow(c, threads)
    if (rest.length > visible.length) {
      const moreRow = el("button", "tree-row tree-more") as HTMLButtonElement
      moreRow.type = "button"
      moreRow.textContent = `Show ${rest.length - visible.length} more`
      moreRow.addEventListener("click", () => {
        showAll.add(key)
        renderSidebar()
      })
      threadsNav.append(moreRow)
    }
  }
}

function renderChatRow(c: ChatMeta, threads: Thread[]) {
  const isCurrent = state.chat?.id === c.id
  if (state.renaming === c.id) {
    const item = el("div", "tree-row chat renaming")
    const input = document.createElement("input")
    input.className = "rename"
    input.value = c.title
    input.setAttribute("aria-label", "Chat name")
    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      state.renaming = undefined
      const title = input.value.trim()
      if (save && title && title !== c.title) send({ type: "chat.update", id: c.id, title })
      renderSidebar()
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true)
      if (e.key === "Escape") {
        e.stopPropagation()
        finish(false)
      }
    })
    input.addEventListener("blur", () => finish(true))
    item.append(input)
    threadsNav.append(item)
    return
  }
  const row = el("button", `tree-row chat${isCurrent && !state.selected && !state.file ? " selected" : ""}`) as HTMLButtonElement
  row.type = "button"
  row.title = c.title
  row.innerHTML = `${isCurrent ? CROWN_ICON : CHAT_ICON}<span class="row-title"></span>`
  ;(row.querySelector(".row-title") as HTMLElement).textContent = isCurrent && state.chatTitle && !c.title ? state.chatTitle : c.title
  if (isCurrent && threads.length) {
    // The crew badge: people and a count, as Ghostex marks a coordinator's threads.
    const count = el("span", "row-count row-tail", `${PEOPLE_ICON}<span>${threads.length}</span>`)
    count.title = `${threads.length} thread${threads.length > 1 ? "s" : ""}`
    row.append(count)
  } else if (!(isCurrent && state.running)) {
    row.append(
      Object.assign(el("span", "row-age row-tail"), {
        textContent: age(c.updatedAt, Date.now()),
        title: new Date(c.updatedAt).toLocaleString(),
      }),
    )
  }
  if (isCurrent && state.running) row.append(statusMark("running"))
  row.addEventListener("click", () => openChat(c))
  const menu = () => (isCurrent ? currentChatMenu(row) : chatMenu(c, row))
  const actions = [rowAction(MORE_ICON, "More actions", (b) => openMenu(menu(), b, b, "Chat actions"))]
  if (isCurrent && state.running) actions.unshift(rowAction(STOP_ICON, "Stop the turn", () => send({ type: "cancel" })))
  threadsNav.append(sidebarItem(row, actions, menu, "Chat actions", `chat:${c.id}`))
  if (isCurrent) renderThreadRows(threads)
}

function renderThreadRows(list: Thread[]) {
  for (const t of list) {
    const row = el("button", `tree-row thread${state.selected === t.id ? " selected" : ""}`) as HTMLButtonElement
    row.type = "button"
    row.title = `${t.agent}, ${t.taskClass}\n${t.task}`
    const title = el("span", "row-title")
    title.textContent = taskTitle(t.task)
    const tail = el("span", "row-age row-tail")
    tail.textContent = age(t.startedAt, t.finishedAt ?? Date.now())
    row.append(glyph(t.provider), title, statusMark(t.error ? "error" : (t.summary?.status ?? "running")), tail)
    row.addEventListener("click", () => selectThread(t.id))
    const more = rowAction(MORE_ICON, "More actions", (b) => openMenu(threadMenu(t, row), b, b, "Thread actions"))
    threadsNav.append(sidebarItem(row, [more], () => threadMenu(t, row), "Thread actions", t.id))
  }
}

/** A thread's name: its task in a few words, like a Ghostex thread title. */
function taskTitle(task: string): string {
  const first = task.split(/(?<=[.!?])\s/)[0] ?? task
  return first.length > 60 ? `${first.slice(0, 57)}…` : first.replace(/\.$/, "")
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

/**
 * A delegation in the transcript: one line, like Ghostex's "Message to" cards. The agent's mark,
 * who ran it and its task, the time, and a status pill; it opens the thread.
 */
function renderAgentCard(t: Thread) {
  if (!t.chatRow) return
  const status = t.error ? "error" : (t.summary?.status ?? "running")
  const who = el("span", "card-who")
  who.append(
    Object.assign(el("strong"), { textContent: t.agent.charAt(0).toUpperCase() + t.agent.slice(1) }),
    Object.assign(el("span", "muted"), { textContent: ` on ${PROVIDER_LABEL[t.provider]}` }),
  )
  const pill = el("span", `pill ${status}`)
  pill.textContent = STATUS_WORDS[status] ?? status
  t.chatRow.replaceChildren(
    glyph(t.provider),
    who,
    Object.assign(el("span", "card-task"), { textContent: taskTitle(t.task) }),
    Object.assign(el("span", "card-time muted"), { textContent: clock(t.startedAt) }),
    pill,
  )
  t.chatRow.title = `${statusText(t)}${t.why?.[0] ? `\n${t.why[0]}` : ""}`
  if (t.rerunOf) t.chatRow.querySelector(".card-who .muted")?.append(document.createTextNode(", re-run"))
}

/** The Threads pill above the composer: the count, the most urgent state, and a menu of this chat's threads. */
const URGENCY = ["blocked", "error", "failed", "partial", "running", "done"]

function renderThreadsPill() {
  const list = [...state.threads.values()]
  const pill = $<HTMLButtonElement>("threads-pill")
  pill.hidden = list.length === 0
  if (!list.length) {
    closePopovers()
    return
  }
  const statuses = list.map((t) => (t.error ? "error" : (t.summary?.status ?? "running")))
  const top = URGENCY.find((s) => statuses.includes(s)) ?? "done"
  $("threads-pill-dot").className = `mark s-${top}`
  const running = statuses.filter((s) => s === "running").length
  $("threads-pill-count").textContent = running ? `${running} of ${list.length} working` : String(list.length)
  const menu = $("threads-menu")
  menu.replaceChildren()
  for (const t of list) {
    const row = el("button", "menu-row") as HTMLButtonElement
    row.type = "button"
    row.setAttribute("role", "menuitem")
    const text = el("span", "menu-text")
    text.append(
      Object.assign(el("span", "menu-title"), { textContent: taskTitle(t.task) }),
      Object.assign(el("span", "menu-detail"), { textContent: statusText(t) }),
    )
    row.append(statusMark(t.error ? "error" : (t.summary?.status ?? "running")), glyph(t.provider), text)
    row.addEventListener("click", () => {
      closePopovers()
      selectThread(t.id)
    })
    menu.append(row)
  }
}

function selectThread(id: string | undefined) {
  if (!leaveEditor(() => selectThread(id))) return
  state.selected = id
  state.file = undefined
  if (id) state.panel = undefined
  detail.hidden = !id && !state.panel
  renderSidebar()
  renderDetail()
}

/** A file in the side panel at a line, from a reference in a reply or a report. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
const PREVIEWABLE = /\.(md|markdown|html?)$/i

function openFile(path: string, line?: number, endLine?: number, mode?: "preview" | "source") {
  if (!state.workspace) return
  if (!leaveEditor(() => openFile(path, line, endLine, mode))) return
  // Markdown and HTML open rendered unless a line was asked for; pictures always show as pictures.
  const view = IMAGE_FILE.test(path)
    ? "image"
    : /\.excalidraw$/i.test(path)
      ? mode === "source"
        ? "source"
        : "drawing"
      : PREVIEWABLE.test(path)
        ? (mode ?? (line ? "source" : "preview"))
        : "source"
  const file: NonNullable<typeof state.file> = { path, line, endLine, view }
  if (view === "image") {
    state.file = file
    detail.hidden = false
    renderDetail()
    void loadImage(path).then((url) => {
      if (state.file !== file) return
      file.content = url
        ? { path, text: "", truncated: false, image: url }
        : { path, text: "", truncated: false, error: `Could not show ${path}.` }
      renderDetail()
    })
    return
  }
  state.file = file
  detail.hidden = false
  renderDetail()
  renderSidebar()
  void request({ type: "file.read", requestId: nextRequestId(), workspace: runDir(), path }).then((msg) => {
    if (msg.type !== "file.content" || state.file !== file) return
    file.content = msg
    renderDetail()
  })
}

function closeDetail() {
  if (!leaveEditor(closeDetail)) return
  if (state.file && (state.selected || state.panel)) {
    state.file = undefined
    renderDetail()
    renderSidebar()
    return
  }
  state.panel = undefined
  selectThread(undefined)
}

/** Open the side panel on the file tree or the browser, or close it when it already shows that. */
function togglePanel(panel: "files" | "browser" | "chat", url?: string) {
  if (!leaveEditor(() => togglePanel(panel, url))) return
  const showing = state.panel === panel && !state.selected && !state.file && !detail.hidden
  if (showing && !url) {
    closeDetail()
    return
  }
  state.panel = panel
  state.selected = undefined
  state.file = undefined
  if (url) state.browser = { url, nonce: state.browser.nonce + 1 }
  detail.hidden = false
  if (panel === "files") loadFiles()
  renderSidebar()
  renderDetail()
}

function loadFiles() {
  const dir = runDir()
  if (!dir) return
  void request({ type: "files.list", requestId: nextRequestId(), workspace: dir, query: "", limit: 20_000 }).then((m) => {
    if (m.type !== "files.listed") return
    state.files = m.files
    if (state.panel === "files" && !state.file && !state.selected) renderDetail()
  })
}

// ── A thread's diff: review comments and revert ────────────────────────

/** Backends whose delegate sessions take a follow-up (resume). */
const RESUMABLE: ReadonlySet<ProviderId> = new Set(["claude", "openai"])
const pendingRequests = new Map<string, (msg: ServerMessage) => void>()
let requestCounter = 0

function request(message: ClientMessage & { requestId: string }): Promise<ServerMessage> {
  return new Promise((resolve) => {
    pendingRequests.set(message.requestId, resolve)
    send(message)
  })
}
const nextRequestId = () => `r-${++requestCounter}`

function loadDiff(t: Thread) {
  const checkpoint = t.summary?.checkpoint
  if (!checkpoint || t.diffRequested) return
  t.diffRequested = true
  void request({ type: "thread.diff", requestId: nextRequestId(), workspace: runDir(), checkpoint }).then((msg) => {
    if (msg.type !== "thread.diff") return
    t.diff = msg.error
      ? { files: [], truncated: false, error: msg.error }
      : { files: parseUnifiedDiff(msg.patch), truncated: msg.truncated }
    if (state.selected === t.id && !state.file) renderDetail()
  })
}

function pickLine(t: Thread, file: string, side: "new" | "old", line: number, extend: boolean) {
  const s = t.selection
  t.selection =
    extend && s && s.file === file && s.side === side
      ? { file, side, start: Math.min(s.start, line), end: Math.max(s.end, line) }
      : { file, side, start: line, end: line }
  renderDetail()
  ;(document.querySelector(".comment-form textarea") as HTMLTextAreaElement | null)?.focus()
}

function commentForm(t: Thread): HTMLElement {
  const s = t.selection as NonNullable<Thread["selection"]>
  const form = el("div", "comment-form")
  const where = s.start === s.end ? `line ${s.start}` : `lines ${s.start}-${s.end}`
  form.append(
    Object.assign(el("div", "muted"), {
      textContent: `Comment on ${where}${s.side === "old" ? " (deleted)" : ""}. Shift-click another line for a range.`,
    }),
  )
  const box = document.createElement("textarea")
  box.rows = 2
  box.placeholder = "What should change here?"
  box.value = t.draft ?? ""
  box.addEventListener("input", () => {
    t.draft = box.value
  })
  const add = el("button", "primary small") as HTMLButtonElement
  add.type = "button"
  add.textContent = "Add comment"
  const cancel = el("button", "ghost small") as HTMLButtonElement
  cancel.type = "button"
  cancel.textContent = "Cancel"
  const commit = () => {
    const text = box.value.trim()
    if (!text) return
    t.comments.push({ ...s, text })
    t.selection = undefined
    t.draft = undefined
    renderDetail()
  }
  add.addEventListener("click", commit)
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit()
    if (e.key === "Escape") cancel.click()
  })
  cancel.addEventListener("click", () => {
    t.selection = undefined
    t.draft = undefined
    renderDetail()
  })
  const buttons = el("div", "buttons")
  buttons.append(add, cancel)
  form.append(box, buttons)
  return form
}

function renderFileDiff(t: Thread, f: DiffFile, open: boolean): HTMLElement {
  const box = document.createElement("details")
  box.className = "diff-file"
  box.open = open
  const added = f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0)
  const removed = f.hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0)
  const summary = el("summary", "mono")
  const name = f.status === "renamed" ? `${f.oldPath} → ${f.path}` : f.path
  summary.append(
    Object.assign(el("span", "diff-name"), { textContent: name }),
    Object.assign(el("span", "diff-count"), { textContent: f.binary ? "binary" : `+${added} −${removed}` }),
  )
  box.append(summary)
  const table = el("div", "diff-lines mono")
  const sel = t.selection?.file === f.path ? t.selection : undefined
  for (const h of f.hunks) {
    table.append(Object.assign(el("div", "diff-hunk"), { textContent: h.header }))
    for (const line of h.lines) {
      const side = line.kind === "del" ? "old" : "new"
      const no = (side === "old" ? line.old : line.new) as number
      const row = el("div", `diff-row ${line.kind}`)
      if (sel && sel.side === side && no >= sel.start && no <= sel.end) row.classList.add("selected")
      const num = el("button", "diff-num") as HTMLButtonElement
      num.type = "button"
      num.textContent = `${line.old ?? ""}`
      num.title = "Comment on this line (shift-click for a range)"
      const num2 = Object.assign(el("span", "diff-num2"), { textContent: `${line.new ?? ""}` })
      const code = Object.assign(el("span", "diff-code"), {
        textContent: `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}${line.text}`,
      })
      row.append(num, num2, code)
      row.addEventListener("click", (e) => pickLine(t, f.path, side, no, (e as MouseEvent).shiftKey))
      table.append(row)
      for (const c of t.comments.filter((c) => c.file === f.path && c.side === side && c.end === no)) {
        const note = el("div", "diff-comment")
        note.append(Object.assign(el("span"), { textContent: c.text }))
        const drop = el("button", "icon-btn") as HTMLButtonElement
        drop.type = "button"
        drop.title = "Remove comment"
        drop.setAttribute("aria-label", drop.title)
        drop.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>`
        drop.addEventListener("click", (e) => {
          e.stopPropagation()
          t.comments = t.comments.filter((x) => x !== c)
          renderDetail()
        })
        note.append(drop)
        table.append(note)
      }
      if (sel && sel.side === side && sel.end === no) table.append(commentForm(t))
    }
  }
  box.append(table)
  return box
}

function renderChanges(t: Thread): HTMLElement {
  if (t.wt?.gone && !t.diff) {
    return Object.assign(el("div", "muted"), { textContent: "The worktree was removed, so this thread's diff is no longer available." })
  }
  loadDiff(t)
  const box = el("div", "changes")
  const bar = el("div", "changes-bar")
  const sum = t.summary as DelegationSummary
  if (t.comments.length) {
    const sendBtn = el("button", "primary small") as HTMLButtonElement
    sendBtn.type = "button"
    sendBtn.textContent = `Send ${t.comments.length} comment${t.comments.length > 1 ? "s" : ""} to Conductor`
    sendBtn.title = state.running ? "Queued behind the current turn" : "Conductor hands them to this delegate and checks the fix"
    sendBtn.addEventListener("click", () => {
      const prompt = formatReview(
        {
          title: taskTitle(t.task),
          agent: t.agent,
          taskClass: t.taskClass,
          provider: sum.provider,
          sessionId: sum.sessionId,
          resumable: RESUMABLE.has(sum.provider),
        },
        t.comments,
      )
      if (startRequest(prompt)) {
        t.comments = []
        renderDetail()
      }
    })
    bar.append(sendBtn)
  }
  // A removed worktree's checkout is gone, so there is nothing left to revert in.
  const worktreeGone = Boolean(t.wt?.gone)
  const revert = el("button", "ghost small danger") as HTMLButtonElement
  revert.hidden = worktreeGone
  revert.type = "button"
  const noun = t.taskClass === "turn" ? "turn" : "thread"
  revert.textContent = t.revert === "confirm" ? "Confirm revert" : `Revert ${noun}`
  revert.title = "Undo this thread's changes in its checkout. Refused if the files changed since."
  revert.disabled = typeof t.revert === "object" && t.revert.ok
  revert.addEventListener("click", () => {
    if (t.revert !== "confirm") {
      t.revert = "confirm"
      renderDetail()
      return
    }
    const checkpoint = sum.checkpoint as NonNullable<DelegationSummary["checkpoint"]>
    void request({
      type: "thread.revert",
      requestId: nextRequestId(),
      workspace: runDir(),
      checkpoint,
      title: taskTitle(t.task),
    }).then((msg) => {
      if (msg.type !== "thread.reverted") return
      t.revert = { ok: msg.ok, message: msg.message }
      renderDetail()
    })
  })
  bar.append(revert)
  if (t.revert === "confirm") {
    const cancel = el("button", "ghost small") as HTMLButtonElement
    cancel.type = "button"
    cancel.textContent = "Cancel"
    cancel.addEventListener("click", () => {
      t.revert = undefined
      renderDetail()
    })
    bar.append(cancel)
  }
  box.append(bar)
  if (typeof t.revert === "object")
    box.append(Object.assign(el("div", t.revert.ok ? "notice ok" : "error"), { textContent: t.revert.message }))
  if (!t.diff) {
    box.append(Object.assign(el("div", "muted"), { textContent: "Loading the diff…" }))
    return box
  }
  if (t.diff.error) {
    box.append(Object.assign(el("div", "error"), { textContent: t.diff.error }))
    return box
  }
  if (!t.diff.files.length) box.append(Object.assign(el("div", "muted"), { textContent: "This thread changed no files." }))
  else
    box.append(
      Object.assign(el("div", "muted hint-line"), {
        textContent:
          t.taskClass === "turn"
            ? "Click a line to comment on it. Comments go to Conductor."
            : "Click a line to comment on it. Comments go to Conductor, which hands them to this delegate.",
      }),
    )
  t.diff.files.forEach((f, i) => {
    box.append(renderFileDiff(t, f, i < 6))
  })
  if (t.diff.truncated)
    box.append(Object.assign(el("div", "muted"), { textContent: "The diff is cut off here: it is too large to show in full." }))
  return box
}

// ── A worktree thread: bring its work into the workspace ───────────────

function worktreeAction(t: Thread, worktree: string, action: "preview" | "apply" | "remove", force = false) {
  if (!t.wt) t.wt = {}
  const wt = t.wt
  wt.busy = true
  wt.confirm = undefined
  renderDetail()
  void request({
    type: "worktree.action",
    requestId: nextRequestId(),
    workspace: runDir(),
    worktree,
    action,
    force,
    title: taskTitle(t.task),
  }).then((msg) => {
    if (msg.type !== "worktree.result") return
    wt.busy = false
    if (msg.preview) wt.preview = msg.preview
    wt.result = action === "preview" && msg.ok ? undefined : { ok: msg.ok, message: msg.message }
    if (action !== "preview" && msg.ok) {
      // What the preview said no longer holds once the work is in or the worktree is gone.
      wt.preview = undefined
      if (action === "apply") wt.applied = true
      else wt.gone = true
    }
    if (state.selected === t.id && !state.file) renderDetail()
  })
}

function renderWorktree(t: Thread, worktree: string): HTMLElement {
  if (!t.wt) t.wt = {}
  const wt = t.wt
  const box = el("div", "worktree")
  box.append(Object.assign(el("div", "mono facts"), { textContent: worktree }))
  const bar = el("div", "changes-bar")
  const button = (label: string, cls: string, onClick: () => void, disabled = false) => {
    const b = el("button", `${cls} small`) as HTMLButtonElement
    b.type = "button"
    b.textContent = label
    b.disabled = disabled || Boolean(wt.busy) || Boolean(wt.gone)
    b.addEventListener("click", onClick)
    bar.append(b)
  }
  const second = (action: NonNullable<NonNullable<Thread["wt"]>["confirm"]>) => () => {
    if (wt.confirm === action) worktreeAction(t, worktree, action === "force" ? "remove" : action, action === "force")
    else {
      wt.confirm = action
      renderDetail()
    }
  }
  button("Preview merge", "ghost", () => worktreeAction(t, worktree, "preview"))
  button(
    wt.applied ? "Applied" : wt.confirm === "apply" ? "Confirm apply" : "Apply to workspace",
    "primary",
    second("apply"),
    wt.preview?.appliesCleanly === false || Boolean(wt.applied),
  )
  const refused = wt.result && !wt.result.ok && /not in the workspace yet/.test(wt.result.message)
  if (refused) button(wt.confirm === "force" ? "Confirm discard" : "Remove and discard", "ghost danger", second("force"))
  else button(wt.confirm === "remove" ? "Confirm remove" : "Remove worktree", "ghost", second("remove"))
  if (wt.confirm) {
    button("Cancel", "ghost", () => {
      wt.confirm = undefined
      renderDetail()
    })
  }
  box.append(bar)
  if (wt.busy) box.append(Object.assign(el("div", "muted"), { textContent: "Working…" }))
  const p = wt.preview
  if (p) {
    const lines = el("ul", "facts preview-list")
    const li = (text: string, cls = "") => lines.append(Object.assign(el("li", cls), { textContent: text }))
    li(`Changed: ${p.files.join(", ") || "nothing"}`)
    li(
      p.conflicts.length ? `Conflicts with HEAD: ${p.conflicts.join(", ")}` : "No conflicts with HEAD",
      p.conflicts.length ? "bad" : "good",
    )
    li(
      p.appliesCleanly ? "Applies cleanly to the workspace as it is now" : "Does not apply cleanly to the workspace as it is now",
      p.appliesCleanly ? "good" : "bad",
    )
    if (p.unmergedCommits) li(`Its branch has ${p.unmergedCommits} commit(s) the workspace lacks`)
    box.append(lines)
    if (p.applyError) box.append(Object.assign(el("pre", "mono apply-error"), { textContent: p.applyError }))
  }
  if (wt.result) box.append(Object.assign(el("div", wt.result.ok ? "notice ok" : "error"), { textContent: wt.result.message }))
  return box
}

type DetailTab = "overview" | "changes" | "route" | "activity" | "compare"
const TAB_LABELS: Record<DetailTab, string> = {
  overview: "Overview",
  changes: "Changes",
  route: "Route",
  activity: "Activity",
  compare: "Compare",
}

/** The other side of a re-run: the original for a re-run, the latest re-run for an original. */
function counterpart(t: Thread): Thread | undefined {
  if (t.rerunOf) return state.threads.get(t.rerunOf)
  return [...state.threads.values()].filter((x) => x.rerunOf === t.id).at(-1)
}

function threadTabs(t: Thread): DetailTab[] {
  if (t.taskClass === "turn") return ["changes"]
  const sum = t.summary
  const tabs: DetailTab[] = ["overview"]
  if (sum?.worktree || sum?.checkpoint?.after || sum?.changedFiles.length) tabs.push("changes")
  if (sum) tabs.push("route")
  if (t.activity.length) tabs.push("activity")
  if (counterpart(t)) tabs.push("compare")
  return tabs
}

/** The panel's tabs, as a tablist: arrows move between them, the chosen one is the only tab stop. */
function renderTabs(t: Thread, tabs: DetailTab[], active: DetailTab) {
  const bar = $("detail-tabs")
  bar.hidden = tabs.length < 2
  bar.replaceChildren()
  for (const tab of tabs) {
    const b = el("button", "tab") as HTMLButtonElement
    b.type = "button"
    b.id = `tab-${tab}`
    b.setAttribute("role", "tab")
    b.setAttribute("aria-selected", String(tab === active))
    b.setAttribute("aria-controls", "detail-body")
    b.tabIndex = tab === active ? 0 : -1
    b.textContent = TAB_LABELS[tab]
    if (tab === "changes" && t.comments.length) b.append(Object.assign(el("span", "tab-count"), { textContent: String(t.comments.length) }))
    b.addEventListener("click", () => {
      t.tab = tab
      renderDetail()
      $("detail-tabs").querySelector<HTMLElement>(`#tab-${tab}`)?.focus()
    })
    b.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab)
      const next =
        e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i + tabs.length - 1) % tabs.length] : undefined
      if (!next) return
      e.preventDefault()
      t.tab = next
      renderDetail()
      $("detail-tabs").querySelector<HTMLElement>(`#tab-${next}`)?.focus()
    })
    bar.append(b)
  }
}

/** The bar above a file: back, where you are, and Edit / Save / Done or Open in VS Code and Copy. */
function fileBar(file: NonNullable<typeof state.file>, content: FileContent): HTMLElement {
  const bar = el("div", "file-bar")
  if (state.selected || state.panel) {
    const back = el("button", "ghost small") as HTMLButtonElement
    back.type = "button"
    back.textContent = state.selected ? "Back to the thread" : state.panel === "files" ? "Back to files" : "Back"
    back.addEventListener("click", closeDetail)
    bar.append(back)
  }
  bar.append(
    Object.assign(el("span", "muted"), {
      textContent: editing.dirty ? "Unsaved changes" : file.line ? `Line ${file.line}${file.endLine ? `-${file.endLine}` : ""}` : "",
    }),
  )
  if (editing.path === file.path && !content.error) {
    if (editing.ask)
      bar.append(
        Object.assign(el("span", "muted"), { textContent: "Discard your changes?" }),
        textButton("Save", "primary small", () => void saveEdit()),
        textButton("Discard", "ghost small danger", () => {
          const after = editing.after
          stopEditing()
          after?.()
        }),
        textButton("Keep editing", "ghost small", () => {
          editing.ask = false
          editing.after = undefined
          renderEditorBar()
          editing.handle?.focus()
        }),
      )
    else
      bar.append(
        textButton("Save", "primary small", () => void saveEdit(), !editing.dirty),
        textButton("Done", "ghost small", () => {
          if (leaveEditor(() => renderDetail())) renderDetail()
        }),
      )
    return bar
  }
  if ((PREVIEWABLE.test(file.path) || /\.excalidraw$/i.test(file.path)) && !content.error) {
    const seg = el("div", "seg")
    seg.setAttribute("role", "radiogroup")
    seg.setAttribute("aria-label", "Show the file")
    const rendered = /\.excalidraw$/i.test(file.path) ? ("drawing" as const) : ("preview" as const)
    for (const [v, label] of [
      [rendered, rendered === "drawing" ? "Drawing" : "Preview"],
      ["source", "Source"],
    ] as const) {
      const b = el("button", "seg-btn") as HTMLButtonElement
      b.type = "button"
      b.setAttribute("role", "radio")
      b.setAttribute("aria-checked", String(file.view === v))
      b.textContent = label
      b.addEventListener("click", () => {
        file.view = v
        renderDetail()
      })
      seg.append(b)
    }
    bar.append(seg)
  }
  if (!content.error && !content.truncated && file.view !== "image")
    bar.append(textButton("Edit", "ghost small", () => startEditing(file.path)))
  bar.append(
    iconButton(EDITOR_ICON, "Open in VS Code", () => send({ type: "open.editor", workspace: runDir(), path: file.path, line: file.line })),
    copyButton(() => (file.line ? `${file.path}:${file.line}` : file.path), "Copy path"),
  )
  return bar
}

function renderFilePanel(file: NonNullable<typeof state.file>) {
  const g = $("detail-glyph")
  g.className = "glyph file"
  g.innerHTML = FOLDER_ICON.replace("row-icon", "file-icon")
  $("detail-title").textContent = file.path
  $("detail-tabs").hidden = true
  const body = $("detail-body")
  body.setAttribute("aria-labelledby", "detail-title")
  const content = file.content
  if (!content) {
    body.replaceChildren(Object.assign(el("div", "muted"), { textContent: "Loading the file…" }))
    return
  }
  const bar = fileBar(file, content)
  if (editing.path === file.path && !content.error) {
    const host = el("div", "editor-host")
    body.replaceChildren(bar, host)
    const text = editing.handle?.text() ?? content.text
    editing.handle?.destroy()
    editing.handle = undefined
    void createEditor(host, {
      doc: text,
      path: file.path,
      line: file.line,
      changed: (dirty) => {
        const next = dirty || text !== content.text
        if (next === editing.dirty) return
        editing.dirty = next
        renderEditorBar()
      },
      save: () => void saveEdit(),
    }).then((h) => {
      if (!host.isConnected) {
        h.destroy()
        return
      }
      editing.handle = h
      h.focus()
    })
    return
  }
  if (file.view === "drawing" && !content.error) {
    const els = parseDrawing(content.text)
    const drawing = els ? renderDrawing(els) : undefined
    if (!drawing?.svg) {
      body.replaceChildren(bar, Object.assign(el("div", "muted"), { textContent: "This file is not a drawing this app can show." }))
      return
    }
    const wrap = el("div", "drawing-wrap", drawing.svg)
    wrap.append(Object.assign(el("p", "muted"), { textContent: "Click a shape to leave a note on it." }))
    wrap.addEventListener("click", (e) => {
      const g = (e.target as Element).closest<SVGGElement>("g.ex-el")
      if (!g) return
      for (const x of wrap.querySelectorAll(".ex-el.picked")) x.classList.remove("picked")
      g.classList.add("picked")
      const label = drawing.labels[g.dataset.id as string] ?? "shape"
      annotator.offer({ kind: "drawing", path: file.path, shape: label }, label, g.getBoundingClientRect())
    })
    body.replaceChildren(bar, wrap)
    return
  }
  if (file.view === "image" && content.image) {
    const img = document.createElement("img")
    img.className = "file-image"
    img.src = content.image
    img.alt = file.path
    img.addEventListener("click", () => openLightbox(content.image as string, file.path))
    body.replaceChildren(bar, img)
    return
  }
  if (file.view === "preview" && !content.error) {
    if (/\.html?$/i.test(file.path)) {
      // The page runs in a sandbox with no access to the app (no same-origin), as a preview should.
      const frame = document.createElement("iframe")
      frame.className = "page-frame"
      frame.title = `Preview of ${file.path}`
      frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals")
      frame.srcdoc = content.text
      body.replaceChildren(bar, frame)
      return
    }
    const doc = el("div", "md md-preview")
    doc.innerHTML = renderMarkdownBlocks(content.text)
    // Pictures in a document are relative to it.
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : ""
    for (const img of doc.querySelectorAll<HTMLImageElement>("img[data-src]"))
      if (!(img.dataset.src as string).startsWith("/")) img.dataset.src = `${dir}${img.dataset.src}`
    linkifyFileRefs(doc, openFile, (url) => openUrl(url))
    resolveImages(doc)
    body.replaceChildren(bar, doc)
    return
  }
  const view = el("div", "file-wrap")
  renderFileView(view, content, file.line, file.endLine)
  body.replaceChildren(bar, view)
}

// ── The built-in editor ─────────────────────────────────────────────────

const EDITOR_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11 2.5 5.5 8 11 13.5l2.5-1.2V3.7zM5.5 8 2.5 5.5v5zM11 5.5 7.5 8 11 10.5" /></svg>`
const editing: { path?: string; dirty: boolean; handle?: EditorHandle; ask?: boolean; after?: () => void; saving?: boolean } = {
  dirty: false,
}

function textButton(label: string, cls: string, run: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", cls) as HTMLButtonElement
  b.type = "button"
  b.textContent = label
  b.disabled = disabled
  b.addEventListener("click", run)
  return b
}

function startEditing(path: string) {
  editing.path = path
  editing.dirty = false
  editing.ask = false
  renderDetail()
}

function stopEditing() {
  editing.handle?.destroy()
  Object.assign(editing, { path: undefined, dirty: false, handle: undefined, ask: false, after: undefined })
  renderDetail()
}

/** Leaving the editor with unsaved changes asks first; true when it is fine to go on now. */
function leaveEditor(after: () => void): boolean {
  if (!editing.path) return true
  if (!editing.dirty) {
    editing.handle?.destroy()
    Object.assign(editing, { path: undefined, handle: undefined, ask: false })
    return true
  }
  editing.ask = true
  editing.after = after
  renderEditorBar()
  return false
}

/** Redraw the file bar only: the editor keeps its text, cursor and focus. */
function renderEditorBar() {
  const old = $("detail-body").querySelector(":scope > .file-bar")
  if (!old || !state.file?.content) return
  old.replaceWith(fileBar(state.file, state.file.content))
}

async function saveEdit() {
  const file = state.file
  if (!file?.content || !editing.handle || editing.saving) return
  editing.saving = true
  const text = editing.handle.text()
  const msg = await request({
    type: "file.write",
    requestId: nextRequestId(),
    workspace: runDir(),
    path: file.path,
    text,
    expectedMtime: file.content.mtime,
  })
  editing.saving = false
  if (msg.type !== "file.saved") return
  if (msg.error) {
    showBanner(msg.error)
    return
  }
  file.content = { ...file.content, text, mtime: msg.mtime }
  editing.dirty = false
  const after = editing.ask ? editing.after : undefined
  editing.ask = false
  editing.after = undefined
  renderEditorBar()
  flash($("detail-title"), `Saved ${file.path}`)
  after?.()
}

function renderPanelButtons() {
  const onPanel = !detail.hidden && !state.selected && !state.file
  $("toggle-files").setAttribute("aria-pressed", String(onPanel && state.panel === "files"))
  $("toggle-browser").setAttribute("aria-pressed", String(onPanel && state.panel === "browser"))
}

/** A turn's own changes (Conductor's and its threads'), reviewed in the panel like a thread's. */
const turnThreads = new Map<string, Thread>()
const findThread = (id: string | undefined) => (id ? (state.threads.get(id) ?? turnThreads.get(id)) : undefined)

function turnCheckpoint(turnId: string, checkpoint: ThreadCheckpoint) {
  const turnEl = state.turnEl
  if (!turnEl) return
  const id = `turn:${turnId}:${checkpoint.before.slice(0, 8)}`
  const t: Thread = {
    id,
    agent: "conductor",
    taskClass: "turn",
    mode: "edit",
    task: "Changes in this turn",
    provider: "claude",
    tier: "",
    status: "done",
    startedAt: now(),
    finishedAt: now(),
    tokens: 0,
    activity: [],
    comments: [],
    tab: "changes",
    summary: {
      status: "done",
      provider: "claude",
      tier: "deep",
      attempts: [],
      stopReason: "",
      costUsd: 0,
      tokens: { input: 0, output: 0 },
      findings: [],
      notes: [],
      changedFiles: [],
      taskClass: "turn",
      report: "",
      checkpoint,
    },
  }
  turnThreads.set(id, t)
  const bar = el("div", "turn-changes")
  const label = Object.assign(el("span", "muted"), { textContent: "This turn changed files in the folder." })
  const review = textButton("Review the changes", "ghost small", () => selectThread(id))
  let asking = false
  const back = textButton("Go back to before this turn", "ghost small", () => {
    if (!asking) {
      asking = true
      back.textContent = "Confirm: restore the folder"
      back.classList.add("danger")
      return
    }
    asking = false
    back.disabled = true
    void request({
      type: "turn.restore",
      requestId: nextRequestId(),
      workspace: runDir(),
      before: checkpoint.before,
      label: turnId,
    }).then((m) => {
      if (m.type !== "turn.restored") return
      back.disabled = false
      back.textContent = "Go back to before this turn"
      back.classList.remove("danger")
      label.textContent = m.message
      label.className = m.ok ? "notice ok" : "error"
      const undoSha = m.undo
      if (m.ok && undoSha && m.files.length) {
        const undo = textButton("Undo the restore", "ghost small", () => {
          void request({
            type: "turn.restore",
            requestId: nextRequestId(),
            workspace: runDir(),
            before: undoSha,
            label: `undo-${turnId}`,
          }).then((u) => {
            if (u.type !== "turn.restored") return
            label.textContent = u.ok ? "Restore undone: the folder is as it was." : u.message
            label.className = u.ok ? "notice ok" : "error"
            undo.remove()
          })
        })
        bar.append(undo)
      }
    })
  })
  bar.append(label, el("span", "spacer"), review, back)
  turnEl.append(bar)
}

function renderDetail() {
  renderPanelButtons()
  if (state.file) {
    renderFilePanel(state.file)
    return
  }
  if (!state.selected && state.panel) {
    renderSidePanel(state.panel)
    return
  }
  const t = findThread(state.selected)
  if (!t) return
  const g = $("detail-glyph")
  g.className = `glyph ${t.provider}`
  g.innerHTML = agentLogoSvg(t.provider)
  $("detail-title").textContent = taskTitle(t.task)
  const body = $("detail-body")
  body.replaceChildren()
  body.setAttribute("aria-labelledby", "detail-title")
  const tabs = threadTabs(t)
  const tab = t.tab && tabs.includes(t.tab) ? t.tab : "overview"
  renderTabs(t, tabs, tab)
  if (tabs.length > 1) body.setAttribute("aria-labelledby", `tab-${tab}`)

  const section = (title: string, node: HTMLElement) => {
    const s = el("section", "detail-section")
    s.append(Object.assign(el("h3"), { textContent: title }), node)
    body.append(s)
  }
  const sum = t.summary
  if (tab === "changes") {
    if (sum?.worktree) section("Worktree", renderWorktree(t, sum.worktree))
    if (sum?.checkpoint?.after) section("Changes", renderChanges(t))
    else if (sum?.changedFiles.length) {
      const list = el("ul", "files mono")
      for (const f of sum.changedFiles) list.append(Object.assign(el("li"), { textContent: f }))
      section("Files changed", list)
    }
    return
  }
  if (tab === "route" && sum) {
    const attempts = el("ol", "attempts")
    for (const a of sum.attempts) {
      const li = el("li", a.outcome === "ok" || a.outcome === "done" ? "good" : "")
      li.append(
        glyph(a.provider),
        Object.assign(el("span"), { textContent: `${PROVIDER_LABEL[a.provider]}, ${a.tier}` }),
        Object.assign(el("span", "muted"), { textContent: `${a.outcome}${a.errorKind ? ` (${a.errorKind})` : ""}` }),
      )
      if (a.message) li.title = a.message
      attempts.append(li)
    }
    section("Attempts", attempts)
    const box = el("div", "facts")
    for (const line of [
      `Task class: ${sum.taskClass}`,
      `Stop reason: ${sum.stopReason}`,
      ...(sum.sessionId ? [`Session: ${sum.sessionId}`] : []),
      ...(sum.worktree ? [`Worktree: ${sum.worktree}`] : []),
    ])
      box.append(Object.assign(el("div"), { textContent: line }))
    section("Route", box)
    if (sum.notes.length) {
      const notes = el("ul", "findings")
      for (const n of sum.notes) notes.append(Object.assign(el("li"), { textContent: n }))
      section("Notes", notes)
    }
    return
  }
  if (tab === "compare") {
    const other = counterpart(t)
    const [a, b] = t.rerunOf ? [other, t] : [t, other]
    for (const x of [a, b]) {
      if (!x) continue
      const box = el("div", "compare-side")
      const head = el("div", "compare-head")
      head.append(
        glyph(x.provider),
        Object.assign(el("strong"), { textContent: `${PROVIDER_LABEL[x.provider]} ${x.summary?.model ?? x.model ?? ""}` }),
      )
      head.append(Object.assign(el("span", "muted"), { textContent: x === t ? "this thread" : x.rerunOf ? "the re-run" : "the original" }))
      const facts = x.summary
        ? `${x.summary.status}, ${compact(x.tokens)} tokens${x.summary.costUsd ? `, $${x.summary.costUsd.toFixed(4)}` : ""}, ${age(x.startedAt, x.finishedAt ?? Date.now())}`
        : statusText(x)
      box.append(head, Object.assign(el("div", "facts-row"), { textContent: facts }))
      box.append(
        x.summary ? mdBlock(x.summary.report || "(no output)") : Object.assign(el("div", "muted"), { textContent: "Still running…" }),
      )
      section(x === a ? "Original" : "Re-run", box)
    }
    return
  }
  if (tab === "activity") {
    const list = el("ul", "activity mono")
    for (const line of t.activity) {
      const li = el("li")
      li.append(Object.assign(el("span", "who"), { textContent: line.who }), document.createTextNode(line.text))
      list.append(li)
    }
    section("Activity", list)
    list.scrollTop = list.scrollHeight
    return
  }

  const status = t.error ? "error" : (t.summary?.status ?? "running")
  const meta = el("div", "detail-meta")
  const pill = el("span", `pill ${status}`)
  pill.textContent = STATUS_WORDS[status] ?? status
  const badge = el("span", `badge ${t.provider}`, agentLogoSvg(t.provider))
  badge.append(
    Object.assign(el("span"), {
      textContent: `${PROVIDER_LABEL[t.provider]} ${t.summary?.model ?? t.model ?? "default model"}, ${t.summary?.tier ?? t.tier}`,
    }),
  )
  meta.append(pill, badge)
  body.append(meta)
  // Each fact its own item, spaced apart, rather than joined by middle dots.
  const facts = el("div", "facts-row")
  for (const fact of [
    `${t.agent}, ${t.taskClass}, ${t.mode}`,
    `${compact(t.tokens)} tokens`,
    ...(t.summary?.costUsd ? [`$${t.summary.costUsd.toFixed(4)}`] : []),
    age(t.startedAt, t.finishedAt),
  ]) {
    facts.append(Object.assign(el("span"), { textContent: fact }))
  }
  body.append(facts)

  section("Task", Object.assign(el("p", "task"), { textContent: t.task }))
  if (t.why?.length) {
    const why = el("ul", "why")
    for (const line of t.why) why.append(Object.assign(el("li"), { textContent: line }))
    section(t.rerunOf ? "Why this backend (a re-run you asked for)" : "Why this backend", why)
  }
  if (t.error) section("Error", Object.assign(el("div", "error"), { textContent: t.error }))
  if (sum?.findings.length) {
    const list = el("ul", "findings")
    for (const f of sum.findings) list.append(Object.assign(el("li", f.severity), { textContent: f.message }))
    section("Harness findings", list)
  }
  if (sum) {
    const report = mdBlock(sum.report || "(no output)")
    report.dataset.report = t.id
    section("Report (Conductor verifies before using it)", report)
  } else if (!t.error && t.activity.length) {
    const last = t.activity.at(-1) as Thread["activity"][number]
    section("Now", Object.assign(el("div", "facts mono"), { textContent: `${last.who}: ${last.text}` }))
  }
}

function refreshThread(t: Thread) {
  renderStrip()
  renderAgentCard(t)
  renderThreadsPill()
  renderSidebar()
  if (state.selected === t.id && !state.file) renderDetail()
}

function delegationStarted(msg: Extract<ServerMessage, { type: "delegation.started" }>) {
  const t: Thread = {
    id: msg.id,
    agent: msg.agent,
    taskClass: msg.taskClass,
    mode: msg.mode,
    task: msg.task,
    provider: msg.provider,
    model: msg.model,
    tier: msg.tier,
    status: "running",
    startedAt: now(),
    tokens: 0,
    activity: [],
    comments: [],
    why: msg.why,
    brief: msg.brief,
    rerunOf: msg.rerunOf,
  }
  const row = el("button", "agent-card") as HTMLButtonElement
  row.type = "button"
  row.addEventListener("click", () => selectThread(t.id))
  append(row, turnCards())
  t.chatRow = row
  state.threads.set(t.id, t)
  refreshThread(t)
}

function delegationEvent(msg: Extract<ServerMessage, { type: "delegation.event" }>) {
  const t = state.threads.get(msg.id)
  if (!t) return
  const ev = msg.event
  if (ev.type === "quota") {
    recordQuota(msg.provider, ev.windows)
    return
  }
  if (ev.type === "usage") {
    t.tokens += ev.inputTokens + ev.outputTokens
    t.provider = msg.provider
  } else if (ev.type === "tool_call") {
    t.activity.push({ who: PROVIDER_LABEL[msg.provider], text: `${ev.name} ${describeTool(ev.input)}` })
  } else if (ev.type === "error") {
    t.activity.push({ who: PROVIDER_LABEL[msg.provider], text: `${ev.kind}: ${ev.message}` })
  } else return
  if (msg.provider !== t.provider) t.provider = msg.provider
  if (state.selected === t.id && !state.file) renderDetail()
  if (ev.type !== "tool_call") renderSidebar()
  else renderStrip()
}

function delegationFinished(id: string, summary: DelegationSummary) {
  const t = state.threads.get(id)
  if (!t) return
  addUsage(summary.costUsd, summary.tokens.input, summary.tokens.output)
  Object.assign(t, { summary, provider: summary.provider, tokens: summary.tokens.input + summary.tokens.output, finishedAt: now() })
  refreshThread(t)
  if (summary.status === "blocked") {
    notify("agent-router: a thread needs you", `${taskTitle(t.task)}: ${resultLine(summary.report)}`)
    sound("attention")
  }
}

function delegationFailed(id: string, error: string) {
  const t = state.threads.get(id)
  if (!t) {
    append(el("div", "error", escapeHtml(`Delegation refused: ${error}`)))
    return
  }
  Object.assign(t, { error, finishedAt: now() })
  refreshThread(t)
}

function clearThreads() {
  state.threads.clear()
  renderThreadsPill()
  state.chatTitle = ""
  selectThread(undefined)
  $("chat-title").textContent = "Conductor"
}

const emptyState = ($("empty") as HTMLElement).cloneNode(true) as HTMLElement

/** An empty transcript: no turn, no threads, no usage. The server's chat is left to the caller. */
function resetView(withEmpty: boolean) {
  find.reset()
  turnThreads.clear()
  quickCards.clear()
  clearThreads()
  state.fold = undefined
  state.turnEl = undefined
  state.tools.clear()
  log.replaceChildren(...(withEmpty ? [emptyState.cloneNode(true)] : []))
  state.costUsd = 0
  state.tokensIn = 0
  state.tokensOut = 0
  addUsage(0)
}

/** A new chat, in this workspace or another folder. */
function newChat(dir?: string) {
  if (state.running) {
    showBanner("Stop the running turn before starting a new chat.")
    return
  }
  send({ type: "reset" })
  state.chat = undefined
  prefs.remove("chat")
  resetView(true)
  if (dir && !samePath(dir, state.workspace)) setWorkspace(dir)
  else {
    renderSidebar()
    loadWorktrees()
  }
  promptBox.focus()
}

const KEEP_TURNS = 20

/** A reopened chat, drawn from its saved messages exactly as they first arrived. */
function replayChat(msg: Extract<ServerMessage, { type: "chat.replay" }>) {
  resetView(false)
  state.chat = msg.chat
  prefs.set("chat", msg.chat.id)
  if (!samePath(msg.chat.workspace, state.workspace)) setWorkspace(msg.chat.workspace)
  // A long chat shows its last turns; the older ones are drawn folded, behind one button.
  const starts = msg.events.flatMap((e, i) => (e.msg.type === "turn.started" ? [i] : []))
  const cut = starts.length > KEEP_TURNS ? (starts[starts.length - KEEP_TURNS] as number) : 0
  if (cut) {
    // Drawn into a detached element, out of the page (and out of find, the minimap and layout) until asked for.
    const earlier = el("div", "earlier-turns")
    const more = el("button", "ghost small earlier-button") as HTMLButtonElement
    more.type = "button"
    more.textContent = `Show ${starts.length - KEEP_TURNS} earlier turn${starts.length - KEEP_TURNS > 1 ? "s" : ""}`
    more.addEventListener("click", () => {
      const keep = log.scrollHeight - log.scrollTop
      more.replaceWith(earlier)
      log.scrollTop = log.scrollHeight - keep
    })
    log.append(more)
    state.earlier = earlier
  }
  state.replaying = true
  try {
    msg.events.forEach((ev, i) => {
      if (i === cut) state.earlier = undefined
      state.replayAt = ev.at
      onMessage(ev.msg)
    })
  } finally {
    state.replaying = false
    state.replayAt = undefined
    state.earlier = undefined
  }
  if (msg.running) setRunning(true)
  else {
    // The app or the turn stopped before this chat's last turn ended: close it as it stands.
    if (state.turnEl) {
      state.turnEl.querySelector(".status-line")?.remove()
      closeFold()
      state.turnEl = undefined
    }
    for (const t of state.threads.values())
      if (!t.summary && !t.error) Object.assign(t, { error: "Stopped before it finished.", finishedAt: t.startedAt })
    for (const t of state.threads.values()) refreshThread(t)
    setRunning(false)
  }
  state.chatTitle = msg.chat.title
  $("chat-title").textContent = msg.chat.title
  renderWorktreeTray()
  if (!log.childElementCount) log.append(emptyState.cloneNode(true))
  log.scrollTop = log.scrollHeight
  renderSidebar()
}

$("detail-close").addEventListener("click", closeDetail)
// Ages in the sidebar tick while threads run.
setInterval(() => {
  if ([...state.threads.values()].some((t) => !t.finishedAt)) renderSidebar()
}, 15_000)

// ── Approvals ───────────────────────────────────────────────────────────

function approvalSummary(tool: string, input: Record<string, unknown>): { title: string; body: string } {
  if (tool === "mcp__router__delegate") {
    const brief = (input.brief ?? {}) as Record<string, unknown>
    return {
      title: `Delegate a ${String(brief.mode ?? "read-only")} ${String(input.task_class)} task?`,
      body: `${String(brief.task ?? "")}\n\nScope: ${String(brief.scope || "not stated")}`,
    }
  }
  if (tool === "Bash") return { title: "Run this command?", body: String(input.command ?? "") }
  if (tool === "Edit" || tool === "Write")
    return { title: `${tool} ${String(input.file_path ?? "a file")}?`, body: JSON.stringify(input, null, 2).slice(0, 4000) }
  return { title: `Allow ${tool}?`, body: JSON.stringify(input, null, 2).slice(0, 4000) }
}

function approvalRequest(msg: Extract<ServerMessage, { type: "approval.request" }>) {
  const { title, body } = approvalSummary(msg.tool, msg.input)
  const card = el("article", "card approval")
  card.innerHTML = `<h4></h4><pre class="mono"></pre><div class="buttons"><button type="button" class="primary" data-allow="1">Allow</button><button type="button" class="ghost" data-allow="0">Deny</button></div>`
  ;(card.querySelector("h4") as HTMLElement).textContent = title
  ;(card.querySelector("pre") as HTMLElement).textContent = body
  for (const button of card.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      const allow = button.dataset.allow === "1"
      send({ type: "approval", id: msg.id, allow, message: allow ? undefined : "The user denied this in the desktop app." })
      card.classList.add("answered")
      ;(card.querySelector(".buttons") as HTMLElement).textContent = allow ? "Allowed" : "Denied"
    })
  }
  append(card)
  ;(card.querySelector("button") as HTMLButtonElement).focus()
  notify("agent-router: approval needed", title)
  sound("attention")
}

// ── Server connection ───────────────────────────────────────────────────

function onMessage(msg: ServerMessage) {
  if (settings.onMessage(msg)) return
  if (besideMessage(msg)) return
  if ("requestId" in msg && pendingRequests.has(msg.requestId)) {
    pendingRequests.get(msg.requestId)?.(msg)
    pendingRequests.delete(msg.requestId)
    return
  }
  switch (msg.type) {
    case "chats":
      state.chats = msg.items
      if (state.chat) {
        const fresh = msg.items.find((c) => c.id === state.chat?.id)
        if (fresh) {
          state.chat = fresh
          state.chatTitle = fresh.title
          $("chat-title").textContent = fresh.title
        }
      }
      renderSidebar()
      return
    case "chat.current": {
      // On connecting, reopen what was on screen (or last time's chat), so the next request resumes it.
      if (state.greeting) {
        state.greeting = false
        const want = msg.chat?.id ?? state.chat?.id ?? savedChat ?? undefined
        if (want && (state.chats.some((c) => c.id === want) || msg.chat?.id === want)) {
          send({ type: "chat.open", id: want })
          return
        }
      }
      // A scheduled request can start a new chat on its own: clear what was on screen.
      if (!msg.chat && state.chat && !state.running) resetView(true)
      state.chat = msg.chat
      if (msg.chat) prefs.set("chat", msg.chat.id)
      if (msg.chat && state.runningCard) {
        send({ type: "board.upsert", workspace: state.workspace, card: { id: state.runningCard, column: "doing", chatId: msg.chat.id } })
        state.runningCard = undefined
      }
      renderSidebar()
      renderWorktreeTray()
      return
    }
    case "chat.replay":
      replayChat(msg)
      return
    case "hello":
      state.version = msg.version
      state.greeting = true
      showBanner(undefined)
      // Backend health does not depend on the folder, so show it before one is chosen.
      if (state.workspace) setWorkspace(state.workspace)
      else send({ type: "status", workspace: msg.cwd })
      return
    case "status":
      renderBackends(msg.backends)
      renderProfiles(msg.backends.profiles, msg.backends.defaultProfile)
      renderPlans(msg.backends.plans, msg.backends.configuredPlan)
      return
    case "turn.started": {
      append(userMessage(msg.prompt, now()), top())
      if (!state.chatTitle) {
        state.chatTitle = state.chat?.title ?? taskTitle(msg.prompt)
        $("chat-title").textContent = state.chatTitle
      }
      state.turnEl = el("section", "turn")
      state.turnEl.append(
        el(
          "div",
          "status-line",
          `<span class="spinner"></span><span>${msg.resumed ? "Continuing the conversation" : "Starting Conductor"}…</span>${msg.mode ? `<span class="muted">${escapeHtml(msg.mode)}</span>` : ""}`,
        ),
      )
      append(state.turnEl, top())
      if (!state.replaying) setRunning(true)
      return
    }
    case "conductor":
      state.turnEl?.querySelector(".status-line")?.remove()
      conductorEvent(msg.event)
      return
    case "turn.finished":
      state.turnEl?.querySelector(".status-line")?.remove()
      closeFold()
      if (!msg.ok && msg.error) append(el("div", "error", escapeHtml(msg.error)))
      notify("agent-router", msg.ok ? "Your request is done." : `Stopped: ${(msg.error ?? "error").slice(0, 160)}`)
      sound("done")
      state.turnEl = undefined
      if (state.replaying) return
      // Delegates stop with the turn (Stop, an interrupt, a crash): their threads end here too.
      for (const t of state.threads.values())
        if (!t.summary && !t.error) {
          Object.assign(t, { error: "Stopped with the turn.", finishedAt: Date.now() })
          refreshThread(t)
        }
      setRunning(false)
      // A board card that ran in this chat is ready for review.
      for (const card of board.cards())
        if (card.chatId && card.chatId === state.chat?.id && card.column === "doing")
          send({ type: "board.move", workspace: state.workspace, id: card.id, column: "review", index: 0 })
      // The turn may have changed files: refresh the branch's +/- counts.
      if (state.workspace) send({ type: "status", workspace: state.workspace })
      return
    case "queue":
      renderQueue(msg.items, msg.paused)
      return
    case "delegation.started":
      delegationStarted(msg)
      return
    case "delegation.event":
      delegationEvent(msg)
      return
    case "delegation.finished":
      delegationFinished(msg.id, msg.summary)
      return
    case "delegation.failed":
      delegationFailed(msg.id, msg.error)
      return
    case "approval.request":
      approvalRequest(msg)
      return
    case "error":
      // A budget refusal can be overridden for this one request.
      if (/^Budget reached/.test(msg.message) && state.lastStart) {
        const again = { ...state.lastStart, overBudget: true }
        showBanner(msg.message.replace(/ Raise or clear.*$/, ""), { label: "Send anyway", run: () => send(again) })
      } else showBanner(msg.message)
      return
  }
}

async function connect() {
  const info = await invoke<ServerInfo>("server_info")
  const socket = new WebSocket(`${info.url}/ui?token=${encodeURIComponent(info.token)}`)
  state.socket = socket
  socket.addEventListener("message", (e) => onMessage(JSON.parse(String(e.data)) as ServerMessage))
  socket.addEventListener("close", () => {
    setRunning(false)
    showBanner("Lost connection to the agent-router core. Reconnecting…")
    setTimeout(() => void connect().catch(reportStartupError), 1500)
  })
}

function reportStartupError(error: unknown) {
  showBanner(`Could not start the agent-router core: ${error instanceof Error ? error.message : String(error)}`)
}

// ── Controls ────────────────────────────────────────────────────────────

const settings = createSettings(send, () => state.workspace, showBanner)

/** Send a request to Conductor (queued by the server if a turn is running). False if it cannot be sent. */
function startRequest(prompt: string): boolean {
  if (!state.workspace) {
    showBanner("Choose a workspace folder first.")
    return false
  }
  showBanner(undefined)
  const run = state.newChatRun
  const start: Extract<ClientMessage, { type: "start" }> = {
    type: "start",
    prompt,
    workspace: state.workspace,
    permission: permissionSelect.value as PermissionMode,
    profile: profileSelect.value || undefined,
    plan: planSelect.value || undefined,
    // Only a new chat picks where it runs.
    ...(!state.chat && run.mode === "new" ? { worktree: { base: run.base } } : {}),
    ...(!state.chat && run.mode === "existing" ? { worktree: { path: run.path } } : {}),
  }
  state.lastStart = start
  send(start)
  return true
}

function submit() {
  const prompt = promptBox.value.trim()
  if (state.running && !prompt) {
    send({ type: "cancel" })
    return
  }
  if (!prompt) return
  // "/btw …" is a side question for the fast model; Conductor's chat is not interrupted.
  const side = /^\/btw\s+([\s\S]+)/.exec(prompt)
  if (side) {
    if (!state.workspace) {
      showBanner("Choose a workspace folder first.")
      return
    }
    send({ type: "side.ask", workspace: runDir(), question: (side[1] as string).trim() })
    history.push(prompt)
    prefs.set("history", JSON.stringify(history.all))
    promptBox.value = ""
    composer.close()
    updateSendButton()
    return
  }
  // "/name …" runs a prompt template of yours or the project's.
  const tpl = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(prompt)
  const template = tpl ? state.templates.find((x) => x.name === tpl[1]) : undefined
  const text = template ? expandTemplate(template.text, tpl?.[2] ?? "") : prompt
  // The bubble appears when the server starts the turn: now, or later if it queues it.
  if (!startRequest(text)) return
  history.push(prompt)
  prefs.set("history", JSON.stringify(history.all))
  promptBox.value = ""
  composer.close()
  updateSendButton()
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault()
  submit()
})
promptBox.addEventListener("input", updateSendButton)
promptBox.addEventListener("keydown", (e) => {
  if (e.isComposing || composer.handleKey(e)) return
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    submit()
  } else if (e.key === "Tab" && !e.shiftKey && state.running && promptBox.value.trim()) {
    // Ghostex's Tab to queue: only while a turn runs and there is text, so Tab still moves focus otherwise.
    e.preventDefault()
    submit()
  }
})
$("workspace").addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false, defaultPath: state.workspace || undefined })
  if (typeof dir === "string" && !samePath(dir, state.workspace)) newChat(dir)
})
$("new-chat").addEventListener("click", () => newChat())

// ── Composer: @files, /commands, history, images ───────────────────────

const history = new PromptHistory(prefs.json<string[]>("history", []))

function slashCommands(): Command[] {
  const profiles = state.backends?.profiles ?? []
  return [
    { name: "new", hint: "Start a new chat", run: () => newChat() },
    ...(state.running ? [{ name: "stop", hint: "Stop the running turn", run: () => send({ type: "cancel" }) }] : []),
    { name: "route", hint: "Pin a kind of task: /route code.review gemini", insert: "/route" },
    ...profiles.map((p) => ({ name: p.name, hint: `${p.label} profile for this request`, insert: `@${p.name}` })),
    { name: "claude", hint: "Pin Claude for this request", insert: "@claude" },
    { name: "gemini", hint: "Pin Gemini for this request", insert: "@gemini" },
    { name: "codex", hint: "Pin Codex for this request", insert: "@codex" },
    { name: "ultrawork", hint: "Finish the whole task and verify it", insert: "ultrawork" },
    { name: "btw", hint: "A side question for a fast model; Conductor keeps working", insert: "/btw" },
    { name: "catchup", hint: "Where this chat stands, in a few lines", run: () => catchUp() },
    { name: "terminal", hint: "Open the terminal", run: () => dock.show(true) },
    { name: "cli", hint: "Continue Conductor's session in the Claude Code CLI", run: () => void dock.open("conductor") },
    { name: "files", hint: "Browse the workspace's files", run: () => togglePanel("files") },
    { name: "browser", hint: "Preview a local web page", run: () => togglePanel("browser") },
    { name: "board", hint: "The workspace's Kanban board", run: () => setView("board") },
    ...state.templates.map((t) => ({
      name: t.name,
      hint: `${t.scope === "project" ? "Project template" : "Your template"}: ${t.text.split("\n")[0]?.slice(0, 60) ?? ""}`,
      insert: `/${t.name}`,
    })),
    { name: "templates", hint: "Make or edit prompt templates", run: () => openTemplates() },
    { name: "memory", hint: "The project memory Conductor reads", run: () => void openMemory() },
    { name: "routing", hint: "Which backend and tier each kind of task gets", run: () => openRouting() },
    { name: "usage", hint: "Subscriptions and spend", run: () => void openUsage() },
    { name: "code", hint: "VS Code in the app", run: () => setView("code") },
    {
      name: "visuals",
      hint: "Ask for charts, tables and stat tiles in the answer",
      insert:
        'Where it helps, answer with visuals: a ```chart block ({"type":"bar"|"line","labels":[…],"series":[{"name","values"}]}), a ```stats block ([{"label","value","delta"}]), or a Markdown table.',
    },
    {
      name: "save",
      hint: "Save this chat as Markdown",
      run: () => state.chat && void saveMarkdown(state.chat.title, { chatId: state.chat.id }),
    },
    { name: "models", hint: "Model and reasoning for each tier", run: () => $("open-settings").click() },
    { name: "find", hint: "Find in this chat", run: () => find.open() },
    { name: "search", hint: "Search every chat", run: () => palette.open() },
    { name: "glass", hint: "Turn glass on or off", run: () => appearance.toggle() },
  ]
}

const composer = setupComposer({
  box: promptBox,
  list: $("complete"),
  files: (query) =>
    state.workspace
      ? request({ type: "files.list", requestId: nextRequestId(), workspace: runDir(), query }).then((m) =>
          m.type === "files.listed" ? m.files : [],
        )
      : Promise.resolve([]),
  commands: slashCommands,
  history,
  changed: updateSendButton,
})

/** Images go to the workspace (.harness/attachments) and into the request as @path. */
async function attachImages(files: File[]) {
  const images = files.filter((f) => f.type.startsWith("image/"))
  if (!images.length) return
  if (!state.workspace) {
    showBanner("Choose a workspace folder first.")
    return
  }
  for (const f of images) {
    const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png"
    const name = f.name && /\.\w+$/.test(f.name) ? f.name : `pasted.${ext}`
    const data = await fileBase64(f)
    const msg = await request({ type: "attachment.save", requestId: nextRequestId(), workspace: runDir(), name, data })
    if (msg.type !== "attachment.saved") continue
    if (msg.error) showBanner(msg.error)
    else composer.mention(msg.path)
  }
}
promptBox.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])]
  if (!files.some((f) => f.type.startsWith("image/"))) return
  e.preventDefault()
  void attachImages(files)
})
const form = $("form")
form.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) return
  e.preventDefault()
  form.classList.add("dropping")
})
form.addEventListener("dragleave", () => form.classList.remove("dropping"))
form.addEventListener("drop", (e) => {
  form.classList.remove("dropping")
  const files = [...(e.dataTransfer?.files ?? [])]
  if (!files.length) return
  e.preventDefault()
  void attachImages(files)
})
const attachInput = $<HTMLInputElement>("attach-file")
$("attach").addEventListener("click", () => attachInput.click())
attachInput.addEventListener("change", () => {
  const files = [...(attachInput.files ?? [])]
  attachInput.value = ""
  void attachImages(files)
})
$("expand").addEventListener("click", () => {
  const big = form.classList.toggle("expanded")
  $("expand").setAttribute("aria-pressed", String(big))
  promptBox.focus()
})

// ── Find, the palette, appearance ───────────────────────────────────────

const find = setupFind({
  bar: $("find-bar"),
  input: $<HTMLInputElement>("find-input"),
  count: $("find-count"),
  prev: $<HTMLButtonElement>("find-prev"),
  next: $<HTMLButtonElement>("find-next"),
  close: $<HTMLButtonElement>("find-close"),
  root: log,
})
$("open-find").addEventListener("click", () => find.open())

const paletteFilter = { folder: false, pinned: false }
const chatShown = (c: ChatMeta) => (!paletteFilter.folder || samePath(c.workspace, state.workspace)) && (!paletteFilter.pinned || c.pinned)

function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = []
  for (const c of state.chats.filter(chatShown))
    items.push({
      group: "Chats",
      label: c.title,
      detail: `${folderName(c.workspace)}, ${age(c.updatedAt, Date.now())} ago${c.pinned ? ", pinned" : ""}`,
      run: () => openChat(c),
    })
  for (const t of state.threads.values())
    items.push({ group: "Threads in this chat", label: taskTitle(t.task), detail: statusText(t), run: () => selectThread(t.id) })
  items.push(
    { group: "Commands", label: "New chat", keys: "Ctrl N", run: () => newChat() },
    { group: "Commands", label: "Open a folder", run: () => $("workspace").click() },
    { group: "Commands", label: "Find in this chat", keys: "Ctrl F", run: () => find.open() },
    { group: "Commands", label: "Models", run: () => $("open-settings").click() },
    {
      group: "Commands",
      label: "Toggle the sidebar",
      keys: "Ctrl B",
      run: () => document.querySelector(".app")?.classList.toggle("no-sidebar"),
    },
    { group: "Commands", label: "Glass on or off", run: () => appearance.toggle() },
  )
  items.push(
    { group: "Commands", label: "Board", run: () => setView("board") },
    { group: "Commands", label: "Files", keys: "Ctrl P", run: () => togglePanel("files") },
    { group: "Commands", label: "Browser preview", run: () => togglePanel("browser") },
    { group: "Commands", label: "Terminal", keys: "Ctrl `", run: () => dock.show(true) },
    { group: "Commands", label: "Continue in the Claude Code CLI", run: () => void dock.open("conductor") },
    { group: "Commands", label: "Catch me up", run: catchUp },
    { group: "Commands", label: "Usage", run: () => void openUsage() },
    { group: "Commands", label: "Routing", run: () => openRouting() },
    { group: "Commands", label: "Prompt templates", run: () => openTemplates() },
    { group: "Commands", label: "Project memory", run: () => void openMemory() },
    { group: "Commands", label: "Code: VS Code in the app", run: () => setView("code") },
  )
  if (state.chat) {
    const chat = state.chat
    items.push({ group: "Commands", label: "Save this chat as Markdown", run: () => void saveMarkdown(chat.title, { chatId: chat.id }) })
  }
  if (state.running) items.push({ group: "Commands", label: "Stop the turn", run: () => send({ type: "cancel" }) })
  for (const sc of state.schedules)
    items.push({
      group: "Scheduled",
      label: sc.prompt,
      detail: new Date(sc.at).toLocaleString(),
      run: () => $("schedule-btn").click(),
    })
  return items
}

const palette = setupPalette({
  dialog: $<HTMLDialogElement>("palette"),
  input: $<HTMLInputElement>("palette-input"),
  list: $("palette-list"),
  items: paletteItems,
  search: (query) =>
    request({ type: "chats.search", requestId: nextRequestId(), query }).then((m) =>
      m.type === "chats.found"
        ? m.hits
            .filter((h) => chatShown(h.chat))
            .map((h) => ({ group: "In messages", label: h.chat.title, detail: h.snippet, run: () => openChat(h.chat) }))
        : [],
    ),
})
$("open-palette").addEventListener("click", () => palette.open())
for (const [id, key] of [
  ["pf-folder", "folder"],
  ["pf-pinned", "pinned"],
] as const)
  $(id).addEventListener("click", () => {
    paletteFilter[key] = !paletteFilter[key]
    $(id).setAttribute("aria-pressed", String(paletteFilter[key]))
    palette.refresh()
    $("palette-input").focus()
  })

const appearance = setupAppearance({
  toggle: $<HTMLInputElement>("glass-toggle"),
  swatches: $("backdrop-swatches"),
  choose: $<HTMLButtonElement>("backdrop-choose"),
  remove: $<HTMLButtonElement>("backdrop-remove"),
  file: $<HTMLInputElement>("backdrop-file"),
  dim: $<HTMLInputElement>("glass-dim"),
  store: prefs,
  report: showBanner,
})
permissionSelect.value = prefs.get("permission") ?? "default"
permissionSelect.addEventListener("change", () => prefs.set("permission", permissionSelect.value))
profileSelect.addEventListener("change", () => {
  prefs.set("profile", profileSelect.value)
  profileSelect.title = profileSelect.selectedOptions[0]?.title ?? ""
})
planSelect.addEventListener("change", () => {
  prefs.set("plan", planSelect.value)
  planSelect.title = planSelect.selectedOptions[0]?.title ?? ""
})
/** The composer's one mode pill names the profile and permission in effect; the plan shows when one is chosen. */
function renderModeSummary() {
  const text = (s: HTMLSelectElement) => s.selectedOptions[0]?.textContent?.replace(/ \(default\)$/, "") ?? ""
  const parts = [text(profileSelect), ...(planSelect.value ? [text(planSelect)] : []), text(permissionSelect)].filter(Boolean)
  $("mode-summary").textContent = parts.join(", ")
}
for (const select of [profileSelect, planSelect, permissionSelect]) select.addEventListener("change", renderModeSummary)
popover($<HTMLButtonElement>("mode-pill"), $("mode-menu"))
// ── Beside the chat: side panels, notes, side questions, worktrees, schedules, terminal, board ──

function renderSidePanel(panel: "files" | "browser" | "chat") {
  if (panel === "chat") {
    renderChatBeside()
    return
  }
  const g = $("detail-glyph")
  g.className = "glyph file"
  g.innerHTML =
    panel === "files"
      ? FOLDER_ICON.replace("row-icon", "file-icon")
      : `<svg class="file-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></svg>`
  $("detail-title").textContent = panel === "files" ? `Files in ${folderName(runDir())}` : "Browser"
  $("detail-tabs").hidden = true
  const body = $("detail-body")
  body.setAttribute("aria-labelledby", "detail-title")
  body.replaceChildren()
  if (panel === "browser") {
    renderBrowser(body, state.browser, {
      navigate: (url) => {
        state.browser = { url, nonce: state.browser.nonce + 1 }
        renderDetail()
      },
      external: (url) => send({ type: "open.url", url }),
      reload: () => {
        state.browser = { ...state.browser, nonce: state.browser.nonce + 1 }
        renderDetail()
      },
    })
    return
  }
  renderFileTree(body, state.files, {
    filter: state.fileFilter,
    open: state.openDirs,
    openFile: (path) => openFile(path),
    setFilter: (q) => {
      state.fileFilter = q
      renderDetail()
      body.querySelector<HTMLInputElement>(".tree-filter")?.focus()
    },
    redraw: () => renderDetail(),
  })
}

const openUrl = (url: string) => togglePanel("browser", url)

/** Side questions (/btw) and catch-ups: cards in the chat that are not part of Conductor's conversation. */
const quickCards = new Map<string, HTMLElement>()

function quickCard(id: string, kind: "side" | "catchup", question?: string): HTMLElement {
  const have = quickCards.get(id)
  if (have) return have
  const card = el("article", `card ${kind === "side" ? "side-card" : "catchup-card"}`)
  const head = el("header", "quick-head")
  head.append(
    Object.assign(el("span", "quick-kind"), { textContent: kind === "side" ? "By the way" : "Catch-up" }),
    Object.assign(el("span", "muted"), {
      textContent: kind === "side" ? "a fast model, outside Conductor's chat" : "where this chat stands",
    }),
  )
  card.append(head)
  if (question) card.append(Object.assign(el("p", "quick-question"), { textContent: question }))
  const body = el("div", "quick-body")
  body.append(el("span", "spinner"), Object.assign(el("span", "muted"), { textContent: "Thinking…" }))
  card.append(body)
  quickCards.set(id, card)
  append(card, top())
  return card
}

function quickAnswer(id: string, kind: "side" | "catchup", text: string, error: string | undefined, question?: string) {
  const card = quickCard(id, kind, question)
  const body = card.querySelector(".quick-body") as HTMLElement
  if (error) body.replaceChildren(Object.assign(el("div", "error"), { textContent: error }))
  else body.replaceChildren(mdBlock(text))
  card.append(
    messageMeta(
      now(),
      () => text,
      "Copy answer",
      speakButton(() => text),
    ),
  )
}

function catchUp() {
  if (!state.workspace) {
    showBanner("Choose a workspace folder first.")
    return
  }
  if (!state.chat) {
    showBanner("There is nothing to catch up on yet: this chat has no requests.")
    return
  }
  send({ type: "catchup", workspace: runDir() })
}
$("catchup").addEventListener("click", catchUp)

// Notes made on files and reports collect above the composer until sent.
function addNote(note: Annotation) {
  state.notes.push(note)
  renderNotes()
}

function renderNotes() {
  const box = $("notes")
  box.hidden = !state.notes.length
  box.replaceChildren()
  if (!state.notes.length) return
  const head = el("div", "notes-head")
  head.append(
    Object.assign(el("strong"), { textContent: `${state.notes.length} note${state.notes.length > 1 ? "s" : ""} for Conductor` }),
    el("span", "spacer"),
    textButton("Send notes", "primary small", () => {
      if (startRequest(formatAnnotations(state.notes))) {
        state.notes = []
        renderNotes()
      }
    }),
    textButton("Clear", "ghost small", () => {
      state.notes = []
      renderNotes()
    }),
  )
  const list = el("ol", "notes-list")
  for (const n of state.notes) {
    const li = el("li", "note-row")
    const where =
      n.source.kind === "file"
        ? `${n.source.path}:${n.source.start}${n.source.end !== n.source.start ? `-${n.source.end}` : ""}`
        : n.source.kind === "drawing"
          ? `${n.source.path}: ${n.source.shape}`
          : `report of "${n.source.title}"`
    li.append(
      Object.assign(el("span", `note-chip mark-${n.mark}`), { textContent: MARK_LABELS[n.mark] }),
      Object.assign(el("span", "note-where mono"), { textContent: where }),
      Object.assign(el("span", "note-quote"), { textContent: n.note ? `${n.note} (on "${n.quote}")` : `"${n.quote}"`, title: n.quote }),
      iconButton(ICON.close, "Remove note", () => {
        state.notes = state.notes.filter((x) => x !== n)
        renderNotes()
      }),
    )
    list.append(li)
  }
  box.append(head, list)
}

const annotator = setupAnnotator({
  root: $("detail-body"),
  bar: $("note-bar"),
  add: addNote,
  sourceFor: (range) => {
    const node = range.commonAncestorContainer
    const elOf = (node instanceof Element ? node : node.parentElement) as HTMLElement | null
    if (state.file && elOf?.closest(".file-view, .md-preview")) {
      const lines = fileLines(range)
      return lines ? { kind: "file", path: state.file.path, ...lines } : undefined
    }
    const report = elOf?.closest<HTMLElement>("[data-report]")
    const t = report ? state.threads.get(report.dataset.report as string) : undefined
    return t ? { kind: "report", title: taskTitle(t.task), agent: t.agent } : undefined
  },
})

// A new chat can run in a worktree, picked before its first request (Ghostex's worktree tray).
function loadWorktrees() {
  state.worktrees = undefined
  state.newChatRun = { mode: "here" }
  renderWorktreeTray()
  if (!state.workspace) return
  void request({ type: "worktrees.list", requestId: nextRequestId(), workspace: state.workspace }).then((m) => {
    if (m.type !== "worktrees") return
    state.worktrees = m.list
    renderWorktreeTray()
  })
}

function renderWorktreeTray() {
  const tray = $("worktree-tray")
  const wt = state.worktrees
  tray.hidden = Boolean(state.chat) || !wt || state.view !== "chat"
  renderRunBadge()
  if (tray.hidden || !wt) return
  tray.replaceChildren()
  const run = state.newChatRun
  const group = el("div", "seg")
  group.setAttribute("role", "radiogroup")
  group.setAttribute("aria-label", "Where this chat runs")
  const option = (mode: "here" | "new" | "existing", label: string, title: string) => {
    const b = el("button", "seg-btn") as HTMLButtonElement
    b.type = "button"
    b.setAttribute("role", "radio")
    b.setAttribute("aria-checked", String(run.mode === mode))
    b.textContent = label
    b.title = title
    b.disabled = mode === "existing" && !wt.worktrees.length
    b.addEventListener("click", () => {
      state.newChatRun =
        mode === "new"
          ? { mode, base: wt.current }
          : mode === "existing"
            ? { mode, path: (wt.worktrees[0] as { path: string }).path }
            : { mode }
      renderWorktreeTray()
    })
    group.append(b)
  }
  option("here", "This folder", `Run in ${state.workspace}`)
  option("new", "New worktree", "A fresh checkout on its own branch, so this chat's edits stay apart")
  option("existing", "Existing worktree", wt.worktrees.length ? "Continue in a worktree that already exists" : "No other worktrees yet")
  tray.append(Object.assign(el("span", "muted"), { textContent: "Run in" }), group)
  if (run.mode !== "here") {
    const select = document.createElement("select")
    select.className = "seg-select"
    select.setAttribute("aria-label", run.mode === "new" ? "Start from branch" : "Worktree")
    const items =
      run.mode === "new" ? wt.branches.map((b) => [b, `from ${b}`]) : wt.worktrees.map((w) => [w.path, `${w.branch || folderName(w.path)}`])
    for (const [value, label] of items) select.add(new Option(label, value))
    select.value = run.mode === "new" ? run.base : run.path
    select.addEventListener("change", () => {
      state.newChatRun = run.mode === "new" ? { mode: "new", base: select.value } : { mode: "existing", path: select.value }
    })
    tray.append(select)
  }
}

/** The chat's worktree beside its title in the header. */
function renderRunBadge() {
  let badge = document.getElementById("crumb-run")
  if (!badge) {
    badge = el("span", "crumb-run")
    badge.id = "crumb-run"
    $("chat-title").after(badge)
  }
  const runIn = state.chat?.runIn
  badge.hidden = !runIn
  badge.textContent = runIn ? `worktree ${folderName(runIn)}` : ""
  badge.title = runIn ?? ""
}

// Schedule the composer's request for later (Ghostex's automations).
const REPEATS: [Schedule["repeat"], string][] = [
  ["none", "Once"],
  ["hourly", "Every hour"],
  ["daily", "Every day"],
  ["weekdays", "Weekdays"],
  ["weekly", "Every week"],
]

function localInputValue(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

function renderScheduleMenu() {
  const menu = $("schedule-menu")
  menu.replaceChildren()
  const form = document.createElement("form")
  form.className = "schedule-form"
  const text = document.createElement("textarea")
  text.rows = 2
  text.value = promptBox.value.trim()
  text.className = "schedule-input"
  text.placeholder = "The request to send"
  text.setAttribute("aria-label", "Request")
  const when = document.createElement("input")
  when.type = "datetime-local"
  when.value = localInputValue(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000)
  when.setAttribute("aria-label", "When")
  const repeat = document.createElement("select")
  repeat.setAttribute("aria-label", "Repeat")
  for (const [v, label] of REPEATS) repeat.add(new Option(label, v))
  const target = document.createElement("select")
  target.setAttribute("aria-label", "Send it to")
  if (state.chat) target.add(new Option("This chat", "chat"))
  target.add(new Option("A new chat", "new"))
  const row = el("div", "schedule-row")
  row.append(when, repeat, target)
  const go = textButton("Schedule", "primary small", () => form.requestSubmit())
  go.type = "submit"
  form.append(text, row, go)
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    const at = new Date(when.value).getTime()
    if (!text.value.trim() || !Number.isFinite(at) || !state.workspace) return
    send({
      type: "schedule.add",
      schedule: {
        workspace: state.workspace,
        chatId: target.value === "chat" ? state.chat?.id : undefined,
        prompt: text.value.trim(),
        at,
        repeat: repeat.value as Schedule["repeat"],
        profile: profileSelect.value || undefined,
        permission: permissionSelect.value as PermissionMode,
      },
    })
    if (text.value.trim() === promptBox.value.trim()) {
      promptBox.value = ""
      updateSendButton()
    }
  })
  menu.append(form)
  if (state.schedules.length) {
    const list = el("ul", "schedule-list")
    for (const sc of state.schedules) {
      const li = el("li")
      const label = REPEATS.find(([v]) => v === sc.repeat)?.[1] ?? ""
      li.append(
        Object.assign(el("span", "schedule-when"), {
          textContent: `${new Date(sc.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}${sc.repeat !== "none" ? `, ${label.toLowerCase()}` : ""}`,
        }),
        Object.assign(el("span", "schedule-text"), { textContent: sc.prompt, title: sc.prompt }),
        iconButton(ICON.close, "Cancel this schedule", () => send({ type: "schedule.remove", id: sc.id })),
      )
      list.append(li)
    }
    menu.append(Object.assign(el("div", "field-label"), { textContent: "Scheduled" }), list)
  }
  requestAnimationFrame(() => (text.value ? when : text).focus())
}

// The terminal dock.
const dock = setupDock({
  dock: $("dock"),
  tabs: $("dock-tabs"),
  body: $("dock-body"),
  send,
  request,
  nextId: nextRequestId,
  workspace: runDir,
  draft: () => {
    const d = promptBox.value.trim()
    promptBox.value = ""
    updateSendButton()
    return d
  },
  report: showBanner,
})
$("toggle-dock").addEventListener("click", () => dock.toggle())
$("dock-hide").addEventListener("click", () => dock.show(false))
$("dock-shell").addEventListener("click", () => void dock.open("shell"))
$("dock-cli").addEventListener("click", () => void dock.open("conductor"))
{
  // Drag (or arrow keys on) the dock's top edge to resize it.
  const handle = $("dock-resize")
  const set = (h: number) => {
    const max = Math.round(innerHeight * 0.7)
    const px = Math.max(120, Math.min(max, h))
    document.documentElement.style.setProperty("--dock-height", `${px}px`)
    prefs.set("dock-height", String(px))
  }
  const saved = Number(prefs.get("dock-height"))
  if (saved) set(saved)
  handle.addEventListener("pointerdown", (e) => {
    const startY = e.clientY
    const startH = $("dock").getBoundingClientRect().height
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => set(startH + startY - ev.clientY)
    const up = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", up)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", up)
  })
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
    e.preventDefault()
    set($("dock").getBoundingClientRect().height + (e.key === "ArrowUp" ? 24 : -24))
  })
}

// The board view, in place of the chat.
const board = setupBoard({
  root: $("board"),
  send,
  workspace: () => state.workspace,
  chats: () => state.chats,
  run: (card: Card) => {
    if (state.running) {
      showBanner("Stop the running turn before starting a card.")
      return false
    }
    newChat()
    state.runningCard = card.id
    setView("chat")
    return startRequest(card.notes.trim() ? `${card.title}\n\n${card.notes}` : card.title)
  },
  openChat: (id) => {
    const c = state.chats.find((x) => x.id === id)
    if (!c) return
    setView("chat")
    openChat(c)
  },
})

type View = "chat" | "board" | "code"
const VIEWS: View[] = ["chat", "board", "code"]

function setView(view: View) {
  state.view = view
  for (const v of VIEWS) {
    const tab = $(`view-${v}`)
    tab.setAttribute("aria-selected", String(view === v))
    tab.tabIndex = view === v ? 0 : -1
  }
  log.hidden = view !== "chat"
  $("board").hidden = view !== "board"
  $("ide").hidden = view !== "code"
  document.querySelector(".composer")?.toggleAttribute("hidden", view !== "chat")
  if (view !== "chat") $("minimap").hidden = true
  if (view === "board") board.load()
  if (view === "code") {
    renderIde()
    send({ type: "ide.status" })
  }
  renderWorktreeTray()
}
for (const v of VIEWS) {
  $(`view-${v}`).addEventListener("click", () => setView(v))
  $(`view-${v}`).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    const next = VIEWS[(VIEWS.indexOf(state.view) + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length] as View
    setView(next)
    $(`view-${next}`).focus()
  })
}

// ── Code: VS Code in the app, on demand (Ghostex's built-in IDE) ─────────

function renderIde() {
  const box = $("ide")
  const ide = state.ide
  const folder = runDir()
  if (ide.state === "running" && ide.url) {
    let frame = box.querySelector<HTMLIFrameElement>("iframe.vscode-embed")
    if (!frame || frame.dataset.url !== ide.url) {
      box.replaceChildren()
      const bar = el("div", "ide-bar")
      bar.append(
        Object.assign(el("span", "muted"), { textContent: `VS Code (${ide.kind ?? "server"}) in ${folderName(folder)}` }),
        el("span", "spacer"),
        textButton("Reload", "ghost small", () => {
          const f = box.querySelector<HTMLIFrameElement>("iframe.vscode-embed")
          if (f) f.src = f.dataset.url ?? f.src
        }),
        textButton("Open in your browser", "ghost small", () => send({ type: "open.url", url: ide.url as string })),
        textButton("Stop", "ghost small", () => send({ type: "ide.stop" })),
      )
      frame = document.createElement("iframe")
      frame.className = "vscode-embed"
      frame.title = "VS Code"
      frame.dataset.url = ide.url
      frame.src = ide.url
      frame.setAttribute("allow", "clipboard-read; clipboard-write")
      box.append(bar, frame)
    }
    return
  }
  box.replaceChildren()
  const card = el("section", "ide-empty")
  card.append(Object.assign(el("h2"), { textContent: "VS Code, in the app" }))
  const say = (text: string, cls = "muted") => card.append(Object.assign(el("p", cls), { textContent: text }))
  if (ide.state === "installing") {
    say(ide.progress ?? "Installing…")
    card.append(el("span", "spinner"))
  } else if (ide.state === "ready") {
    say(`Runs a local VS Code server (${ide.kind}) for ${folder || "the workspace"}, only on this machine.`)
    card.append(textButton("Open VS Code here", "primary", () => folder && send({ type: "ide.start", workspace: folder }), !folder))
  } else {
    say("This needs a VS Code server: openvscode-server or code-server, on PATH or downloaded here.")
    if (ide.canInstall) {
      say("Download openvscode-server (about 80 MB) into the app's data folder. Nothing is installed system-wide.")
      card.append(textButton("Download openvscode-server", "primary", () => send({ type: "ide.install" })))
    } else say("On this system, install code-server (for example with Homebrew: brew install code-server), then come back.")
  }
  if (ide.error) say(ide.error, "error")
  box.append(card)
}

$("toggle-files").addEventListener("click", () => togglePanel("files"))
$("toggle-browser").addEventListener("click", () => togglePanel("browser"))

sortable($("queue"), {
  lists: () => [...$("queue").querySelectorAll<HTMLElement>(".queue-list")],
  item: ".queue-row",
  handle: ".queue-grip",
  drop: (id, _list, index) => send({ type: "queue.move", id, to: index }),
})
setupMinimap(log, $("minimap"))

const soundToggle = $<HTMLInputElement>("sound-toggle")
soundToggle.checked = prefs.get("sound") === "on"
soundToggle.addEventListener("change", () => {
  prefs.set("sound", soundToggle.checked ? "on" : "off")
  if (soundToggle.checked) chime("done")
})

/** Messages for the views beside the chat; true when handled. */
function besideMessage(msg: ServerMessage): boolean {
  if (dock.onMessage(msg)) return true
  switch (msg.type) {
    // Each answer belongs to the chat it was asked in; another chat on screen does not show it.
    case "quick.started":
      if (msg.chatId === state.chat?.id) quickCard(msg.id, msg.kind, msg.question)
      return true
    case "side.answer":
      if (msg.chatId === state.chat?.id || state.replaying) quickAnswer(msg.id, "side", msg.text, msg.error, msg.question)
      return true
    case "catchup":
      if (msg.chatId === state.chat?.id || state.replaying) quickAnswer(msg.id, "catchup", msg.text, msg.error)
      return true
    case "schedules":
      state.schedules = msg.items
      if (!$("schedule-menu").hidden) renderScheduleMenu()
      $("schedule-btn").classList.toggle("has-items", msg.items.length > 0)
      return true
    case "board":
      board.set(msg.workspace, msg.cards)
      return true
    case "turn.checkpoint":
      turnCheckpoint(msg.turnId, msg.checkpoint)
      return true
    case "budget":
      renderBudget(msg.budget)
      return true
    case "templates":
      state.templates = msg.items
      if (settingsTab() === "templates") renderTemplates()
      return true
    case "ide":
      state.ide = msg.ide
      if (state.view === "code") renderIde()
      return true
    default:
      return false
  }
}

// ── Usage: subscriptions and spend in one place ─────────────────────────

async function openUsage() {
  const dialog = $<HTMLDialogElement>("usage")
  const body = $("usage-body")
  body.replaceChildren(Object.assign(el("p", "muted"), { textContent: "Adding up your chats…" }))
  if (!dialog.open) dialog.showModal()
  const subs = el("section", "usage-section")
  subs.append(Object.assign(el("h3"), { textContent: "Subscriptions" }))
  const status = state.backends
  for (const p of Object.keys(status?.health ?? {}) as ProviderId[]) {
    const h = status?.health[p]
    const row = el("div", "usage-sub")
    const head = el("div", "usage-sub-head")
    head.append(
      el("span", `dot ${h?.healthy ? "ok" : "bad"}`),
      Object.assign(el("strong"), { textContent: PROVIDER_LABEL[p] }),
      Object.assign(el("span", "muted"), {
        textContent: h?.healthy ? `${status?.executables[p] ?? ""} ${h.version ?? ""}`.trim() : (h?.reason ?? "unavailable"),
      }),
    )
    row.append(head)
    const windows = currentWindows(p)
    if (!windows.length)
      row.append(
        Object.assign(el("div", "muted usage-none"), { textContent: "No usage reported yet (it shows after this backend's next run)." }),
      )
    for (const w of windows) {
      const pct = Math.round(w.usedFraction * 100)
      const level = w.limited || pct >= 90 ? "bad" : pct >= 70 ? "warn" : ""
      const meter = el("div", "usage-window")
      const bar = el("div", `usage-bar ${level}`)
      bar.setAttribute("role", "meter")
      bar.setAttribute("aria-valuemin", "0")
      bar.setAttribute("aria-valuemax", "100")
      bar.setAttribute("aria-valuenow", String(pct))
      bar.setAttribute("aria-label", `${PROVIDER_LABEL[p]} ${w.label}`)
      const fill = el("span", "usage-fill")
      fill.style.width = `${Math.min(100, pct)}%`
      bar.append(fill)
      meter.append(
        Object.assign(el("span", "usage-label"), { textContent: w.label }),
        bar,
        Object.assign(el("span", "usage-pct"), { textContent: `${pct}%${w.limited ? ", limit reached" : ""}` }),
        Object.assign(el("span", "muted usage-reset"), {
          textContent: w.resetsAt
            ? `resets ${new Date(w.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
            : "",
        }),
      )
      row.append(meter)
    }
    subs.append(row)
  }
  const reply = await request({ type: "usage.summary", requestId: nextRequestId() })
  if (reply.type !== "usage" || !dialog.open) return
  const u: UsageSummary = reply.summary
  const spend = el("section", "usage-section")
  spend.append(Object.assign(el("h3"), { textContent: "Spend, all saved chats" }))
  const tiles = el("div", "stat-tiles")
  for (const [label, value] of [
    ["Reported cost", `$${u.costUsd.toFixed(2)}`],
    ["Tokens", compact(u.tokens)],
    ["Chats", String(u.chats)],
    ["Requests", String(u.turns)],
  ] as [string, string][])
    tiles.append(
      el("div", "stat-tile", `<div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div>`),
    )
  spend.append(tiles)
  const chart = el(
    "div",
    "",
    renderChart({
      type: "bar",
      title: "Tokens per day, last 14 days",
      labels: u.days.map((d) => d.day.slice(5)),
      series: [{ name: "", values: u.days.map((d) => d.tokens) }],
    }),
  )
  spend.append(chart)
  const table = el("table", "usage-table")
  table.innerHTML = "<thead><tr><th>Backend</th><th>Threads</th><th>Tokens</th><th>Reported cost</th></tr></thead>"
  const tb = document.createElement("tbody")
  for (const p of Object.keys(u.providers) as ProviderId[]) {
    const v = u.providers[p]
    const tr = document.createElement("tr")
    for (const text of [
      PROVIDER_LABEL[p],
      String(v.threads),
      compact(v.tokens),
      p === "claude" ? `$${v.costUsd.toFixed(2)}` : "not reported",
    ]) {
      tr.append(Object.assign(document.createElement("td"), { textContent: text }))
    }
    tb.append(tr)
  }
  table.append(tb)
  spend.append(
    table,
    Object.assign(el("p", "muted"), { textContent: "Conductor counts as Claude. Gemini and Codex report tokens but not cost." }),
  )
  body.replaceChildren(budgetSection(), subs, spend)
}
$("open-usage").addEventListener("click", () => void openUsage())
$("usage-close").addEventListener("click", () => $<HTMLDialogElement>("usage").close())
$("lightbox-close").addEventListener("click", () => $<HTMLDialogElement>("lightbox").close())
$("lightbox").addEventListener("click", (e) => {
  if (e.target === $("lightbox")) $<HTMLDialogElement>("lightbox").close()
})

// ── Spaces: sets of folders, Arc-style, so the sidebar shows one set at a time ──

interface Space {
  id: string
  name: string
  folders: string[]
}
const spaces = () => prefs.json<Space[]>("spaces", [])
const saveSpaces = (list: Space[]) => prefs.set("spaces", JSON.stringify(list))
const activeSpace = () => spaces().find((sp) => sp.id === prefs.get("space"))
let namingSpace: string | undefined

function renderSpaces() {
  const bar = $("spaces")
  const list = spaces()
  const active = activeSpace()
  bar.replaceChildren()
  const chip = (id: string, label: string, sp?: Space) => {
    const b = el("button", "space-chip") as HTMLButtonElement
    b.type = "button"
    b.setAttribute("role", "tab")
    b.setAttribute("aria-selected", String((active?.id ?? "") === id))
    b.textContent = label
    b.title = sp ? `${sp.folders.length} folder${sp.folders.length === 1 ? "" : "s"}. Right-click to rename or delete.` : "Every folder"
    b.addEventListener("click", () => {
      prefs.set("space", id)
      renderSpaces()
      renderSidebar()
    })
    if (sp)
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault()
        openMenu(
          [
            {
              label: "Rename…",
              run: () => {
                namingSpace = sp.id
                renderSpaces()
              },
            },
            {
              label: "Delete space",
              danger: true,
              run: () => {
                saveSpaces(spaces().filter((x) => x.id !== sp.id))
                if (prefs.get("space") === sp.id) prefs.set("space", "")
                renderSpaces()
                renderSidebar()
              },
            },
          ],
          { x: e.clientX, y: e.clientY },
          b,
          `Space ${sp.name}`,
        )
      })
    bar.append(b)
  }
  chip("", "All")
  for (const sp of list) {
    if (namingSpace === sp.id) bar.append(spaceInput(sp))
    else chip(sp.id, sp.name, sp)
  }
  if (namingSpace === "new") bar.append(spaceInput())
  else {
    const add = el("button", "space-chip add") as HTMLButtonElement
    add.type = "button"
    add.title = "New space with this folder"
    add.setAttribute("aria-label", "New space")
    add.textContent = "+"
    add.addEventListener("click", () => {
      namingSpace = "new"
      renderSpaces()
    })
    bar.append(add)
  }
  bar.querySelector<HTMLInputElement>("input")?.focus()
}

function spaceInput(sp?: Space): HTMLInputElement {
  const input = document.createElement("input")
  input.className = "space-input"
  input.value = sp?.name ?? ""
  input.placeholder = "Space name"
  input.setAttribute("aria-label", "Space name")
  let done = false
  const finish = (save: boolean) => {
    if (done) return
    done = true
    namingSpace = undefined
    const name = input.value.trim()
    if (save && name) {
      if (sp) saveSpaces(spaces().map((x) => (x.id === sp.id ? { ...x, name } : x)))
      else {
        const id = `s-${Date.now().toString(36)}`
        saveSpaces([...spaces(), { id, name, folders: state.workspace ? [state.workspace] : [] }])
        prefs.set("space", id)
      }
    }
    renderSpaces()
    renderSidebar()
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true)
    if (e.key === "Escape") {
      e.stopPropagation()
      finish(false)
    }
  })
  input.addEventListener("blur", () => finish(true))
  return input
}

/** A folder's space actions, for its sidebar menu. */
function spaceItems(dir: string): MenuItem[] {
  const items: MenuItem[] = []
  const active = activeSpace()
  for (const sp of spaces())
    if (!sp.folders.some((f) => samePath(f, dir)))
      items.push({
        label: `Add to space ${sp.name}`,
        run: () => {
          saveSpaces(spaces().map((x) => (x.id === sp.id ? { ...x, folders: [...x.folders, dir] } : x)))
          renderSidebar()
        },
      })
  if (active?.folders.some((f) => samePath(f, dir)))
    items.push({
      label: `Remove from ${active.name}`,
      run: () => {
        saveSpaces(spaces().map((x) => (x.id === active.id ? { ...x, folders: x.folders.filter((f) => !samePath(f, dir)) } : x)))
        renderSidebar()
      },
    })
  return items
}
renderSpaces()

// ── The tray icon's status line (Ghostex's menu bar item) ─────────────────

let lastTray = ""
function trayStatus() {
  const blocked = [...state.threads.values()].some((t) => t.summary?.status === "blocked")
  const text = state.running ? `Working: ${state.fold?.activity ?? "starting"}` : blocked ? "A thread needs you" : "Idle"
  if (text === lastTray) return
  lastTray = text
  void invoke("tray_status", { text }).catch(() => {})
}

// ── Budgets: limits per chat and per day, enforced by the core ──────────

let lastBudgetWarning = ""
function renderBudget(b: BudgetState) {
  state.budget = b
  const item = $("budget")
  const limit = b.limits.chatUsd ?? b.limits.dayUsd
  item.hidden = limit === null
  item.className = `status-item budget${b.over ? " bad" : b.near ? " warn" : ""}`
  const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
  if (b.limits.chatUsd !== null) item.textContent = `${usd(b.chatUsd)} of ${usd(b.limits.chatUsd)}`
  else if (b.limits.dayUsd !== null) item.textContent = `${usd(b.dayUsd)} of ${usd(b.limits.dayUsd)} today`
  item.title = b.over ?? b.near ?? "Spending limits: set them in Usage"
  const warning = b.over ?? b.near ?? ""
  if (warning && warning !== lastBudgetWarning && !state.replaying) showBanner(warning, { label: "Limits", run: () => void openUsage() })
  lastBudgetWarning = warning
  // A subscription window past the warning share warns once, too.
  for (const p of Object.keys(state.quota) as ProviderId[]) {
    const full = currentWindows(p).find((w) => w.usedFraction >= b.limits.warnAt)
    const key = full ? `${p}:${full.label}:${Math.round(full.usedFraction * 100)}` : ""
    if (full && !quotaWarned.has(key)) {
      quotaWarned.add(key)
      showBanner(`${PROVIDER_LABEL[p]} ${describeWindow(full)}. The router prefers other backends now.`)
    }
  }
}
const quotaWarned = new Set<string>()

/** The Limits section of the Usage dialog. */
function budgetSection(): HTMLElement {
  const box = el("section", "usage-section")
  box.append(Object.assign(el("h3"), { textContent: "Limits" }))
  const limits = state.budget?.limits ?? { chatUsd: null, dayUsd: null, warnAt: 0.8 }
  const form = document.createElement("form")
  form.className = "limits-form"
  const field = (label: string, value: number | null, hint: string) => {
    const wrap = el("label", "field")
    const input = document.createElement("input")
    input.type = "number"
    input.className = "field-input"
    input.min = "0"
    input.step = "any"
    input.placeholder = "no limit"
    input.value = value === null ? "" : String(value)
    wrap.append(Object.assign(el("span"), { textContent: label }), input, Object.assign(el("small", "muted"), { textContent: hint }))
    form.append(wrap)
    return input
  }
  const chat = field("Per chat, USD", limits.chatUsd, "A turn will not start past it, and stops when it gets there.")
  const day = field("Per day, USD", limits.dayUsd, "All chats together, today.")
  const warn = field("Warn at, %", Math.round(limits.warnAt * 100), "Of a limit, or of a subscription window.")
  warn.step = "5"
  warn.min = "10"
  warn.max = "99"
  const save = textButton("Save limits", "primary small", () => form.requestSubmit())
  save.type = "submit"
  const status = Object.assign(el("span", "muted"), { textContent: state.budget ? `This chat: $${state.budget.chatUsd.toFixed(2)}` : "" })
  const row = el("div", "buttons")
  row.append(save, status)
  form.append(row)
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    const n = (i: HTMLInputElement) => (i.value.trim() === "" ? null : Number(i.value))
    send({ type: "budget.set", limits: { chatUsd: n(chat), dayUsd: n(day), warnAt: (Number(warn.value) || 80) / 100 } })
    status.textContent = "Saved."
  })
  box.append(
    form,
    Object.assign(el("p", "muted"), {
      textContent: "Only Claude reports cost, so limits count Conductor and Claude threads; Gemini and Codex count tokens only.",
    }),
  )
  return box
}

// ── Prompt templates ────────────────────────────────────────────────────

function openTemplates() {
  openSettings("templates")
}

function renderTemplates(edit?: PromptTemplate) {
  const body = $("spanel-templates")
  body.replaceChildren(
    ...panelHead("Templates", "Requests you send often. Type / and the name in the composer; $ARGUMENTS takes what you type after it."),
  )
  const form = document.createElement("form")
  form.className = "template-form"
  const name = document.createElement("input")
  name.className = "field-input"
  name.placeholder = "name, like review-pr"
  name.setAttribute("aria-label", "Template name")
  name.value = edit?.name ?? ""
  const scope = document.createElement("select")
  scope.className = "field-input"
  scope.setAttribute("aria-label", "Save for")
  scope.add(new Option("This project (.harness/prompts, shared through git)", "project"))
  scope.add(new Option("Me, in every project", "user"))
  scope.value = edit?.scope ?? "project"
  const text = document.createElement("textarea")
  text.className = "field-text"
  text.rows = 6
  text.placeholder = "The request. $ARGUMENTS is replaced by what you type after the command."
  text.setAttribute("aria-label", "Template text")
  text.value = edit?.text ?? promptBox.value.trim()
  const save = textButton(edit ? "Save template" : "Add template", "primary small", () => form.requestSubmit())
  save.type = "submit"
  const status = el("span", "muted")
  const row = el("div", "buttons")
  row.append(save, status)
  form.append(name, scope, text, row)
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    send({
      type: "template.save",
      workspace: state.workspace,
      scope: scope.value as "project" | "user",
      name: name.value.trim(),
      text: text.value,
    })
    status.textContent = `Saved: type /${name.value.trim()} in the composer.`
  })
  body.append(form)
  if (state.templates.length) {
    const list = el("ul", "template-list")
    for (const t of state.templates) {
      const li = el("li")
      li.append(
        Object.assign(el("strong", "mono"), { textContent: `/${t.name}` }),
        Object.assign(el("span", "muted"), { textContent: t.scope === "project" ? "project" : "yours" }),
        Object.assign(el("span", "template-text"), { textContent: t.text.split("\n")[0] ?? "", title: t.text }),
        textButton("Edit", "ghost small", () => renderTemplates(t)),
        textButton("Delete", "ghost small danger", () =>
          send({ type: "template.delete", workspace: state.workspace, scope: t.scope, name: t.name }),
        ),
      )
      list.append(li)
    }
    body.append(list)
  }
  requestAnimationFrame(() => (edit ? text : name).focus())
}

// ── Project memory: the notes Conductor reads at the start of each turn ──

async function openMemory() {
  if (!state.workspace) {
    showBanner("Choose a workspace folder first.")
    return
  }
  const path = ".harness/memory.md"
  const read = await request({ type: "file.read", requestId: nextRequestId(), workspace: runDir(), path })
  if (read.type === "file.content" && read.error && /No such file/.test(read.error))
    await request({ type: "file.write", requestId: nextRequestId(), workspace: runDir(), path, text: "" })
  openFile(path, undefined, undefined, "source")
}

// ── Routing: which backend and tier each kind of task gets ──────────────

function openRouting() {
  openSettings("routing")
}

async function renderRouting() {
  const current = beginRender("routing")
  const body = $("spanel-routing")
  body.replaceChildren(Object.assign(el("p", "muted"), { textContent: "Loading the routes…" }))
  const reply = await request({ type: "routing.get", requestId: nextRequestId(), workspace: state.workspace })
  if (reply.type !== "routing" || !current()) return
  if (reply.error) {
    body.replaceChildren(Object.assign(el("div", "error"), { textContent: reply.error }))
    return
  }
  const rows: RouteRow[] = reply.routes.filter((r) => r.agent !== "conductor")
  const providers = Object.keys(PROVIDER_LABEL) as ProviderId[]
  const tiers = ["fast", "standard", "deep"] as const
  const intro = panelHead(
    "Routing",
    "Each kind of task goes to its first backend, then the next ones if that cannot take it. A tier never goes below the task's floor. Changes apply from the next delegation.",
  )
  const table = el("table", "routing-table")
  table.innerHTML = "<thead><tr><th>Task</th><th>First backend</th><th>Then</th><th>Tier</th></tr></thead>"
  const tbody = document.createElement("tbody")
  const edits = new Map<string, RouteRow>()
  for (const r of rows) {
    const row = { ...r, fallback: [...r.fallback] }
    edits.set(r.taskClass, row)
    const tr = document.createElement("tr")
    const cls = Object.assign(document.createElement("td"), { textContent: r.taskClass })
    cls.title = `Agent: ${r.agent}`
    const primary = document.createElement("select")
    primary.className = "field-input"
    primary.setAttribute("aria-label", `${r.taskClass}: first backend`)
    for (const p of providers) primary.add(new Option(PROVIDER_LABEL[p], p))
    if (r.primary === "auto_not_author") primary.add(new Option("Not the author (reviews)", "auto_not_author"))
    if (r.primary === "self") primary.add(new Option("Conductor itself", "self"))
    primary.value = r.primary
    primary.addEventListener("change", () => {
      row.primary = primary.value as RouteRow["primary"]
    })
    const fallback = el("td", "routing-fallback")
    for (const p of providers) {
      const label = el("label", "check")
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = row.fallback.includes(p)
      box.addEventListener("change", () => {
        row.fallback = box.checked ? [...row.fallback, p] : row.fallback.filter((x) => x !== p)
      })
      label.append(box, document.createTextNode(` ${PROVIDER_LABEL[p]}`))
      fallback.append(label)
    }
    const tier = document.createElement("select")
    tier.className = "field-input"
    tier.setAttribute("aria-label", `${r.taskClass}: tier`)
    for (const t of tiers) if (tiers.indexOf(t) >= tiers.indexOf(r.minTier)) tier.add(new Option(t, t))
    tier.value = r.tier
    tier.addEventListener("change", () => {
      row.tier = tier.value as RouteRow["tier"]
    })
    const td = (node: HTMLElement) => {
      const c = document.createElement("td")
      c.append(node)
      return c
    }
    tr.append(cls, td(primary), fallback, td(tier))
    tbody.append(tr)
  }
  table.append(tbody)
  const scope = document.createElement("select")
  scope.className = "field-input"
  scope.setAttribute("aria-label", "Save to")
  scope.add(new Option("This project", "project"))
  scope.add(new Option("All projects", "user"))
  const status = el("span", "muted")
  const save = textButton("Save routing", "primary small", async () => {
    const res = await request({
      type: "routing.save",
      requestId: nextRequestId(),
      workspace: state.workspace,
      scope: scope.value as "project" | "user",
      routes: [...edits.values()].map((r) => ({ taskClass: r.taskClass, primary: r.primary, fallback: r.fallback, tier: r.tier })),
    })
    if (res.type !== "routing.saved") return
    status.textContent = res.error ?? `Saved to ${res.path}`
    status.className = res.error ? "error" : "muted"
  })
  const bar = el("div", "buttons")
  bar.append(Object.assign(el("span", "muted"), { textContent: "Save to" }), scope, save, status)
  // A dry run: where would this request go, and why?
  const test = document.createElement("form")
  test.className = "route-test"
  const q = document.createElement("input")
  q.className = "field-input"
  q.placeholder = "Try a request, like: find where the login handler is defined"
  q.setAttribute("aria-label", "A request to route")
  const go = textButton("Where would it go?", "ghost small", () => test.requestSubmit())
  go.type = "submit"
  const out = el("div", "route-result")
  test.append(q, go)
  test.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (!q.value.trim()) return
    out.replaceChildren(Object.assign(el("span", "muted"), { textContent: "Asking the router…" }))
    const r = await request({
      type: "route.test",
      requestId: nextRequestId(),
      workspace: state.workspace,
      text: q.value,
      profile: profileSelect.value || undefined,
    })
    if (r.type !== "route.tested") return
    const res = r.result
    out.replaceChildren(
      Object.assign(el("strong"), {
        textContent: res.error
          ? `${res.taskClass}: ${res.error}`
          : `${res.taskClass} goes to ${PROVIDER_LABEL[res.provider as ProviderId]} (${res.tier}${res.model ? `, ${res.model}` : ""})`,
      }),
    )
    const ul = el("ul", "why")
    for (const line of res.why) ul.append(Object.assign(el("li"), { textContent: line }))
    out.append(ul)
  })
  body.replaceChildren(...intro, test, out, table, bar)
}

// ── Settings: every setting in one place (Ctrl+,) ────────────────────────

type SettingsTab = "general" | "models" | "routing" | "profiles" | "advanced" | "limits" | "appearance" | "templates" | "about"
const SETTINGS_TABS: SettingsTab[] = ["general", "models", "routing", "profiles", "advanced", "limits", "appearance", "templates", "about"]
const settingsDialog = $<HTMLDialogElement>("settings")
let currentSettingsTab: SettingsTab = "general"
const settingsTab = () => (settingsDialog.open ? currentSettingsTab : undefined)
const panelRenders = new Map<SettingsTab, number>()
/** Starts a render of a settings panel. The check turns false once a newer render of that panel starts or another tab is chosen, so two renders never interleave their awaits into one panel. */
function beginRender(tab: SettingsTab): () => boolean {
  const n = (panelRenders.get(tab) ?? 0) + 1
  panelRenders.set(tab, n)
  return () => panelRenders.get(tab) === n && settingsTab() === tab
}
const panelOf = (tab: SettingsTab) => (tab === "models" ? $("settings-form") : $(`spanel-${tab}`))

function openSettings(tab: SettingsTab = currentSettingsTab) {
  const needsFolder: SettingsTab[] = ["general", "models", "routing", "profiles", "advanced", "templates"]
  const chosen = !state.workspace && needsFolder.includes(tab) ? "appearance" : tab
  const opening = !settingsDialog.open
  if (opening) settingsDialog.showModal()
  $("settings-workspace").textContent = state.workspace ? folderName(state.workspace) : ""
  $("settings-workspace").title = state.workspace
  selectSettingsTab(chosen, opening)
}

function selectSettingsTab(tab: SettingsTab, focus = false) {
  currentSettingsTab = tab
  for (const t of SETTINGS_TABS) {
    const b = $(`stab-${t}`)
    b.setAttribute("aria-selected", String(t === tab))
    b.tabIndex = t === tab ? 0 : -1
    panelOf(t).hidden = t !== tab
  }
  if (focus) $(`stab-${tab}`).focus()
  if (tab === "general") void renderGeneral()
  else if (tab === "models") settings.load()
  else if (tab === "routing") void renderRouting()
  else if (tab === "profiles") void renderProfilesTab()
  else if (tab === "advanced") void renderAdvanced()
  else if (tab === "limits") $("spanel-limits").replaceChildren(budgetSection())
  else if (tab === "templates") renderTemplates()
  else if (tab === "about") renderAbout()
}

for (const t of SETTINGS_TABS) {
  $(`stab-${t}`).addEventListener("click", () => selectSettingsTab(t))
  $(`stab-${t}`).addEventListener("keydown", (e) => {
    const i = SETTINGS_TABS.indexOf(t)
    const next =
      e.key === "ArrowDown"
        ? SETTINGS_TABS[(i + 1) % SETTINGS_TABS.length]
        : e.key === "ArrowUp"
          ? SETTINGS_TABS[(i + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length]
          : undefined
    if (!next) return
    e.preventDefault()
    selectSettingsTab(next, true)
  })
}
$("settings-close").addEventListener("click", () => settingsDialog.close())
$("open-settings").addEventListener("click", () => openSettings("general"))
$("appearance-btn").addEventListener("click", () => openSettings("appearance"))

/** A "Save to" choice for a settings section: this project's file or yours. */
function scopePicker(): HTMLSelectElement {
  const scope = document.createElement("select")
  scope.className = "field-input"
  scope.setAttribute("aria-label", "Save to")
  scope.add(new Option("This project", "project"))
  scope.add(new Option("All projects", "user"))
  return scope
}

function panelHead(title: string, intro: string): HTMLElement[] {
  return [Object.assign(el("h3", "panel-title"), { textContent: title }), Object.assign(el("p", "hint"), { textContent: intro })]
}

function savedStatus(status: HTMLElement, reply: ServerMessage, what = "Saved") {
  if (reply.type !== "config.saved") return false
  status.textContent = reply.error ?? `${what} to ${reply.path}`
  status.className = reply.error ? "error" : "muted"
  return !reply.error
}

// General: the default profile and permission, and where things are.
async function renderGeneral() {
  const current = beginRender("general")
  const body = $("spanel-general")
  body.replaceChildren(...panelHead("General", "Defaults for new requests. The mode pill in the composer changes them for one request."))
  const reply = await request({ type: "profiles.get", requestId: nextRequestId(), workspace: state.workspace })
  if (reply.type !== "profiles" || !current()) return
  const form = el("div", "settings-grid")
  const profile = document.createElement("select")
  profile.className = "field-input"
  profile.setAttribute("aria-label", "Default profile")
  for (const p of reply.profiles) profile.add(new Option(p.label, p.name))
  profile.value = reply.defaultProfile ?? reply.profiles[0]?.name ?? ""
  const about = el("small", "muted settings-note")
  const describe = () => {
    about.textContent = reply.profiles.find((p) => p.name === profile.value)?.description ?? ""
  }
  describe()
  profile.addEventListener("change", describe)
  const scope = scopePicker()
  const status = el("span", "muted")
  const save = textButton("Save default profile", "primary small", async () => {
    const r = await request({
      type: "profile.default",
      requestId: nextRequestId(),
      workspace: state.workspace,
      scope: scope.value as "project" | "user",
      name: profile.value,
    })
    if (savedStatus(status, r)) send({ type: "status", workspace: state.workspace })
  })
  const permission = document.createElement("select")
  permission.className = "field-input"
  permission.setAttribute("aria-label", "Default permission")
  for (const o of permissionSelect.options) permission.add(new Option(o.textContent ?? o.value, o.value))
  permission.value = permissionSelect.value
  permission.addEventListener("change", () => {
    permissionSelect.value = permission.value
    prefs.set("permission", permission.value)
    renderModeSummary()
  })
  const row = (label: string, ...nodes: HTMLElement[]) => {
    const r = el("div", "settings-row")
    r.append(Object.assign(el("span", "settings-label"), { textContent: label }), ...nodes)
    form.append(r)
  }
  const profileControls = el("div", "settings-controls")
  profileControls.append(profile, scope, save, status, about)
  row("Default profile", profileControls)
  const permissionControls = el("div", "settings-controls")
  permissionControls.append(
    permission,
    Object.assign(el("small", "muted"), { textContent: "On this machine: what Conductor and its delegates may do without asking." }),
  )
  row("Permission", permissionControls)
  row("Workspace", Object.assign(el("span", "mono"), { textContent: state.workspace || "none" }))
  body.append(form)
}

// Profiles: make, change and delete them, with Conductor's tier and per-task overrides.
async function renderProfilesTab(editing?: ProfileRow) {
  const current = beginRender("profiles")
  const body = $("spanel-profiles")
  body.replaceChildren(
    ...panelHead(
      "Profiles",
      "A profile trades cost for depth above each task's quality floor: Conductor's own tier, guidance for it, and tier or backend changes per kind of task.",
    ),
  )
  const reply = await request({ type: "profiles.get", requestId: nextRequestId(), workspace: state.workspace })
  if (reply.type !== "profiles" || !current()) return
  if (reply.error) {
    body.append(Object.assign(el("div", "error"), { textContent: reply.error }))
    return
  }
  const list = el("ul", "profile-list")
  for (const p of reply.profiles) {
    const li = el("li", p.name === editing?.name ? "editing" : "")
    li.append(
      Object.assign(el("strong"), { textContent: p.label }),
      Object.assign(el("span", "mono muted"), { textContent: p.name }),
      Object.assign(el("span", "muted profile-desc"), {
        textContent: `${p.description}${p.name === reply.defaultProfile ? " (default)" : ""}`,
      }),
      textButton("Edit", "ghost small", () => void renderProfilesTab(p)),
    )
    if (!p.builtIn)
      li.append(
        textButton("Delete", "ghost small danger", async () => {
          for (const scope of ["project", "user"] as const) {
            const r = await request({ type: "profile.delete", requestId: nextRequestId(), workspace: state.workspace, scope, name: p.name })
            if (r.type === "config.saved" && !r.error) break
          }
          send({ type: "status", workspace: state.workspace })
          void renderProfilesTab()
        }),
      )
    list.append(li)
  }
  body.append(list)
  const draft: ProfileRow = editing
    ? { ...editing, routeTiers: { ...editing.routeTiers }, routePrimary: { ...editing.routePrimary } }
    : {
        name: "",
        label: "",
        description: "",
        tier: "standard",
        reasoning: "",
        guidance: "",
        routeTiers: {},
        routePrimary: {},
        builtIn: false,
      }
  const form = document.createElement("form")
  form.className = "profile-form"
  form.append(Object.assign(el("h4"), { textContent: editing ? `Edit ${editing.label}` : "New profile" }))
  const input = (label: string, value: string, set: (v: string) => void, opts: { readOnly?: boolean; placeholder?: string } = {}) => {
    const wrap = el("label", "field")
    const i = document.createElement("input")
    i.className = "field-input"
    i.value = value
    i.readOnly = Boolean(opts.readOnly)
    if (opts.placeholder) i.placeholder = opts.placeholder
    i.addEventListener("input", () => set(i.value))
    wrap.append(Object.assign(el("span"), { textContent: label }), i)
    return wrap
  }
  const TIER_NAMES = ["fast", "standard", "deep"]
  const tierSelect = (value: string, label: string, set: (v: string) => void, inherit?: string, floor?: string) => {
    const sel = document.createElement("select")
    sel.className = "field-input"
    sel.setAttribute("aria-label", label)
    if (inherit) sel.add(new Option(inherit, ""))
    for (const t of TIER_NAMES) if (!floor || TIER_NAMES.indexOf(t) >= TIER_NAMES.indexOf(floor)) sel.add(new Option(t, t))
    sel.value = value
    sel.addEventListener("change", () => set(sel.value))
    return sel
  }
  const grid = el("div", "profile-fields")
  grid.append(
    input(
      "Name",
      draft.name,
      (v) => {
        draft.name = v.trim()
      },
      { readOnly: Boolean(editing), placeholder: "night-runs" },
    ),
    input(
      "Label",
      draft.label,
      (v) => {
        draft.label = v
      },
      { placeholder: "Night runs" },
    ),
    input(
      "Description",
      draft.description,
      (v) => {
        draft.description = v
      },
      { placeholder: "What it is for" },
    ),
  )
  const tierWrap = el("label", "field")
  tierWrap.append(
    Object.assign(el("span"), { textContent: "Conductor's tier" }),
    tierSelect(draft.tier, "Conductor's tier", (v) => {
      draft.tier = v as ProfileRow["tier"]
    }),
  )
  grid.append(
    tierWrap,
    input(
      "Conductor's reasoning effort",
      draft.reasoning,
      (v) => {
        draft.reasoning = v
      },
      { placeholder: "high, or empty for the default" },
    ),
  )
  const guidance = document.createElement("textarea")
  guidance.className = "field-text"
  guidance.rows = 4
  guidance.value = draft.guidance
  guidance.placeholder = "Rules added to Conductor's instructions while this profile runs."
  guidance.setAttribute("aria-label", "Guidance")
  guidance.addEventListener("input", () => {
    draft.guidance = guidance.value
  })
  const routing = await request({ type: "routing.get", requestId: nextRequestId(), workspace: state.workspace })
  if (!current()) return
  const rows = routing.type === "routing" ? routing.routes.filter((r) => r.agent !== "conductor") : []
  const table = el("table", "routing-table")
  table.innerHTML = "<thead><tr><th>Task</th><th>Tier in this profile</th><th>First backend in this profile</th></tr></thead>"
  const tb = document.createElement("tbody")
  for (const r of rows) {
    const tr = document.createElement("tr")
    const tier = tierSelect(
      draft.routeTiers[r.taskClass] ?? "",
      `${r.taskClass} tier`,
      (v) => {
        if (v) draft.routeTiers[r.taskClass] = v as ProfileRow["tier"]
        else delete draft.routeTiers[r.taskClass]
      },
      `as routed (${r.tier})`,
      r.minTier,
    )
    const primary = document.createElement("select")
    primary.className = "field-input"
    primary.setAttribute("aria-label", `${r.taskClass} first backend`)
    primary.add(new Option("as routed", ""))
    for (const p of Object.keys(PROVIDER_LABEL) as ProviderId[]) primary.add(new Option(PROVIDER_LABEL[p], p))
    primary.value = draft.routePrimary[r.taskClass] ?? ""
    primary.addEventListener("change", () => {
      if (primary.value) draft.routePrimary[r.taskClass] = primary.value as ProviderId
      else delete draft.routePrimary[r.taskClass]
    })
    const td = (n: HTMLElement) => {
      const c = document.createElement("td")
      c.append(n)
      return c
    }
    tr.append(Object.assign(document.createElement("td"), { textContent: r.taskClass }), td(tier), td(primary))
    tb.append(tr)
  }
  table.append(tb)
  const scope = scopePicker()
  const status = el("span", "muted")
  const save = textButton(editing ? "Save profile" : "Add profile", "primary small", () => form.requestSubmit())
  save.type = "submit"
  const buttons = el("div", "buttons")
  buttons.append(Object.assign(el("span", "muted"), { textContent: "Save to" }), scope, save)
  if (editing) buttons.append(textButton("New profile instead", "ghost small", () => void renderProfilesTab()))
  buttons.append(status)
  form.append(grid, guidance, table, buttons)
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    const r = await request({
      type: "profile.save",
      requestId: nextRequestId(),
      workspace: state.workspace,
      scope: scope.value as "project" | "user",
      profile: draft,
    })
    if (savedStatus(status, r)) send({ type: "status", workspace: state.workspace })
  })
  body.append(form)
}

// Advanced: the settings that used to need routing.yaml, grouped, each checked before saving.
async function renderAdvanced() {
  const current = beginRender("advanced")
  const body = $("spanel-advanced")
  body.replaceChildren(
    ...panelHead(
      "Advanced",
      "Escalation, limits and watchdogs, privacy, project checks, worktree setup and each backend's command. Only what you change is written; the rest keeps inheriting.",
    ),
  )
  const reply = await request({ type: "advanced.get", requestId: nextRequestId(), workspace: state.workspace })
  if (reply.type !== "advanced" || !current()) return
  if (reply.error) {
    body.append(Object.assign(el("div", "error"), { textContent: reply.error }))
    return
  }
  const changed = new Map<string, unknown>()
  const form = document.createElement("form")
  form.className = "advanced-form"
  let group = ""
  let fieldset: HTMLFieldSetElement | undefined
  for (const f of reply.fields) {
    if (f.group !== group) {
      group = f.group
      fieldset = document.createElement("fieldset")
      fieldset.className = "advanced-group"
      fieldset.append(Object.assign(document.createElement("legend"), { textContent: group }))
      form.append(fieldset)
    }
    const row = el("label", "advanced-row")
    const label = Object.assign(el("span", "settings-label"), { textContent: f.label })
    let control: HTMLElement
    if (f.type === "bool") {
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = Boolean(f.value)
      box.addEventListener("change", () => changed.set(f.key, box.checked))
      control = box
      row.classList.add("advanced-bool")
      row.append(box, label)
    } else if (f.type === "list") {
      const ta = document.createElement("textarea")
      ta.className = "field-text"
      const items = (f.value as string[] | null) ?? []
      ta.rows = Math.min(6, Math.max(2, items.length + 1))
      ta.value = items.join("\n")
      ta.addEventListener("input", () => changed.set(f.key, ta.value.split("\n")))
      control = ta
      row.append(label, ta)
    } else {
      const i = document.createElement("input")
      i.className = "field-input"
      if (f.type === "int" || f.type === "number") {
        i.type = "number"
        i.step = f.type === "int" ? "1" : "any"
        if (f.min !== undefined) i.min = String(f.min)
        if (f.max !== undefined) i.max = String(f.max)
      }
      i.value = f.value === null || f.value === undefined ? "" : String(f.value)
      if (f.nullable) i.placeholder = "off"
      i.addEventListener("input", () => changed.set(f.key, f.type === "string" || i.value === "" ? i.value : Number(i.value)))
      control = i
      row.append(label, i)
    }
    control.setAttribute("aria-label", f.label)
    if (f.help) row.append(Object.assign(el("small", "muted"), { textContent: f.help }))
    fieldset?.append(row)
  }
  const scope = scopePicker()
  const status = el("span", "muted")
  const save = textButton("Save changes", "primary small", () => form.requestSubmit())
  save.type = "submit"
  const buttons = el("div", "buttons sticky-buttons")
  buttons.append(Object.assign(el("span", "muted"), { textContent: "Save to" }), scope, save, status)
  form.append(buttons)
  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (!changed.size) {
      status.textContent = "Nothing changed."
      return
    }
    const count = changed.size
    const r = await request({
      type: "advanced.save",
      requestId: nextRequestId(),
      workspace: state.workspace,
      scope: scope.value as "project" | "user",
      values: Object.fromEntries(changed),
    })
    if (savedStatus(status, r, `Saved ${count} setting${count > 1 ? "s" : ""}`)) changed.clear()
  })
  body.append(form)
}

// About: version, where things live, the keys.
function renderAbout() {
  const body = $("spanel-about")
  const facts: [string, string][] = [
    ["Version", state.version || "unknown"],
    ["Workspace", state.workspace || "none"],
    ["Project settings", state.workspace ? `${state.workspace}/.harness/routing.yaml` : "none"],
    ["Templates", state.workspace ? `${state.workspace}/.harness/prompts` : "none"],
    ["Project memory", state.workspace ? `${state.workspace}/.harness/memory.md` : "none"],
  ]
  const dl = el("dl", "about-list")
  for (const [k, v] of facts) dl.append(Object.assign(el("dt"), { textContent: k }), Object.assign(el("dd", "mono"), { textContent: v }))
  const keys: [string, string][] = [
    ["Ctrl+,", "Settings"],
    ["Ctrl+K", "Search chats and commands"],
    ["Ctrl+F", "Find in this chat"],
    ["Ctrl+N", "New chat"],
    ["Ctrl+B", "Hide the sidebar"],
    ["Ctrl+P", "Files"],
    ["Ctrl+`", "Terminal"],
    ["Escape", "Close a menu or the side panel"],
    ["@ /", "Mention a file; commands and your templates"],
    ["Tab", "Queue a request while Conductor works"],
  ]
  const kl = el("dl", "about-list keys")
  for (const [k, v] of keys) {
    const dt = el("dt")
    for (const part of k.split(/[+ ]/)) dt.append(Object.assign(document.createElement("kbd"), { textContent: part }))
    kl.append(dt, Object.assign(el("dd"), { textContent: v }))
  }
  body.replaceChildren(
    ...panelHead("About", "agent-router runs Conductor on Claude Code and routes its subtasks to Claude, Gemini and Codex."),
    dl,
    Object.assign(el("h4"), { textContent: "Keys" }),
    kl,
  )
}

popover($<HTMLButtonElement>("threads-pill"), $("threads-menu"))
popover($<HTMLButtonElement>("schedule-btn"), $("schedule-menu"), renderScheduleMenu)
installTooltips($("tooltip"))
for (const id of ["log", "threads", "detail-body"]) overlayScrollbar($(id))

// Ghostex's keys: Mod+B the sidebar, Mod+N a new chat, Mod+K search, Mod+F find, Escape closes the side panel.
document.addEventListener("keydown", (e) => {
  const mod = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
  const key = e.key.toLowerCase()
  if (mod && key === "b") {
    e.preventDefault()
    document.querySelector(".app")?.classList.toggle("no-sidebar")
  } else if (mod && key === "n") {
    e.preventDefault()
    newChat()
  } else if (mod && key === "k") {
    e.preventDefault()
    palette.open()
  } else if (mod && key === "f" && !document.querySelector("dialog[open]")) {
    e.preventDefault()
    find.open()
  } else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "`" || e.code === "Backquote")) {
    e.preventDefault()
    dock.toggle()
  } else if (mod && e.key === ",") {
    e.preventDefault()
    openSettings()
  } else if (mod && key === "p") {
    e.preventDefault()
    togglePanel("files")
  } else if (e.key === "Escape" && !e.defaultPrevented && (state.selected || state.file) && !document.querySelector("dialog[open]")) {
    closeDetail()
  }
})
// Chat ages in the sidebar tick over.
setInterval(renderSidebar, 60_000)

showWorkspacePath(state.workspace)
renderModeSummary()

connect().catch(reportStartupError)
