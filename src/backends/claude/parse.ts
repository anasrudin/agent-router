import type { OutputParser } from "../cli-runner"
import { num, safeJson } from "../cli-runner"
import { BackendError, type BackendEvent, classifyErrorText } from "../events"

/** Parses `claude -p --output-format stream-json --verbose`. */
export function createClaudeParser(): OutputParser {
  return {
    line(line) {
      const msg = safeJson(line)
      if (!msg) return []
      switch (msg.type) {
        case "system":
          return msg.subtype === "init" && typeof msg.session_id === "string" ? [{ type: "session", sessionId: msg.session_id }] : []
        case "assistant":
          return contentBlocks(msg).flatMap((block): BackendEvent[] => {
            if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }]
            if (block.type === "tool_use") return [{ type: "tool_call", name: String(block.name), input: block.input }]
            return []
          })
        case "user":
          return contentBlocks(msg)
            .filter((block) => block.type === "tool_result")
            .map((block) => ({ type: "tool_result", ok: block.is_error !== true }))
        case "result":
          return resultEvents(msg)
        default:
          return []
      }
    },
    end: () => [],
  }
}

function contentBlocks(msg: Record<string, unknown>): Record<string, unknown>[] {
  const message = msg.message as { content?: unknown } | undefined
  return Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
}

function resultEvents(msg: Record<string, unknown>): BackendEvent[] {
  const usage = (msg.usage ?? {}) as Record<string, unknown>
  const events: BackendEvent[] = [
    {
      type: "usage",
      usage: {
        inputTokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
        outputTokens: num(usage.output_tokens),
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
      },
    },
  ]
  const text = typeof msg.result === "string" ? msg.result : ""
  if (msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype !== "success")) {
    const status = num(msg.api_error_status)
    const detail = text || String(msg.subtype)
    const kind = status === 429 ? "rate_limited" : status === 401 ? "not_authenticated" : classifyErrorText(detail)
    events.push({ type: "error", error: new BackendError("claude", kind, `claude: ${detail}`) })
  } else {
    events.push({ type: "done", text })
  }
  return events
}
