import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { BackendRegistry } from "../../backends/registry"
import { ledgerContext, readLedger } from "../../coordinator/ledger"
import { fakeRegistry, report, testSession } from "../../test-support"
import { createMcpServer } from "../server"

async function connect(backends: BackendRegistry, ledger?: string, signal?: AbortSignal) {
  const server = createMcpServer(testSession(backends), { routes: {} }, { ledger, signal })
  const client = new Client({ name: "test", version: "0" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    return { text: r.content[0]?.text ?? "", isError: r.isError ?? false }
  }
  return { call }
}

const brief = { task: "Find where config is loaded.", why: "w", acceptance: ["paths"] }
/** A backend that answers only when `release` is called. */
function gated(backends: BackendRegistry) {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const original = backends.gemini.run
  backends.gemini.run = async function* (o) {
    await Promise.race([gate, new Promise((r) => o.signal?.addEventListener("abort", r, { once: true }))])
    yield* original(o)
  }
  return () => release()
}

describe("background delegations", () => {
  test("start → status → result, and the ledger records it", async () => {
    const ledger = path.join(mkdtempSync(path.join(tmpdir(), "ar-ledger-")), "chat.jsonl")
    const backends = fakeRegistry({ gemini: [{ text: report("done"), sessionId: "g-1" }] })
    const release = gated(backends)
    const { call } = await connect(backends, ledger)

    const started = await call("delegate", { task_class: "search.codebase", brief, background: true })
    const id = /Started background delegation (\S+)/.exec(started.text)?.[1] as string
    expect(id).toMatch(/^job-/)
    expect((await call("delegation_status")).text).toContain(`${id} · search.codebase · running`)
    expect((await call("delegation_result", { id, wait_seconds: 0 })).text).toContain("still running")
    expect(ledgerContext(readLedger(ledger))).toContain("Still running in the background")

    release()
    const result = await call("delegation_result", { id, wait_seconds: 5 })
    expect(result.isError).toBe(false)
    expect(result.text).toContain("# Delegation result — done")
    const context = ledgerContext(readLedger(ledger)) ?? ""
    expect(context).not.toContain("Still running")
    expect(context).toContain(`resume with { provider: "gemini", session_id: "g-1" }`)
  })

  test("cancel stops a running job", async () => {
    const backends = fakeRegistry({ gemini: [{ text: report("done") }] })
    gated(backends)
    const { call } = await connect(backends)
    const id = /delegation (\S+)/.exec(
      (await call("delegate", { task_class: "search.codebase", brief, background: true })).text,
    )?.[1] as string
    expect((await call("cancel_delegation", { id })).text).toBe(`Cancelled ${id}.`)
    expect((await call("delegation_status")).text).not.toContain("running")
  })

  test("a refused delegation fails at once instead of becoming a job", async () => {
    const { call } = await connect(fakeRegistry({}))
    const r = await call("delegate", { task_class: "no.such.class", brief, background: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("Unknown task class")
    expect((await call("delegation_status")).text).toBe("No background delegations in this turn.")
  })

  test("unknown ids are reported, not thrown", async () => {
    const { call } = await connect(fakeRegistry({}))
    expect((await call("delegation_result", { id: "job-x" })).isError).toBe(true)
  })

  test("a new server marks the previous turn's unfinished jobs as interrupted", async () => {
    const ledger = path.join(mkdtempSync(path.join(tmpdir(), "ar-ledger-")), "chat.jsonl")
    const backends = fakeRegistry({ gemini: [{ text: report("done") }] })
    gated(backends)
    const turn = new AbortController()
    const { call } = await connect(backends, ledger, turn.signal)
    await call("delegate", { task_class: "search.codebase", brief, background: true })
    await connect(fakeRegistry({}), ledger)
    const context = ledgerContext(readLedger(ledger)) ?? ""
    expect(context).not.toContain("Still running")
    expect(context).toContain("interrupted: the turn ended before it finished")
    turn.abort()
  })
})
