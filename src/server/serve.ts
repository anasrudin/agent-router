import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { resolveExecutable } from "../backends/process"
import { createBackends } from "../backends/registry"
import { createSession, prepareConductor, SELF_ENTRY, streamConductor } from "../conductor/run"
import { loadConfig, resolvePlan } from "../config/load"
import { describePlan, PLAN_PRESETS } from "../config/plans"
import { PROVIDERS, type ProviderId, type RoutingConfig } from "../config/schema"
import { checkpointDiff, checkpointFiles, restoreCheckpoint, revertCheckpoint, snapshot } from "../coordinator/checkpoints"
import { delegate } from "../coordinator/delegate"
import { applyWorktree, previewMerge, removeDelegateWorktree } from "../coordinator/merge"
import { Brief } from "../coordinator/protocol"
import { Session } from "../coordinator/session"
import { createWorktree, isDelegateWorktree, samePath } from "../coordinator/worktrees"
import { latestVersions, runDoctor } from "../doctor"
import { describePreview, summarize } from "../mcp/server"
import { type Overrides, parseOverrides, ULTRAWORK_NOTE } from "../router/classify"
import { explainDecision, matchesAny } from "../router/policy"
import { QuotaTracker } from "../router/quota"
import { readAdvanced, saveAdvanced } from "./advanced"
import { BoardStore } from "./boards"
import { toWire } from "./bridge"
import { ChatStore, dataDir } from "./chats"
import { historyDiff, listHistory, restoreHistory } from "./confighistory"
import { dataStats, exportChats, pruneChats } from "./datastore"
import { chatMarkdown } from "./export"
import {
  editorCommand,
  gitStats,
  listWorkspaceFiles,
  listWorktrees,
  mentionedFiles,
  openerCommand,
  readWorkspaceFile,
  readWorkspaceImage,
  saveAttachment,
  writeWorkspaceFile,
} from "./files"
import { findIde, freePort, ideCommand, installIde } from "./ide"
import { deleteProfile, exportProfiles, importProfiles, readProfiles, saveProfile, setDefaultProfile } from "./profiles"
import type {
  BackendStatus,
  BridgeMessage,
  BridgeReply,
  BudgetLimits,
  BudgetState,
  ChatMeta,
  ClientMessage,
  IdeState,
  QueuedPrompt,
  ServerMessage,
  ThreadCheckpoint,
} from "./protocol"
import { catchUpPrompt, quickAsk, sideQuestionPrompt, transcriptDigest } from "./quick"
import { readRouting, saveRouting, testRoute } from "./routing"
import { ScheduleStore } from "./schedules"
import { backendOptions, readSettings, saveSettings, testModel } from "./settings"
import { deleteTemplate, listTemplates, saveTemplate } from "./templates"
import { Terminals } from "./terminals"
import { chatCost, checkBudget, profileCosts, usageSummary } from "./usage"

type Role = "ui" | "bridge"
type Socket = ServerWebSocket<{ role: Role }>

