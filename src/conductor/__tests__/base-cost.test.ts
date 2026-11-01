import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "../../mcp/server"
import { PROMPTS_DIR, protocolForConductor } from "../../prompts/render"
import { fakeRegistry, testSession } from "../../test-support"
import { conductorSystemPrompt } from "../run"

// Conductor's system prompt and tool list are written to the prompt cache at the start of every
// chat, so these guard what keeps them small.
describe("Conductor's per-request context", () => {
  const protocol = readFileSync(path.join(PROMPTS_DIR, "shared", "delegation-protocol.md"), "utf8")

  test("its protocol keeps the brief and report rules but not the templates or delegate-only advice", () => {
    const lean = protocolForConductor(protocol)
    expect(lean).toContain("### Brief rules")
    expect(lean).toContain("### Report rules")
    expect(lean).toContain("`## Status` (done | partial | blocked | failed)")
    expect(lean).not.toContain("## Acceptance criteria\n- [ ]")
    expect(lean).not.toContain("## 3. Cross-provider handoffs")
    expect(lean.length).toBeLessThan(protocol.length * 0.65)
  })

  test("the whole appended prompt stays within budget", () => {
    const text = conductorSystemPrompt(testSession(fakeRegistry({})), "sonnet").text
    // About 4.8k tokens on 2026-11-01; a jump means something large slipped in. Windows adds its
    // shell notes on top.
    const windowsNotes = process.platform === "win32" ? readFileSync(path.join(PROMPTS_DIR, "shared", "windows.md"), "utf8").length : 0
    expect(text.length).toBeLessThan(19_000 + windowsNotes)
    expect(text).not.toContain("\r")
  })

  test("no tools that repeat what the prompt already says (route preview, backend status)", async () => {
    const server = createMcpServer(testSession(fakeRegistry({})), { routes: {} })
    const client = new Client({ name: "t", version: "0" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain("route")
    expect(names).not.toContain("backends")
    expect(names).toContain("delegate")
  })
})
