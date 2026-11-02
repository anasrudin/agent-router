import { loadConfig } from "../config/load"
import { PROVIDERS, type RoutingConfig } from "../config/schema"
import { editLayer, type LayerResult, type LayerWrite } from "./layers"
import type { AdvancedField, SettingsScope } from "./protocol"

type Spec = Omit<AdvancedField, "value">

const NAMES = { claude: "Claude", gemini: "Gemini", openai: "Codex" } as const

/**
 * Settings that used to live only in routing.yaml, described once so the Settings page can show
 * and validate them: the escalation ladder, limits and watchdogs, the delegate token cap, privacy,
 * project checks, worktree setup, telemetry, language servers and each backend's command.
 */
export const ADVANCED: Spec[] = [
  {
    key: "escalation.to_deep_when.files_touched_gt",
    group: "Escalation",
    label: "Raise to deep when a task touches more files than",
    type: "int",
    min: 0,
  },
  {
    key: "escalation.to_deep_when.previous_attempt_failed",
    group: "Escalation",
    label: "Raise to deep after a failed attempt",
    type: "bool",
  },
  {
    key: "escalation.to_deep_when.task_mentions",
    group: "Escalation",
    label: "Raise to deep when the task mentions",
    type: "list",
    help: "One phrase per line, such as migration or security.",
  },
  { key: "escalation.to_deep_when.classes", group: "Escalation", label: "Task classes these rules can raise", type: "list" },
  { key: "escalation.max_attempts_per_subtask", group: "Escalation", label: "Attempts per subtask, across backends", type: "int", min: 1 },
  { key: "limits.max_parallel_agents", group: "Limits and watchdogs", label: "Delegates at once", type: "int", min: 1 },
  { key: "limits.max_parallel_per_provider", group: "Limits and watchdogs", label: "Delegates at once per backend", type: "int", min: 1 },
  {
    key: "limits.parallel_writers_need_worktree",
    group: "Limits and watchdogs",
    label: "Parallel writers need their own worktree",
    type: "bool",
  },
  { key: "limits.delegate_timeout_seconds", group: "Limits and watchdogs", label: "Delegate time limit, seconds", type: "int", min: 1 },
  {
    key: "limits.delegate_stall_seconds",
    group: "Limits and watchdogs",
    label: "Stop a delegate silent for, seconds",
    type: "int",
    min: 1,
  },
  {
    key: "limits.max_identical_tool_calls",
    group: "Limits and watchdogs",
    label: "Stop a delegate repeating one tool call this often",
    type: "int",
    min: 2,
  },
  {
    key: "limits.backend_unhealthy_after_errors",
    group: "Limits and watchdogs",
    label: "Treat a backend as down after errors in a row",
    type: "int",
    min: 1,
  },
  {
    key: "limits.quota_avoid_at",
    group: "Limits and watchdogs",
    label: "Prefer other backends once a subscription window is this full",
    type: "number",
    min: 0,
    max: 1,
    help: "0 to 1; 1 turns it off.",
  },
  {
    key: "budget.delegate_tokens",
    group: "Limits and watchdogs",
    label: "Tokens one delegation may use (all attempts)",
    type: "int",
    min: 1,
    nullable: true,
    help: "Empty: no cap.",
  },
  {
    key: "privacy.never_send",
    group: "Privacy",
    label: "Files that never leave this machine",
    type: "list",
    help: "Glob patterns, one per line, such as **/.env or secrets/**.",
  },
  {
    key: "checks.commands",
    group: "Checks and worktrees",
    label: "Checks after every edit",
    type: "list",
    help: "Commands, one per line, such as npm test.",
  },
  { key: "checks.timeout_seconds", group: "Checks and worktrees", label: "Check time limit, seconds", type: "int", min: 1 },
  {
    key: "worktrees.setup",
    group: "Checks and worktrees",
    label: "Prepare each new worktree with",
    type: "list",
    help: "Commands, one per line, such as npm ci.",
  },
  { key: "worktrees.timeout_seconds", group: "Checks and worktrees", label: "Worktree setup time limit, seconds", type: "int", min: 1 },
  {
    key: "telemetry.events_file",
    group: "Integrations",
    label: "Write delegation events to (JSON lines)",
    type: "string",
    nullable: true,
    help: "For other tools, such as Ghostex. Empty: off.",
  },
  { key: "lsp.enabled", group: "Integrations", label: "Give delegates code navigation through language servers", type: "bool" },
  ...PROVIDERS.flatMap((p): Spec[] => [
    { key: `backends.${p}.executable`, group: "Backend commands", label: `${NAMES[p]} command`, type: "string" },
    {
      key: `backends.${p}.extra_args`,
      group: "Backend commands",
      label: `${NAMES[p]} extra arguments`,
      type: "list",
      help: "One per line, passed on every run.",
    },
  ]),
  {
    key: "backends.claude.lean_tools",
    group: "Backend commands",
    label: "Claude loads only the tools the harness uses (saves about 14k tokens a request)",
    type: "bool",
  },
]

const at = (config: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], config)

export function readAdvanced(workspace: string): AdvancedField[] {
  const { config } = loadConfig(workspace, null)
  return ADVANCED.map((f) => ({ ...f, value: at(config, f.key) as AdvancedField["value"] }))
}

/** Check one value against its field; returns the value to store. */
export function coerce(f: Spec, value: unknown): unknown {
  if (f.nullable && (value === null || value === "")) return null
  switch (f.type) {
    case "bool":
      if (typeof value !== "boolean") throw new Error(`${f.label}: on or off`)
      return value
    case "int":
    case "number": {
      const n = Number(value)
      if (!Number.isFinite(n) || (f.type === "int" && !Number.isInteger(n)))
        throw new Error(`${f.label}: not a ${f.type === "int" ? "whole " : ""}number`)
      if (f.min !== undefined && n < f.min) throw new Error(`${f.label}: at least ${f.min}`)
      if (f.max !== undefined && n > f.max) throw new Error(`${f.label}: at most ${f.max}`)
      return n
    }
    case "list":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error(`${f.label}: a list of text`)
      return value.map((v) => v.trim()).filter(Boolean)
    default: {
      const s = String(value ?? "").trim()
      if (!s && !f.nullable) throw new Error(`${f.label}: needed`)
      return s
    }
  }
}

export function saveAdvanced(workspace: string, scope: SettingsScope, values: Record<string, unknown>, opts: LayerWrite = {}): LayerResult {
  const count = Object.keys(values).length
  return editLayer(
    workspace,
    scope,
    (_doc, inherited: RoutingConfig, { set }) => {
      for (const [key, raw] of Object.entries(values)) {
        const f = ADVANCED.find((x) => x.key === key)
        if (!f) throw new Error(`Unknown setting ${key}`)
        set(key.split("."), coerce(f, raw), at(inherited, key))
      }
    },
    { ...opts, what: `Advanced: ${count} setting${count === 1 ? "" : "s"}` },
  )
}
