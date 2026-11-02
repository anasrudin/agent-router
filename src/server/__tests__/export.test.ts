import { describe, expect, test } from "bun:test"
import { chatMarkdown } from "../export"
import type { ChatEvent, ChatMeta } from "../protocol"

const chat: ChatMeta = { id: "c1", workspace: "/w", title: "Find greet", createdAt: 0, updatedAt: 0, pinned: false, turns: 1 }
const ev = (msg: ChatEvent["msg"], at = 0): ChatEvent => ({ at, msg })
const summary = {
  status: "done",
  provider: "gemini" as const,
  tier: "fast" as const,
  attempts: [],
  stopReason: "succeeded",
  costUsd: 0,
  tokens: { input: 1, output: 1 },
  findings: [],
  notes: [],
  changedFiles: [],
  taskClass: "search.codebase",
  report: "## Status\ndone\n\n## Result\n- greet.js:10 exports it\n",
}

describe("chatMarkdown", () => {
  test("requests, Conductor's words, tools folded, threads and their outcome, in order", () => {
    const md = chatMarkdown(chat, [
      ev({ type: "turn.started", turnId: "t", prompt: "Where is greet?", resumed: false }),
      ev({ type: "conductor", turnId: "t", event: { type: "text", text: "Looking." } }),
      ev({ type: "conductor", turnId: "t", event: { type: "tool_call", name: "Read", input: { file_path: "greet.js" } } }),
      ev({ type: "conductor", turnId: "t", event: { type: "tool_call", name: "mcp__router__delegate", input: {} } }),
      ev({
        type: "delegation.started",
        id: "d",
        taskClass: "search.codebase",
        agent: "scout",
        task: "Find the export.",
        mode: "read-only",
        provider: "gemini",
        tier: "fast",
      }),
      ev({ type: "delegation.finished", id: "d", summary }),
      ev({ type: "conductor", turnId: "t", event: { type: "text", text: "greet.js:10" } }),
      ev({ type: "conductor", turnId: "t", event: { type: "usage", inputTokens: 1, outputTokens: 1 } }),
      ev({ type: "turn.finished", turnId: "t", ok: true }),
      ev({ type: "side.answer", id: "s", question: "What is a scout?", text: "A fast lookup." }),
    ])
    expect(md).toStartWith("# Find greet\n")
    const order = [
      "## Request",
      "Where is greet?",
      "Looking.",
      "1 tool call",
      "- Read `greet.js`",
      "**Thread** scout on Gemini",
      "done: greet.js:10 exports it",
      "greet.js:10",
      "**By the way**: What is a scout?",
    ]
    let at = 0
    for (const part of order) {
      const i = md.indexOf(part, at)
      expect(i).toBeGreaterThanOrEqual(0)
      at = i
    }
    expect(md).not.toContain("delegate")
    expect(md).not.toMatch(/\n{3,}/)
  })
})
