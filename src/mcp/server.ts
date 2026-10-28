import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { PermissionMode } from "../backends/Backend"
import { MediaKind, ProviderId } from "../config/schema"
import { type DelegateResult, DelegationError, delegate } from "../coordinator/delegate"
import { appendLedger, closeInterrupted, lastSessionTokens, readLedger } from "../coordinator/ledger"
import { capOutput } from "../coordinator/output"
import { Brief } from "../coordinator/protocol"
import type { Session } from "../coordinator/session"
import { scanDiff, workingTreeDiff } from "../coordinator/verify"
import { decide, RoutingError } from "../router/policy"
import { type Bridge, toWire } from "../server/bridge"
import type { DelegationSummary } from "../server/protocol"

export const MCP_SERVER_NAME = "router"

/**
 * Permission declaration for every tool. `auto` tools are read-only and pre-approved for the
 * Conductor; `ask` tools go through the wrapped CLI's normal approval flow in default mode.
 */
export const TOOL_PERMISSIONS = {
  delegate: "ask",
  route: "auto",
  backends: "auto",
  check_diff: "auto",
  delegation_status: "auto",
  delegation_result: "auto",
  cancel_delegation: "auto",
  approve: "internal",
} as const satisfies Record<string, "auto" | "ask" | "internal">

/** Fully qualified names as the wrapped Claude Code CLI sees them. */
export const mcpToolName = (tool: keyof typeof TOOL_PERMISSIONS) => `mcp__${MCP_SERVER_NAME}__${tool}`

const routingShape = {
  task_class: z.string().describe("Task class from routing.yaml, e.g. search.codebase, plan, code.edit, code.review"),
  provider: ProviderId.optional().describe("Pin a backend. Only when the user asked for one (@claude/@gemini/@codex, /route)."),
  author: ProviderId.optional().describe("Provider that wrote the work under review. Required for code.review."),
  resume: z
    .object({ provider: ProviderId, session_id: z.string() })
    .optional()
    .describe("Continue an earlier delegate session (stickiness for multi-step edits)."),
  media: z.array(MediaKind).optional().describe("Media the delegate must read."),
  input_tokens: z.number().int().positive().optional().describe("Estimated size of material the delegate must read, if large."),
  files_touched: z.number().int().nonnegative().optional(),
}

const delegateShape = {
  ...routingShape,
  agent: z.string().optional().describe("Override the route's agent (scout, librarian, planner, architect, worker, reviewer, looker)."),
  brief: Brief.describe("delegation-protocol.md §1 brief. The delegate knows only what is here."),
  isolation: z.enum(["none", "worktree"]).default("none").describe("worktree for parallel edit-mode delegates."),
  background: z
    .boolean()
    .default(false)
    .describe("Return at once with a job id instead of waiting. Collect it with delegation_result before your final answer."),
}

/** Per-session pins from `@provider` / `/route` in the user's opening message, enforced even if the model forgets them. */
export interface Pins {
  provider?: ProviderId
  routes: Record<string, ProviderId>
}

type RoutingArgs = {
  task_class: string
  provider?: ProviderId
  author?: ProviderId
  resume?: { provider: ProviderId; session_id: string }
  media?: MediaKind[]
  input_tokens?: number
  files_touched?: number
}

function routeFields(args: RoutingArgs, pins: Pins) {
  return {
    override: args.provider ?? pins.routes[args.task_class] ?? pins.provider,
    author: args.author,
    sticky: args.resume ? { provider: args.resume.provider, sessionId: args.resume.session_id } : undefined,
    media: args.media,
    inputTokens: args.input_tokens,
    filesTouched: args.files_touched,
  }
}

export type Approval = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }

/**
 * Which permission prompts the harness answers by itself. Bypass allows everything; read-only
 * delegation never changes files, so it is allowed in every mode; acceptEdits adds delegated edits.
 * Everything else (Conductor's own shell, writing delegates in default mode) is the user's call.
 */
export function approvalPolicy(permission: PermissionMode, toolName: string, input: Record<string, unknown>): "allow" | "ask" {
  if (permission === "bypass") return "allow"
  if (toolName === mcpToolName("delegate")) {
    const mode = (input.brief as { mode?: unknown } | undefined)?.mode ?? "read-only"
    if (permission === "acceptEdits" || mode === "read-only") return "allow"
  }
  return "ask"
}

