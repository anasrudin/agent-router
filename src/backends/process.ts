import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"

export interface ProcessSpec {
  command: string
  args: string[]
  cwd: string
  stdin?: string
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ProcessExit {
  code: number | null
  stderr: string
  timedOut: boolean
  cancelled: boolean
  /** Set when the executable could not be started at all (ENOENT and friends). */
  spawnError?: NodeJS.ErrnoException
}

export interface RunningProcess {
  lines: AsyncIterable<string>
  exit: Promise<ProcessExit>
}

const STDERR_LIMIT = 64 * 1024

/**
 * Environment for headless agents. Nobody can answer a pager, an editor or a credential prompt,
 * so a command that opens one would hang until the watchdog's stall timer. These make the common
 * tools fail fast or skip the prompt instead. `GIT_EDITOR=:` works on Windows too: git runs the
 * editor through its bundled sh.
 */
export const NONINTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_PAGER: "cat",
  GCM_INTERACTIVE: "never",
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "cat",
  DEBIAN_FRONTEND: "noninteractive",
  PIP_NO_INPUT: "1",
  ...(process.platform === "win32" ? {} : { PAGER: "cat", MANPAGER: "cat", EDITOR: ":", VISUAL: ":" }),
}

/**
 * Find an executable on PATH the way the OS would. On Windows this honours PATHEXT,
 * because npm-installed CLIs are `.cmd` shims that spawn() cannot find by bare name.
 */
export function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""]
  const candidates = (dir: string) => exts.map((ext) => pathApi.join(dir, name + ext))
  if (name.includes("/") || name.includes("\\")) return exts.map((ext) => name + ext).find(exists)
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean)
  for (const dir of dirs) {
    const hit = candidates(dir).find(exists)
    if (hit) return hit
  }
  return undefined
}

const CMD_UNSAFE = /[%!"\r\n]/

/**
 * `.cmd`/`.bat` shims only run under cmd.exe. Arguments reach cmd.exe verbatim, so anything
 * cmd would expand is refused rather than escaped; prompts never travel this way (stdin only).
 */
export function buildInvocation(
  resolved: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args, verbatim: false }
  for (const arg of [resolved, ...args]) {
    if (CMD_UNSAFE.test(arg)) throw new Error(`Argument not safe to pass through cmd.exe: ${JSON.stringify(arg)}`)
  }
  const quoted = [resolved, ...args].map((a) => `"${a}"`).join(" ")
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${quoted}"`], verbatim: true }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-(child.pid as number), signal)
  } catch {
    child.kill(signal)
  }
}

/** Default time a POSIX process tree gets to clean up after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 3000

/**
 * Kill the child and everything it started. Wrapped CLIs spawn tools of their own, and the
 * router's MCP child runs delegates in process groups of their own, so on POSIX the group first
 * gets SIGTERM: that is the MCP child's cue to stop its delegates. SIGKILL follows after the grace.
 */
export async function killTree(child: ChildProcess, graceMs = KILL_GRACE_MS): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== "win32") {
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
    signalGroup(child, "SIGTERM")
    const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs).unref())
    await Promise.race([exited, timer])
    // Also after a clean exit: a tool in the group may have ignored SIGTERM and outlived its parent.
    signalGroup(child, "SIGKILL")
    return
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    killer.once("error", () => {
      child.kill()
      resolve()
    })
    killer.once("close", (code) => {
      if (code !== 0) child.kill()
      resolve()
    })
  })
}

export function runProcess(spec: ProcessSpec): RunningProcess {
  const resolved = resolveExecutable(spec.command, { ...process.env, ...spec.env })
  if (!resolved) {
    const error = Object.assign(new Error(`${spec.command}: not found on PATH`), { code: "ENOENT" })
    return {
      lines: (async function* () {})(),
      exit: Promise.resolve({ code: null, stderr: "", timedOut: false, cancelled: false, spawnError: error }),
    }
  }
  const invocation = buildInvocation(resolved, spec.args)
  const child = spawn(invocation.command, invocation.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: invocation.verbatim,
    // POSIX: lead a process group so killTree reaches grandchildren.
    detached: process.platform !== "win32",
  })

  let stderr = ""
  let timedOut = false
  let cancelled = false
  let spawnError: NodeJS.ErrnoException | undefined
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk
  })
  child.on("error", (error) => {
    spawnError = error
  })
  // A CLI that exits before reading its prompt must surface as a failure, not an EPIPE crash.
  child.stdin?.on("error", () => {})
  child.stdin?.end(spec.stdin ?? "")

  const timer =
    spec.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          void killTree(child)
        }, spec.timeoutMs)
  const onAbort = () => {
    cancelled = true
    void killTree(child)
  }
  if (spec.signal?.aborted) onAbort()
  else spec.signal?.addEventListener("abort", onAbort, { once: true })

  const exit = new Promise<ProcessExit>((resolve) => {
    child.once("close", (code) => {
      if (timer) clearTimeout(timer)
      spec.signal?.removeEventListener("abort", onAbort)
      resolve({ code, stderr, timedOut, cancelled, spawnError })
    })
  })

  const lines = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }) : (async function* () {})()
  return { lines, exit }
}
