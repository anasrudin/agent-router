import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChatEvent } from "../protocol"
import { catchUpPrompt, quickAsk, sideQuestionPrompt, transcriptDigest } from "../quick"

const dir = mkdtempSync(path.join(tmpdir(), "quick-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const fake = path.join(dir, "claude")
writeFileSync(
  fake,
  `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
cat > "${dir}/stdin"
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Short answer."}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"x","usage":{"input_tokens":3,"output_tokens":2},"total_cost_usd":0.0004}'
`,
)
chmodSync(fake, 0o755)

describe.skipIf(process.platform === "win32")("quickAsk", () => {
  test("runs the fast model with no tools and no MCP servers, prompt on stdin", async () => {
    const r = await quickAsk({ executable: fake, model: "haiku", cwd: dir, prompt: "What now?" })
    expect(r).toEqual({ text: "Short answer.", costUsd: 0.0004, error: undefined })
    const args = readFileSync(path.join(dir, "args"), "utf8").split("\n")
    expect(args).toContain("haiku")
    expect(args[args.indexOf("--tools") + 1]).toBe("")
    expect(args).toContain("--strict-mcp-config")
    expect(readFileSync(path.join(dir, "stdin"), "utf8")).toBe("What now?")
  })

  test("a missing executable is an error, not a throw", async () => {
    const r = await quickAsk({ executable: path.join(dir, "nope"), cwd: dir, prompt: "x" })
    expect(r.error).toBeTruthy()
    expect(r.text).toBe("")
  })
})

describe("prompts", () => {
  const events: ChatEvent[] = [
    { at: 0, msg: { type: "turn.started", turnId: "t", prompt: "Fix the login bug", resumed: false } },
    { at: 0, msg: { type: "conductor", turnId: "t", event: { type: "text", text: "Patched auth.ts" } } },
    { at: 0, msg: { type: "conductor", turnId: "t", event: { type: "tool_call", name: "Read", input: {} } } },
  ]
  test("the digest keeps prompts and replies, newest last, and keeps the end when cut", () => {
    expect(transcriptDigest(events)).toBe("User: Fix the login bug\n\nConductor: Patched auth.ts")
    expect(transcriptDigest(events, 10)).toBe("…ed auth.ts")
  })
  test("side question and catch-up carry the conversation", () => {
    expect(sideQuestionPrompt("why?", "D")).toContain("<conversation>\nD\n</conversation>")
    expect(sideQuestionPrompt("why?", "D")).toEndWith("Question: why?")
    expect(catchUpPrompt("")).toContain("(nothing yet)")
  })
})
