import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { BackendRegistry } from "../../backends/registry"
import type { PaneEvent } from "../../coordinator/telemetry"
import { taskSummary } from "../../coordinator/telemetry"
import { fakeRegistry, report, testSession } from "../../test-support"
import { createMcpServer } from "../server"

async function delegateOnce(backends: BackendRegistry, patch: unknown, brief: Record<string, unknown>) {
  const session = testSession(backends, patch)
  const server = createMcpServer(session, { routes: {} })
  const client = new Client({ name: "test", version: "0" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  await client.callTool({ name: "delegate", arguments: { task_class: "search.codebase", brief } })
  return session.workspace
}

const readEvents = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as PaneEvent)

const brief = { task: "Find where config is loaded.", why: "w", acceptance: ["paths"], relevant_files: ["src/config/load.ts:10-40"] }

describe("telemetry.events_file", () => {
  test("off by default: nothing is written", async () => {
    const workspace = await delegateOnce(fakeRegistry({ gemini: [{ text: report("done") }] }), {}, brief)
    expect(existsSync(path.join(workspace, ".harness", "events.jsonl"))).toBe(false)
  })

  test("dispatch → update → merge with the pane's refs and token badges", async () => {
    const backends = fakeRegistry({ gemini: [{ text: report("done"), costUsd: 0.01 }] })
    const workspace = await delegateOnce(backends, { telemetry: { events_file: ".harness/events.jsonl" } }, brief)
    const events = readEvents(path.join(workspace, ".harness", "events.jsonl"))
    expect(events.map((e) => `${e.event}:${e.pane.status}`)).toEqual(["dispatch:running", "update:running", "merge:done"])
    expect(events[0]?.pane).toMatchObject({
      task_class: "search.codebase",
      agent: "scout",
      provider: "gemini",
      mode: "read-only",
      task_summary: "Find where config is loaded.",
      context_refs: ["src/config/load.ts:10-40"],
    })
    expect(events[2]?.budget).toEqual({ input_tokens: 10, cached_tokens: 0, output_tokens: 5, cost_usd: 0.01, cap_tokens: null })
    expect(events[2]?.detail).toBe("succeeded")
  })

  test("a failed attempt shows as retrying; no usable result halts the pane", async () => {
    const backends = fakeRegistry({ gemini: [{ error: "missing_executable" }], claude: [{ error: "failed" }, { error: "failed" }] })
    const workspace = await delegateOnce(backends, { telemetry: { events_file: "events.jsonl" } }, brief)
    const events = readEvents(path.join(workspace, "events.jsonl"))
    expect(events[1]).toMatchObject({ event: "update", pane: { provider: "gemini", status: "retrying" } })
    expect(events.at(-1)).toMatchObject({ event: "halt", pane: { status: "error" } })
  })

  test("task summaries are cut to 12 words", () => {
    expect(taskSummary("one two three four five six seven eight nine ten eleven twelve thirteen")).toBe(
      "one two three four five six seven eight nine ten eleven twelve…",
    )
  })
})
