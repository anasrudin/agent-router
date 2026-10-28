import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Backend, PermissionMode, RunOptions } from "./backends/Backend"
import { BackendError, type BackendErrorKind, type BackendEvent } from "./backends/events"
import type { BackendRegistry } from "./backends/registry"
import { deepMerge, loadConfig } from "./config/load"
import { type ProviderId, RoutingConfig } from "./config/schema"
import { Session } from "./coordinator/session"

/** The shipped routing.yaml, optionally patched. Tests run against the real defaults. */
export function testConfig(patch: unknown = {}): RoutingConfig {
  const { config } = loadConfig(mkdtempSync(path.join(tmpdir(), "ar-ws-")))
  return RoutingConfig.parse(deepMerge(config, patch))
}

export type Scripted =
  | { text: string; sessionId?: string; costUsd?: number }
  /** `toolCalls`: tool calls made before the error (work in progress). */
  | { error: BackendErrorKind; message?: string; toolCalls?: number; sessionId?: string }
  /** Emit nothing until aborted, then report "cancelled" the way a real CLI does. */
  | { hang: true; sessionId?: string }
  /** Repeat one tool call `times` times, then finish with `text`. */
  | { loop: number; text: string; sessionId?: string }
  /** The adapter itself throws, as a bad argument or parser would. */
  | { throws: string }

/** A backend that replays scripted outcomes and records every call. */
export function fakeBackend(id: ProviderId, script: Scripted[], supportsResume = id === "claude"): Backend & { calls: RunOptions[] } {
  const calls: RunOptions[] = []
  return {
    id,
    supportsResume,
    calls,
    detect: async () => ({ installed: true, version: "fake" }),
    options: async () => ({ models: [{ id: `${id}-model` }], reasoningLevels: [], supportsTrustOverride: false }),
    async *run(options): AsyncGenerator<BackendEvent> {
      calls.push(options)
      const next = script.shift()
      if (!next) throw new Error(`fake ${id}: no scripted response left`)
      if ("throws" in next) throw new Error(next.throws)
      if ("sessionId" in next && next.sessionId) yield { type: "session", sessionId: next.sessionId }
      if ("hang" in next) {
        await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }))
        yield { type: "error", error: new BackendError(id, "cancelled", "aborted") }
        return
      }
      if ("loop" in next) {
        for (let i = 0; i < next.loop && !options.signal?.aborted; i++)
          yield { type: "tool_call", name: "Read", input: { path: "a.ts", limit: 50 } }
        if (options.signal?.aborted) {
          yield { type: "error", error: new BackendError(id, "cancelled", "aborted") }
          return
        }
        yield { type: "done", text: next.text }
        return
      }
      if ("error" in next) {
        for (let i = 0; i < (next.toolCalls ?? 0); i++) yield { type: "tool_call", name: "Read", input: { path: `f${i}.ts` } }
        yield { type: "error", error: new BackendError(id, next.error, next.message ?? next.error) }
        return
      }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, costUsd: next.costUsd } }
      yield { type: "done", text: next.text }
    },
  }
}

export function fakeRegistry(scripts: Partial<Record<ProviderId, Scripted[]>>) {
  return {
    claude: fakeBackend("claude", scripts.claude ?? []),
    gemini: fakeBackend("gemini", scripts.gemini ?? []),
    openai: fakeBackend("openai", scripts.openai ?? []),
  } satisfies BackendRegistry
}

export function testSession(backends: BackendRegistry, patch: unknown = {}, permission: PermissionMode = "default"): Session {
  return new Session({
    workspace: mkdtempSync(path.join(tmpdir(), "ar-ws-")),
    config: testConfig(patch),
    backends,
    selfProvider: "claude",
    permission,
  })
}

export const report = (status: string, extra = "") =>
  `## Status\n${status}\n\n## Result\nDid the thing.\n\n## Changes\n${extra}\n\n## Evidence\nRan \`bun test\`: pass\n\n## Confidence\nhigh — tests pass\n\n## Open questions / risks\nnone\n`
