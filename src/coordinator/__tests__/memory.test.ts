import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { conductorSystemPrompt } from "../../conductor/run"
import { createMcpServer } from "../../mcp/server"
import { fakeRegistry, report, testSession } from "../../test-support"
import { delegate } from "../delegate"
import { forget, MEMORY_FILE, memoryPath, NOTE_CHAR_LIMIT, NOTES_MAX, readNotes, remember } from "../memory"
import { Brief } from "../protocol"

const ws = () => mkdtempSync(path.join(tmpdir(), "ar-mem-"))

describe("project memory file", () => {
  test("remember appends, skips duplicates, and the file stays hand-editable", () => {
    const dir = ws()
    expect(remember(dir, "Tests need `make test-local`.").ok).toBe(true)
    expect(remember(dir, "  tests need   `make test-local`. ").message).toContain("Already saved")
    const file = memoryPath(dir)
    writeFileSync(file, `${readFileSync(file, "utf8")}- Never edit billing/ (added by hand)\n`)
    expect(readNotes(dir)).toEqual(["Tests need `make test-local`.", "Never edit billing/ (added by hand)"])
  })

  test("limits: note length and note count", () => {
    const dir = ws()
    expect(remember(dir, "x".repeat(NOTE_CHAR_LIMIT + 1)).ok).toBe(false)
    for (let i = 0; i < NOTES_MAX; i++) remember(dir, `note ${i}`)
    expect(remember(dir, "one too many").message).toContain("Memory is full")
  })

  test("forget removes by number and reports a bad number", () => {
    const dir = ws()
    remember(dir, "a")
    remember(dir, "b")
    expect(forget(dir, 1).message).toContain("Forgot: a")
    expect(readNotes(dir)).toEqual(["b"])
    expect(forget(dir, 5).ok).toBe(false)
  })
})

describe("where project memory goes", () => {
  test("every brief carries it", async () => {
    const backends = fakeRegistry({ gemini: [{ text: report("done") }] })
    const session = testSession(backends)
    remember(session.workspace, "Never edit billing/.")
    const brief = Brief.parse({ task: "Find X.", why: "w", acceptance: ["paths"] })
    await delegate(session, { taskClass: "search.codebase", brief })
    expect(backends.gemini.calls[0]?.prompt).toContain("- Project memory (standing facts and rules")
    expect(backends.gemini.calls[0]?.prompt).toContain("  - Never edit billing/.")
  })

  test("Conductor's system prompt carries it, numbered", () => {
    const session = testSession(fakeRegistry({}))
    expect(conductorSystemPrompt(session, "opus").text).toContain(`(none yet; ${MEMORY_FILE})`)
    remember(session.workspace, "Use pnpm, not npm.")
    expect(conductorSystemPrompt(session, "opus").text).toContain("1. Use pnpm, not npm.")
  })

  test("remember and forget are router tools Conductor can call", async () => {
    const session = testSession(fakeRegistry({}))
    const server = createMcpServer(session, { routes: {} })
    const client = new Client({ name: "test", version: "0" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]?.text ?? ""
    expect(await call("remember", { note: "Docs live in docs/." })).toContain("1. Docs live in docs/.")
    expect(await call("forget", { number: 1 })).toContain("(no notes)")
  })
})
