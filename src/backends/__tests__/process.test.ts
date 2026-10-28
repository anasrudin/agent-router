import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createClaudeParser } from "../claude/parse"
import { runCli } from "../cli-runner"
import type { BackendEvent } from "../events"
import { buildInvocation, resolveExecutable } from "../process"

const FAKE = path.join(import.meta.dir, "fixtures", "fake-cli.mjs")

async function collect(
  mode: string,
  opts: { stdin?: string; timeoutMs?: number; signal?: AbortSignal; command?: string; env?: Record<string, string> } = {},
) {
  const events: BackendEvent[] = []
  for await (const e of runCli(
    "claude",
    {
      command: opts.command ?? process.execPath,
      args: [FAKE, mode],
      cwd: import.meta.dir,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      env: opts.env,
    },
    createClaudeParser(),
  )) {
    events.push(e)
  }
  return events
}

const terminals = (events: BackendEvent[]) => events.filter((e) => e.type === "done" || e.type === "error")

describe("runCli with a real child process", () => {
  test("prompt arrives on stdin intact, banner noise tolerated", async () => {
    const big = "x".repeat(100_000)
    const events = await collect("echo", { stdin: big })
    expect(events[0]).toEqual({ type: "session", sessionId: "fake-session" })
    expect(terminals(events)).toEqual([{ type: "done", text: `got 100000 chars: ${"x".repeat(20)}` }])
  })
  test("delegates run with prompts for pagers, editors and credentials turned off; caller env still wins", async () => {
    const events = await collect("env", { env: { KEEP_ME: "yes", GIT_PAGER: "less" } })
    const done = terminals(events)[0]
    expect(done?.type).toBe("done")
    expect(JSON.parse(done?.type === "done" ? done.text : "{}")).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "less",
      GIT_EDITOR: ":",
      KEEP_ME: "yes",
    })
  })

  test("non-zero exit maps stderr to a typed error", async () => {
    const events = await collect("ratelimit")
    expect(terminals(events)).toHaveLength(1)
    expect(terminals(events)[0]).toMatchObject({ type: "error", error: { kind: "rate_limited" } })
  })
  test("clean exit without a result is still a failure", async () => {
    expect(terminals(await collect("silent-ok"))[0]).toMatchObject({ type: "error", error: { kind: "failed" } })
  })
  test("missing executable", async () => {
    const events = await collect("echo", { command: "definitely-not-a-cli-xyz" })
    expect(events).toEqual([expect.objectContaining({ type: "error", error: expect.objectContaining({ kind: "missing_executable" }) })])
  })
  test("timeout kills the process tree", async () => {
    const started = Date.now()
    const events = await collect("hang", { timeoutMs: 300 })
    expect(terminals(events)[0]).toMatchObject({ type: "error", error: { kind: "timeout" } })
    expect(Date.now() - started).toBeLessThan(5000)
  })
  test("abort cancels", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const events = await collect("hang", { signal: controller.signal })
    expect(terminals(events)[0]).toMatchObject({ type: "error", error: { kind: "cancelled" } })
  })
})

// POSIX only: Windows has no process groups and uses taskkill /T, covered by the tree kill itself.
describe.skipIf(process.platform === "win32")("graceful tree kill", () => {
  /** A zombie (killed, not yet reaped) still answers kill(pid, 0); on Linux /proc says it is dead. */
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }
    try {
      return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
    } catch {
      return true
    }
  }
  test("cancel lets a parent stop workers in their own process group", async () => {
    const controller = new AbortController()
    let workerPid = 0
    const events: BackendEvent[] = []
    for await (const e of runCli(
      "claude",
      { command: process.execPath, args: [FAKE, "group-parent"], cwd: import.meta.dir, signal: controller.signal },
      createClaudeParser(),
    )) {
      events.push(e)
      if (e.type === "session") {
        workerPid = Number(e.sessionId)
        expect(alive(workerPid)).toBe(true)
        controller.abort()
      }
    }
    expect(terminals(events)[0]).toMatchObject({ type: "error", error: { kind: "cancelled" } })
    // A killed process lingers as a zombie until reaped, and kill(pid, 0) still succeeds on it.
    const deadline = Date.now() + 2000
    while (alive(workerPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(alive(workerPid)).toBe(false)
  })
  test("a process that ignores SIGTERM is killed after the grace period", async () => {
    const started = Date.now()
    const events = await collect("ignore-term", { timeoutMs: 200 })
    expect(terminals(events)[0]).toMatchObject({ type: "error", error: { kind: "timeout" } })
    expect(Date.now() - started).toBeLessThan(8000)
  })
})

describe("Windows executable resolution", () => {
  const files = new Set(["C:\\npm\\gemini.CMD", "C:\\Program Files\\Claude\\claude.EXE"])
  const env = { PATH: "C:\\npm;C:\\Program Files\\Claude", PATHEXT: ".COM;.EXE;.BAT;.CMD" }
  test("PATHEXT finds .cmd shims and .exe files", () => {
    expect(resolveExecutable("gemini", env, "win32", (f) => files.has(f))).toBe("C:\\npm\\gemini.CMD")
    expect(resolveExecutable("claude", env, "win32", (f) => files.has(f))).toBe("C:\\Program Files\\Claude\\claude.EXE")
    expect(resolveExecutable("codex", env, "win32", (f) => files.has(f))).toBeUndefined()
  })
  test(".cmd shims run through cmd.exe with quoted args", () => {
    const inv = buildInvocation("C:\\npm\\gemini.CMD", ["-m", "pro model"], "win32")
    expect(inv.verbatim).toBe(true)
    expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"])
    expect(inv.args[3]).toBe('""C:\\npm\\gemini.CMD" "-m" "pro model""')
  })
  test("cmd metacharacters are refused, not escaped", () => {
    expect(() => buildInvocation("C:\\npm\\gemini.CMD", ["%PATH%"], "win32")).toThrow()
  })
  test(".exe and POSIX run directly", () => {
    expect(buildInvocation("C:\\x\\claude.exe", ["-p"], "win32")).toEqual({ command: "C:\\x\\claude.exe", args: ["-p"], verbatim: false })
    expect(buildInvocation("/usr/bin/claude", ["-p"], "linux").verbatim).toBe(false)
  })
})
