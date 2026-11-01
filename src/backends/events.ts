import type { ProviderId } from "../config/schema"

export interface Usage {
  /** All prompt-side tokens, cached or not, so providers compare like for like. */
  inputTokens: number
  /** Includes thinking/reasoning tokens, which every provider bills as output. */
  outputTokens: number
  /** The part of inputTokens served from the provider's prompt cache, when the CLI reports it. */
  cachedInputTokens?: number
  /** Only set when the CLI reports it; never estimated. */
  costUsd?: number
}

export type BackendErrorKind =
  | "missing_executable"
  | "not_authenticated"
  /** The CLI refuses to run headless in a folder the user has not trusted (Gemini CLI exits 55). */
  | "untrusted_workspace"
  | "rate_limited"
  | "context_overflow"
  | "timeout"
  /** The harness watchdog stopped a delegate that went silent (no events for limits.delegate_stall_seconds). */
  | "stalled"
  /** The harness watchdog stopped a delegate repeating one tool call (limits.max_identical_tool_calls). */
  | "tool_loop"
  | "cancelled"
  | "failed"

export class BackendError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly kind: BackendErrorKind,
    message: string,
  ) {
    super(message)
    this.name = "BackendError"
  }
}

/** One usage window of a subscription, as the CLI reports it: "5h" at 72% until 14:10. */
export interface QuotaWindow {
  /** Window length in words: "5h", "7d", "30d". */
  label: string
  /** 0 to 1. */
  usedFraction: number
  /** Epoch milliseconds, when the CLI says. */
  resetsAt?: number
  /** The provider is refusing requests in this window until it resets. */
  limited: boolean
}

export interface ProviderQuota {
  windows: QuotaWindow[]
  /** When this was reported, epoch milliseconds. */
  at: number
}

export type QuotaSnapshot = Partial<Record<ProviderId, ProviderQuota>>

export type BackendEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; ok: boolean }
  | { type: "usage"; usage: Usage }
  /** The subscription's usage windows, when the CLI reports them (Claude stream, Codex rollout). */
  | { type: "quota"; windows: QuotaWindow[] }
  | { type: "error"; error: BackendError }
  | { type: "done"; text: string }

const ERROR_PATTERNS: [BackendErrorKind, RegExp][] = [
  ["untrusted_workspace", /not running in a trusted directory|trusted.?folder/i],
  // Before rate limits: a 401 body can carry ids that happen to contain "503".
  [
    "not_authenticated",
    /not (logged|signed) in|unauthori[sz]ed|\b401\b|invalid api key|please (log ?in|login|authenticate)|auth(entication)? (required|failed)/i,
  ],
  // Overload (503) behaves like a rate limit for routing: retrying the same backend now will not help.
  ["rate_limited", /rate.?limit|\b429\b|too many requests|quota|usage limit|resource.?exhausted|\b503\b|high demand|overloaded/i],
  ["context_overflow", /context.{0,20}(length|window|limit)|prompt is too long|too many tokens|maximum context/i],
]

/** Map free-form CLI error text onto the kinds the router acts on. */
export function classifyErrorText(text: string): BackendErrorKind {
  for (const [kind, pattern] of ERROR_PATTERNS) if (pattern.test(text)) return kind
  return "failed"
}
