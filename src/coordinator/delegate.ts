import { existsSync } from "node:fs"
import path from "node:path"
import type { BackendEvent } from "../backends/events"
import { isPlaceholderModel, type ProviderId, type Tier } from "../config/schema"
import { agentPromptPath, composeSystemPrompt, PROMPTS_DIR } from "../prompts/render"
import { scopedAgentsMd } from "../prompts/scoped-rules"
import { promptVars } from "../prompts/vars"
import { estimateTokens } from "../router/classify"
import { type Attempt, nextStep } from "../router/escalation"
import { decide, type RouteDecision, type RouteRequest } from "../router/policy"
import { type CheckResult, runConfiguredChecks } from "./checks"
import { type Brief, parseReport, type Report, type RetryNote, renderBrief } from "./protocol"
import type { Session } from "./session"
import { checkReport, type Finding } from "./verify"
import { Watchdog, type WatchdogTrip } from "./watchdog"
import { createWorktree, type Worktree } from "./worktrees"

export interface DelegateRequest {
  taskClass: string
  brief: Brief
  /** Defaults to the route's agent. */
  agent?: string
  route?: Pick<RouteRequest, "override" | "author" | "sticky" | "media" | "inputTokens" | "filesTouched">
  isolation?: "none" | "worktree"
  /** Called once routing has decided, before any backend runs. */
  onStart?: (decision: RouteDecision, agent: string) => void
  onEvent?: (provider: ProviderId, event: BackendEvent) => void
  signal?: AbortSignal
}

export interface AttemptRecord extends Attempt {
  model?: string
  sessionId?: string
}

export interface DelegateResult {
  /** The delegate's own status, or "error" when no attempt produced a usable report. */
  status: Report["status"] | "error"
  report?: Report
  /** Final text from the last attempt, verbatim. */
  text: string
  decision: RouteDecision
  provider: ProviderId
  tier: Tier
  model?: string
  sessionId?: string
  worktree?: Worktree
  attempts: AttemptRecord[]
  stopReason: string
  costUsd: number
  /** Summed over every attempt, as each CLI reported it (Claude counts cache reads as input). */
  tokens: { input: number; output: number }
  /** Structural problems found in the report. Conductor still runs the build and tests itself. */
  findings: Finding[]
  /** Results of `checks.commands` run after an edit-mode delegation; empty when none ran. */
  checks: CheckResult[]
}

export class DelegationError extends Error {
  override name = "DelegationError"
}

function describeFailure(attempt: AttemptRecord, text: string): string {
  if (attempt.outcome === "backend_error") return `${attempt.errorKind}: ${attempt.message}`
  return `Your report was rejected: ${attempt.message}\n\nReport received:\n${text.slice(0, 4000)}`
}

/** Run one subtask through routing, the backend, and the escalation ladder (conductor.md §2 steps 3–5). */
export async function delegate(session: Session, req: DelegateRequest): Promise<DelegateResult> {
  const brief = req.brief
  const decision = decide(session, {
    ...req.route,
    taskClass: req.taskClass,
    files: brief.relevant_files.map((f) => f.replace(/:[\d-]+$/, "")),
    taskText: `${brief.task}\n${brief.why}`,
    inputTokens: req.route?.inputTokens ?? estimateTokens(renderBrief(brief, session.workspace).length),
  })
  const agent = req.agent ?? decision.agent
  if (agent === "conductor") {
    throw new DelegationError(`${req.taskClass} is Conductor's own work (conductor.md §3); do it yourself rather than delegating.`)
  }
  if (!existsSync(path.join(PROMPTS_DIR, agentPromptPath(agent)))) throw new DelegationError(`Unknown agent "${agent}"`)

  const writer = brief.mode === "edit"
  let worktree: Worktree | undefined
  if (writer && req.isolation === "worktree") worktree = createWorktree(session.workspace, `${agent}-${req.taskClass}`)
  if (writer && !worktree && session.config.limits.parallel_writers_need_worktree && session.activeWritersInWorkspace > 0) {
    throw new DelegationError(
      'Another edit-mode delegate is already writing in the workspace. Parallel writers need isolation: "worktree" (conductor.md §6).',
    )
  }
  const cwd = worktree?.path ?? session.workspace
  if (writer && !worktree) session.activeWritersInWorkspace += 1
  req.onStart?.(decision, agent)

  try {
    return await session.slots.run(() => runLadder(session, req, decision, agent, cwd, worktree))
  } finally {
    if (writer && !worktree) session.activeWritersInWorkspace -= 1
  }
}

