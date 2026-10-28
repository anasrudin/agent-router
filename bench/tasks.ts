// Benchmark tasks and their automatic scoring. Shared by bench.ts (runs) and report.ts (re-scores saved runs).

import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export const REPO = path.resolve(import.meta.dir, "..")

export interface Workspace {
  dir: string
  /** Whether Conductor may edit here. Only throwaway fixture copies are writable. */
  writable: boolean
}

export interface Task {
  id: string
  prompt: string
  workspace: () => Workspace
  score: (run: RunResult, ws: Workspace) => Score
}

export interface Score {
  pass: boolean
  checks: Record<string, boolean>
}

export interface RunResult {
  task: string
  profile: string
  rep: number
  ok: boolean
  error: string
  ms: number
  conductor: { usd: number; input: number; output: number }
  delegates: {
    taskClass?: string
    provider: string
    model?: string
    tier: string
    usd: number
    tokens: { input: number; output: number }
    status: string
    /** "provider/tier: outcome" per attempt, e.g. "openai/deep: report_failed". */
    attempts: string[]
  }[]
  approvals: { tool: string; allowed: boolean }[]
  answer: string
  score?: Score
}

export const repoWorkspace = (): Workspace => ({ dir: REPO, writable: false })

export function fixtureWorkspace(): Workspace {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-bench-fix-"))
  cpSync(path.join(REPO, "bench/fixture"), dir, { recursive: true })
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, stdio: "ignore" })
  git("init", "-q")
  git("add", ".")
  git("-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-qm", "fixture")
  return { dir, writable: true }
}

export const has = (text: string, ...needles: string[]) => needles.every((n) => text.includes(n))

export const TASKS: Task[] = [
  {
    id: "explain",
    prompt:
      "How does this harness handle a delegate that fails? Walk through the escalation ladder with file:line references, and name one edge case in it that the tests do not cover. Answer in under 200 words.",
    workspace: repoWorkspace,
    score: (run) => {
      const checks = {
        names_nextStep: has(run.answer, "nextStep"),
        // Answers cite lines as "escalation.ts:41" or as "(44–47)" under an escalation.ts heading.
        cites_escalation_ts: run.answer.includes("escalation.ts") && /\b\d{2,3}\b/.test(run.answer),
        no_invented_runAttempts: !run.answer.includes("runAttempts"),
        names_edge_case: /edge case/i.test(run.answer),
      }
      return { pass: Object.values(checks).every(Boolean), checks }
    },
  },
  {
    id: "fix",
    prompt:
      "The tests in this project fail (`node --test`). Fix the source code, not the tests, so every test passes. Keep the change minimal and tell me what the bugs were.",
    workspace: fixtureWorkspace,
    score: (_run, ws) => {
      const test = spawnSync("node", ["--test"], { cwd: ws.dir, encoding: "utf8" })
      const testsChanged = spawnSync("git", ["diff", "--quiet", "HEAD", "--", "test"], { cwd: ws.dir }).status !== 0
      const checks = { tests_pass: test.status === 0, tests_untouched: !testsChanged }
      return { pass: Object.values(checks).every(Boolean), checks }
    },
  },
  {
    id: "review",
    prompt:
      "Get an independent code review of src/router/escalation.ts from a model other than yourself. Then give me the single most important finding with a line reference, and say whether you agree with it. Under 150 words.",
    workspace: repoWorkspace,
    score: (run) => {
      const checks = {
        delegated_to_other_model: run.delegates.some((d) => d.provider !== "claude"),
        cites_line: /escalation\.ts:\d+|\blines? \d+|:\d+/i.test(run.answer),
        states_agreement: /\b(agree|disagree)\b/i.test(run.answer),
      }
      return { pass: Object.values(checks).every(Boolean), checks }
    },
  },
]
