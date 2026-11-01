import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import type { PermissionMode } from "../../backends/Backend"
import type { QuotaSnapshot, QuotaWindow } from "../../backends/events"
import type { ProviderId } from "../../config/schema"
import type {
  BackendStatus,
  ClientMessage,
  DelegationSummary,
  ProfileInfo,
  QueuedPrompt,
  ServerMessage,
  WireEvent,
  WorktreePreview,
} from "../../server/protocol"
import { closePopovers, flash, installTooltips, type MenuItem, openMenu, popover } from "./chrome"
import { type DiffFile, formatReview, parseUnifiedDiff, type ReviewComment } from "./diff"
import { agentLogoSvg } from "./icons"
import { escapeHtml, renderMarkdown, resultLine } from "./markdown"
import { notifyIfAway } from "./notify"
import { type Answer, formatAnswers, letter, type QuestionForm, splitQuestions } from "./questions"
import { createSettings } from "./settings"

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

/** Per-viewer conveniences only; the app works without storage. */
const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`agent-router.${key}`)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`agent-router.${key}`, value)
    } catch {}
  },
}

const state = {
  socket: undefined as WebSocket | undefined,
  workspace: prefs.get("workspace") ?? "",
  running: false,
  turnEl: undefined as HTMLElement | undefined,
  /** This turn's "Worked for" fold: Conductor's own work, folded once the turn ends. */
  fold: undefined as { el: HTMLDetailsElement; body: HTMLElement; started: number; tools: number } | undefined,
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
}

function el(tag: string, className?: string, html?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

function append(node: HTMLElement, parent: HTMLElement = state.turnEl ?? log) {
  $("empty")?.remove()
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120
  parent.append(node)
  if (nearBottom) log.scrollTop = log.scrollHeight
}

function send(message: ClientMessage) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message))
  else showBanner("Not connected to the agent-router core.")
}

function showBanner(text: string | undefined) {
  banner.hidden = !text
  banner.textContent = text ?? ""
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
}

/** While a turn runs the button stops it, unless there is text to queue behind it. */
function updateSendButton() {
  const stop = state.running && !promptBox.value.trim()
  sendButton.classList.toggle("stop", stop)
  sendButton.title = stop ? "Stop" : state.running ? "Queue: runs when the current turn ends" : "Send"
  sendButton.setAttribute("aria-label", sendButton.title)
}

// ── Prompt queue ────────────────────────────────────────────────────────

function renderQueue(items: QueuedPrompt[], paused: boolean) {
  const box = $("queue")
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
  items.forEach((item, i) => {
    const row = el("div", "queue-row")
    const label = el("span", "queue-text")
    label.textContent = item.prompt
    label.title = item.prompt
    const next = el("button", "icon-btn") as HTMLButtonElement
    next.type = "button"
    next.title = i === 0 ? "Send now when idle" : "Send next"
    next.setAttribute("aria-label", next.title)
    next.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>`
    next.addEventListener("click", () => send({ type: "queue.send", id: item.id }))
    const remove = el("button", "icon-btn") as HTMLButtonElement
    remove.type = "button"
    remove.title = "Remove from queue"
    remove.setAttribute("aria-label", remove.title)
    remove.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>`
    remove.addEventListener("click", () => send({ type: "queue.remove", id: item.id }))
    row.append(Object.assign(el("span", "queue-num"), { textContent: String(i + 1) }), label, next, remove)
    box.append(row)
  })
}

// ── Workspace and backends ──────────────────────────────────────────────

function setWorkspace(dir: string) {
  state.workspace = dir
  prefs.set("workspace", dir)
  showWorkspacePath(dir)
  if (dir) send({ type: "status", workspace: dir })
}

/** Long paths are cut from the left so the folder name stays visible; the placeholder is plain text. */
function showWorkspacePath(dir: string) {
  const label = $("workspace-path")
  label.replaceChildren()
  label.classList.toggle("is-path", Boolean(dir))
  const name = dir ? (dir.split(/[\\/]/).filter(Boolean).pop() ?? dir) : ""
  label.textContent = name || "Choose a folder…"
  $("crumb-workspace").textContent = name || "No folder"
  $("workspace").title = dir || "Choose the project folder Conductor works in"
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
}

// ── Conductor turn rendering ────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = { Read: "Read", Grep: "Search", Glob: "Find files", Bash: "Run", Edit: "Edit", Write: "Write" }

function describeTool(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const detail = i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.task_class ?? i.description ?? ""
  return String(detail)
}

