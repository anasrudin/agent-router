import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import type { BackendEvent } from "../backends/events"
import type { ProviderId, Tier } from "../config/schema"
import type { Tokens } from "./delegate"

/**
 * One line of `telemetry.events_file`: a delegation seen as a pane, for UIs that show agents side by
 * side (Ghostex and the like). dispatch opens the pane, update refreshes its badges, merge closes it
 * with a usable result, halt closes it without one.
 */
export interface PaneEvent {
  ts: string
  event: "dispatch" | "update" | "merge" | "halt"
  pane: {
    id: string
    task_class: string
    agent: string
    mode: string
    provider: ProviderId
    tier: Tier
    model?: string
    worktree?: string
    status: "running" | "retrying" | "done" | "partial" | "blocked" | "error"
    /** At most 12 words, for a pane header. */
    task_summary: string
    /** The brief's relevant files, `path:start-end` where it gave ranges. */
    context_refs: string[]
  }
  /** `cached_tokens` is the part of `input_tokens` served from the prompt cache. */
  budget: { input_tokens: number; cached_tokens: number; output_tokens: number; cost_usd: number; cap_tokens: number | null }
  /** Why a pane is retrying or halted, or the stop reason on merge. */
  detail?: string
}

export function taskSummary(task: string, words = 12): string {
  const all = task.trim().split(/\s+/)
  return all.length <= words ? all.join(" ") : `${all.slice(0, words).join(" ")}…`
}

type PaneInfo = PaneEvent["pane"]

/** Appends pane events for one delegation. Writing is best-effort: telemetry never fails a delegation. */
export class PaneTelemetry {
  private readonly tokens: Tokens = { input: 0, output: 0 }
  private costUsd = 0

  constructor(
    private readonly file: string | undefined,
    private readonly pane: PaneInfo,
    private readonly capTokens: number | null,
  ) {
    if (file) this.emit("dispatch")
  }

  /** Usage refreshes the badges; an error means this attempt failed and the ladder may try again. */
  observe(provider: ProviderId, event: BackendEvent): void {
    if (!this.file) return
    if (event.type === "usage") {
      this.tokens.input += event.usage.inputTokens
      this.tokens.output += event.usage.outputTokens
      this.tokens.cached = (this.tokens.cached ?? 0) + (event.usage.cachedInputTokens ?? 0)
      this.costUsd += event.usage.costUsd ?? 0
      this.emit("update", { provider, status: "running" })
    } else if (event.type === "error" && event.error.kind !== "cancelled") {
      this.emit("update", { provider, status: "retrying" }, event.error.message.slice(0, 300))
    }
  }

  /** Final totals come from the delegation result, which subtracts resumed sessions' earlier usage. */
  finish(result: {
    status: string
    provider: ProviderId
    tier: Tier
    model?: string
    tokens: Tokens
    costUsd: number
    stopReason: string
    worktree?: string
  }): void {
    if (!this.file) return
    Object.assign(this.tokens, { cached: 0 }, result.tokens)
    this.costUsd = result.costUsd
    const usable = result.status === "done" || result.status === "partial" || result.status === "blocked"
    this.emit(
      usable ? "merge" : "halt",
      {
        provider: result.provider,
        tier: result.tier,
        model: result.model,
        worktree: result.worktree,
        status: usable ? (result.status as PaneInfo["status"]) : "error",
      },
      result.stopReason,
    )
  }

  fail(error: string): void {
    if (this.file) this.emit("halt", { status: "error" }, error.slice(0, 300))
  }

  private emit(event: PaneEvent["event"], patch: Partial<PaneInfo> = {}, detail?: string): void {
    Object.assign(this.pane, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)))
    const line: PaneEvent = {
      ts: new Date().toISOString(),
      event,
      pane: { ...this.pane },
      budget: {
        input_tokens: this.tokens.input,
        cached_tokens: this.tokens.cached ?? 0,
        output_tokens: this.tokens.output,
        cost_usd: this.costUsd,
        cap_tokens: this.capTokens,
      },
      ...(detail ? { detail } : {}),
    }
    try {
      mkdirSync(path.dirname(this.file as string), { recursive: true })
      appendFileSync(this.file as string, `${JSON.stringify(line)}\n`)
    } catch {
      // Best-effort, like the ledger.
    }
  }
}

/** `telemetry.events_file` resolved against the workspace, or undefined when telemetry is off. */
export function eventsFile(setting: string | null, workspace: string): string | undefined {
  return setting ? path.resolve(workspace, setting) : undefined
}
