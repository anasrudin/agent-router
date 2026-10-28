import { invoke } from "@tauri-apps/api/core"
import { open } from "@tauri-apps/plugin-dialog"
import type { PermissionMode } from "../../backends/Backend"
import type { ProviderId } from "../../config/schema"
import type { BackendStatus, ClientMessage, DelegationSummary, ProfileInfo, ServerMessage, WireEvent } from "../../server/protocol"
import { escapeHtml, renderMarkdown } from "./markdown"
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
  cards: new Map<string, HTMLElement>(),
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
  sendButton.textContent = running ? "Stop" : "Send"
  sendButton.classList.toggle("stop", running)
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
    const bdi = document.createElement("bdi")
    bdi.textContent = dir
    label.append(bdi)
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
      const line = el("div", "tool mono", `<span class="name">${escapeHtml(label)}</span><span class="detail"></span>`)
      ;(line.querySelector(".detail") as HTMLElement).textContent = describeTool(event.input)
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

// ── Delegation cards ────────────────────────────────────────────────────

function delegationStarted(msg: Extract<ServerMessage, { type: "delegation.started" }>) {
  const card = el("article", "card")
  card.innerHTML = `
    <div class="card-head">
      <span class="agent">${escapeHtml(msg.agent)}</span>
      <span class="class mono">${escapeHtml(msg.taskClass)} · ${escapeHtml(msg.mode)}</span>
      <span class="badge ${msg.provider}">${PROVIDER_LABEL[msg.provider]} · ${escapeHtml(msg.model ?? "default model")} · ${msg.tier}</span>
      <span class="pill"><span class="spinner"></span></span>
    </div>
    <p class="task"></p>
    <ul class="activity mono"></ul>`
  ;(card.querySelector(".task") as HTMLElement).textContent = msg.task
  state.cards.set(msg.id, card)
  append(card)
}

function delegationEvent(msg: Extract<ServerMessage, { type: "delegation.event" }>) {
  const card = state.cards.get(msg.id)
  if (!card) return
  const ev = msg.event
  if (ev.type === "tool_call") {
    const li = el("li")
    li.textContent = `${PROVIDER_LABEL[msg.provider]} · ${ev.name} ${describeTool(ev.input)}`
    const list = card.querySelector(".activity") as HTMLElement
    list.append(li)
    list.scrollTop = list.scrollHeight
  } else if (ev.type === "error") {
    const li = el("li")
    li.textContent = `${PROVIDER_LABEL[msg.provider]} · ${ev.kind}: ${ev.message}`
    ;(card.querySelector(".activity") as HTMLElement).append(li)
  }
}

function delegationFinished(id: string, summary: DelegationSummary) {
  const card = state.cards.get(id)
  if (!card) return
  addUsage(summary.costUsd, summary.tokens.input, summary.tokens.output)
  const pill = card.querySelector(".pill") as HTMLElement
  pill.className = `pill ${summary.status}`
  pill.textContent = summary.status
  const badge = card.querySelector(".badge") as HTMLElement
  badge.className = `badge ${summary.provider}`
  badge.textContent = `${PROVIDER_LABEL[summary.provider]} · ${summary.model ?? "default model"} · ${summary.tier}`

  const meta = el("div", "meta")
  const attempts = summary.attempts.map(
    (a) => `${PROVIDER_LABEL[a.provider]}/${a.tier} ${a.outcome}${a.errorKind ? ` (${a.errorKind})` : ""}`,
  )
  for (const text of [
    `Attempts: ${attempts.join(" → ")}`,
    `${summary.costUsd ? `Cost $${summary.costUsd.toFixed(4)}` : "Cost not reported"} · ${compact(summary.tokens.input + summary.tokens.output)} tokens`,
    ...summary.notes.filter((n) => n.startsWith("fallback") || n.startsWith("skip") || n.startsWith("tier")),
    ...(summary.worktree ? [`Worktree ${summary.worktree}`] : []),
  ]) {
    const span = el("span")
    span.textContent = text
    meta.append(span)
  }
  card.append(meta)
  if (summary.findings.length) {
    const list = el("ul", "findings")
    for (const f of summary.findings) {
      const li = el("li", f.severity)
      li.textContent = f.message
      list.append(li)
    }
    card.append(list)
  }
  const details = el("details", "report")
  details.innerHTML = `<summary>Delegate report (Conductor verifies before using it)</summary><div class="md">${renderMarkdown(summary.report || "(no output)")}</div>`
  card.append(details)
}

function delegationFailed(id: string, error: string) {
  const card = state.cards.get(id)
  if (!card) {
    append(el("div", "error", escapeHtml(`Delegation refused: ${error}`)))
    return
  }
  const pill = card.querySelector(".pill") as HTMLElement
  pill.className = "pill error"
  pill.textContent = "error"
  card.append(el("div", "error", escapeHtml(error)))
}

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
  state.cards.clear()
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
