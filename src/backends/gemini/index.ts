import { detectGeminiModels, mergeDetected } from "../../config/catalog"
import type { BackendConfig } from "../../config/schema"
import type { AgentMode, Backend, BackendOptions, PermissionMode, RunOptions } from "../Backend"
import { detectCli, runCli, withRolePreamble } from "../cli-runner"
import { createGeminiParser } from "./parse"

/** Version the fixtures in backends/__tests__/fixtures/gemini-*.jsonl were recorded with. */
export const GEMINI_TESTED_VERSION = "0.66.0"

/** Gemini appends `-p` to whatever arrives on stdin, so the brief goes on stdin and this short line rides on argv. */
const STDIN_PROMPT = "Carry out the task described above and reply in the report format it specifies."

export function geminiApprovalArgs(mode: AgentMode, permission: PermissionMode): string[] {
  // Headless default mode declines tools that need approval (shell, writes), so run-commands degrades to read-only.
  if (mode !== "edit") return ["--approval-mode", "default"]
  return ["--approval-mode", permission === "bypass" ? "yolo" : "auto_edit"]
}

/** Gemini CLI has no model-list command: the API lists models when a key is in the environment, else config/models.json. */
export async function geminiOptions(): Promise<BackendOptions> {
  return mergeDetected("gemini", await detectGeminiModels(), { authoritative: false })
}

export function geminiArgs(options: RunOptions, extra: string[], trustWorkspace = false): string[] {
  return [
    "-p",
    STDIN_PROMPT,
    // stream-json, not json: progress arrives as it happens instead of in one document at exit.
    "--output-format",
    "stream-json",
    ...(options.model ? ["-m", options.model] : []),
    ...geminiApprovalArgs(options.mode, options.permission),
    ...(trustWorkspace ? ["--skip-trust"] : []),
    ...extra,
  ]
}

export function createGeminiBackend(config: BackendConfig): Backend {
  return {
    id: "gemini",
    supportsResume: false,
    detect: () => detectCli(config.executable, GEMINI_TESTED_VERSION),
    options: geminiOptions,
    run: (options) =>
      runCli(
        "gemini",
        {
          command: config.executable,
          args: geminiArgs(options, config.extra_args, config.trust_workspace),
          cwd: options.cwd,
          stdin: withRolePreamble(options),
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        },
        createGeminiParser(),
      ),
  }
}
