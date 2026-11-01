import { spawn } from "node:child_process"
import type { PermissionMode } from "../backends/Backend"
import { killTree, NONINTERACTIVE_ENV } from "../backends/process"
import type { Finding } from "./verify"

export interface CheckResult {
  command: string
  ok: boolean
  /** Exit code, or undefined when the command timed out or could not start. */
  code?: number
  /** The last part of stdout and stderr together. */
  output: string
}

const OUTPUT_TAIL = 2_000

/** Run one shell command in `cwd` and keep the tail of its output. */
export async function runCheck(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  env: Record<string, string> = {},
): Promise<CheckResult> {
  return await new Promise<CheckResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...NONINTERACTIVE_ENV, ...env },
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    let output = ""
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL * 2)
    }
    child.stdout?.on("data", keep)
    child.stderr?.on("data", keep)
    let stopped: string | undefined
    const stop = (why: string) => {
      stopped = why
      void killTree(child, 1_000)
    }
    const timer = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs)
    const onAbort = () => stop("cancelled")
    signal?.addEventListener("abort", onAbort, { once: true })
    const finish = (result: Omit<CheckResult, "command">) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve({ command, ...result, output: result.output.slice(-OUTPUT_TAIL).trim() })
    }
    child.once("error", (error) => finish({ ok: false, output: error.message }))
    child.once("close", (code) =>
      finish(stopped ? { ok: false, output: `${output}\n[${stopped}]` } : { ok: code === 0, code: code ?? undefined, output }),
    )
  })
}

/**
 * The project's own checks (`checks.commands`, e.g. typecheck and tests) after an edit-mode
 * delegation. They run only where the user already lets agents run commands; in "Ask before
 * changes" mode Conductor is told to run them itself instead.
 */
export async function runConfiguredChecks(
  commands: string[],
  cwd: string,
  permission: PermissionMode,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ results: CheckResult[]; findings: Finding[] }> {
  if (!commands.length) return { results: [], findings: [] }
  if (permission === "default") {
    return {
      results: [],
      findings: [
        {
          severity: "check",
          message: `Configured checks were not run in "Ask before changes" mode. Run them yourself: ${commands.join("; ")}`,
        },
      ],
    }
  }
  const results: CheckResult[] = []
  for (const command of commands) {
    if (signal?.aborted) break
    results.push(await runCheck(command, cwd, timeoutMs, signal))
  }
  const findings: Finding[] = results
    .filter((r) => !r.ok)
    .map((r) => ({
      severity: "reject",
      message: `Check \`${r.command}\` failed${r.code !== undefined ? ` (exit ${r.code})` : ""}:\n${r.output || "(no output)"}`,
    }))
  return { results, findings }
}

/**
 * `worktrees.setup`: prepare a fresh delegate worktree (install dependencies, copy `.env`) before
 * the delegate starts, so it does not spend turns on that or fail the project checks. The commands
 * run in the worktree with AGENT_ROUTER_WORKSPACE set to the main checkout. Stops at the first
 * failure; a failure is a finding, and the delegate still runs.
 */
export async function runWorktreeSetup(
  commands: string[],
  worktree: string,
  workspace: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ results: CheckResult[]; findings: Finding[] }> {
  const results: CheckResult[] = []
  for (const command of commands) {
    if (signal?.aborted) break
    const result = await runCheck(command, worktree, timeoutMs, signal, { AGENT_ROUTER_WORKSPACE: workspace })
    results.push(result)
    if (!result.ok) {
      return {
        results,
        findings: [
          {
            severity: "check",
            message: `Worktree setup \`${command}\` failed${result.code !== undefined ? ` (exit ${result.code})` : ""}, so the delegate ran in an unprepared worktree:\n${result.output || "(no output)"}`,
          },
        ],
      }
    }
  }
  return { results, findings: [] }
}
