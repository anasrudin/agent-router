import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Session } from "../coordinator/session"
import { listAgents } from "./render"

export const HARNESS_NAME = "agent-router"

const PROJECT_DOC_LIMIT = 12_000

function readIfExists(file: string, limit: number): string | undefined {
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, "utf8")
  return text.length > limit ? `${text.slice(0, limit)}\n\n[truncated at ${limit} characters; read ${file} for the rest]` : text
}

function profileRules(session: Session): string {
  const profile = session.profile ? session.config.profiles[session.profile] : undefined
  if (!profile?.guidance.trim()) return ""
  return `\n\n## Routing profile: ${profile.label}\n\n${profile.guidance.trim()}\n`
}

/** Values for every {{VARIABLE}} the prompts use. Delegates get the same values Conductor sees. */
export function promptVars(session: Session, selfModel: string | undefined): Record<string, string> {
  const ws = session.workspace
  const agentsMd = readIfExists(path.join(ws, "AGENTS.md"), PROJECT_DOC_LIMIT)
  const readme = readIfExists(path.join(ws, "README.md"), 2_000)
  return {
    HARNESS_NAME,
    WINDOWS_VERSION: session.platformLine(),
    SHELL:
      process.platform === "win32"
        ? "PowerShell 7 (pwsh)"
        : `${process.env.SHELL ?? "sh"} (POSIX; Windows rules in shared/windows.md do not apply)`,
    WORKSPACE_ROOT: ws,
    SELF_PROVIDER: session.selfProvider,
    SELF_MODEL: selfModel ?? "CLI default",
    BACKENDS_STATUS: session.backendsStatusLine(),
    PERMISSION_MODE: session.permission,
    BUDGET: session.budgetLine(),
    AGENTS_MD: agentsMd ? `\n\n<project-agents-md>\n${agentsMd}\n</project-agents-md>\n` : "(no AGENTS.md in workspace)",
    README_SUMMARY: readme ? `\n\n<project-readme-excerpt>\n${readme}\n</project-readme-excerpt>\n` : "(no README.md in workspace)",
    CONDITIONAL_RULES: profileRules(session),
    AGENT_LIST: listAgents()
      .map((a) => `${a.name} (${a.mode}) — ${a.description}`)
      .join("; "),
    SKILL_LIST: "none configured",
    MAX_ATTEMPTS_PER_SUBTASK: String(session.config.escalation.max_attempts_per_subtask),
    MAX_PARALLEL_AGENTS: String(session.config.limits.max_parallel_agents),
  }
}
