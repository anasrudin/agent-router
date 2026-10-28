import { spawn } from "node:child_process"
import type { PermissionMode } from "../backends/Backend"
import { createClaudeParser } from "../backends/claude/parse"
import { tempFile } from "../backends/cli-runner"
import type { BackendEvent } from "../backends/events"
import { buildInvocation, NONINTERACTIVE_ENV, type ProcessExit, resolveExecutable, runProcess } from "../backends/process"
import { createBackends } from "../backends/registry"
import { loadConfig } from "../config/load"
import { isPlaceholderModel, type ProviderId, TIERS, type Tier } from "../config/schema"
import { Session } from "../coordinator/session"
import { mcpToolName, type Pins, TOOL_PERMISSIONS } from "../mcp/server"
import { composeSystemPrompt } from "../prompts/render"
import { promptVars } from "../prompts/vars"
import { selfCommand } from "../self"

export interface SessionInit {
  workspace: string
  permission: PermissionMode
  selfProvider: ProviderId
  /** Routing profile; falls back to `default_profile` in the config. */
  profile?: string
  /** Subscription plan preset, overriding `plan` in the config ("none" turns it off). */
  plan?: string
}

export async function createSession(init: SessionInit): Promise<Session> {
  const { config } = loadConfig(init.workspace, init.profile, undefined, init.plan)
  const session = new Session({ ...init, config, backends: createBackends(config) })
  await session.detectBackends()
  return session
}

/** How the harness's own tools are wired into the conductor. conductor.md is backend-neutral, so this says the concrete names. */
const HARNESS_ADDENDUM = `
---

# This harness: how to delegate

- Delegate with the \`${mcpToolName("delegate")}\` tool. Pass \`task_class\` from §4 and a complete \`brief\` (delegation-protocol §1 as fields). The harness picks the backend, tier and model, applies fallback and escalation, and returns the delegate's report with routing metadata.
- Preview a routing decision without spawning anything with \`${mcpToolName("route")}\`; check backend health with \`${mcpToolName("backends")}\`.
- Before accepting edit-mode work, run the project's build and tests yourself and call \`${mcpToolName("check_diff")}\` (pass the worktree path for isolated delegates).
- For \`code.review\`, always pass \`author\`: the provider that wrote the code. Code you wrote yourself has author \`{{SELF_PROVIDER}}\`.
- For a follow-up step of a multi-step edit, pass \`resume\` with the provider and session id from the previous result (stickiness).
- For parallel edit-mode delegates, pass \`isolation: "worktree"\` and merge the branches yourself.
- To run independent subtasks at the same time, pass \`background: true\`: you get a job id at once. Check progress with \`${mcpToolName("delegation_status")}\`, collect each result with \`${mcpToolName("delegation_result")}\`, and stop one with \`${mcpToolName("cancel_delegation")}\`. Collect every background job before your final answer: unfinished jobs are cancelled when your turn ends.
- If the project configures checks (\`checks.commands\`), the harness runs them after each edit-mode delegation and reports failures as findings. That does not replace your own verification.
- Your built-in subagent tool is disabled on purpose: all delegation goes through the router so routing policy applies.
`

const CLAUDE_PERMISSION: Record<PermissionMode, string> = {
  default: "manual",
  acceptEdits: "acceptEdits",
  bypass: "bypassPermissions",
}

export interface ConductorOptions extends SessionInit {
  prompt?: string
  pins: Pins
  /** The bun/node binary and CLI entry used to start the MCP server child. */
  entry: { runtime: string; script?: string }
  /** Desktop server URL the MCP child reports delegation events and approval prompts to. */
  bridgeUrl?: string
  /** This chat's delegation ledger (JSON lines); restored into Conductor's context after compaction. */
  ledger?: string
}

export function conductorSystemPrompt(session: Session, model: string | undefined): { text: string; missing: string[] } {
  const vars = promptVars(session, model)
  const main = composeSystemPrompt("conductor.md", vars)
  const addendum = HARNESS_ADDENDUM.replaceAll("{{SELF_PROVIDER}}", session.selfProvider)
  return { text: main.text + addendum, missing: main.missing }
}

function pinArgs(pins: Pins): string[] {
  return [
    ...(pins.provider ? ["--pin", pins.provider] : []),
    ...Object.entries(pins.routes).flatMap(([cls, p]) => ["--pin", `${cls}=${p}`]),
  ]
}

export interface PreparedConductor {
  session: Session
  /** Arguments shared by interactive and headless runs. */
  args: string[]
  cleanup: () => void
}

