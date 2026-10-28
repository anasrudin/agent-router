import { afterAll, describe, expect, test } from "bun:test"
import { Bridge } from "../bridge"
import type { ServerMessage } from "../protocol"
import { startServer } from "../serve"

const token = "test-token-0123456789abcdef"
const server = startServer({ port: 0, token, version: "test" })
const base = `ws://127.0.0.1:${server.port}`
afterAll(() => server.stop())

/** A UI client that queues every server message for awaiting in order. */
async function uiClient() {
  const socket = new WebSocket(`${base}/ui?token=${token}`)
  const inbox: ServerMessage[] = []
  const waiters: ((m: ServerMessage) => void)[] = []
  socket.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data)) as ServerMessage
    const waiter = waiters.shift()
    if (waiter) waiter(msg)
    else inbox.push(msg)
  })
  await new Promise((r) => socket.addEventListener("open", r))
  const next = () => {
    const queued = inbox.shift()
    return queued ? Promise.resolve(queued) : new Promise<ServerMessage>((r) => waiters.push(r))
  }
  return { socket, next, send: (m: unknown) => socket.send(JSON.stringify(m)) }
}

describe("serve", () => {
  test("rejects a wrong token and unknown paths", async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/ui?token=nope`)).status).toBe(403)
    expect((await fetch(`http://127.0.0.1:${server.port}/other?token=${token}`)).status).toBe(404)
  })

  test("hello, then backend status for a workspace", async () => {
    const ui = await uiClient()
    expect(await ui.next()).toMatchObject({ type: "hello", version: "test" })
    ui.send({ type: "status", workspace: process.cwd() })
    const status = await ui.next()
    expect(status.type).toBe("status")
    if (status.type === "status") expect(Object.keys(status.backends.health).sort()).toEqual(["claude", "gemini", "openai"])
    ui.send({ type: "status", workspace: "/definitely/not/here" })
    expect(await ui.next()).toMatchObject({ type: "error", message: expect.stringContaining("Not a folder") })
    ui.socket.close()
  })

  test("approval round trip: bridge asks, UI answers, bridge gets the answer", async () => {
    const ui = await uiClient()
    await ui.next()
    const bridge = await Bridge.connect(`${base}/bridge?token=${token}`)
    bridge.emit({
      type: "delegation.started",
      id: "d1",
      taskClass: "plan",
      agent: "planner",
      task: "Plan it",
      mode: "read-only",
      provider: "claude",
      tier: "deep",
    })
    expect(await ui.next()).toMatchObject({ type: "delegation.started", id: "d1" })

    const answer = bridge.requestApproval("Bash", { command: "bun test" })
    const request = await ui.next()
    expect(request).toMatchObject({ type: "approval.request", tool: "Bash", input: { command: "bun test" } })
    if (request.type !== "approval.request") throw new Error("unreachable")
    ui.send({ type: "approval", id: request.id, allow: false, message: "not now" })
    expect(await answer).toEqual({ allow: false, message: "not now" })
    ui.socket.close()
  })

  test("with no window open, approvals fail closed", async () => {
    await new Promise((r) => setTimeout(r, 50))
    const bridge = await Bridge.connect(`${base}/bridge?token=${token}`)
    expect(await bridge.requestApproval("Edit", {})).toMatchObject({ allow: false })
  })

  test("bridge refuses to connect with a bad token", async () => {
    await expect(Bridge.connect(`${base}/bridge?token=wrong`, 1000)).rejects.toThrow()
  })
})
