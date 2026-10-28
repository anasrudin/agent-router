import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import type { McpServerSpec } from "../backends/Backend"
import type { BackendEvent } from "../backends/events"
import { isPlaceholderModel, type ProviderId, type Tier } from "../config/schema"
import { LSP_MCP_NAME } from "../lsp/mcp"
import { installedServers } from "../lsp/servers"
import { agentPromptPath, composeSystemPrompt, PROMPTS_DIR } from "../prompts/render"
import { scopedRules } from "../prompts/scoped-rules"
import { promptVars } from "../prompts/vars"
import { estimateTokens } from "../router/classify"
import { type Attempt, nextStep } from "../router/escalation"
import { decide, type RouteDecision, type RouteRequest } from "../router/policy"
import { SELF_ENTRY } from "../self"
import { type CheckResult, runConfiguredChecks } from "./checks"
import { checkEvidence, keepsEvidence, prepareEvidenceDir } from "./evidence"
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
  /** Running total last reported for the session in `route.sticky`, when its backend reports totals (from the ledger). */
  priorSessionTokens?: Tokens
}

export type Tokens = { input: number; output: number }

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
  /** Summed over every attempt, this delegation's own share (Claude counts cache reads as input). */
  tokens: Tokens
  /** The last session's running total, for backends that report one (Codex); the ledger keeps it for a later resume. */
  sessionTokens?: Tokens
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

/**
 * The code-navigation MCP server for a delegate working in `cwd`, when a language server for the
 * project is installed. It runs this same program (`agent-router lsp-mcp`).
 */
export function lspServerSpec(session: Session, cwd: string): McpServerSpec | undefined {
  if (!session.config.lsp.enabled) return undefined
  const servers = installedServers(session.workspace, session.config.lsp.servers)
  if (!servers.length) return undefined
  const languages = [...new Set(servers.flatMap((s) => s.extensions))].join(" ")
  return {
    name: LSP_MCP_NAME,
    command: SELF_ENTRY.runtime,
    // A worktree has no node_modules of its own: servers are found where detection found them.
    args: [...(SELF_ENTRY.script ? [SELF_ENTRY.script] : []), "lsp-mcp", "--workspace", cwd, "--tools-root", session.workspace],
    note: `You have code-navigation tools from a language server (MCP server "${LSP_MCP_NAME}") for ${languages} files: diagnostics (type errors in a file), definition, references (line and column are 1-based) and symbols (a file's outline). Prefer them to grep for finding where something is defined or used, and run diagnostics on each file you edit before reporting.`,
  }
}

/** Sent into a stopped delegate's own session (same backend, same tier) instead of starting over. */
export function nudgeMessage(trip: WatchdogTrip, stallSeconds: number): string {
  const why =
    trip.kind === "stalled"
      ? `The harness stopped your last step: there was no output for ${stallSeconds} s. A command was most likely waiting for input, or never finishing. Do not run it again the same way: add non-interactive flags or a timeout, or do without it.`
      : `The harness stopped you: you ${trip.message}. Repeating it will not give a different result. Change your approach.`
  return `${why}\n\nContinue the task from where you are; your earlier work in this session still counts. When you are done, or cannot go further, reply with the report in the required format (## Status, ## Result, ## Changes, ## Evidence, ## Confidence, ## Open questions / risks).`
}

/** `git status --porcelain` lines, or none if this is not a repository (or git is slow or missing). */
function gitChanges(cwd: string): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain"], { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      resolve(new Set(error ? [] : stdout.split("\n").filter((l) => l.trim() && !l.includes(".harness/")))),
    )
  })
}

async function changedSince(cwd: string, before: Promise<Set<string>>): Promise<string[]> {
  const [then, now] = await Promise.all([before, gitChanges(cwd)])
  return [...now].filter((line) => !then.has(line))
}

/** What a fresh session needs after the previous one filled its context mid-task. */
function contextRestartNote(changed: string[], toolCalls: number): string {
  const files = changed.length
    ? `Files changed in the working tree during this task (keep this work; check it rather than redoing it):\n${changed.slice(0, 50).join("\n")}`
    : "No files were changed yet."
  return `The previous session ran out of context window after ${toolCalls} tool calls, so this is a fresh session on the same backend. ${files}\n\nRead only the parts of files you need (line ranges, grep), not whole large files.`
}

/**
 * Add one attempt's usage. With `totals` (a backend that reports running totals), a resumed session's
 * earlier total is subtracted, so a resume counts only what it added; an unknown earlier total
 * counts the whole report, which overstates rather than hides spend.
 */
