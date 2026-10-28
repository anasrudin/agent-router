import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { RunOptions } from "../Backend"
import { CONDUCTOR_TOOLS, claudeArgs, READ_ONLY_BASH } from "../claude"
import { createClaudeParser } from "../claude/parse"
import type { OutputParser } from "../cli-runner"
import type { BackendEvent } from "../events"
import { classifyErrorText } from "../events"
import { geminiArgs } from "../gemini"
import { createGeminiParser } from "../gemini/parse"
import { codexArgs, parseCodexModels } from "../openai"
import { createCodexParser } from "../openai/parse"
import { buildInvocation } from "../process"

const FIXTURES = path.join(import.meta.dir, "fixtures")

function replay(parser: OutputParser, fixture: string): BackendEvent[] {
  const lines = readFileSync(path.join(FIXTURES, fixture), "utf8").split(/\r?\n/)
  return [...lines.flatMap((l) => parser.line(l)), ...parser.end()]
}

const terminal = (events: BackendEvent[]) => events.filter((e) => e.type === "done" || e.type === "error")

describe("claude stream-json (recorded 2.1.312)", () => {
  const events = replay(createClaudeParser(), "claude-stream.jsonl")
  test("session id from init", () => {
    expect(events[0]).toEqual({ type: "session", sessionId: "181a2cda-5c25-4e61-8e67-5301319957b8" })
  })
  test("text, usage with cost, single done", () => {
    expect(events).toContainEqual({ type: "text", text: "pong" })
    const usage = events.find((e) => e.type === "usage")
    expect(usage).toMatchObject({ usage: { outputTokens: 4, costUsd: 0.00180992 } })
    expect(usage?.type === "usage" && usage.usage.inputTokens).toBe(2 + 8446 + 11852)
    expect(terminal(events)).toEqual([{ type: "done", text: "pong" }])
  })
  test("is_error result becomes a typed error", () => {
    const parser = createClaudeParser()
    const [, err] = parser.line(
      JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "overloaded" }),
    )
    expect(err).toMatchObject({ type: "error", error: { kind: "rate_limited", provider: "claude" } })
  })
  test("tool use and results", () => {
    const parser = createClaudeParser()
    expect(
      parser.line(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a" } }] } }),
      ),
    ).toEqual([{ type: "tool_call", name: "Read", input: { file_path: "a" } }])
    expect(parser.line(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } }))).toEqual([
      { type: "tool_result", ok: false },
    ])
  })
  test("partial and non-JSON lines are ignored", () => {
    const parser = createClaudeParser()
    expect(parser.line('{"type":"assist')).toEqual([])
    expect(parser.line("Update available! Run npm i -g")).toEqual([])
  })
})

describe("gemini stream-json (recorded 0.66.0)", () => {
  test("session, tool call and result, text, usage, single done", () => {
    const events = replay(createGeminiParser(), "gemini-stream.jsonl")
    expect(events[0]).toEqual({ type: "session", sessionId: "404bfafa-a7fa-48ed-8ba4-bbeb936a74c8" })
    expect(events).toContainEqual({ type: "tool_call", name: "read_file", input: { file_path: "note.txt" } })
    expect(events).toContainEqual({ type: "tool_result", ok: true })
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 17755, outputTokens: 21 } })
    expect(terminal(events)).toEqual([{ type: "done", text: "hello" }])
  })
  test("free-tier quota on the pro model is a rate limit", () => {
    const events = replay(createGeminiParser(), "gemini-quota.jsonl")
    expect(terminal(events)).toHaveLength(1)
    expect(terminal(events)[0]).toMatchObject({ type: "error", error: { kind: "rate_limited", provider: "gemini" } })
  })
  test("deltas accumulate into the final text; the echoed user message is ignored", () => {
    const parser = createGeminiParser()
    const lines = [
      '{"type":"message","role":"user","content":"brief"}',
      '{"type":"message","role":"assistant","content":"## Status\\n","delta":true}',
      '{"type":"message","role":"assistant","content":"done","delta":true}',
      '{"type":"result","status":"success","stats":{"input_tokens":1,"output_tokens":2}}',
    ]
    expect(terminal(lines.flatMap((l) => parser.line(l)))).toEqual([{ type: "done", text: "## Status\ndone" }])
  })
  test("banner noise before the stream is ignored; no result means no terminal (runner reports exit)", () => {
    const parser = createGeminiParser()
    expect(parser.line("Loaded cached credentials.")).toEqual([])
    expect(parser.end()).toEqual([])
  })
})

