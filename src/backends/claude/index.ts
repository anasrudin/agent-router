import { writeFileSync } from "node:fs"
import path from "node:path"
import type { BackendConfig } from "../../config/schema"
import { selfCommand } from "../../self"
import type { AgentMode, Backend, BackendOptions, PermissionMode, RunOptions } from "../Backend"
import { detectCli, runCli, tempFile } from "../cli-runner"
import type { BackendEvent } from "../events"
import { createClaudeParser } from "./parse"

/** Version the fixtures in backends/__tests__/fixtures/claude-*.jsonl were recorded with. */
export const CLAUDE_TESTED_VERSION = "2.1.312"

const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"]

/** Claude Code has no model-list command; these are its aliases plus current full ids. */
export const CLAUDE_OPTIONS: BackendOptions = {
  models: [
    { id: "haiku", description: "Alias for the latest Haiku: fastest" },
    { id: "sonnet", description: "Alias for the latest Sonnet: balanced" },
    { id: "opus", description: "Alias for the latest Opus: most capable" },
    { id: "claude-haiku-5-5" },
    { id: "claude-sonnet-5-5" },
    { id: "claude-opus-5-5" },
    { id: "claude-fable-5-1" },
  ],
  // `claude --help`: --effort <level> (low, medium, high, xhigh, max)
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
  supportsTrustOverride: false,
}

/**
 * Claude Code 2.1.312 has no Grep/Glob tools ("search file contents with grep via the Bash tool"),
 * so a read-only delegate needs a few shell commands to search at all. Each is read-only and
 * cannot start another program; rg (--pre) and git (pagers, fsmonitor hooks) can, so they are out.
 * Verified on 2.1.312 under dontAsk: a compound command or redirection that adds anything else is denied.
 */
export const READ_ONLY_BASH = ["grep", "ls", "cat", "head", "tail", "wc"].map((c) => `Bash(${c}:*)`)

/** Told to read-only delegates, which otherwise reach for rg or find, get denied, and give up. */
export const READ_ONLY_SHELL_NOTE = `

## Shell in this session

You are read-only. The only shell commands allowed are grep, ls, cat, head, tail and wc. Pipes between them are fine. Anything else is refused, including rg, find, git, sed and redirection to a file. Search with \`grep -rn --exclude-dir=node_modules --exclude-dir=.git PATTERN PATH\`. If a command is refused, use one of the allowed ones before you report that you are blocked.`

/** Delegation goes through the router only: a delegate must not start its own subagents. */
const NO_SUBAGENTS = ["Agent", "Task"]

/** `Bash(<command>:*)` rules; a command with parentheses cannot be written as a rule and is left out. */
export const commandRules = (commands: string[]) => commands.filter((c) => !/[()]/.test(c)).map((c) => `Bash(${c.trim()}:*)`)

export function claudePermissionArgs(
  mode: AgentMode,
  permission: PermissionMode,
  allowedCommands: string[] = [],
  mcpServers: string[] = [],
): string[] {
  // Attached MCP servers are the harness's own read-only tools: allowed without asking.
  const mcp = mcpServers.map((name) => `mcp__${name}`)
  if (mode === "edit") {
    if (permission === "bypass") return ["--permission-mode", "bypassPermissions", "--disallowedTools", ...NO_SUBAGENTS]
    // Nobody can answer a prompt in a headless delegate: without these, every command is refused,
    // so it could not even run the tests it was asked to make pass.
    return [
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...READ_ONLY_BASH,
      ...commandRules(allowedCommands),
      ...mcp,
      "--disallowedTools",
      ...NO_SUBAGENTS,
    ]
  }
  // dontAsk denies anything not pre-approved instead of prompting, so read-only stays read-only.
  // Claude Code has no OS sandbox here: an allowed Bash *can* write files; the brief forbids it.
  const bash = mode === "run-commands" ? ["Bash"] : READ_ONLY_BASH
  return ["--permission-mode", "dontAsk", "--allowedTools", ...bash, ...mcp, "--disallowedTools", ...EDIT_TOOLS, ...NO_SUBAGENTS]
}

/** A --settings file whose Stop hook runs `agent-router hook report-gate`; its folder holds the gate's counters. */
export function reportGateSettings(): { file: string; cleanup: () => void } {
  const settings = tempFile("settings.json", "")
  const command = selfCommand(["hook", "report-gate", "--state", path.dirname(settings.file)])
  writeFileSync(settings.file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 30 }] }] } }))
  return settings
}

export function claudeArgs(
  options: RunOptions,
  systemPromptFile: string | undefined,
  extra: string[],
  settingsFile?: string,
  mcpConfigFile?: string,
): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // Delegates must not reach the harness's MCP server and delegate recursively: only what we attach.
    "--strict-mcp-config",
    ...(mcpConfigFile ? ["--mcp-config", mcpConfigFile] : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.reasoning ? ["--effort", options.reasoning] : []),
    ...(options.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
    ...(systemPromptFile ? ["--append-system-prompt-file", systemPromptFile] : []),
    ...(settingsFile ? ["--settings", settingsFile] : []),
    ...claudePermissionArgs(
      options.mode,
      options.permission,
      options.allowedCommands,
      mcpConfigFile ? (options.mcpServers ?? []).map((s) => s.name) : [],
    ),
    ...extra,
  ]
}

export function createClaudeBackend(config: BackendConfig): Backend {
  return {
    id: "claude",
    supportsResume: true,
    detect: () => detectCli(config.executable, CLAUDE_TESTED_VERSION),
    options: async () => CLAUDE_OPTIONS,
    async *run(options): AsyncGenerator<BackendEvent> {
      const servers = options.mcpServers ?? []
      const notes = servers.map((s) => `\n\n${s.note}`).join("")
      const system = `${options.systemPrompt ?? ""}${options.mode === "read-only" ? READ_ONLY_SHELL_NOTE : ""}${notes}`
      const sys = system.trim() ? tempFile("system-prompt.md", system) : undefined
      const gate = options.reportGate ? reportGateSettings() : undefined
      const mcp = servers.length
        ? tempFile(
            "mcp.json",
            JSON.stringify({
              mcpServers: Object.fromEntries(servers.map((s) => [s.name, { type: "stdio", command: s.command, args: s.args }])),
            }),
          )
        : undefined
      try {
        yield* runCli(
          "claude",
          {
            command: config.executable,
            args: claudeArgs(options, sys?.file, config.extra_args, gate?.file, mcp?.file),
            cwd: options.cwd,
            stdin: options.prompt,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
          },
          createClaudeParser(),
        )
      } finally {
        sys?.cleanup()
        gate?.cleanup()
        mcp?.cleanup()
      }
    },
  }
}