async function runLadder(
  session: Session,
  req: DelegateRequest,
  decision: RouteDecision,
  agent: string,
  cwd: string,
  worktree: Worktree | undefined,
): Promise<DelegateResult> {
  const attempts: AttemptRecord[] = []
  const retryNotes: RetryNote[] = []
  let provider = decision.provider
  let tier = decision.tier
  let resumeSessionId = decision.resumeSessionId
  let costUsd = 0
  const tokens = { input: 0, output: 0 }
  let text = ""
  let report: Report | undefined
  let stopReason = ""
  const timeoutMs = session.config.limits.delegate_timeout_seconds * 1000
  const directoryRules = scopedAgentsMd(session.workspace, req.brief.relevant_files)

  for (;;) {
    const rawModel = session.config.backends[provider].tiers[tier]
    const model = isPlaceholderModel(rawModel) ? undefined : rawModel
    const backend = session.backends[provider]
    const system = composeSystemPrompt(agentPromptPath(agent), promptVars(session, model))
    const attempt: AttemptRecord = { provider, tier, model, outcome: "ok" }
    text = ""
    report = undefined

    // The watchdog aborts only this attempt; the caller's signal still cancels the whole delegation.
    const attemptAbort = new AbortController()
    const onCancel = () => attemptAbort.abort()
    req.signal?.addEventListener("abort", onCancel, { once: true })
    if (req.signal?.aborted) attemptAbort.abort()
    let trip: WatchdogTrip | undefined
    // Queue for this backend's slot first, so time spent waiting never counts as a stall.
    await session.providerSlot(provider).run(async () => {
      const watchdog = new Watchdog({
        stallMs: session.config.limits.delegate_stall_seconds * 1000,
        maxIdenticalToolCalls: session.config.limits.max_identical_tool_calls,
        onTrip: (t) => {
          trip = t
          attemptAbort.abort()
        },
      })

      try {
        for await (const event of backend.run({
          prompt: renderBrief(req.brief, cwd, retryNotes, directoryRules),
          systemPrompt: system.text,
          model,
          reasoning: session.config.backends[provider].reasoning[tier],
          cwd,
          mode: req.brief.mode,
          permission: session.permission,
          resumeSessionId: backend.supportsResume ? resumeSessionId : undefined,
          timeoutMs,
          signal: attemptAbort.signal,
          reportGate: true,
          allowedCommands: session.config.checks.commands,
        })) {
          watchdog.observe(event)
          req.onEvent?.(provider, event)
          if (event.type === "session") attempt.sessionId = event.sessionId
          else if (event.type === "usage") {
            costUsd += event.usage.costUsd ?? 0
            tokens.input += event.usage.inputTokens
            tokens.output += event.usage.outputTokens
          } else if (event.type === "done") text = event.text
          else if (event.type === "error") {
            attempt.outcome = "backend_error"
            attempt.errorKind = event.error.kind
            attempt.message = event.error.message
          }
        }
      } finally {
        watchdog.stop()
        req.signal?.removeEventListener("abort", onCancel)
      }
    })
    // The CLI reports the watchdog's abort as "cancelled"; record why it was really stopped.
    if (trip && !req.signal?.aborted) {
      attempt.outcome = "backend_error"
      attempt.errorKind = trip.kind
      attempt.message = `${provider} ${trip.message}; stopped by the harness watchdog`
    }

    if (attempt.outcome === "ok") {
      report = parseReport(text)
      if (!report.wellFormed) {
        attempt.outcome = "report_failed"
        attempt.message = "not in delegation-protocol §2 format (needs ## Status and ## Result)"
      } else if (report.status === "failed") {
        attempt.outcome = "report_failed"
        attempt.message = `delegate reported failed: ${report.result.slice(0, 500)}`
      } else if (report.status === "blocked") {
        attempt.outcome = "blocked"
      }
    }
    if (attempt.outcome === "backend_error") session.health.recordError(provider, attempt.errorKind ?? "failed", attempt.message ?? "")
    else session.health.recordSuccess(provider)
    attempts.push(attempt)

    const step = nextStep({
      history: attempts,
      candidates: decision.candidates,
      pinned: decision.pinned,
      maxAttempts: session.config.escalation.max_attempts_per_subtask,
    })
    if (step.action === "stop") {
      stopReason = step.reason
      break
    }
    // A malformed or failed report is cheapest to fix in the same session; anything else starts clean.
    resumeSessionId = step.action === "retry" && attempt.outcome === "report_failed" ? attempt.sessionId : undefined
    retryNotes.push({ attempt: attempts.length, provider, problem: describeFailure(attempt, text) })
    provider = step.provider
    tier = step.tier
  }
  session.addCost(costUsd)

  const last = attempts.at(-1) as AttemptRecord
  const usable = last.outcome === "ok" || last.outcome === "blocked"
  const findings = usable && report ? checkReport(report, req.brief) : []
  let checks: CheckResult[] = []
  if (usable && req.brief.mode === "edit" && (report?.status === "done" || report?.status === "partial")) {
    const ran = await runConfiguredChecks(
      session.config.checks.commands,
      cwd,
      session.permission,
      session.config.checks.timeout_seconds * 1000,
      req.signal,
    )
    checks = ran.results
    findings.push(...ran.findings)
  }
  return {
    status: usable ? report?.status : "error",
    report: usable ? report : undefined,
    text,
    decision,
    provider: last.provider,
    tier: last.tier,
    model: last.model,
    sessionId: last.sessionId,
    worktree,
    attempts,
    stopReason,
    costUsd,
    tokens,
    findings,
    checks,
  }
}
