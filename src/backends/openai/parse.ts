import type { OutputParser } from "../cli-runner"
import { num, safeJson } from "../cli-runner"
import { BackendError, type BackendEvent, classifyErrorText } from "../events"

/** Parses `codex exec --json` (JSONL thread/turn/item events). */
export function createCodexParser(): OutputParser {
  let lastMessage: string | undefined
  let failed = false
  return {
    line(line) {
      const msg = safeJson(line)
      if (!msg) return []
      switch (msg.type) {
        case "thread.started":
          return typeof msg.thread_id === "string" ? [{ type: "session", sessionId: msg.thread_id }] : []
        case "item.started":
        case "item.completed":
          return itemEvents(msg.type, msg.item as Record<string, unknown> | undefined, (text) => {
            lastMessage = text
          })
        case "turn.completed": {
          const usage = (msg.usage ?? {}) as Record<string, unknown>
          return [
            {
              type: "usage",
              usage: { inputTokens: num(usage.input_tokens), outputTokens: num(usage.output_tokens) },
            },
          ]
        }
        case "error":
          // Codex retries transport failures itself and reports each try; only the last word counts.
          if (typeof msg.message === "string" && /^Reconnecting\.\.\./.test(msg.message)) return []
          return failure(msg)
        case "turn.failed":
          return failure(msg)
        default:
          return []
      }
    },
    end(): BackendEvent[] {
      return !failed && lastMessage !== undefined ? [{ type: "done", text: lastMessage }] : []
    },
  }

  /** Codex reports a fatal error twice (`error`, then `turn.failed`); the first one is the failure. */
  function failure(msg: Record<string, unknown>): BackendEvent[] {
    if (failed) return []
    failed = true
    const error = msg.error as Record<string, unknown> | undefined
    const message = String(error?.message ?? msg.message ?? "unknown error")
    return [{ type: "error", error: new BackendError("openai", classifyErrorText(message), `codex: ${message}`) }]
  }
}

function itemEvents(phase: unknown, item: Record<string, unknown> | undefined, onMessage: (text: string) => void): BackendEvent[] {
  if (!item) return []
  if (item.type === "agent_message" && phase === "item.completed" && typeof item.text === "string") {
    onMessage(item.text)
    return [{ type: "text", text: item.text }]
  }
  if (item.type === "command_execution") {
    if (phase === "item.started") return [{ type: "tool_call", name: "shell", input: item.command }]
    return [{ type: "tool_result", ok: item.status === "completed" && num(item.exit_code) === 0 }]
  }
  if (item.type === "file_change" && phase === "item.completed") {
    return [{ type: "tool_call", name: "file_change", input: item.changes }]
  }
  if (item.type === "mcp_tool_call") {
    // Named the way Claude Code names MCP tools, so the app and the watchdog treat both alike.
    if (phase === "item.started") return [{ type: "tool_call", name: `mcp__${item.server}__${item.tool}`, input: item.arguments }]
    if (phase === "item.completed") return [{ type: "tool_result", ok: item.status === "completed" && !item.error }]
  }
  return []
}