export interface ServeOptions {
  port: number
  /** Shared secret the desktop shell passes to its webview; required on every connection. */
  token: string
  version: string
  /** Where chats are saved; the platform's data folder by default. */
  dataDir?: string
  /** How often scheduled requests are checked (tests make it short). */
  scheduleTickMs?: number
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function assertDirectory(dir: string): string {
  const resolved = path.resolve(dir)
  if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${resolved}`)
  return resolved
}

export async function backendStatus(workspace: string): Promise<BackendStatus> {
  const { config } = loadConfig(workspace, null)
  const session = new Session({
    workspace,
    config,
    backends: createBackends(config),
    selfProvider: "claude",
    permission: "default",
  })
  await session.detectBackends()
  return {
    health: session.health.snapshot(),
    quota: session.quota.snapshot(),
    executables: Object.fromEntries(PROVIDERS.map((p) => [p, config.backends[p].executable])) as Record<ProviderId, string>,
    profiles: Object.entries(config.profiles).map(([name, p]) => ({ name, label: p.label, description: p.description })),
    defaultProfile: config.default_profile,
    plans: Object.entries(PLAN_PRESETS).map(([name, p]) => ({ name, label: p.label, description: describePlan(p.plan) })),
    configuredPlan: describeConfiguredPlan(config.plan),
    git: gitStats(workspace),
  }
}

/**
 * Where a new chat runs when the user picked a worktree for it: an existing worktree of this
 * repository, or a new one (in .harness/worktrees, like a delegate's) from a branch.
 */
export function chatWorktree(workspace: string, title: string, wt: { base: string } | { path: string }): string {
  const list = listWorktrees(workspace)
  if (!list) throw new Error("A worktree needs a git repository.")
  if ("path" in wt) {
    const found = list.worktrees.find((w) => samePath(w.path, wt.path))
    if (!found) throw new Error("That worktree is not one of this repository's.")
    return found.path
  }
  if (!list.branches.includes(wt.base)) throw new Error(`No branch named ${wt.base}.`)
  const created = createWorktree(workspace, `chat-${title}`, wt.base).path
  // The project's own settings and memory apply in the worktree too, even when not committed.
  for (const file of ["routing.yaml", "memory.md"]) {
    const from = path.join(workspace, ".harness", file)
    const to = path.join(created, ".harness", file)
    if (existsSync(from) && !existsSync(to)) {
      mkdirSync(path.dirname(to), { recursive: true })
      copyFileSync(from, to)
    }
  }
  return created
}

/** A new chat's name: its first request's first sentence, kept short. */
export function chatTitle(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? ""
  const first = line.split(/(?<=[.!?])\s/)[0] ?? line
  return first.length > 80 ? `${first.slice(0, 77)}…` : first.replace(/\.$/, "") || "Untitled chat"
}

/** Messages a reopened chat needs; live-only ones (quota, approvals) are not saved. */
function worthSaving(msg: ServerMessage): boolean {
  if (msg.type === "conductor" || msg.type === "delegation.event") return msg.event.type !== "quota"
  return msg.type === "turn.started" || msg.type === "turn.finished" || msg.type === "turn.checkpoint" || msg.type.startsWith("delegation.")
}

/** The config's own plan in words, or undefined when none is set or it does not resolve. */
function describeConfiguredPlan(plan: RoutingConfig["plan"]): string | undefined {
  try {
    const resolved = resolvePlan(plan)
    return resolved ? describePlan(resolved) : undefined
  } catch {
    return undefined
  }
}

/**
 * A checkpoint from the UI, checked before git sees it: the checkout must be the workspace or one
 * of its delegate worktrees, and the snapshots full commit ids.
 */
export function trustedCheckpoint(workspace: string, c: ThreadCheckpoint): ThreadCheckpoint {
  const ws = assertDirectory(workspace)
  const cwd = path.resolve(c.cwd)
  if (!samePath(cwd, ws) && !isDelegateWorktree(ws, cwd)) {
    throw new Error("That checkout is not this workspace or one of its delegate worktrees.")
  }
  const sha = /^[0-9a-f]{40}$/
  if (!sha.test(c.before) || (c.after !== undefined && !sha.test(c.after))) throw new Error("Not a checkpoint.")
  return { before: c.before, after: c.after, cwd }
}

interface Turn {
  id: string
  abort: AbortController
  /** The user chose to go over the budget for this request. */
  overBudget?: boolean
}

type StartMessage = Extract<ClientMessage, { type: "start" }>

/**
 * Requests sent while a turn runs wait here and start in order when it ends. A cancelled turn
 * pauses the queue: Stop means stop, so nothing starts again until the user sends or resumes.
 * The queue lives in memory only, so a crash can never re-send a request on its own.
 */
export class PromptQueue {
  private items: (QueuedPrompt & { msg: StartMessage })[] = []
  paused = false
  private counter = 0

  add(msg: StartMessage): string {
    const id = `q-${++this.counter}`
    this.items.push({ id, prompt: msg.prompt, msg })
    return id
  }

  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id)
  }

  /** Move to the front. */
  promote(id: string): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    this.items = [item, ...this.items.filter((i) => i !== item)]
    return true
  }

  /** Put an item at `index` (clamped), for drag-to-reorder. */
  move(id: string, index: number): boolean {
    const item = this.items.find((i) => i.id === id)
    if (!item) return false
    const rest = this.items.filter((i) => i !== item)
    const at = Math.max(0, Math.min(rest.length, Math.floor(index)))
    this.items = [...rest.slice(0, at), item, ...rest.slice(at)]
    return true
  }

  /** Remove an item and return its text (Edit takes it back into the composer). */
  take(id: string): string | undefined {
    const item = this.items.find((i) => i.id === id)
    if (!item) return undefined
    this.remove(id)
    return item.prompt
  }

  /** The next request to run, unless paused. */
  next(): StartMessage | undefined {
    if (this.paused) return undefined
    return this.items.shift()?.msg
  }

  clear(): void {
    this.items = []
    this.paused = false
  }

  view(): { items: QueuedPrompt[]; paused: boolean } {
    return { items: this.items.map(({ id, prompt }) => ({ id, prompt })), paused: this.paused && this.items.length > 0 }
  }
}

/**
 * Local server for the desktop app (AGENTS.md "server mode"). Binds 127.0.0.1 only. The UI and
 * the router MCP child both connect over WebSocket with the token; the server runs one Conductor
 * turn at a time and relays delegation progress and approval prompts between them.
 */
export function startServer(opts: ServeOptions) {
  const ui = new Set<Socket>()
  const approvals = new Map<string, Socket>()
  let turn: Turn | undefined
  const dataRoot = opts.dataDir ?? dataDir()
  const chats = new ChatStore(path.join(dataRoot, "chats"))
  const schedules = new ScheduleStore(path.join(dataRoot, "schedules.json"))
  const boards = new BoardStore(path.join(dataRoot, "boards"))
  const terminals = new Terminals({
    output: (id, chunk) => broadcast({ type: "term.output", id, data: chunk }),
    exit: (id, code) => {
      broadcast({ type: "term.exit", id, code })
      broadcast({ type: "terminals", items: terminals.list() })
    },
  })
  /** Set while a turn is stopped so a queued request can run now (not a user Stop: the queue keeps going). */
  let interrupting = false
  /** VS Code in the app: one server at a time, started on request. */
  let ide: { proc?: ChildProcess; url?: string; folder?: string; installing?: string; error?: string } = {}
  const ideState = (): IdeState => {
    const bin = findIde(dataRoot)
    return {
      state: ide.installing ? "installing" : ide.url ? "running" : bin ? "ready" : "missing",
      url: ide.url,
      kind: bin?.kind,
      canInstall: process.platform === "linux",
      progress: ide.installing,
      error: ide.error,
    }
  }
  const broadcastIde = () => broadcast({ type: "ide", ide: ideState() })

  // Spending limits, enforced here: a turn does not start over budget, and stops once it gets there.
  const budgetFile = path.join(dataRoot, "budget.json")
  const readLimits = (): BudgetLimits => {
    try {
      return { chatUsd: null, dayUsd: null, warnAt: 0.8, ...JSON.parse(readFileSync(budgetFile, "utf8")) }
    } catch {
      return { chatUsd: null, dayUsd: null, warnAt: 0.8 }
    }
  }
  const todayUsd = () =>
    usageSummary(
      chats.list().map((meta) => ({ meta, events: chats.events(meta.id) })),
      Date.now(),
      1,
    ).days[0]?.costUsd ?? 0
  const budgetState = (): BudgetState => {
    const limits = readLimits()
    const chatUsd = chat ? chatCost(chats.events(chat.id)) : 0
    const dayUsd = limits.dayUsd ? todayUsd() : 0
    return { limits, chatUsd, dayUsd, ...checkBudget(limits, chatUsd, dayUsd) }
  }
  const broadcastBudget = () => broadcast({ type: "budget", budget: budgetState() })
  /** Called when spend moves during a turn: stop it at the limit. */
  const enforceBudget = () => {
    const state = budgetState()
    broadcast({ type: "budget", budget: state })
    if (state.over && turn && !turn.overBudget) {
      budgetStop = state.over
      turn.abort.abort()
    }
  }
  let budgetStop: string | undefined
  const stopIde = () => {
    // The server runs in its own process group (a launcher script and node children): end all of it.
    const pid = ide.proc?.pid
    if (pid) {
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM")
      } catch {}
    }
    ide = {}
  }
  /** The chat requests go to: its Conductor session is resumed, its messages saved. A new chat starts with its first request. */
  let chat: ChatMeta | undefined
  let turnCounter = 0
  /** Conductor runs on Claude, so its own stream reports Claude's quota too. */
  const quota = new QuotaTracker()
  const queue = new PromptQueue()
  /** Things Conductor should hear at the start of its next turn, such as a thread the user reverted. */
  const pendingNotes: string[] = []
  const bridgeUrl = () => `ws://127.0.0.1:${server.port}/bridge?token=${encodeURIComponent(opts.token)}`
  const broadcastQueue = () => broadcast({ type: "queue", ...queue.view() })
  /** Start the next queued request if nothing is running. */
  const drain = () => {
    if (turn) return
    const next = queue.next()
    broadcastQueue()
    if (!next) return
    runTurn(next, bridgeUrl()).catch((e: unknown) => {
      // It failed before starting (a folder that no longer exists): report it and go on with the rest.
      broadcast({ type: "error", message: errorText(e) })
      drain()
    })
  }

  const broadcast = (message: ServerMessage) => {
    const data = JSON.stringify(message)
    for (const socket of ui) socket.send(data)
    if (chat && worthSaving(message)) {
      try {
        chats.append(chat.id, message)
      } catch {
        // Saving is for reopening later; a full disk must not stop the turn.
      }
    }
  }
  const broadcastChats = () => broadcast({ type: "chats", items: chats.list() })
  const savedChats = () => chats.list().map((meta) => ({ meta, events: chats.events(meta.id) }))
  const reply = (socket: Socket, message: ServerMessage) => {
    socket.send(JSON.stringify(message))
  }

  /** Profile names the workspace's config defines, for `@<profile>` keywords. A broken config just means none. */
  function profileNames(workspace: string): string[] {
    try {
      return Object.keys(loadConfig(workspace, null).config.profiles)
    } catch {
      return []
    }
  }

  async function runTurn(msg: StartMessage, bridgeUrl: string) {
    const workspace = assertDirectory(msg.workspace)
    const overrides = parseOverrides(msg.prompt, profileNames(workspace))
    // A keyword in the message beats the profile menu, for this request only.
    const profile = overrides.profile ?? msg.profile
    const base = overrides.ultrawork ? `${msg.prompt}\n\n${ULTRAWORK_NOTE}` : msg.prompt
    const files = mentionedFiles(msg.prompt, chat?.runIn ?? workspace)
    if (files.length)
      pendingNotes.push(`The user referenced these workspace files with @ (read them as needed; images included): ${files.join(", ")}`)
    const notes = pendingNotes.splice(0)
    const prompt = notes.length ? `${base}\n\n[Since your last turn, in the desktop app:]\n${notes.map((n) => `- ${n}`).join("\n")}` : base
    // A chat deleted on disk (or from another window) cannot take more messages: start a new one.
    if (!chat || !samePath(chat.workspace, workspace) || !chats.get(chat.id)) {
      // Named by what was asked, without the routing keywords (@economy, ultrawork, /route lines).
      const title = chatTitle(overrides.text.trim() || msg.prompt)
      const runIn = msg.worktree ? chatWorktree(workspace, title, msg.worktree) : undefined
      // Pictures pasted before the chat existed were saved in the workspace; Conductor runs in the worktree.
      if (runIn)
        for (const rel of mentionedFiles(msg.prompt, workspace))
          if (rel.startsWith(".harness/attachments/") && !existsSync(path.join(runIn, rel))) {
            mkdirSync(path.dirname(path.join(runIn, rel)), { recursive: true })
            copyFileSync(path.join(workspace, rel), path.join(runIn, rel))
          }
      chat = chats.create(workspace, title)
      if (runIn) chat = chats.update(chat.id, { runIn }) ?? chat
      broadcast({ type: "chat.current", chat })
      broadcastChats()
    }
    if (!msg.overBudget) {
      const over = budgetState().over
      if (over) throw new Error(`${over} Raise or clear the limit in Usage, or send the request again with "Send anyway".`)
    }
    const id = `turn-${++turnCounter}`
    const abort = new AbortController()
    turn = { id, abort, overBudget: msg.overBudget }
    const current = chat
    const runDir = current.runIn && statSync(current.runIn, { throwIfNoEntry: false })?.isDirectory() ? current.runIn : workspace
    const resume = current.sessionId
    let error: string | undefined
    let prepared: Awaited<ReturnType<typeof prepareConductor>> | undefined
    // The folder before the turn, so its whole change can be reviewed, reverted or restored later.
    const before = snapshot(runDir, `${current.id.slice(0, 8)}-${id}-before`)
    try {
      broadcast({
        type: "turn.started",
        turnId: id,
        prompt: msg.prompt,
        resumed: resume !== undefined,
        mode: modeLine(overrides),
        profile,
      })
      // The chat remembers the menu's profile; a keyword (@economy, ultrawork) is for this request only.
      if (msg.profile && current.profile !== msg.profile) chat = chats.update(current.id, { profile: msg.profile }) ?? chat
      prepared = await prepareConductor({
        workspace: runDir,
        permission: msg.permission,
        selfProvider: "claude",
        profile,
        plan: msg.plan,
        pins: { provider: overrides.provider, routes: overrides.routes },
        entry: SELF_ENTRY,
        bridgeUrl,
        ledger: chats.ledgerPath(current.id),
      })
      const exit = await streamConductor(prepared, prompt, {
        resumeSessionId: resume,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === "session" && current.sessionId !== event.sessionId) {
            current.sessionId = event.sessionId
            chats.update(current.id, { sessionId: event.sessionId })
          }
          if (event.type === "error") error = event.error.message
          if (event.type === "quota") quota.record("claude", event.windows)
          broadcast({ type: "conductor", turnId: id, event: toWire(event) })
          if (event.type === "usage" && event.usage.costUsd) enforceBudget()
        },
      })
      if (exit.cancelled && budgetStop) {
        error = `Stopped: ${budgetStop}`
        queue.paused = true
      } else if (exit.cancelled && interrupting) error = "Interrupted: the next request runs now."
      else if (exit.cancelled) {
        error = "Cancelled."
        queue.paused = true
      } else if (!error && exit.code !== 0) error = exit.stderr.trim().slice(-2000) || `Conductor exited with code ${exit.code}`
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      prepared?.cleanup()
      turn = undefined
      interrupting = false
      budgetStop = undefined
      if (before) {
        const after = snapshot(runDir, `${current.id.slice(0, 8)}-${id}-after`)
        // Two snapshots never share a commit id; whether files changed is what counts.
        if (after && checkpointFiles({ before, after, cwd: runDir }).length)
          broadcast({ type: "turn.checkpoint", turnId: id, checkpoint: { before, after, cwd: runDir } })
      }
      broadcast({
        type: "turn.finished",
        turnId: id,
        ok: error === undefined,
        error,
      })
      broadcastChats()
      broadcastBudget()
      drain()
    }
  }

  const server = Bun.serve<{ role: Role }>({
    hostname: "127.0.0.1",
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url)
      const role = url.pathname === "/ui" ? "ui" : url.pathname === "/bridge" ? "bridge" : undefined
      if (!role) return new Response("not found", { status: 404 })
      if (!sameSecret(url.searchParams.get("token") ?? "", opts.token)) return new Response("forbidden", { status: 403 })
      return srv.upgrade(req, { data: { role } }) ? undefined : new Response("upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) {
        if (socket.data.role !== "ui") return
        ui.add(socket)
        reply(socket, {
          type: "hello",
          version: opts.version,
          cwd: process.cwd(),
        })
        reply(socket, { type: "chats", items: chats.list() })
        reply(socket, { type: "chat.current", chat })
        reply(socket, { type: "schedules", items: schedules.list() })
        reply(socket, { type: "terminals", items: terminals.list() })
        reply(socket, { type: "queue", ...queue.view() })
        reply(socket, { type: "budget", budget: budgetState() })
      },
      close(socket) {
        ui.delete(socket)
        for (const [id, owner] of approvals) if (owner === socket) approvals.delete(id)
      },
      message(socket, raw) {
        try {
          handle(socket, JSON.parse(String(raw)) as ClientMessage | BridgeMessage)
        } catch (e) {
          if (socket.data.role === "ui")
            reply(socket, {
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            })
        }
      },
    },
  })

  function handle(socket: Socket, data: ClientMessage | BridgeMessage) {
    if (socket.data.role === "bridge") {
      const msg = data as BridgeMessage
      if (msg.type === "approval.request") {
        if (ui.size === 0) {
          const deny: BridgeReply = {
            type: "approval.response",
            id: msg.id,
            allow: false,
            message: "No desktop window is open to approve this.",
          }
          socket.send(JSON.stringify(deny))
          return
        }
        approvals.set(msg.id, socket)
      }
      broadcast(msg)
      if (msg.type === "delegation.finished" && msg.summary.costUsd) enforceBudget()
      return
    }
    const msg = data as ClientMessage
    switch (msg.type) {
      case "status":
        Promise.resolve(msg.workspace)
          .then((dir) => backendStatus(assertDirectory(dir)))
          .then((backends) =>
            reply(socket, {
              type: "status",
              workspace: path.resolve(msg.workspace),
              backends,
            }),
          )
          .catch((e: unknown) =>
            reply(socket, {
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          )
        return
      case "start":
        // A new request is the user saying "go": it resumes a paused queue, behind what is already waiting.
        queue.add(msg)
        queue.paused = false
        drain()
        if (turn) broadcastQueue()
        return
      case "thread.diff":
        Promise.resolve()
          .then(() => checkpointDiff(trustedCheckpoint(msg.workspace, msg.checkpoint)))
          .then((d) => reply(socket, { type: "thread.diff", requestId: msg.requestId, ...d }))
          .catch((e: unknown) =>
            reply(socket, { type: "thread.diff", requestId: msg.requestId, patch: "", truncated: false, error: errorText(e) }),
          )
        return
      case "thread.revert":
        Promise.resolve()
          .then(() => revertCheckpoint(trustedCheckpoint(msg.workspace, msg.checkpoint)))
          .then((r) => {
            if (r.ok && r.files.length)
              pendingNotes.push(
                `The user reverted the changes of thread "${msg.title}" (${r.files.join(", ")}). Those files are back to how they were before it ran.`,
              )
            reply(socket, { type: "thread.reverted", requestId: msg.requestId, ...r })
          })
          .catch((e: unknown) =>
            reply(socket, { type: "thread.reverted", requestId: msg.requestId, ok: false, message: errorText(e), files: [] }),
          )
        return
      case "worktree.action":
        Promise.resolve()
          .then((): ServerMessage => {
            const ws = assertDirectory(msg.workspace)
            if (msg.action === "preview") {
              const preview = previewMerge(ws, msg.worktree)
              return { type: "worktree.result", requestId: msg.requestId, ok: true, message: describePreview(preview), preview }
            }
            const r = msg.action === "apply" ? applyWorktree(ws, msg.worktree) : removeDelegateWorktree(ws, msg.worktree, msg.force)
            if (r.ok) {
              pendingNotes.push(
                msg.action === "apply"
                  ? `The user applied the worktree of thread "${msg.title}" to the workspace (uncommitted).`
                  : `The user removed the worktree of thread "${msg.title}" (${msg.worktree}).`,
              )
            }
            return { type: "worktree.result", requestId: msg.requestId, ok: r.ok, message: r.message }
          })
          .then((m) => reply(socket, m))
          .catch((e: unknown) => reply(socket, { type: "worktree.result", requestId: msg.requestId, ok: false, message: errorText(e) }))
        return
      case "queue.remove":
        queue.remove(msg.id)
        broadcastQueue()
        return
      case "file.image":
        Promise.resolve()
          .then(() => readWorkspaceImage(assertDirectory(msg.workspace), msg.path))
          .then((dataUrl) => reply(socket, { type: "file.imaged", requestId: msg.requestId, dataUrl }))
          .catch((e: unknown) => reply(socket, { type: "file.imaged", requestId: msg.requestId, error: errorText(e) }))
        return
      case "chat.markdown": {
        const meta = chats.get(msg.id)
        reply(
          socket,
          meta
            ? { type: "chat.markdowned", requestId: msg.requestId, title: meta.title, text: chatMarkdown(meta, chats.events(meta.id)) }
            : { type: "chat.markdowned", requestId: msg.requestId, error: "That chat no longer exists." },
        )
        return
      }
      case "usage.summary":
        reply(socket, {
          type: "usage",
          requestId: msg.requestId,
          summary: usageSummary(savedChats()),
        })
        return
      case "thread.rerun": {
        if (msg.brief.mode !== "read-only")
          throw new Error(
            "Only read-only threads run again directly. For one that edits or runs commands, ask Conductor to redo it on that backend.",
          )
        const dir = assertDirectory(msg.workspace)
        const id = `rerun-${randomUUID().slice(0, 8)}`
        const brief = Brief.parse(msg.brief)
        void (async () => {
          try {
            const session = await createSession({
              workspace: chat?.runIn ?? dir,
              permission: msg.permission,
              selfProvider: "claude",
              profile: msg.profile,
            })
            const result = await delegate(session, {
              checkpointId: id,
              taskClass: msg.taskClass,
              brief,
              route: { override: msg.provider },
              onStart: (decision, agent) =>
                broadcast({
                  type: "delegation.started",
                  id,
                  taskClass: decision.taskClass,
                  agent,
                  task: brief.task,
                  mode: brief.mode,
                  provider: decision.provider,
                  tier: decision.tier,
                  model: decision.model,
                  why: explainDecision(session.config, decision, session.profile),
                  brief,
                  rerunOf: msg.threadId,
                }),
              onEvent: (provider, event) => broadcast({ type: "delegation.event", id, provider, event: toWire(event) }),
            })
            broadcast({ type: "delegation.finished", id, summary: summarize(result) })
          } catch (e) {
            broadcast({ type: "delegation.failed", id, error: errorText(e) })
          }
          broadcastBudget()
        })()
        return
      }
      case "turn.restore":
        Promise.resolve()
          .then(() => {
            const dir = assertDirectory(msg.workspace)
            const r = restoreCheckpoint(
              trustedCheckpoint(msg.workspace, { before: msg.before, cwd: dir }).cwd,
              msg.before,
              msg.label.replace(/[^\w.-]+/g, "_").slice(0, 40),
            )
            if (r.ok && r.files.length)
              pendingNotes.push(
                `The user restored the folder to how it was before an earlier turn (${r.files.join(", ")} changed back). Re-read files before relying on what you saw since.`,
              )
            reply(socket, { type: "turn.restored", requestId: msg.requestId, ...r })
          })
          .catch((e: unknown) =>
            reply(socket, { type: "turn.restored", requestId: msg.requestId, ok: false, message: errorText(e), files: [] }),
          )
        return
      case "budget.get":
        reply(socket, { type: "budget", budget: budgetState() })
        return
      case "budget.set": {
        const clean = (n: number | null) => (n === null || !Number.isFinite(n) || n <= 0 ? null : Math.round(n * 10_000) / 10_000)
        const limits: BudgetLimits = {
          chatUsd: clean(msg.limits.chatUsd),
          dayUsd: clean(msg.limits.dayUsd),
          warnAt: Math.min(0.99, Math.max(0.1, Number(msg.limits.warnAt) || 0.8)),
        }
        mkdirSync(dataRoot, { recursive: true })
        writeFileSync(budgetFile, JSON.stringify(limits, null, 2))
        broadcastBudget()
        return
      }
      case "routing.get":
        Promise.resolve()
          .then(() => readRouting(assertDirectory(msg.workspace)))
          .then((r) => reply(socket, { type: "routing", requestId: msg.requestId, routes: r.routes, profiles: r.profiles }))
          .catch((e: unknown) =>
            reply(socket, { type: "routing", requestId: msg.requestId, routes: [], profiles: [], error: errorText(e) }),
          )
        return
      case "routing.save":
        Promise.resolve()
          .then(() => saveRouting(assertDirectory(msg.workspace), msg.scope, msg.routes))
          .then((r) => reply(socket, { type: "routing.saved", requestId: msg.requestId, path: r.path }))
          .catch((e: unknown) => reply(socket, { type: "routing.saved", requestId: msg.requestId, error: errorText(e) }))
        return
      case "route.test":
        Promise.resolve()
          .then(() => testRoute(assertDirectory(msg.workspace), msg.text, msg.taskClass, msg.profile))
          .then((result) => reply(socket, { type: "route.tested", requestId: msg.requestId, result }))
          .catch((e: unknown) =>
            reply(socket, {
              type: "route.tested",
              requestId: msg.requestId,
              result: { taskClass: msg.taskClass ?? "", why: [], error: errorText(e) },
            }),
          )
        return
      case "advanced.get":
        Promise.resolve()
          .then(() => readAdvanced(assertDirectory(msg.workspace)))
          .then((fields) => reply(socket, { type: "advanced", requestId: msg.requestId, fields }))
          .catch((e: unknown) => reply(socket, { type: "advanced", requestId: msg.requestId, fields: [], error: errorText(e) }))
        return
      case "profiles.get":
        Promise.resolve()
          .then(() => readProfiles(assertDirectory(msg.workspace)))
          .then((r) => reply(socket, { type: "profiles", requestId: msg.requestId, ...r, costs: profileCosts(savedChats()) }))
          .catch((e: unknown) =>
            reply(socket, { type: "profiles", requestId: msg.requestId, profiles: [], classes: [], error: errorText(e) }),
          )
        return
      case "advanced.save":
      case "profile.save":
      case "profile.delete":
      case "profile.default":
        Promise.resolve()
          .then(() => {
            const dir = assertDirectory(msg.workspace)
            if (msg.type === "advanced.save") return saveAdvanced(dir, msg.scope, msg.values)
            if (msg.type === "profile.save") return saveProfile(dir, msg.scope, msg.profile)
            if (msg.type === "profile.delete") return deleteProfile(dir, msg.scope, msg.name)
            return setDefaultProfile(dir, msg.scope, msg.name)
          })
          .then((r) => reply(socket, { type: "config.saved", requestId: msg.requestId, path: r.path }))
          .catch((e: unknown) => reply(socket, { type: "config.saved", requestId: msg.requestId, error: errorText(e) }))
        return
      case "config.preview":
        Promise.resolve()
          .then(() => {
            const dir = assertDirectory(msg.workspace)
            const c = msg.change
            const preview = { preview: true }
            if (c.kind === "advanced") return saveAdvanced(dir, msg.scope, c.values, preview)
            if (c.kind === "profile") return saveProfile(dir, msg.scope, c.profile, preview)
            if (c.kind === "profiles.import") return importProfiles(dir, msg.scope, c.text, preview)
            if (c.kind === "routing") return saveRouting(dir, msg.scope, c.routes, preview)
            return saveSettings(dir, msg.scope, c.values, preview)
          })
          .then((r) => reply(socket, { type: "config.diff", requestId: msg.requestId, path: r.path, diff: r.diff }))
          .catch((e: unknown) => reply(socket, { type: "config.diff", requestId: msg.requestId, diff: [], error: errorText(e) }))
        return
      case "config.history.get":
        Promise.resolve()
          .then(() => listHistory(assertDirectory(msg.workspace)))
          .then((items) => reply(socket, { type: "config.history", requestId: msg.requestId, items }))
          .catch((e: unknown) => reply(socket, { type: "config.history", requestId: msg.requestId, items: [], error: errorText(e) }))
        return
      case "config.change.get":
        Promise.resolve()
          .then(() => historyDiff(msg.id))
          .then((diff) => reply(socket, { type: "config.diff", requestId: msg.requestId, diff }))
          .catch((e: unknown) => reply(socket, { type: "config.diff", requestId: msg.requestId, diff: [], error: errorText(e) }))
        return
      case "config.restore":
      case "profiles.import":
        Promise.resolve()
          .then(() => {
            const dir = assertDirectory(msg.workspace)
            return msg.type === "config.restore" ? restoreHistory(dir, msg.id) : importProfiles(dir, msg.scope, msg.text)
          })
          .then((r) => reply(socket, { type: "config.saved", requestId: msg.requestId, path: r.path }))
          .catch((e: unknown) => reply(socket, { type: "config.saved", requestId: msg.requestId, error: errorText(e) }))
        return
      case "profiles.export":
        Promise.resolve()
          .then(() => exportProfiles(assertDirectory(msg.workspace), msg.names))
          .then((text) => reply(socket, { type: "profiles.exported", requestId: msg.requestId, text }))
          .catch((e: unknown) => reply(socket, { type: "profiles.exported", requestId: msg.requestId, text: "", error: errorText(e) }))
        return
      case "doctor.run":
        Promise.resolve()
          .then(() => runDoctor(assertDirectory(msg.workspace)))
          .then((report) => reply(socket, { type: "doctor", requestId: msg.requestId, report }))
          .catch((e: unknown) => reply(socket, { type: "doctor", requestId: msg.requestId, error: errorText(e) }))
        return
      case "doctor.latest":
        void latestVersions().then((versions) => reply(socket, { type: "doctor.latest", requestId: msg.requestId, versions }))
        return
      case "privacy.test":
        Promise.resolve()
          .then(() => {
            const { config } = loadConfig(assertDirectory(msg.workspace), null)
            const rel = path.isAbsolute(msg.path) ? path.relative(msg.workspace, msg.path) : msg.path
            return { pattern: matchesAny(rel.split(path.sep).join("/"), config.privacy.never_send), patterns: config.privacy.never_send }
          })
          .then((r) => reply(socket, { type: "privacy.tested", requestId: msg.requestId, ...r }))
          .catch((e: unknown) => reply(socket, { type: "privacy.tested", requestId: msg.requestId, patterns: [], error: errorText(e) }))
        return
      case "data.stats":
        Promise.resolve()
          .then(() => dataStats(dataRoot, chats))
          .then((stats) => reply(socket, { type: "data.stats", requestId: msg.requestId, stats }))
          .catch((e: unknown) => reply(socket, { type: "data.stats", requestId: msg.requestId, error: errorText(e) }))
        return
      case "data.prune":
      case "data.export":
        Promise.resolve()
          .then(() => {
            if (msg.type === "data.export") {
              const r = exportChats(dataRoot, chats, msg.workspace ? assertDirectory(msg.workspace) : undefined)
              return { message: `Saved ${r.count} chat${r.count === 1 ? "" : "s"} as Markdown.`, path: r.dir }
            }
            const n = pruneChats(dataRoot, chats, msg.days, msg.mode, Date.now(), chat?.id)
            if (n) broadcastChats()
            return { message: `${msg.mode === "archive" ? "Archived" : "Deleted"} ${n} chat${n === 1 ? "" : "s"}.` }
          })
          .then((r) => reply(socket, { type: "data.done", requestId: msg.requestId, ...r }))
          .catch((e: unknown) => reply(socket, { type: "data.done", requestId: msg.requestId, message: "", error: errorText(e) }))
        return
      case "templates.list":
        reply(socket, { type: "templates", items: listTemplates(assertDirectory(msg.workspace), dataRoot) })
        return
      case "template.save":
      case "template.delete": {
        const dir = assertDirectory(msg.workspace)
        if (msg.type === "template.save") saveTemplate(dir, dataRoot, msg.scope, msg.name, msg.text)
        else deleteTemplate(dir, dataRoot, msg.scope, msg.name)
        broadcast({ type: "templates", items: listTemplates(dir, dataRoot) })
        return
      }
      case "ide.status":
        reply(socket, { type: "ide", ide: ideState() })
        return
      case "ide.install":
        if (ide.installing || process.platform !== "linux") return
        ide.installing = "Starting the download…"
        ide.error = undefined
        broadcastIde()
        void installIde(dataRoot, (text) => {
          ide.installing = text
          broadcastIde()
        })
          .catch((e: unknown) => {
            ide.error = errorText(e)
          })
          .finally(() => {
            ide.installing = undefined
            broadcastIde()
          })
        return
      case "ide.start": {
        const folder = assertDirectory(msg.workspace)
        if (ide.url && ide.folder === folder) {
          broadcastIde()
          return
        }
        stopIde()
        const bin = findIde(dataRoot)
        if (!bin) {
          ide.error = "No VS Code server is installed."
          broadcastIde()
          return
        }
        void (async () => {
          const port = await freePort()
          const { args, url } = ideCommand(bin, folder, port, randomUUID().replaceAll("-", ""))
          const proc = spawn(args[0] as string, args.slice(1), { cwd: folder, stdio: "ignore", detached: process.platform !== "win32" })
          ide = { proc, folder }
          void new Promise((r) => proc.once("exit", r)).then(() => {
            if (ide.proc === proc) {
              ide = { error: "The VS Code server stopped." }
              broadcastIde()
            }
          })
          // Ready when it answers on its port.
          for (let i = 0; i < 120 && ide.proc === proc; i++) {
            try {
              await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
              ide.url = url
              break
            } catch {
              await Bun.sleep(250)
            }
          }
          if (ide.proc === proc && !ide.url) {
            stopIde()
            ide.error = "The VS Code server did not start within 30 seconds."
          }
          broadcastIde()
        })()
        return
      }
      case "ide.stop":
        stopIde()
        broadcastIde()
        return
      case "queue.move":
        queue.move(msg.id, msg.to)
        broadcastQueue()
        return
      case "queue.take":
        queue.take(msg.id)
        broadcastQueue()
        return
      case "queue.interrupt":
        if (!queue.promote(msg.id)) return
        queue.paused = false
        if (turn) {
          interrupting = true
          turn.abort.abort()
        } else drain()
        broadcastQueue()
        return
      case "export.save":
        Promise.resolve()
          .then(() => {
            if (!path.isAbsolute(msg.path) || !/\.(md|markdown|txt)$/i.test(msg.path)) throw new Error("Save as a .md file.")
            let text = msg.text ?? ""
            if (msg.chatId) {
              const meta = chats.get(msg.chatId)
              if (!meta) throw new Error("That chat no longer exists.")
              text = chatMarkdown(meta, chats.events(meta.id))
            }
            writeFileSync(msg.path, text)
            reply(socket, { type: "export.saved", requestId: msg.requestId, path: msg.path })
          })
          .catch((e: unknown) => reply(socket, { type: "export.saved", requestId: msg.requestId, path: msg.path, error: errorText(e) }))
        return
      case "side.ask":
      case "catchup": {
        const dir = assertDirectory(msg.workspace)
        const question = msg.type === "side.ask" ? msg.question.trim() : ""
        if (msg.type === "side.ask" && !question) return
        const id = randomUUID()
        const owner = chat
        const digest = owner ? transcriptDigest(chats.events(owner.id)) : ""
        broadcast({
          type: "quick.started",
          id,
          kind: msg.type === "side.ask" ? "side" : "catchup",
          question: question || undefined,
          chatId: owner?.id,
        })
        const { config } = loadConfig(dir, null)
        void quickAsk({
          executable: config.backends.claude.executable,
          model: config.backends.claude.tiers.fast,
          cwd: owner?.runIn ?? dir,
          prompt: msg.type === "side.ask" ? sideQuestionPrompt(question, digest) : catchUpPrompt(digest),
        }).then((r) => {
          // Saved with the chat it was asked in, even if another chat is open by now.
          const answer: ServerMessage =
            msg.type === "side.ask"
              ? { type: "side.answer", id, question, text: r.text, error: r.error, chatId: owner?.id }
              : { type: "catchup", id, text: r.text, error: r.error, chatId: owner?.id }
          const data = JSON.stringify(answer)
          for (const s of ui) s.send(data)
          if (owner && !r.error) chats.append(owner.id, answer)
        })
        return
      }
      case "worktrees.list":
        Promise.resolve()
          .then(() => listWorktrees(assertDirectory(msg.workspace)))
          .then((list) => reply(socket, { type: "worktrees", requestId: msg.requestId, list }))
          .catch(() => reply(socket, { type: "worktrees", requestId: msg.requestId }))
        return
      case "schedules.list":
        reply(socket, { type: "schedules", items: schedules.list() })
        return
      case "schedule.add": {
        const s = msg.schedule
        assertDirectory(s.workspace)
        if (!s.prompt.trim()) throw new Error("A scheduled request needs some text.")
        if (!Number.isFinite(s.at)) throw new Error("Pick a time for the scheduled request.")
        schedules.add({ ...s, prompt: s.prompt.trim(), repeat: s.repeat ?? "none" })
        broadcast({ type: "schedules", items: schedules.list() })
        return
      }
      case "schedule.remove":
        schedules.remove(msg.id)
        broadcast({ type: "schedules", items: schedules.list() })
        return
      case "board.get":
        reply(socket, { type: "board", workspace: msg.workspace, cards: boards.get(msg.workspace) })
        return
      case "board.upsert":
        boards.upsert(msg.workspace, msg.card)
        broadcast({ type: "board", workspace: msg.workspace, cards: boards.get(msg.workspace) })
        return
      case "board.remove":
        boards.remove(msg.workspace, msg.id)
        broadcast({ type: "board", workspace: msg.workspace, cards: boards.get(msg.workspace) })
        return
      case "board.move":
        boards.move(msg.workspace, msg.id, msg.column, msg.index)
        broadcast({ type: "board", workspace: msg.workspace, cards: boards.get(msg.workspace) })
        return
      case "term.list":
        reply(socket, { type: "terminals", items: terminals.list() })
        return
      case "term.open":
        Promise.resolve()
          .then(() => {
            const dir = assertDirectory(msg.workspace)
            let command: string[]
            let title: string
            if (msg.kind === "conductor") {
              const sessionId = chat?.sessionId
              if (!sessionId) throw new Error("This chat has no Conductor session yet: send a request first.")
              const { config } = loadConfig(dir, null)
              const exe = resolveExecutable(config.backends.claude.executable)
              if (!exe) throw new Error(`${config.backends.claude.executable} is not on PATH.`)
              command = [exe, "--resume", sessionId, ...(msg.draft?.trim() ? [msg.draft.trim()] : [])]
              title = "Conductor CLI"
            } else {
              command = [process.env.SHELL || "/bin/bash"]
              title = path.basename(command[0] as string)
            }
            const terminal = terminals.open({ title, cwd: chat?.runIn ?? dir, command, cols: msg.cols, rows: msg.rows })
            reply(socket, { type: "term.opened", requestId: msg.requestId, terminal })
            broadcast({ type: "terminals", items: terminals.list() })
          })
          .catch((e: unknown) => reply(socket, { type: "term.opened", requestId: msg.requestId, error: errorText(e) }))
        return
      case "term.attach":
        reply(socket, { type: "term.scrollback", id: msg.id, data: terminals.scrollback(msg.id) })
        return
      case "term.input":
        terminals.input(msg.id, msg.data)
        return
      case "term.resize":
        terminals.resize(msg.id, msg.cols, msg.rows)
        return
      case "term.close":
        terminals.close(msg.id)
        broadcast({ type: "terminals", items: terminals.list() })
        return
      case "file.write":
        Promise.resolve()
          .then(() => writeWorkspaceFile(assertDirectory(msg.workspace), msg.path, msg.text, msg.expectedMtime))
          .then((r) => reply(socket, { type: "file.saved", requestId: msg.requestId, ...r }))
          .catch((e: unknown) => reply(socket, { type: "file.saved", requestId: msg.requestId, path: msg.path, error: errorText(e) }))
        return
      case "open.url":
      case "open.editor": {
        const command = msg.type === "open.url" ? openerCommand(msg.url) : editorCommand(assertDirectory(msg.workspace), msg.path, msg.line)
        Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] }).unref()
        return
      }
      case "queue.send":
        if (queue.promote(msg.id)) queue.paused = false
        drain()
        if (turn) broadcastQueue()
        return
      case "cancel":
        turn?.abort.abort()
        return
      case "reset":
        chat = undefined
        pendingNotes.length = 0
        queue.clear()
        broadcastQueue()
        broadcast({ type: "chat.current" })
        return
      case "chats.list":
        reply(socket, { type: "chats", items: chats.list() })
        return
      case "chat.open": {
        const target = chats.get(msg.id)
        if (!target) throw new Error("That chat no longer exists.")
        // Reopening the chat that is running only redraws it; switching away waits for the turn.
        if (turn && target.id !== chat?.id) throw new Error("Stop the running turn before opening another chat.")
        if (target.id !== chat?.id) {
          chat = target
          pendingNotes.length = 0
          queue.clear()
          broadcastQueue()
        }
        broadcast({ type: "chat.replay", chat: target, events: chats.events(target.id), running: Boolean(turn) })
        return
      }
      case "chat.update": {
        const title = msg.title?.trim()
        const updated = chats.update(msg.id, {
          ...(title ? { title: title.slice(0, 200) } : {}),
          ...(msg.pinned !== undefined ? { pinned: msg.pinned } : {}),
        })
        // In place: a running turn holds this object and records the session id on it.
        if (updated && chat?.id === updated.id) Object.assign(chat, { title: updated.title, pinned: updated.pinned })
        broadcastChats()
        return
      }
      case "chat.delete":
        if (chat?.id === msg.id) {
          if (turn) throw new Error("Stop the running turn before deleting this chat.")
          chat = undefined
          queue.clear()
          broadcastQueue()
          broadcast({ type: "chat.current" })
        }
        chats.delete(msg.id)
        broadcastChats()
        return
      case "chats.search":
        reply(socket, { type: "chats.found", requestId: msg.requestId, hits: chats.search(msg.query) })
        return
      case "files.list":
        Promise.resolve(assertDirectory(msg.workspace))
          .then((dir) => listWorkspaceFiles(dir, msg.query, Math.min(20_000, Math.max(1, msg.limit ?? 50))))
          .then((files) => reply(socket, { type: "files.listed", requestId: msg.requestId, files }))
          .catch(() => reply(socket, { type: "files.listed", requestId: msg.requestId, files: [] }))
        return
      case "file.read":
        Promise.resolve()
          .then(() => readWorkspaceFile(assertDirectory(msg.workspace), msg.path))
          .then((f) => reply(socket, { type: "file.content", requestId: msg.requestId, ...f }))
          .catch((e: unknown) =>
            reply(socket, {
              type: "file.content",
              requestId: msg.requestId,
              path: msg.path,
              text: "",
              truncated: false,
              error: errorText(e),
            }),
          )
        return
      case "attachment.save":
        Promise.resolve()
          .then(() => saveAttachment(assertDirectory(msg.workspace), msg.name, msg.data))
          .then((rel) => reply(socket, { type: "attachment.saved", requestId: msg.requestId, path: rel }))
          .catch((e: unknown) => reply(socket, { type: "attachment.saved", requestId: msg.requestId, path: "", error: errorText(e) }))
        return
      case "settings.get":
        Promise.resolve(assertDirectory(msg.workspace))
          .then(async (dir) => reply(socket, { type: "settings", snapshot: readSettings(dir), options: await backendOptions(dir) }))
          .catch((e: unknown) => reply(socket, { type: "settings.error", message: errorText(e) }))
        return
      case "settings.save":
        Promise.resolve(assertDirectory(msg.workspace))
          .then((dir) => {
            const saved = saveSettings(dir, msg.scope, msg.values)
            reply(socket, { type: "settings.saved", path: saved.path, shadowed: saved.shadowed, snapshot: saved.snapshot })
          })
          .catch((e: unknown) => reply(socket, { type: "settings.error", message: errorText(e) }))
        return
      case "settings.test":
        Promise.resolve(assertDirectory(msg.workspace))
          .then((dir) => testModel(dir, msg.provider, msg.model, msg.reasoning, msg.trustWorkspace))
          .then((result) => reply(socket, { type: "settings.tested", requestId: msg.requestId, ...result }))
          .catch((e: unknown) =>
            reply(socket, { type: "settings.tested", requestId: msg.requestId, ok: false, detail: errorText(e), ms: 0 }),
          )
        return
      case "approval": {
        const bridge = approvals.get(msg.id)
        approvals.delete(msg.id)
        const response: BridgeReply = {
          type: "approval.response",
          id: msg.id,
          allow: msg.allow,
          message: msg.message,
        }
        bridge?.send(JSON.stringify(response))
        return
      }
    }
  }

  // Scheduled requests fire while the app is open, when no turn is running.
  const scheduler = setInterval(() => {
    // Only when nothing runs or waits: never ahead of the user's own queue, never past their Stop.
    if (turn || queue.view().items.length || queue.paused) return
    const due = schedules.due()[0]
    if (!due) return
    schedules.ran(due.id)
    broadcast({ type: "schedules", items: schedules.list() })
    if (!statSync(due.workspace, { throwIfNoEntry: false })?.isDirectory()) return
    const target = due.chatId ? chats.get(due.chatId) : undefined
    if (target && target.id !== chat?.id) {
      chat = target
      pendingNotes.length = 0
      broadcast({ type: "chat.replay", chat: target, events: chats.events(target.id), running: false })
    } else if (!target) {
      chat = undefined
      pendingNotes.length = 0
      broadcast({ type: "chat.current" })
    }
    queue.add({ type: "start", prompt: due.prompt, workspace: due.workspace, permission: due.permission, profile: due.profile })
    queue.paused = false
    drain()
  }, opts.scheduleTickMs ?? 20_000)
  scheduler.unref?.()

  return {
    port: server.port as number,
    stop() {
      clearInterval(scheduler)
      terminals.closeAll()
      stopIde()
      turn?.abort.abort()
      server.stop(true)
    },
  }
}

/** What the message's keywords changed, for the turn's status line. */
export function modeLine(o: Overrides): string | undefined {
  const parts = [
    o.ultrawork ? "ultrawork mode" : "",
    o.profile ? `${o.profile} profile` : "",
    o.provider ? `pinned to ${o.provider}` : "",
    ...Object.entries(o.routes).map(([cls, p]) => `${cls} → ${p}`),
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : undefined
}
