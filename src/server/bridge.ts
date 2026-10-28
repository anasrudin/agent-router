import type { BackendEvent } from "../backends/events"
import type { BridgeMessage, BridgeReply, WireEvent } from "./protocol"

export function toWire(event: BackendEvent): WireEvent {
  switch (event.type) {
    case "usage":
      return { type: "usage", ...event.usage }
    case "error":
      return { type: "error", kind: event.error.kind, message: event.error.message }
    default:
      return event
  }
}

export interface ApprovalAnswer {
  allow: boolean
  message?: string
}

/**
 * The MCP child's link back to the desktop server: delegation progress goes up,
 * permission answers come down. If the link drops, approvals fail closed (deny).
 */
export class Bridge {
  private readonly pending = new Map<string, (answer: ApprovalAnswer) => void>()
  private counter = 0

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (e) => {
      const reply = JSON.parse(String(e.data)) as BridgeReply
      if (reply.type !== "approval.response") return
      this.pending.get(reply.id)?.({ allow: reply.allow, message: reply.message })
      this.pending.delete(reply.id)
    })
    socket.addEventListener("close", () => {
      for (const resolve of this.pending.values()) resolve({ allow: false, message: "Desktop app disconnected." })
      this.pending.clear()
    })
  }

  static connect(url: string, timeoutMs = 5000): Promise<Bridge> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => reject(new Error(`bridge: no connection to ${new URL(url).host}`)), timeoutMs)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        resolve(new Bridge(socket))
      })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("bridge: connection failed"))
      })
    })
  }

  nextId(prefix: string): string {
    this.counter += 1
    return `${prefix}-${process.pid}-${this.counter}`
  }

  emit(message: BridgeMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  requestApproval(tool: string, input: Record<string, unknown>): Promise<ApprovalAnswer> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.resolve({ allow: false, message: "Desktop app disconnected." })
    const id = this.nextId("approval")
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.emit({ type: "approval.request", id, tool, input })
    })
  }
}
