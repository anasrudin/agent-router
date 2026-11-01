import { statSync } from "node:fs"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { createBackends } from "../backends/registry"
import { prepareConductor, SELF_ENTRY, streamConductor } from "../conductor/run"
import { loadConfig, resolvePlan } from "../config/load"
import { describePlan, PLAN_PRESETS } from "../config/plans"
import { PROVIDERS, type ProviderId, type RoutingConfig } from "../config/schema"
import { checkpointDiff, revertCheckpoint } from "../coordinator/checkpoints"
import { newLedgerPath } from "../coordinator/ledger"
import { applyWorktree, previewMerge, removeDelegateWorktree } from "../coordinator/merge"
import { Session } from "../coordinator/session"
import { isDelegateWorktree, samePath } from "../coordinator/worktrees"
import { describePreview } from "../mcp/server"
import { type Overrides, parseOverrides, ULTRAWORK_NOTE } from "../router/classify"
import { QuotaTracker } from "../router/quota"
import { toWire } from "./bridge"
import type { BackendStatus, BridgeMessage, BridgeReply, ClientMessage, QueuedPrompt, ServerMessage, ThreadCheckpoint } from "./protocol"
import { backendOptions, readSettings, saveSettings, testModel } from "./settings"

type Role = "ui" | "bridge"
type Socket = ServerWebSocket<{ role: Role }>

export interface ServeOptions {
  port: number
  /** Shared secret the desktop shell passes to its webview; required on every connection. */
  token: string
  version: string
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
  }
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
  let conductor: { workspace: string; sessionId: string } | undefined
  /** The current chat's delegation ledger; a new chat (or workspace) starts a new one. */
  let chatLedger: string | undefined
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
  }
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
    const notes = pendingNotes.splice(0)
    const prompt = notes.length ? `${base}\n\n[Since your last turn, in the desktop app:]\n${notes.map((n) => `- ${n}`).join("\n")}` : base
    const id = `turn-${++turnCounter}`
    const abort = new AbortController()
    turn = { id, abort }
    const resume = conductor?.workspace === workspace ? conductor.sessionId : undefined
    if (!resume || !chatLedger) chatLedger = newLedgerPath()
    let error: string | undefined
    let prepared: Awaited<ReturnType<typeof prepareConductor>> | undefined
    try {
      broadcast({
        type: "turn.started",
        turnId: id,
        prompt: msg.prompt,
        resumed: resume !== undefined,
        mode: modeLine(overrides),
      })
      prepared = await prepareConductor({
        workspace,
        permission: msg.permission,
        selfProvider: "claude",
        profile,
        plan: msg.plan,
        pins: { provider: overrides.provider, routes: overrides.routes },
        entry: SELF_ENTRY,
        bridgeUrl,
        ledger: chatLedger,
      })
      const exit = await streamConductor(prepared, prompt, {
        resumeSessionId: resume,
        signal: abort.signal,
        onEvent: (event) => {
          if (event.type === "session") conductor = { workspace, sessionId: event.sessionId }
          if (event.type === "error") error = event.error.message
          if (event.type === "quota") quota.record("claude", event.windows)
          broadcast({ type: "conductor", turnId: id, event: toWire(event) })
        },
      })
      if (exit.cancelled) {
        error = "Cancelled."
        queue.paused = true
      } else if (!error && exit.code !== 0) error = exit.stderr.trim().slice(-2000) || `Conductor exited with code ${exit.code}`
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      prepared?.cleanup()
      turn = undefined
      broadcast({
        type: "turn.finished",
        turnId: id,
        ok: error === undefined,
        error,
      })
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
      case "queue.send":
        if (queue.promote(msg.id)) queue.paused = false
        drain()
        if (turn) broadcastQueue()
        return
      case "cancel":
        turn?.abort.abort()
        return
      case "reset":
        conductor = undefined
        chatLedger = undefined
        pendingNotes.length = 0
        queue.clear()
        broadcastQueue()
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

  return {
    port: server.port as number,
    stop() {
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