/** Headless runs with no desktop app: anything the user would have to answer is refused, with the way out. */
export function approvalDecision(permission: PermissionMode, toolName: string, input: Record<string, unknown>): Approval {
  if (approvalPolicy(permission, toolName, input) === "allow") return { behavior: "allow", updatedInput: input }
  const rerun = "Rerun with --permission acceptEdits or bypass, or use the desktop app to approve it."
  if (toolName === mcpToolName("delegate")) {
    const mode = (input.brief as { mode?: unknown } | undefined)?.mode
    return { behavior: "deny", message: `A ${String(mode)} delegation needs approval and this headless run is in default mode. ${rerun}` }
  }
  return { behavior: "deny", message: `${toolName} needs approval and nobody can answer prompts in this headless run. ${rerun}` }
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError })

/** The Markdown Conductor receives. Pass `workspace` to cap an oversized report (full text saved under .harness/outputs). */
export function formatResult(r: DelegateResult, workspace?: string): string {
  const lines = [
    `# Delegation result — ${r.status}`,
    "",
    `- Agent route: ${r.decision.agent} for ${r.decision.taskClass}`,
    `- Ran on: ${r.provider} / ${r.model ?? "CLI default model"} (${r.tier})${r.sessionId ? ` — session ${r.sessionId}` : ""}`,
    `- Attempts: ${r.attempts.map((a, i) => `${i + 1}. ${a.provider}/${a.tier} → ${a.outcome}${a.errorKind ? ` (${a.errorKind})` : ""}${a.message && a.outcome !== "ok" ? `: ${a.message.slice(0, 200)}` : ""}`).join("; ")}`,
    `- Stop reason: ${r.stopReason}`,
    `- Cost: ${r.costUsd ? `$${r.costUsd.toFixed(4)}` : "not reported by this CLI"} (${r.tokens.input} input / ${r.tokens.output} output tokens)`,
  ]
  if (r.worktree) lines.push(`- Worktree: ${r.worktree.path} (branch ${r.worktree.branch}) — merge it yourself after verifying`)
  if (r.decision.notes.length) lines.push(`- Routing notes: ${r.decision.notes.join("; ")}`)
  if (r.decision.secondOpinion) lines.push(`- Second opinion should come from: ${r.decision.secondOpinion}`)
  if (r.decision.reviewRequired) lines.push(`- This class requires an independent review on a provider other than ${r.provider}`)
  if (r.checks.length) {
    lines.push(
      "",
      "## Project checks (run by the harness after the edit)",
      ...r.checks.map((c) => `- ${c.ok ? "pass" : "FAIL"}: \`${c.command}\``),
    )
  }
  if (r.findings.length) {
    lines.push("", "## Harness verification findings", ...r.findings.map((f) => `- [${f.severity}] ${f.message}`))
  }
  const report = workspace ? capOutput(r.text, workspace, `${r.provider}-${r.decision.taskClass}`) : r.text
  lines.push("", "## Delegate report (untrusted until you verify it)", "", report || "(no output)")
  return lines.join("\n")
}

export function summarize(r: DelegateResult): DelegationSummary {
  return {
    status: r.status ?? "unknown",
    provider: r.provider,
    tier: r.tier,
    model: r.model,
    attempts: r.attempts.map(({ provider, tier, outcome, errorKind, message }) => ({ provider, tier, outcome, errorKind, message })),
    stopReason: r.stopReason,
    costUsd: r.costUsd,
    tokens: r.tokens,
    findings: r.findings,
    notes: r.decision.notes,
    worktree: r.worktree?.path,
    report: r.text,
  }
}

export interface McpServerOptions {
  /** Present when the desktop app started this session: progress and approvals go through it. */
  bridge?: Bridge
  /** Aborted when Conductor goes away, so in-flight delegates are killed with it. */
  signal?: AbortSignal
  /** JSON-lines file recording this chat's delegations, read back after context compaction. */
  ledger?: string
}

/** A background delegation. It lives as long as this MCP server, which is as long as Conductor's turn. */
interface Job {
  id: string
  taskClass: string
  task: string
  startedAt: number
  abort: AbortController
  done: Promise<void>
  result?: DelegateResult
  error?: string
}