/** The turn's fold, created with Conductor's first tool call (Ghostex: one per turn, its work collapsed). */
function turnFold() {
  if (state.fold) return state.fold
  const fold = document.createElement("details")
  fold.className = "turn-fold"
  fold.open = true
  const summary = document.createElement("summary")
  const body = el("div", "fold-body")
  fold.append(summary, body)
  append(fold)
  state.fold = { el: fold, body, started: Date.now(), tools: 0 }
  renderFoldSummary(false)
  return state.fold
}

function renderFoldSummary(done: boolean) {
  const f = state.fold
  if (!f) return
  const summary = f.el.querySelector("summary") as HTMLElement
  const secs = Math.max(1, Math.round((Date.now() - f.started) / 1000))
  summary.replaceChildren(
    ...(done ? [] : [el("span", "spinner")]),
    Object.assign(el("span", "fold-title"), {
      textContent: done ? `Worked for ${secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`}` : "Working",
    }),
    Object.assign(el("span", "count-pill"), { textContent: `${f.tools} tool call${f.tools === 1 ? "" : "s"}` }),
  )
}

/** At the turn's end: fold the work away and keep the final reply below it, where it is read. */
function closeFold() {
  const f = state.fold
  if (!f) return
  const last = f.body.lastElementChild
  if (last?.classList.contains("md") && state.turnEl) state.turnEl.append(last)
  renderFoldSummary(true)
  f.el.open = false
  state.fold = undefined
}

function conductorEvent(event: WireEvent) {
  switch (event.type) {
    case "text":
      for (const seg of splitQuestions(event.text)) {
        if (seg.kind === "markdown") append(el("div", "md", renderMarkdown(seg.text)), state.fold?.body ?? state.turnEl ?? log)
        else {
          append(renderQuestionForm(seg.form))
          notifyIfAway("agent-router: Conductor has questions", seg.form.title ?? seg.form.questions[0]?.question ?? "")
        }
      }
      return
    case "tool_call": {
      // Delegations get their own card from the router; showing the raw call too would duplicate it.
      if (event.name.startsWith("mcp__router__")) return
      const label = TOOL_LABELS[event.name] ?? event.name.replace(/^mcp__[^_]+__/, "")
      const line = el("div", "tool mono", `<span class="name">${escapeHtml(label)}</span><span class="tool-detail"></span>`)
      ;(line.querySelector(".tool-detail") as HTMLElement).textContent = describeTool(event.input)
      const fold = turnFold()
      fold.tools += 1
      renderFoldSummary(false)
      append(line, fold.body)
      return
    }
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
  return card
}

// ── Threads: one per delegation, in the sidebar, the chat and the detail panel ──

interface Thread {
  id: string
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

function age(from: number, to = Date.now()): string {
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
  if (sum?.report) items.push({ label: "Copy report", run: () => copyText(sum.report, row) })
  const worktree = sum?.worktree
  if (worktree && !t.wt?.gone)
    items.push("separator", {
      label: "Preview worktree merge",
      run: () => {
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
        selectThread(t.id)
        detail.querySelector(".changes-bar")?.scrollIntoView({ block: "nearest" })
      },
    })
  return items
}

function conductorMenu(row: HTMLElement): MenuItem[] {
  const items: MenuItem[] = [{ label: "Show conversation", run: () => selectThread(undefined) }]
  if (state.running) items.push({ label: "Stop the turn", danger: true, run: () => send({ type: "cancel" }) })
  items.push("separator", { label: "Copy chat title", run: () => copyText(state.chatTitle ?? "", row) }, "separator", {
    label: "New chat",
    run: () => $("new-chat").click(),
  })
  return items
}

function renderSidebar() {
  const list = [...state.threads.values()]
  // The tree is rebuilt every second while threads run; keep keyboard focus where it was.
  const focusKey = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>("#threads [data-focus-key]")?.dataset.focusKey
  threadsNav.replaceChildren()
  renderSidebarRows(list)
  if (focusKey) threadsNav.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus()
  const running = list.filter((t) => !t.summary && !t.error).length
  $("status-threads").textContent = list.length
    ? `${list.length} thread${list.length > 1 ? "s" : ""}${running ? `, ${running} running` : ""}`
    : ""
}

function renderSidebarRows(list: Thread[]) {
  if (!state.chatTitle) return
  const head = el("button", `tree-row conductor${state.selected ? "" : " selected"}`) as HTMLButtonElement
  head.type = "button"
  head.innerHTML = `<svg class="crown" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5h12M2.5 11 1.8 5l3.6 2.6L8 3l2.6 4.6L14.2 5l-.7 6z" /></svg><span class="row-title"></span>`
  ;(head.querySelector(".row-title") as HTMLElement).textContent = state.chatTitle
  if (list.length) {
    // The crew badge: people and a count, as Ghostex marks a coordinator's threads.
    const count = el("span", "row-count row-tail", `${PEOPLE_ICON}<span>${list.length}</span>`)
    count.title = `${list.length} thread${list.length > 1 ? "s" : ""}`
    head.append(count)
  }
  if (state.running) head.append(statusMark("running"))
  head.addEventListener("click", () => selectThread(undefined))
  const headActions = [rowAction(MORE_ICON, "More actions", (b) => openMenu(conductorMenu(head), b, b, "Chat actions"))]
  if (state.running) headActions.unshift(rowAction(STOP_ICON, "Stop the turn", () => send({ type: "cancel" })))
  threadsNav.append(sidebarItem(head, headActions, () => conductorMenu(head), "Chat actions", "conductor"))
  for (const t of list) {
    const row = el("button", `tree-row thread${state.selected === t.id ? " selected" : ""}`) as HTMLButtonElement
    row.type = "button"
    row.title = `${t.agent}, ${t.taskClass}\n${t.task}`
    const title = el("span", "row-title")
    title.textContent = taskTitle(t.task)
    const tail = el("span", "row-age row-tail")
    tail.textContent = age(t.startedAt, t.finishedAt)
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
  t.chatRow.title = statusText(t)
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
  state.selected = id
  detail.hidden = !id
  renderSidebar()
  if (id) renderDetail()
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
  void request({ type: "thread.diff", requestId: nextRequestId(), workspace: state.workspace, checkpoint }).then((msg) => {
    if (msg.type !== "thread.diff") return
    t.diff = msg.error
      ? { files: [], truncated: false, error: msg.error }
      : { files: parseUnifiedDiff(msg.patch), truncated: msg.truncated }
    if (state.selected === t.id) renderDetail()
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
  revert.textContent = t.revert === "confirm" ? "Confirm revert" : "Revert thread"
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
      workspace: state.workspace,
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
        textContent: "Click a line to comment on it. Comments go to Conductor, which hands them to this delegate.",
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
    workspace: state.workspace,
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
    if (state.selected === t.id) renderDetail()
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

function renderDetail() {
  const t = state.selected ? state.threads.get(state.selected) : undefined
  if (!t) return
  const g = $("detail-glyph")
  g.className = `glyph ${t.provider}`
  g.innerHTML = agentLogoSvg(t.provider)
  $("detail-title").textContent = taskTitle(t.task)
  const body = $("detail-body")
  body.replaceChildren()

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

  const section = (title: string, node: HTMLElement) => {
    const s = el("section", "detail-section")
    s.append(Object.assign(el("h3"), { textContent: title }), node)
    body.append(s)
  }
  section("Task", Object.assign(el("p", "task"), { textContent: t.task }))
  if (t.error) section("Error", Object.assign(el("div", "error"), { textContent: t.error }))
  const sum = t.summary
  if (sum?.worktree) section("Worktree", renderWorktree(t, sum.worktree))
  if (sum?.checkpoint?.after) section("Changes", renderChanges(t))
  else if (sum?.changedFiles.length) {
    const list = el("ul", "files mono")
    for (const f of sum.changedFiles) list.append(Object.assign(el("li"), { textContent: f }))
    section("Files changed", list)
  }
  if (sum?.findings.length) {
    const list = el("ul", "findings")
    for (const f of sum.findings) list.append(Object.assign(el("li", f.severity), { textContent: f.message }))
    section("Harness findings", list)
  }
  if (sum) {
    const attempts = sum.attempts.map(
      (a) => `${PROVIDER_LABEL[a.provider]}/${a.tier} ${a.outcome}${a.errorKind ? ` (${a.errorKind})` : ""}`,
    )
    const lines = [
      `Attempts: ${attempts.join(" → ")}`,
      `Stop reason: ${sum.stopReason}`,
      ...(sum.worktree ? [`Worktree: ${sum.worktree}`] : []),
    ]
    const box = el("div", "facts")
    for (const line of lines) box.append(Object.assign(el("div"), { textContent: line }))
    section("Route", box)
    section("Report (Conductor verifies before using it)", el("div", "md", renderMarkdown(sum.report || "(no output)")))
  }
  if (t.activity.length) {
    const list = el("ul", "activity mono")
    for (const line of t.activity) {
      const li = el("li")
      li.append(Object.assign(el("span", "who"), { textContent: line.who }), document.createTextNode(line.text))
      list.append(li)
    }
    section("Activity", list)
    list.scrollTop = list.scrollHeight
  }
}

function refreshThread(t: Thread) {
  renderAgentCard(t)
  renderThreadsPill()
  renderSidebar()
  if (state.selected === t.id) renderDetail()
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
    startedAt: Date.now(),
    tokens: 0,
    activity: [],
    comments: [],
  }
  const row = el("button", "agent-card") as HTMLButtonElement
  row.type = "button"
  row.addEventListener("click", () => selectThread(t.id))
  append(row)
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
  if (state.selected === t.id) renderDetail()
  if (ev.type !== "tool_call") renderSidebar()
}

function delegationFinished(id: string, summary: DelegationSummary) {
  const t = state.threads.get(id)
  if (!t) return
  addUsage(summary.costUsd, summary.tokens.input, summary.tokens.output)
  Object.assign(t, { summary, provider: summary.provider, tokens: summary.tokens.input + summary.tokens.output, finishedAt: Date.now() })
  refreshThread(t)
}

function delegationFailed(id: string, error: string) {
  const t = state.threads.get(id)
  if (!t) {
    append(el("div", "error", escapeHtml(`Delegation refused: ${error}`)))
    return
  }
  Object.assign(t, { error, finishedAt: Date.now() })
  refreshThread(t)
}

function clearThreads() {
  state.threads.clear()
  renderThreadsPill()
  state.chatTitle = ""
  selectThread(undefined)
  $("chat-title").textContent = "Conductor"
}

$("detail-close").addEventListener("click", () => selectThread(undefined))
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
  notifyIfAway("agent-router: approval needed", title)
}

// ── Server connection ───────────────────────────────────────────────────

function onMessage(msg: ServerMessage) {
  if (settings.onMessage(msg)) return
  if (
    (msg.type === "thread.diff" || msg.type === "thread.reverted" || msg.type === "worktree.result") &&
    pendingRequests.has(msg.requestId)
  ) {
    pendingRequests.get(msg.requestId)?.(msg)
    pendingRequests.delete(msg.requestId)
    return
  }
  switch (msg.type) {
    case "hello":
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
      append(el("div", "user", escapeHtml(msg.prompt)), log)
      if (!state.chatTitle) {
        state.chatTitle = taskTitle(msg.prompt)
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
      append(state.turnEl, log)
      setRunning(true)
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
      notifyIfAway("agent-router", msg.ok ? "Your request is done." : `Stopped: ${(msg.error ?? "error").slice(0, 160)}`)
      setRunning(false)
      state.turnEl = undefined
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
      showBanner(msg.message)
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
  send({
    type: "start",
    prompt,
    workspace: state.workspace,
    permission: permissionSelect.value as PermissionMode,
    profile: profileSelect.value || undefined,
    plan: planSelect.value || undefined,
  })
  return true
}

function submit() {
  const prompt = promptBox.value.trim()
  if (state.running && !prompt) {
    send({ type: "cancel" })
    return
  }
  if (!prompt) return
  // The bubble appears when the server starts the turn: now, or later if it queues it.
  if (!startRequest(prompt)) return
  promptBox.value = ""
  updateSendButton()
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault()
  submit()
})
promptBox.addEventListener("input", updateSendButton)
promptBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submit()
  }
})
$("workspace").addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false, defaultPath: state.workspace || undefined })
  if (typeof dir === "string") {
    if (dir !== state.workspace) send({ type: "reset" })
    setWorkspace(dir)
  }
})
$("new-chat").addEventListener("click", () => {
  if (state.running) return
  send({ type: "reset" })
  clearThreads()
  state.fold = undefined
  log.replaceChildren()
  state.costUsd = 0
  state.tokensIn = 0
  state.tokensOut = 0
  addUsage(0)
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
popover($<HTMLButtonElement>("threads-pill"), $("threads-menu"))
installTooltips($("tooltip"))

// Ghostex's keys: Mod+B the sidebar, Mod+N a new chat, Escape closes the thread panel.
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
    e.preventDefault()
    document.querySelector(".app")?.classList.toggle("no-sidebar")
  } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault()
    $("new-chat").click()
  } else if (e.key === "Escape" && !e.defaultPrevented && state.selected && !document.querySelector("dialog[open]")) {
    selectThread(undefined)
  }
})

showWorkspacePath(state.workspace)
renderModeSummary()

connect().catch(reportStartupError)
