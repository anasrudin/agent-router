import type { OutputParser } from "../cli-runner"
import { num, safeJson } from "../cli-runner"
import { BackendError, type BackendEvent, classifyErrorText } from "../events"

/** Parses `gemini --output-format stream-json` (init, message deltas, tool_use/tool_result, result). */
export function createGeminiParser(): OutputParser {
  let text = ""
  return {
    line(line) {
      const msg = safeJson(line)
      if (!msg) return []
      switch (msg.type) {
        case "init":
          return typeof msg.session_id === "string" ? [{ type: "session", sessionId: msg.session_id }] : []
        case "message":
          if (msg.role !== "assistant" || typeof msg.content !== "string") return []
          text = msg.delta === true ? text + msg.content : msg.content
          return [{ type: "text", text: msg.content }]
        case "tool_use":
          return [{ type: "tool_call", name: String(msg.tool_name), input: msg.parameters }]
        case "tool_result":
          return [{ type: "tool_result", ok: msg.status === "success" }]
        case "result":
          return resultEvents(msg, text)
        default:
          return []
      }
    },
    end: () => [],
  }
}

function resultEvents(msg: Record<string, unknown>, text: string): BackendEvent[] {
  const stats = (msg.stats ?? {}) as Record<string, unknown>
  const events: BackendEvent[] = []
  if (msg.stats) events.push({ type: "usage", usage: { inputTokens: num(stats.input_tokens), outputTokens: num(stats.output_tokens) } })
  if (msg.status === "success") {
    events.push({ type: "done", text })
    return events
  }
  const error = (msg.error ?? {}) as Record<string, unknown>
  const message = String(error.message ?? error.type ?? "unknown error")
  events.push({ type: "error", error: new BackendError("gemini", classifyErrorText(message), `gemini: ${message}`) })
  return events
}