describe("codex exec --json (recorded 0.165.0)", () => {
  test("thread, command, last message, usage", () => {
    const events = replay(createCodexParser(), "codex-exec.jsonl")
    expect(events[0]).toEqual({ type: "session", sessionId: "01a181f7-5cc6-7051-829c-1f333e8a65be" })
    expect(events).toContainEqual({ type: "tool_call", name: "shell", input: "/bin/bash -lc 'cat note.txt'" })
    expect(events).toContainEqual({ type: "tool_result", ok: true })
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 25818, outputTokens: 40 } })
    expect(terminal(events)).toEqual([{ type: "done", text: "hello" }])
  })

  test("MCP tool calls are tool calls, named as Claude Code names them", () => {
    const events = replay(createCodexParser(), "codex-mcp.jsonl")
    expect(events).toEqual([
      { type: "tool_call", name: "mcp__lsp__symbols", input: { file: "src/math.ts" } },
      { type: "tool_result", ok: true },
    ])
  })
})

describe("argument mapping", () => {
  const base: RunOptions = { prompt: "brief", cwd: ".", mode: "read-only", permission: "default", timeoutMs: 1000 }

  test("prompts never travel on argv", () => {
    const secret = "UNIQUE-BRIEF-TEXT"
    const opts = { ...base, prompt: secret, systemPrompt: secret }
    for (const args of [claudeArgs(opts, "/tmp/sys.md", []), geminiArgs(opts, []), codexArgs(opts, [])]) {
      expect(args.join(" ")).not.toContain(secret)
    }
  })
  test("claude read-only denies edit tools; edit accepts edits; resume and model pass through", () => {
    expect(claudeArgs(base, undefined, [])).toEqual(expect.arrayContaining(["--disallowedTools", "Edit", "Write", "--strict-mcp-config"]))
    const edit = claudeArgs({ ...base, mode: "edit", model: "sonnet", resumeSessionId: "s1" }, "/tmp/s.md", [])
    expect(edit).toEqual(
      expect.arrayContaining(["acceptEdits", "--model", "sonnet", "--resume", "s1", "--append-system-prompt-file", "/tmp/s.md"]),
    )
    // Edit tools stay available in edit mode; only subagents are off.
    expect(edit.slice(edit.indexOf("--disallowedTools") + 1)).not.toContain("Edit")
    expect(edit).toEqual(expect.arrayContaining(["--disallowedTools", "Agent", "Task"]))
  })
  test("claude: attached MCP servers come from our config only, and their tools are allowed without asking", () => {
    const opts = { ...base, mcpServers: [{ name: "lsp", command: "bun", args: [], note: "n" }] }
    const ro = claudeArgs(opts, undefined, [], undefined, "/tmp/mcp.json")
    expect(ro).toEqual(expect.arrayContaining(["--strict-mcp-config", "--mcp-config", "/tmp/mcp.json"]))
    expect(ro.slice(ro.indexOf("--allowedTools"), ro.indexOf("--disallowedTools"))).toContain("mcp__lsp")
    const edit = claudeArgs({ ...opts, mode: "edit", permission: "acceptEdits" }, undefined, [], undefined, "/tmp/mcp.json")
    expect(edit.slice(edit.indexOf("--allowedTools"), edit.indexOf("--disallowedTools"))).toContain("mcp__lsp")
    expect(claudeArgs(base, undefined, [])).not.toContain("--mcp-config")
  })

  test("claude edit (accept edits) may run the project's configured checks, and nothing broader", () => {
    const args = claudeArgs({ ...base, mode: "edit", allowedCommands: ["node --test", "npm run lint", "make $(evil)"] }, undefined, [])
    expect(args).toEqual(
      expect.arrayContaining(["acceptEdits", "--allowedTools", "Bash(grep:*)", "Bash(node --test:*)", "Bash(npm run lint:*)"]),
    )
    expect(args).not.toContain("Bash")
    expect(args.some((a) => a.includes("evil"))).toBe(false)
    const bypass = claudeArgs({ ...base, mode: "edit", permission: "bypass", allowedCommands: ["node --test"] }, undefined, [])
    expect(bypass).toContain("bypassPermissions")
    expect(bypass).not.toContain("--allowedTools")
  })
  test("claude read-only may search with a few read-only shell commands, never plain Bash", () => {
    const args = claudeArgs(base, undefined, [])
    expect(args).toEqual(expect.arrayContaining(["dontAsk", "--allowedTools", ...READ_ONLY_BASH, "Agent", "Task"]))
    expect(args).not.toContain("Bash")
    for (const rule of READ_ONLY_BASH) expect(rule).not.toMatch(/\((rg|git|find|sed|awk|xargs)\b/)
  })
  test("claude run-commands pre-approves Bash only", () => {
    expect(claudeArgs({ ...base, mode: "run-commands" }, undefined, [])).toEqual(
      expect.arrayContaining(["--allowedTools", "Bash", "--disallowedTools"]),
    )
  })
  test("claude lean tools load only what each mode uses", () => {
    expect(claudeArgs(base, undefined, [])).not.toContain("--tools")
    const tools = (args: string[]) => args.at(args.indexOf("--tools") + 1)
    expect(tools(claudeArgs(base, undefined, [], undefined, undefined, true))).toBe("Read,Bash")
    expect(tools(claudeArgs({ ...base, mode: "run-commands" }, undefined, [], undefined, undefined, true))).toBe("Read,Bash")
    expect(tools(claudeArgs({ ...base, mode: "edit" }, undefined, [], undefined, undefined, true))).toBe("Read,Edit,Write,Bash")
    expect(CONDUCTOR_TOOLS).not.toContain("Agent")
  })
  test("codex resume: exec resume <id>, sandbox through config, prompt still on stdin", () => {
    const ro = codexArgs({ ...base, resumeSessionId: "t-1" }, [])
    expect(ro.slice(0, 2)).toEqual(["exec", "resume"])
    expect(ro).toEqual(expect.arrayContaining(["-c", "sandbox_mode='read-only'"]))
    expect(ro).not.toContain("--sandbox")
    expect(ro.slice(-2)).toEqual(["t-1", "-"])
    expect(codexArgs({ ...base, mode: "edit", resumeSessionId: "t-1" }, [])).toContain("sandbox_mode='workspace-write'")
    const bypass = codexArgs({ ...base, mode: "edit", permission: "bypass", resumeSessionId: "t-1" }, [])
    expect(bypass).toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(bypass.join(" ")).not.toContain("sandbox_mode")
    expect(codexArgs(base, [])).not.toContain("resume")
  })
  test("codex sandbox follows mode and reads stdin", () => {
    expect(codexArgs(base, [])).toEqual(expect.arrayContaining(["--sandbox", "read-only"]))
    expect(codexArgs({ ...base, mode: "edit" }, [])).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]))
    expect(codexArgs({ ...base, mode: "edit", permission: "bypass" }, [])).toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(codexArgs(base, []).at(-1)).toBe("-")
    const lsp = { name: "lsp", command: "C:\\bun.exe", args: ["cli.ts", "lsp-mcp"], note: "n" }
    const mcp = codexArgs({ ...base, mcpServers: [lsp] }, [])
    expect(mcp).toEqual(
      expect.arrayContaining(["-c", "mcp_servers.lsp.command='C:\\bun.exe'", "-c", "mcp_servers.lsp.args=['cli.ts','lsp-mcp']"]),
    )
    // Literal strings: nothing cmd.exe would refuse when codex is an npm .cmd shim.
    expect(() => buildInvocation("C:\\npm\\codex.cmd", mcp, "win32")).not.toThrow()
    expect(codexArgs({ ...base, mcpServers: [{ ...lsp, args: ["it's"] }] }, []).join(" ")).not.toContain("mcp_servers")
  })
  test("gemini approval follows mode; model omitted when placeholder; streams JSON", () => {
    expect(geminiArgs(base, [])).toEqual(expect.arrayContaining(["--approval-mode", "default", "--output-format", "stream-json"]))
    expect(geminiArgs({ ...base, mode: "edit" }, [])).toEqual(expect.arrayContaining(["--approval-mode", "auto_edit"]))
    expect(geminiArgs(base, [])).not.toContain("-m")
  })
  test("reasoning effort maps per CLI; gemini has none", () => {
    expect(codexArgs({ ...base, reasoning: "xhigh" }, [])).toEqual(expect.arrayContaining(["-c", "model_reasoning_effort=xhigh"]))
    expect(claudeArgs({ ...base, reasoning: "high" }, undefined, [])).toEqual(expect.arrayContaining(["--effort", "high"]))
    expect(geminiArgs({ ...base, reasoning: "high" }, []).join(" ")).not.toContain("high")
    expect(codexArgs(base, []).join(" ")).not.toContain("reasoning")
  })
})

