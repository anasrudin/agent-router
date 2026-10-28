/**
 * Messages between the desktop UI, the local server (`agent-router serve`), and the router MCP
 * child it starts via Conductor. Plain JSON over WebSocket; the UI imports these types only.
 */
import type { BackendOptions, PermissionMode } from "../backends/Backend"
import type { ProviderId, Tier } from "../config/schema"
import type { ProviderHealth } from "../router/health"

export type SettingsScope = "user" | "project"

export interface BackendSettings {
  tiers: Record<Tier, string>
  /** An empty string means "the CLI's default effort". */
  reasoning: Record<Tier, string>
  trustWorkspace: boolean
}

export type SettingsValues = Record<ProviderId, BackendSettings>

export interface SettingsSnapshot {
  workspace: string
  values: SettingsValues
  /** Config files in effect, lowest priority first. */
  sources: string[]
  paths: Record<SettingsScope, string>
}

export interface ModelTest {
  ok: boolean
  detail: string
  ms: number
}

/** BackendEvent with errors flattened to plain data so it survives JSON. */
export type WireEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; ok: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "error"; kind: string; message: string }
  | { type: "done"; text: string }

export interface DelegationSummary {
  status: string
  provider: ProviderId
  tier: Tier
  model?: string
  attempts: { provider: ProviderId; tier: Tier; outcome: string; errorKind?: string; message?: string }[]
  stopReason: string
  costUsd: number
  tokens: { input: number; output: number }
  findings: { severity: string; message: string }[]
  notes: string[]
  worktree?: string
  /** The delegate's report, verbatim. */
  report: string
}

/** MCP child → server. */
export type BridgeMessage =
  | {
      type: "delegation.started"
      id: string
      taskClass: string
      agent: string
      task: string
      mode: string
      provider: ProviderId
      tier: Tier
      model?: string
    }
  | { type: "delegation.event"; id: string; provider: ProviderId; event: WireEvent }
  | { type: "delegation.finished"; id: string; summary: DelegationSummary }
  | { type: "delegation.failed"; id: string; error: string }
  | { type: "approval.request"; id: string; tool: string; input: Record<string, unknown> }

/** Server → MCP child. */
export type BridgeReply = { type: "approval.response"; id: string; allow: boolean; message?: string }

/** UI → server. */
export type ClientMessage =
  | { type: "start"; prompt: string; workspace: string; permission: PermissionMode; profile?: string }
  | { type: "cancel" }
  | { type: "reset" }
  | { type: "status"; workspace: string }
  | { type: "approval"; id: string; allow: boolean; message?: string }
  | { type: "settings.get"; workspace: string }
  | { type: "settings.save"; workspace: string; scope: SettingsScope; values: SettingsValues }
  | {
      type: "settings.test"
      requestId: string
      workspace: string
      provider: ProviderId
      model: string
      reasoning: string
      trustWorkspace: boolean
    }

export interface ProfileInfo {
  name: string
  label: string
  description: string
}

export interface BackendStatus {
  health: Record<ProviderId, ProviderHealth>
  executables: Record<ProviderId, string>
  profiles: ProfileInfo[]
  defaultProfile?: string
}

/** Server → UI. Bridge messages are forwarded as-is. */
export type ServerMessage =
  | { type: "hello"; version: string; cwd: string }
  | { type: "status"; workspace: string; backends: BackendStatus }
  | {
      type: "turn.started"
      turnId: string
      resumed: boolean /** Keywords in the message that changed routing, e.g. "economy profile". */
      mode?: string
    }
  | { type: "conductor"; turnId: string; event: WireEvent }
  | { type: "turn.finished"; turnId: string; ok: boolean; error?: string }
  | { type: "error"; message: string }
  | { type: "settings"; snapshot: SettingsSnapshot; options: Record<ProviderId, BackendOptions> }
  | { type: "settings.saved"; path: string; shadowed: string[]; snapshot: SettingsSnapshot }
  | { type: "settings.error"; message: string }
  | ({ type: "settings.tested"; requestId: string } & ModelTest)
  | BridgeMessage