/** Render Conductor's system prompt and MCP wiring. The caller must call `cleanup`. */
export async function prepareConductor(opts: Omit<ConductorOptions, "prompt">): Promise<PreparedConductor> {
  if (opts.selfProvider !== "claude") {
    throw new Error("Conductor currently runs on claude only: the gemini and codex adapters cannot yet attach the router MCP server.")
  }
  const session = await createSession(opts)
  if (!session.health.isHealthy("claude")) throw new Error(`Conductor's backend is unavailable: ${session.backendsStatusLine()}`)
  const { tier, reasoning } = conductorTier(session)
  const rawModel = session.config.backends.claude.tiers[tier]
  const model = isPlaceholderModel(rawModel) ? undefined : rawModel
  const system = conductorSystemPrompt(session, model)
  if (system.missing.length) process.stderr.write(`warning: unfilled prompt variables: ${system.missing.join(", ")}\n`)

  const sys = tempFile("conductor.md", system.text)
  const mcp = tempFile(
    "mcp.json",
    JSON.stringify({
      mcpServers: {
        router: {
          type: "stdio",
          command: opts.entry.runtime,
          args: [
            ...(opts.entry.script ? [opts.entry.script] : []),
            "mcp",
            "--workspace",
            opts.workspace,
            "--permission",
            opts.permission,
            "--self",
            opts.selfProvider,
            ...(session.profile ? ["--profile", session.profile] : []),
            ...(opts.plan ? ["--plan", opts.plan] : []),
            ...pinArgs(opts.pins),
            ...(opts.bridgeUrl ? ["--bridge", opts.bridgeUrl] : []),
            ...(opts.ledger ? ["--ledger", opts.ledger] : []),
          ],
        },
      },
    }),
  )
  // After auto-compaction Conductor would forget delegate session ids, worktrees and running jobs.
  const settings = opts.ledger
    ? tempFile(
        "settings.json",
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: "compact",
                hooks: [
                  { type: "command", command: selfCommand(["hook", "compact-context", "--ledger", opts.ledger], opts.entry), timeout: 30 },
                ],
              },
            ],
          },
        }),
      )
    : undefined
  const autoTools = Object.entries(TOOL_PERMISSIONS)
    .filter(([, p]) => p === "auto")
    .map(([t]) => mcpToolName(t as keyof typeof TOOL_PERMISSIONS))
  const args = [
    "--append-system-prompt-file",
    sys.file,
    "--mcp-config",
    mcp.file,
    ...(settings ? ["--settings", settings.file] : []),
    ...(model ? ["--model", model] : []),
    ...(reasoning ? ["--effort", reasoning] : []),
    "--permission-mode",
    CLAUDE_PERMISSION[opts.permission],
    "--allowedTools",
    ...autoTools,
    "--disallowedTools",
    "Task",
    "Agent",
    ...session.config.backends.claude.extra_args,
  ]
  return {
    session,
    args,
    cleanup: () => {
      sys.cleanup()
      mcp.cleanup()
      settings?.cleanup()
    },
  }
}

/** Conductor's own tier: the profile's choice, else deep (the judgement and verification live here). */
export function conductorTier(session: Session): { tier: Tier; reasoning?: string } {
  const profile = session.profile ? session.config.profiles[session.profile] : undefined
  const wanted = profile?.conductor.tier ?? "deep"
  // A small Claude plan cannot carry Conductor on the top tier: its context is re-read on every step.
  const cap = session.config.conductor_max_tier
  const capped = cap !== undefined && TIERS.indexOf(wanted) > TIERS.indexOf(cap)
  const tier = capped ? cap : wanted
  // The profile's effort was chosen for its own tier; a capped Conductor uses the capped tier's.
  const reasoning = (!capped && profile?.conductor.reasoning) || session.config.backends.claude.reasoning[tier] || undefined
  return { tier, reasoning }
}

/** Start Conductor inside the wrapped Claude Code CLI, with the router's MCP server attached. */
export async function runConductor(opts: ConductorOptions): Promise<number> {
  const prepared = await prepareConductor(opts)
  try {
    if (opts.prompt === undefined) return await interactive(prepared.session, prepared.args, opts.workspace)
    let failed = false
    const exit = await streamConductor(prepared, opts.prompt, {
      onEvent: (event) => {
        if (event.type === "text") process.stdout.write(`${event.text}\n`)
        else if (event.type === "tool_call") process.stderr.write(`· ${event.name}${describeInput(event.input)}\n`)
        else if (event.type === "usage" && event.usage.costUsd)
          process.stderr.write(`· conductor cost $${event.usage.costUsd.toFixed(4)}\n`)
        else if (event.type === "error") {
          failed = true
          process.stderr.write(`error: ${event.error.message}\n`)
        }
      },
    })
    if (exit.code !== 0 && exit.stderr) process.stderr.write(exit.stderr)
    return failed ? 1 : (exit.code ?? 1)
  } finally {
    prepared.cleanup()
  }
}

async function interactive(session: Session, args: string[], cwd: string): Promise<number> {
  const executable = session.config.backends.claude.executable
  const resolved = resolveExecutable(executable)
  if (!resolved) throw new Error(`${executable} not found on PATH`)
  const invocation = buildInvocation(resolved, args)
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.verbatim,
  })
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })
}

export interface StreamOptions {
  onEvent: (event: BackendEvent) => void
  /** Continue an earlier Conductor conversation (multi-turn chat). */
  resumeSessionId?: string
  signal?: AbortSignal
}

/** One headless Conductor turn. Events stream to `onEvent`; resolves when the CLI exits. */
export async function streamConductor(prepared: PreparedConductor, prompt: string, opts: StreamOptions): Promise<ProcessExit> {
  const proc = runProcess({
    command: prepared.session.config.backends.claude.executable,
    // Nobody can answer a prompt in print mode, so the router's approve tool answers (by policy, or via the desktop app).
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompt-tool",
      mcpToolName("approve"),
      ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
      ...prepared.args,
    ],
    cwd: prepared.session.workspace,
    env: NONINTERACTIVE_ENV,
    stdin: prompt,
    signal: opts.signal,
  })
  const parser = createClaudeParser()
  for await (const line of proc.lines) for (const event of parser.line(line)) opts.onEvent(event)
  return await proc.exit
}

export function describeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const i = input as Record<string, unknown>
  const brief = i.brief as Record<string, unknown> | undefined
  const detail = i.task_class ? `${i.task_class}: ${brief?.task ?? ""}` : (i.description ?? i.command ?? i.file_path ?? i.pattern)
  return detail ? ` — ${String(detail).slice(0, 140)}` : ""
}

export { SELF_ENTRY } from "../self"