describe("classifyErrorText", () => {
  const cases: [string, string][] = [
    ["Error: 429 Too Many Requests", "rate_limited"],
    ["Please login with `claude /login`", "not_authenticated"],
    ["prompt is too long: 250000 tokens > 200000 maximum", "context_overflow"],
    ["segfault", "failed"],
  ]
  for (const [text, kind] of cases) test(text, () => expect(classifyErrorText(text)).toBe(kind as never))
})

describe("recorded failure output", () => {
  test("codex 0.165.0 unauthenticated: reconnect noise is ignored, one terminal error", () => {
    const events = replay(createCodexParser(), "codex-unauthorized.jsonl")
    expect(events[0]).toEqual({ type: "session", sessionId: "01a181ed-fda6-7ce1-8e1e-5c7ef7da168e" })
    const errors = events.filter((e) => e.type === "error")
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ error: { kind: "not_authenticated", provider: "openai" } })
  })
  test("codex reconnect that recovers still succeeds", () => {
    const parser = createCodexParser()
    const lines = [
      '{"type":"error","message":"Reconnecting... 1/5 (stream disconnected)"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}',
    ]
    expect(terminal([...lines.flatMap((l) => parser.line(l)), ...parser.end()])).toEqual([{ type: "done", text: "ok" }])
  })
  test("gemini 0.66.0 untrusted folder maps to its own kind", () => {
    const stderr = readFileSync(path.join(FIXTURES, "gemini-untrusted.stderr.txt"), "utf8")
    expect(classifyErrorText(stderr)).toBe("untrusted_workspace")
  })
  test("overload is routed like a rate limit; 401 wins over an incidental 503", () => {
    expect(classifyErrorText("This model is currently experiencing high demand. status 503")).toBe("rate_limited")
    expect(classifyErrorText("401 Unauthorized, cf-ray: a5-503-SIN")).toBe("not_authenticated")
  })
})

describe("model options", () => {
  test("codex catalog (recorded 0.165.0): only listed models, each with its efforts", () => {
    const options = parseCodexModels(readFileSync(path.join(FIXTURES, "codex-models.json"), "utf8"))
    expect(options.models.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"])
    expect(options.models[0]?.reasoning).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(options.reasoningLevels).toContain("ultra")
  })
  test("gemini trust override is opt-in and maps to --skip-trust", () => {
    const base: RunOptions = { prompt: "b", cwd: ".", mode: "read-only", permission: "default", timeoutMs: 1 }
    expect(geminiArgs(base, [])).not.toContain("--skip-trust")
    expect(geminiArgs(base, [], true)).toContain("--skip-trust")
  })
})
