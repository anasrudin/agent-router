import { statSync } from "node:fs"
import path from "node:path"
import type { ServerWebSocket } from "bun"
import { createBackends } from "../backends/registry"
import { prepareConductor, SELF_ENTRY, streamConductor } from "../conductor/run"
import { loadConfig } from "../config/load"
import { PROVIDERS, type ProviderId } from "../config/schema"
import { newLedgerPath } from "../coordinator/ledger"
import { Session } from "../coordinator/session"
import { type Overrides, parseOverrides, ULTRAWORK_NOTE } from "../router/classify"
import { toWire } from "./bridge"
import type { BackendStatus, BridgeMessage, BridgeReply, ClientMessage, ServerMessage } from "./protocol"
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
    executables: Object.fromEntries(PROVIDERS.map((p) => [p, config.backends[p].executable])) as Record<ProviderId, string>,
    profiles: Object.entries(config.profiles).map(([name, p]) => ({ name, label: p.label, description: p.description })),
    defaultProfile: config.default_profile,
  }
}

interface Turn {
  id: string
  abort: AbortController
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

  async function runTurn(msg: Extract<ClientMessage, { type: "start" }>, bridgeUrl: string) {
    const workspace = assertDirectory(msg.workspace)
    const overrides = parseOverrides(msg.prompt, profileNames(workspace))
    // A keyword in the message beats the profile menu, for this request only.
    const profile = overrides.profile ?? msg.profile
    const prompt = overrides.ultrawork ? `${msg.prompt}\n\n${ULTRAWORK_NOTE}` : msg.prompt
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
        resumed: resume !== undefined,
        mode: modeLine(overrides),
      })
      prepared = await prepareConductor({
        workspace,
        permission: msg.permission,
        selfProvider: "claude",
        profile,
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
          broadcast({ type: "conductor", turnId: id, event: toWire(event) })
        },
      })
      if (exit.cancelled) error = "Cancelled."
      else if (!error && exit.code !== 0) error = exit.stderr.trim().slice(-2000) || `Conductor exited with code ${exit.code}`
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
        if (turn) {
          reply(socket, {
            type: "error",
            message: "Conductor is still working on the previous request.",
          })
          return
        }
        void runTurn(msg, `ws://127.0.0.1:${server.port}/bridge?token=${encodeURIComponent(opts.token)}`)
        return
      case "cancel":
        turn?.abort.abort()
        return
      case "reset":
        conductor = undefined
        chatLedger = undefined
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
