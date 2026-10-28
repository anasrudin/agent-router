import type { BackendConfig } from "../../config/schema"
import type { AgentMode, Backend, BackendOptions, ModelOption, PermissionMode, RunOptions } from "../Backend"
import { captureCli, detectCli, runCli, withRolePreamble } from "../cli-runner"
import { createCodexParser } from "./parse"

/** Version the fixtures in backends/__tests__/fixtures/codex-*.jsonl were recorded with. */
export const CODEX_TESTED_VERSION = "0.165.0"

export function codexSandboxArgs(mode: AgentMode, permission: PermissionMode): string[] {
  // The read-only sandbox still runs commands, so it serves run-commands too, with the OS enforcing no writes.
  if (mode !== "edit") return ["--sandbox", "read-only"]
  if (permission === "bypass") return ["--dangerously-bypass-approvals-and-sandbox"]
  return ["--sandbox", "workspace-write"]
}

/** Read `codex debug models`: the models this account can pick, with the efforts each accepts. */
export function parseCodexModels(json: string): BackendOptions {
  const doc = JSON.parse(json) as { models?: Record<string, unknown>[] }
  const models: ModelOption[] = []
  const levels = new Set<string>()
  for (const m of doc.models ?? []) {
    if (m.visibility !== "list" || typeof m.slug !== "string") continue
    const reasoning = Array.isArray(m.supported_reasoning_levels)
      ? (m.supported_reasoning_levels as Record<string, unknown>[]).map((l) => String(l.effort))
      : undefined
    for (const l of reasoning ?? []) levels.add(l)
    models.push({ id: m.slug, description: typeof m.description === "string" ? m.description : undefined, reasoning })
  }
  return { models, reasoningLevels: [...levels], supportsTrustOverride: false }
}

const CODEX_FALLBACK_OPTIONS: BackendOptions = {
  models: [{ id: "gpt-6-luna" }],
  reasoningLevels: ["low", "medium", "high", "xhigh"],
  supportsTrustOverride: false,
}

/** A TOML literal string: no escapes, so no `"` that cmd.exe would refuse when codex is a .cmd shim. */
const tomlLiteral = (v: string) => `'${v}'`

/**
 * `-c mcp_servers.<name>.*` overrides. A server whose command or arguments cannot be written as
 * literal strings (a `'` or a line break in a path) is left out rather than mis-quoted.
 */
export function codexMcpArgs(servers: RunOptions["mcpServers"] = []): string[] {
  return servers
    .filter((s) => [s.command, ...s.args].every((v) => !/['\r\n]/.test(v)))
    .flatMap((s) => [
      "-c",
      `mcp_servers.${s.name}.command=${tomlLiteral(s.command)}`,
      "-c",
      `mcp_servers.${s.name}.args=[${s.args.map(tomlLiteral).join(",")}]`,
    ])
}

/**
 * `codex exec resume` takes no --sandbox flag (0.165.0); the sandbox is set through config instead.
 * Verified: a resumed read-only session keeps its context and still cannot write.
 */
export function codexResumeSandboxArgs(mode: AgentMode, permission: PermissionMode): string[] {
  if (mode === "edit" && permission === "bypass") return ["--dangerously-bypass-approvals-and-sandbox"]
  return ["-c", `sandbox_mode=${tomlLiteral(mode === "edit" ? "workspace-write" : "read-only")}`]
}

export function codexArgs(options: RunOptions, extra: string[]): string[] {
  const resume = options.resumeSessionId
  return [
    "exec",
    ...(resume ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    ...(options.model ? ["-m", options.model] : []),
    ...(options.reasoning ? ["-c", `model_reasoning_effort=${options.reasoning}`] : []),
    ...(resume ? codexResumeSandboxArgs(options.mode, options.permission) : codexSandboxArgs(options.mode, options.permission)),
    ...codexMcpArgs(options.mcpServers),
    ...extra,
    ...(resume ? [resume] : []),
    // "-" reads the prompt from stdin.
    "-",
  ]
}

export function createCodexBackend(config: BackendConfig): Backend {
  return {
    id: "openai",
    supportsResume: true,
    // turn.completed carries the thread's total so far (checked against the session rollout's token_count).
    cumulativeUsage: true,
    detect: () => detectCli(config.executable, CODEX_TESTED_VERSION),
    async options() {
      const out = await captureCli(config.executable, ["debug", "models"], 30_000)
      try {
        return out === undefined ? CODEX_FALLBACK_OPTIONS : parseCodexModels(out)
      } catch {
        return CODEX_FALLBACK_OPTIONS
      }
    },
    run: (options) =>
      runCli(
        "openai",
        {
          command: config.executable,
          args: codexArgs(options, config.extra_args),
          cwd: options.cwd,
          stdin: withRolePreamble({
            ...options,
            systemPrompt: [options.systemPrompt, ...(options.mcpServers ?? []).map((s) => s.note)].filter(Boolean).join("\n\n"),
          }),
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        },
        createCodexParser(),
      ),
  }
}