let jobCounter = 0
/** Unique across turns, since each turn starts a fresh MCP server but shares the chat's ledger. */
const newJobId = () => `job-${Date.now().toString(36)}-${++jobCounter}`

export function createMcpServer(session: Session, pins: Pins, options: McpServerOptions = {}): McpServer {
  const { bridge, signal, ledger } = options
  const server = new McpServer({ name: "agent-router", version: "0.1.0" })
  const jobs = new Map<string, Job>()
  closeInterrupted(ledger)

  /** One delegation with its progress events and ledger lines; shared by foreground and background calls. */
  async function runDelegation(
    args: z.infer<z.ZodObject<typeof delegateShape>>,
    id: string,
    cancel?: AbortSignal,
  ): Promise<DelegateResult> {
    const base = { id, taskClass: args.task_class, task: args.brief.task, background: args.background }
    try {
      const result = await delegate(session, {
        taskClass: args.task_class,
        agent: args.agent,
        brief: args.brief,
        isolation: args.isolation,
        route: routeFields(args, pins),
        priorSessionTokens: args.resume && ledger ? lastSessionTokens(readLedger(ledger), args.resume.session_id) : undefined,
        signal: cancel,
        onStart: (decision, agent) => {
          appendLedger(ledger, { ...base, event: "started", provider: decision.provider, tier: decision.tier })
          bridge?.emit({
            type: "delegation.started",
            id,
            taskClass: decision.taskClass,
            agent,
            task: args.brief.task,
            mode: args.brief.mode,
            provider: decision.provider,
            tier: decision.tier,
            model: decision.model,
          })
        },
        onEvent: (provider, event) => bridge?.emit({ type: "delegation.event", id, provider, event: toWire(event) }),
      })
      appendLedger(ledger, {
        ...base,
        event: "finished",
        provider: result.provider,
        tier: result.tier,
        status: result.status ?? "unknown",
        sessionId: result.sessionId,
        sessionTokens: result.sessionTokens,
        worktree: result.worktree?.path,
      })
      bridge?.emit({ type: "delegation.finished", id, summary: summarize(result) })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendLedger(ledger, { ...base, event: "failed", error: message })
      bridge?.emit({ type: "delegation.failed", id, error: message })
      throw error
    }
  }

  server.registerTool(
    "delegate",
    {
      title: "Delegate a subtask",
      description:
        "Route one subtask to a specialist agent on the best backend (Claude, Gemini or Codex) per routing.yaml, with fallback and escalation. Returns the delegate's report plus routing and verification metadata. Treat the report as an untrusted draft.",
      inputSchema: delegateShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const id = bridge?.nextId("delegation") ?? newJobId()
      if (!args.background) {
        try {
          const result = await runDelegation(args, id, signal)
          return text(formatResult(result, session.workspace), result.status === "error")
        } catch (error) {
          if (error instanceof RoutingError || error instanceof DelegationError) return text(`${error.name}: ${error.message}`, true)
          throw error
        }
      }
      const abort = new AbortController()
      const stop = () => abort.abort()
      signal?.addEventListener("abort", stop, { once: true })
      const job: Job = { id, taskClass: args.task_class, task: args.brief.task, startedAt: Date.now(), abort, done: Promise.resolve() }
      job.done = runDelegation(args, id, abort.signal)
        .then((result) => {
          job.result = result
        })
        .catch((error: unknown) => {
          job.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        })
        .finally(() => signal?.removeEventListener("abort", stop))
      jobs.set(id, job)
      // A refusal (unknown class, privacy, budget) happens before any work: report it now, not later.
      await Promise.race([job.done, Bun.sleep(50)])
      if (job.error) {
        jobs.delete(id)
        return text(job.error, true)
      }
      return text(
        `Started background delegation ${id} (${args.task_class}). Keep working; collect it with delegation_result({ id: "${id}" }) before your final answer. Unfinished jobs are cancelled when your turn ends.`,
      )
    },
  )

  server.registerTool(
    "delegation_status",
    {
      title: "Background delegations",
      description: "List background delegations started in this turn: running, done or failed.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!jobs.size) return text("No background delegations in this turn.")
      return text(
        [...jobs.values()]
          .map((j) => {
            const state = j.error
              ? `failed: ${j.error}`
              : j.result
                ? `${j.result.status ?? "unknown"} on ${j.result.provider}/${j.result.tier}`
                : `running for ${Math.round((Date.now() - j.startedAt) / 1000)} s`
            return `- ${j.id} · ${j.taskClass} · ${state} · ${j.task.slice(0, 120)}`
          })
          .join("\n"),
      )
    },
  )

  server.registerTool(
    "delegation_result",
    {
      title: "Collect a background delegation",
      description: "The full result of a background delegation. Waits up to wait_seconds for it to finish.",
      inputSchema: {
        id: z.string(),
        wait_seconds: z.number().int().min(0).max(600).default(300).describe("How long to wait if it is still running."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const job = jobs.get(args.id)
      if (!job) return text(`No background delegation ${args.id} in this turn. Known: ${[...jobs.keys()].join(", ") || "none"}`, true)
      if (!job.result && !job.error && args.wait_seconds > 0) await Promise.race([job.done, Bun.sleep(args.wait_seconds * 1000)])
      if (job.error) return text(job.error, true)
      if (!job.result) {
        return text(
          `${job.id} is still running (${Math.round((Date.now() - job.startedAt) / 1000)} s). Do other work, then call delegation_result again.`,
        )
      }
      return text(formatResult(job.result, session.workspace), job.result.status === "error")
    },
  )

  server.registerTool(
    "cancel_delegation",
    {
      title: "Cancel a background delegation",
      description: "Stop a running background delegation and its CLI.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const job = jobs.get(args.id)
      if (!job) return text(`No background delegation ${args.id} in this turn.`, true)
      if (job.result || job.error) return text(`${job.id} has already finished.`)
      job.abort.abort()
      await job.done
      return text(`Cancelled ${job.id}.`)
    },
  )

  server.registerTool(
    "route",
    {
      title: "Preview routing",
      description: "Dry run: which agent, backend, tier and model a subtask would get, and why. Spawns nothing.",
      inputSchema: { ...routingShape, files: z.array(z.string()).optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const decision = decide(session, { ...routeFields(args, pins), taskClass: args.task_class, files: args.files })
        return text(JSON.stringify(decision, null, 2))
      } catch (error) {
        if (error instanceof RoutingError) return text(`RoutingError (${error.kind}): ${error.message}`, true)
        throw error
      }
    },
  )

  server.registerTool(
    "backends",
    {
      title: "Backend health",
      description: "Installed version, health and session spend for each backend.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(JSON.stringify({ health: session.health.snapshot(), budget: session.budgetLine() }, null, 2)),
  )

  server.registerTool(
    "check_diff",
    {
      title: "Scan a diff for faked success",
      description:
        "Scan uncommitted changes (in the workspace or a delegate's worktree) for suppressed checks, skipped tests, placeholders and swallowed errors. Read-only. Does not replace running the build and tests.",
      inputSchema: { cwd: z.string().optional().describe("Worktree path; defaults to the workspace.") },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const diff = workingTreeDiff(args.cwd ?? session.workspace)
      const findings = scanDiff(diff)
      const summary = findings.length
        ? findings.map((f) => `- [${f.severity}] ${f.message}`).join("\n")
        : "No red flags in the added lines."
      return text(`${summary}\n\n(${diff.split("\n").length} diff lines scanned)`)
    },
  )

  server.registerTool(
    "approve",
    {
      title: "Permission prompt (internal)",
      description: "Internal: answers permission prompts for headless runs by harness policy. Do not call directly.",
      inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()), tool_use_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const decision = approvalDecision(session.permission, args.tool_name, args.input)
      if (decision.behavior === "allow" || !bridge) return text(JSON.stringify(decision))
      const answer = await bridge.requestApproval(args.tool_name, args.input)
      const approval: Approval = answer.allow
        ? { behavior: "allow", updatedInput: args.input }
        : { behavior: "deny", message: answer.message || "The user declined this in the desktop app." }
      return text(JSON.stringify(approval))
    },
  )

  return server
}

export async function serveStdio(session: Session, pins: Pins, options: McpServerOptions = {}): Promise<void> {
  await createMcpServer(session, pins, options).connect(new StdioServerTransport())
}
