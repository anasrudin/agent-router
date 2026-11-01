import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import type { PermissionMode } from "../../backends/Backend"
import type { ProviderId } from "../../config/schema"
import type { BackendStatus, ClientMessage, DelegationSummary, ProfileInfo, ServerMessage, WireEvent } from "../../server/protocol"
import { escapeHtml, renderMarkdown, resultLine } from "./markdown"
import { notifyIfAway } from "./notify"
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
  threads: new Map<string, Thread>(),
  /** The thread open in the detail panel; undefined shows Conductor's chat alone. */
  selected: undefined as string | undefined,
  /** The chat's first request, which names it in the sidebar. */
  chatTitle: "",
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
  cost.textContent = `$${state.costUsd.toFixed(4)} · ${compact(state.tokensIn + state.tokensOut)} tokens`
  cost.title = `Reported this session: $${state.costUsd.toFixed(4)}, ${state.tokensIn.toLocaleString()} input (cache reads included) and ${state.tokensOut.toLocaleString()} output tokens. Gemini and Codex do not report cost.`
}

function setRunning(running: boolean) {
  state.running = running
  sendButton.classList.toggle("stop", running)
  sendButton.title = running ? "Stop" : "Send"
  sendButton.setAttribute("aria-label", sendButton.title)
  renderSidebar()
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
  if (dir) {
    label.textContent = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
  } else {
    label.textContent = "Choose a folder…"
  }
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
}

function renderBackends(status: BackendStatus) {
  const box = $("backends")
  box.replaceChildren()
  for (const p of Object.keys(status.health) as ProviderId[]) {
    const h = status.health[p]
    const chip = el(
      "span",
      "chip",
      `<span class="dot ${h.healthy ? "ok" : "bad"}"></span><span class="chip-name">${PROVIDER_LABEL[p]}</span>`,
    )
    const detail = h.healthy
      ? `${status.executables[p]} ${h.version ?? ""}`.trim()
      : `${status.executables[p]}: ${h.reason ?? "unavailable"}`
    // The name hides on narrow windows, so the tooltip and the accessible name carry it too.
    chip.title = `${PROVIDER_LABEL[p]}: ${detail}`
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

function conductorEvent(event: WireEvent) {
  switch (event.type) {
    case "text":
      if (event.text.trim()) append(el("div", "md", renderMarkdown(event.text)))
      return
    case "tool_call": {
      // Delegations get their own card from the router; showing the raw call too would duplicate it.
      if (event.name.startsWith("mcp__router__")) return
      const label = TOOL_LABELS[event.name] ?? event.name.replace(/^mcp__[^_]+__/, "")
      const line = el("div", "tool mono", `<span class="name">${escapeHtml(label)}</span><span class="tool-detail"></span>`)
      ;(line.querySelector(".tool-detail") as HTMLElement).textContent = describeTool(event.input)
      append(line)
      return
    }
    case "usage":
      addUsage(event.costUsd, event.inputTokens, event.outputTokens)
      return
    case "error":
      append(el("div", "error", escapeHtml(event.message)))
      return
    default:
      return
  }
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
  activity: string[]
  summary?: DelegationSummary
  error?: string
  /** The row in this turn's Threads card. */
  chatRow?: HTMLElement
}

const PROVIDER_GLYPH: Record<ProviderId, string> = { claude: "C", gemini: "G", openai: "X" }
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
  const g = el("span", `glyph ${provider}`)
  g.textContent = PROVIDER_GLYPH[provider]
  g.title = PROVIDER_LABEL[provider]
  return g
}

function statusMark(status: string): HTMLElement {
  const mark = el("span", `mark s-${status}`)
  mark.setAttribute("aria-label", status)
  return mark
}

function renderSidebar() {
  const list = [...state.threads.values()]
  threadsNav.replaceChildren()
  if (!state.chatTitle) return
  const head = el("div", `tree-row conductor${state.selected ? "" : " selected"}`)
  head.innerHTML = `<svg class="crown" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12.5h12M2.5 11 1.8 5l3.6 2.6L8 3l2.6 4.6L14.2 5l-.7 6z" /></svg><span class="row-title"></span>`
  ;(head.querySelector(".row-title") as HTMLElement).textContent = state.chatTitle
  if (state.running) head.append(el("span", "spinner"))
  if (list.length) head.append(el("span", "row-count", `${list.length}`))
  head.addEventListener("click", () => selectThread(undefined))
  threadsNav.append(head)
  for (const t of list) {
    const row = el("button", `tree-row thread${state.selected === t.id ? " selected" : ""}`) as HTMLButtonElement
    row.type = "button"
    row.title = `${t.agent} · ${t.taskClass}\n${t.task}`
    const title = el("span", "row-title")
    title.textContent = taskTitle(t.task)
    const tail = el("span", "row-age")
    tail.textContent = age(t.startedAt, t.finishedAt)
    row.append(
      glyph(t.provider),
      title,
      t.summary || t.error ? statusMark(t.error ? "error" : (t.summary?.status ?? "")) : el("span", "spinner"),
      tail,
    )
    row.addEventListener("click", () => selectThread(t.id))
    threadsNav.append(row)
  }
  const running = list.filter((t) => !t.summary && !t.error).length
  $("status-threads").textContent = list.length
    ? `${list.length} thread${list.length > 1 ? "s" : ""}${running ? `, ${running} running` : ""}`
    : ""
}

/** A thread's name: its task in a few words, like a Ghostex thread title. */
function taskTitle(task: string): string {
  const first = task.split(/(?<=[.!?])\s/)[0] ?? task
  return first.length > 60 ? `${first.slice(0, 57)}…` : first.replace(/\.$/, "")
}

/** This turn's Threads card, created with the turn's first delegation. */
function threadsCard(): HTMLElement {
  const turn = state.turnEl ?? log
  let card = turn.querySelector<HTMLElement>(":scope > .threads-card")
  if (!card) {
    card = el("article", "threads-card")
    card.innerHTML = `<header><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="5" r="2" /><circle cx="11" cy="5" r="2" /><path d="M1.5 13a3.5 3.5 0 0 1 7 0M7.5 13a3.5 3.5 0 0 1 7 0" /></svg><span>Threads</span><span class="count muted"></span></header><div class="rows"></div>`
    append(card)
  }
  return card
}

function renderChatRow(t: Thread) {
  if (!t.chatRow) return
  const row = t.chatRow
  row.replaceChildren(
    t.summary || t.error ? statusMark(t.error ? "error" : (t.summary?.status ?? "")) : el("span", "spinner"),
    Object.assign(el("span", "row-name"), { textContent: taskTitle(t.task) }),
    Object.assign(el("span", "row-status"), { textContent: statusText(t) }),
  )
  const card = row.closest(".threads-card")
  if (card) {
    const n = card.querySelectorAll(".rows > *").length
    ;(card.querySelector(".count") as HTMLElement).textContent = `${n} thread${n > 1 ? "s" : ""}`
  }
}

function selectThread(id: string | undefined) {
  state.selected = id
  detail.hidden = !id
  renderSidebar()
  if (id) renderDetail()
}

function renderDetail() {
  const t = state.selected ? state.threads.get(state.selected) : undefined
  if (!t) return
  const g = $("detail-glyph")
  g.className = `glyph ${t.provider}`
  g.textContent = PROVIDER_GLYPH[t.provider]
  $("detail-title").textContent = taskTitle(t.task)
  const body = $("detail-body")
  body.replaceChildren()

  const status = t.error ? "error" : (t.summary?.status ?? "running")
  const meta = el("div", "detail-meta")
  const pill = el("span", `pill ${status}`)
  pill.textContent = status
  const badge = el("span", `badge ${t.provider}`)
  badge.textContent = `${PROVIDER_LABEL[t.provider]} · ${t.summary?.model ?? t.model ?? "default model"} · ${t.summary?.tier ?? t.tier}`
  const facts = el("span", "muted")
  const cost = t.summary?.costUsd ? ` · $${t.summary.costUsd.toFixed(4)}` : ""
  facts.textContent = `${t.agent} · ${t.taskClass} · ${t.mode} · ${compact(t.tokens)} tokens${cost} · ${age(t.startedAt, t.finishedAt)}`
  meta.append(pill, badge, facts)
  body.append(meta)

  const section = (title: string, node: HTMLElement) => {
    const s = el("section", "detail-section")
    s.append(Object.assign(el("h3"), { textContent: title }), node)
    body.append(s)
  }
  section("Task", Object.assign(el("p", "task"), { textContent: t.task }))
  if (t.error) section("Error", Object.assign(el("div", "error"), { textContent: t.error }))
  const sum = t.summary
  if (sum?.changedFiles.length) {
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
    for (const line of t.activity) list.append(Object.assign(el("li"), { textContent: line }))
    section("Activity", list)
    list.scrollTop = list.scrollHeight
  }
}

function refreshThread(t: Thread) {
  renderChatRow(t)
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
  }
  const card = threadsCard()
  const row = el("button", "thread-row") as HTMLButtonElement
  row.type = "button"
  row.addEventListener("click", () => selectThread(t.id))
  ;(card.querySelector(".rows") as HTMLElement).append(row)
  t.chatRow = row
  state.threads.set(t.id, t)
  refreshThread(t)
}