export function addAttemptTokens(
  tokens: Tokens,
  reported: Tokens,
  totals: Map<string, Tokens> | undefined,
  resumed: string | undefined,
  sessionId: string | undefined,
): void {
  const before = resumed ? totals?.get(resumed) : undefined
  tokens.input += Math.max(0, reported.input - (before?.input ?? 0))
  tokens.output += Math.max(0, reported.output - (before?.output ?? 0))
  if (totals && sessionId && (reported.input || reported.output)) totals.set(sessionId, reported)
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
  const tokens: Tokens = { input: 0, output: 0 }
  // Running totals per session, for backends whose usage includes earlier runs of a resumed session.
  const sessionTotals = new Map<string, Tokens>()
  if (resumeSessionId && req.priorSessionTokens) sessionTotals.set(resumeSessionId, req.priorSessionTokens)
  let text = ""
  let report: Report | undefined
  let stopReason = ""
  const timeoutMs = session.config.limits.delegate_timeout_seconds * 1000
  const maxAttempts = session.config.escalation.max_attempts_per_subtask
  // Set for one attempt when it continues the previous session with a short message instead of the brief.
  let followUp: string | undefined
  let nudged = false
  let restarted = false
  const startedAt = Date.now()
  // What was already uncommitted, so a restarted delegate is not told the user's own edits are its work.
  const before = gitChanges(cwd)
  const lsp = lspServerSpec(session, cwd)
  if (req.brief.mode !== "read-only") {
    try {
      prepareEvidenceDir(cwd)
    } catch {
      // A read-only checkout: the delegate cannot save receipts either, and checkEvidence says so.
    }
  }

  for (;;) {
    const rawModel = session.config.backends[provider].tiers[tier]
    const model = isPlaceholderModel(rawModel) ? undefined : rawModel
    const backend = session.backends[provider]
    const system = composeSystemPrompt(agentPromptPath(agent), promptVars(session, model))
    const attempt: AttemptRecord = { provider, tier, model, outcome: "ok" }
    const resumed = backend.supportsResume ? resumeSessionId : undefined
    const reported: Tokens = { input: 0, output: 0 }
    let toolCalls = 0
    const prompt =
      followUp ??
      renderBrief(
        req.brief,
        cwd,
        retryNotes,
        scopedRules(session.workspace, req.brief.relevant_files, provider),
        keepsEvidence(req.brief.mode, provider),
      )
    followUp = undefined
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
        const events = backend.run({
          prompt,
          systemPrompt: system.text,
          model,
          reasoning: session.config.backends[provider].reasoning[tier],
          cwd,
          mode: req.brief.mode,
          permission: session.permission,
          resumeSessionId: resumed,
          timeoutMs,
          signal: attemptAbort.signal,
          reportGate: true,
          allowedCommands: session.config.checks.commands,
          mcpServers: lsp ? [lsp] : [],
        })
        for await (const event of events) {
          watchdog.observe(event)
          req.onEvent?.(provider, event)
          if (event.type === "session") attempt.sessionId = event.sessionId
          else if (event.type === "tool_call") toolCalls += 1
          else if (event.type === "usage") {
            costUsd += event.usage.costUsd ?? 0
            reported.input += event.usage.inputTokens
            reported.output += event.usage.outputTokens
          } else if (event.type === "done") text = event.text
          else if (event.type === "error") {
            attempt.outcome = "backend_error"
            attempt.errorKind = event.error.kind
            attempt.message = event.error.message
          }
        }
      } catch (error) {
        // An adapter that throws (bad arguments, a broken parser) is a failed attempt the ladder can move past.
        attempt.outcome = "backend_error"
        attempt.errorKind = "failed"
        attempt.message = `${provider} adapter error: ${(error as Error).message}`
      } finally {
        watchdog.stop()
        req.signal?.removeEventListener("abort", onCancel)
      }
    })
    addAttemptTokens(tokens, reported, backend.cumulativeUsage ? sessionTotals : undefined, resumed, attempt.sessionId)
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

    // Before the ladder: two failures where the delegate's own work is worth keeping.
    // Never on the last attempt but one: like the ladder, keep a rung for another backend.
    const canContinue = !req.signal?.aborted && attempts.length + 1 < maxAttempts
    if (canContinue && !nudged && attempt.sessionId && backend.supportsResume && (trip?.kind === "stalled" || trip?.kind === "tool_loop")) {
      // A stalled delegate usually sits on a command waiting for input; its session still holds its progress.
      nudged = true
      resumeSessionId = attempt.sessionId
      followUp = nudgeMessage(trip, session.config.limits.delegate_stall_seconds)
      continue
    }
    if (canContinue && !restarted && attempt.errorKind === "context_overflow" && toolCalls > 0) {
      // It filled its context while working, so the brief fits: a fresh session on the same backend
      // can carry on from the files it already changed. A brief too large to start with goes up the ladder.
      restarted = true
      resumeSessionId = undefined
      retryNotes.push({ attempt: attempts.length, provider, problem: contextRestartNote(await changedSince(cwd, before), toolCalls) })
      continue
    }

    const step = nextStep({
      history: attempts,
      candidates: decision.candidates,
      pinned: decision.pinned,
      maxAttempts,
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
  const findings =
    usable && report
      ? [...checkReport(report, req.brief), ...checkEvidence(report, cwd, req.brief.mode, attempts.at(-1)?.provider ?? provider, startedAt)]
      : []
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
    sessionTokens: last.sessionId ? sessionTotals.get(last.sessionId) : undefined,
    findings,
    checks,
  }
}
