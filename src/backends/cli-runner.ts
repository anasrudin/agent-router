import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ProviderId } from "../config/schema"
import type { Detection, RunOptions } from "./Backend"
import { BackendError, type BackendEvent, classifyErrorText } from "./events"
import { type ProcessSpec, runProcess } from "./process"

/** Turns one CLI's stdout into normalised events. Pure, so contract tests can feed it recorded output. */
export interface OutputParser {
  line(line: string): BackendEvent[]
  /** Called once stdout closes; flushes buffered output (e.g. a single pretty-printed JSON document). */
  end(): BackendEvent[]
}

const isTerminal = (e: BackendEvent) => e.type === "done" || e.type === "error"

/**
 * Run a CLI and yield its events. Guarantees exactly one terminal event, emitted after the
 * process exits, so a caller never sees `done` from a process that is still writing files.
 */
export async function* runCli(provider: ProviderId, spec: ProcessSpec, parser: OutputParser): AsyncGenerator<BackendEvent> {
  const proc = runProcess(spec)
  let terminal: BackendEvent | undefined
  const take = function* (events: BackendEvent[]) {
    for (const event of events) {
      if (!isTerminal(event)) yield event
      else terminal ??= event
    }
  }
  for await (const line of proc.lines) yield* take(parser.line(line))
  const exit = await proc.exit
  yield* take(parser.end())

  const fail = (kind: ConstructorParameters<typeof BackendError>[1], message: string): BackendEvent => ({
    type: "error",
    error: new BackendError(provider, kind, message),
  })
  if (exit.spawnError) {
    const missing = exit.spawnError.code === "ENOENT"
    yield fail(missing ? "missing_executable" : "failed", `${spec.command}: ${exit.spawnError.message}`)
  } else if (exit.cancelled) {
    yield fail("cancelled", `${spec.command} was cancelled`)
  } else if (exit.timedOut) {
    yield fail("timeout", `${spec.command} timed out after ${spec.timeoutMs} ms`)
  } else if (terminal) {
    yield terminal
  } else {
    const stderr = exit.stderr.trim()
    const detail = stderr ? `: ${stderr.slice(-2000)}` : ""
    yield fail(classifyErrorText(stderr), `${spec.command} exited with code ${exit.code} and no result${detail}`)
  }
}

export async function detectCli(executable: string, testedVersion?: string): Promise<Detection> {
  const proc = runProcess({ command: executable, args: ["--version"], cwd: process.cwd(), timeoutMs: 15_000 })
  const out: string[] = []
  for await (const line of proc.lines) out.push(line)
  const exit = await proc.exit
  if (exit.spawnError) return { installed: false, testedVersion, detail: `${executable} not found on PATH` }
  if (exit.code !== 0) {
    return { installed: false, testedVersion, detail: `${executable} --version exited ${exit.code}: ${exit.stderr.trim()}` }
  }
  return { installed: true, version: out.join(" ").trim(), testedVersion }
}

/** Full stdout of a short CLI command, or undefined if it failed to run or exited non-zero. */
export async function captureCli(executable: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  const proc = runProcess({ command: executable, args, cwd: process.cwd(), timeoutMs })
  const out: string[] = []
  for await (const line of proc.lines) out.push(line)
  const exit = await proc.exit
  return exit.spawnError || exit.code !== 0 ? undefined : out.join("\n")
}

/** Write text to a private temp file; the caller must call the returned cleanup. */
export function tempFile(name: string, contents: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-router-"))
  const file = path.join(dir, name)
  writeFileSync(file, contents, "utf8")
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function safeJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** For CLIs without an append-system-prompt flag that keeps their own prompt intact: role text leads the stdin message. */
export function withRolePreamble(options: RunOptions): string {
  return options.systemPrompt ? `${options.systemPrompt}\n\n---\n\n${options.prompt}` : options.prompt
}