function delegationEvent(msg: Extract<ServerMessage, { type: "delegation.event" }>) {
  const t = state.threads.get(msg.id)
  if (!t) return
  const ev = msg.event
  if (ev.type === "usage") {
    t.tokens += ev.inputTokens + ev.outputTokens
    t.provider = msg.provider
  } else if (ev.type === "tool_call") {
    t.activity.push(`${PROVIDER_LABEL[msg.provider]} · ${ev.name} ${describeTool(ev.input)}`)
  } else if (ev.type === "error") {
    t.activity.push(`${PROVIDER_LABEL[msg.provider]} · ${ev.kind}: ${ev.message}`)
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
      state.turnEl = el("section", "turn")
      state.turnEl.append(
        el(
          "div",
          "status-line",
          `<span class="spinner"></span><span>${msg.resumed ? "Continuing the conversation" : "Starting Conductor"}…${msg.mode ? ` · ${escapeHtml(msg.mode)}` : ""}</span>`,
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
      if (!msg.ok && msg.error) append(el("div", "error", escapeHtml(msg.error)))
      notifyIfAway("agent-router", msg.ok ? "Your request is done." : `Stopped: ${(msg.error ?? "error").slice(0, 160)}`)
      setRunning(false)
      state.turnEl = undefined
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

function submit() {
  if (state.running) {
    send({ type: "cancel" })
    return
  }
  const prompt = promptBox.value.trim()
  if (!prompt) return
  if (!state.workspace) {
    showBanner("Choose a workspace folder first.")
    return
  }
  showBanner(undefined)
  append(el("div", "user", escapeHtml(prompt)), log)
  if (!state.chatTitle) {
    state.chatTitle = taskTitle(prompt)
    $("chat-title").textContent = state.chatTitle
  }
  promptBox.value = ""
  send({
    type: "start",
    prompt,
    workspace: state.workspace,
    permission: permissionSelect.value as PermissionMode,
    profile: profileSelect.value || undefined,
    plan: planSelect.value || undefined,
  })
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault()
  submit()
})
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
showWorkspacePath(state.workspace)

connect().catch(reportStartupError)
