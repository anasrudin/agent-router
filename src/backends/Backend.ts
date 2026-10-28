import type { ProviderId } from "../config/schema"
import type { BackendEvent } from "./events"

/** How much a delegate may change. Adapters map this onto each CLI's own sandbox/approval flags. */
export type AgentMode = "read-only" | "run-commands" | "edit"

/** The harness-wide permission mode chosen by the user. */
export type PermissionMode = "default" | "acceptEdits" | "bypass"

export interface RunOptions {
  /** The full user-turn text (the brief). Always sent through stdin, never argv. */
  prompt: string
  /** Role instructions for the delegate. */
  systemPrompt?: string
  /** Undefined means "let the CLI pick its default model". */
  model?: string
  /** Reasoning effort for CLIs that support one; others ignore it. */
  reasoning?: string
  cwd: string
  mode: AgentMode
  permission: PermissionMode
  resumeSessionId?: string
  timeoutMs: number
  signal?: AbortSignal
  /** Hold the delegate in its session until its final message is a well-formed report (CLIs with a Stop hook). */
  reportGate?: boolean
  /** Shell commands an edit-mode delegate may run without asking (the project's configured checks). */
  allowedCommands?: string[]
  /** MCP servers to attach (stdio), for CLIs that take them per run. Others ignore this. */
  mcpServers?: McpServerSpec[]
}

export interface McpServerSpec {
  name: string
  command: string
  args: string[]
  /** Told to the delegate so it knows the tools exist and when to use them. */
  note: string
}

export interface Detection {
  installed: boolean
  version?: string
  /** Version the adapter's fixtures were recorded against; undefined when none were recorded. */
  testedVersion?: string
  detail?: string
}

export interface ModelOption {
  id: string
  description?: string
  /** Reasoning efforts this model accepts, when the CLI says; otherwise the backend-wide list applies. */
  reasoning?: string[]
}

/** What the settings UI may offer for this backend. Only adapters know these. */
export interface BackendOptions {
  /** Suggestions, not a whitelist: any model id the CLI accepts can be saved. */
  models: ModelOption[]
  /** Empty when the CLI has no reasoning-effort control. */
  reasoningLevels: string[]
  /** True when the CLI gates headless runs on workspace trust and can be told to skip it. */
  supportsTrustOverride: boolean
}

export interface Backend {
  readonly id: ProviderId
  readonly supportsResume: boolean
  /** Usage events report the session's running total, so a resumed run's usage includes the runs before it. */
  readonly cumulativeUsage?: boolean
  detect(): Promise<Detection>
  options(): Promise<BackendOptions>
  /** Streams normalised events. Ends with exactly one `done` or `error` event. Abort via `signal` to cancel. */
  run(options: RunOptions): AsyncIterable<BackendEvent>
}
