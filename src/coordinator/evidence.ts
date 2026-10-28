import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { AgentMode } from "../backends/Backend"
import type { ProviderId } from "../config/schema"
import type { Report } from "./protocol"
import type { Finding } from "./verify"

/** Where delegates that run commands save the output they cite, relative to their working folder. */
export const EVIDENCE_DIR = ".harness/evidence"

/** File systems with coarse timestamps (FAT, some network shares) round mtimes down by up to 2 s. */
const MTIME_SLACK_MS = 2_000

export const EVIDENCE_NOTE = `Save the output of each command you cite under Evidence to a file in \`${EVIDENCE_DIR}/\` (for example \`${EVIDENCE_DIR}/tests.txt\`), and give that path next to the command. Save the real output, not a summary. The harness checks that each cited file exists and was written during this task.`

/**
 * Whether a delegate can keep receipts: it must run commands and be able to write a file. Edit mode
 * can everywhere; run-commands only on Claude (Codex runs it in a read-only sandbox, Gemini's
 * headless default declines writes).
 */
export const keepsEvidence = (mode: AgentMode, provider: ProviderId | undefined) =>
  mode === "edit" || (mode === "run-commands" && provider === "claude")

/** Create the folder, ignored by git, so receipts never show up in a diff or a commit. */
export function prepareEvidenceDir(cwd: string): void {
  const dir = path.join(cwd, EVIDENCE_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, ".gitignore"), "*\n")
}

const EVIDENCE_PATH = String.raw`\.harness[\\/]evidence[\\/]`

/**
 * `.harness/evidence/...` paths cited in a report, with either slash. A path in backticks is taken
 * whole (it may hold spaces); a bare one ends at whitespace or punctuation.
 */
export function citedEvidence(text: string): string[] {
  const quoted = [...text.matchAll(new RegExp(`\`([^\`]*?(${EVIDENCE_PATH}[^\`]+))\``, "g"))].map((m) => m[2] as string)
  const rest = text.replace(/`[^`]*`/g, " ")
  const bare = (rest.match(new RegExp(`${EVIDENCE_PATH}[^\\s\`'"<>()[\\]{}|,;]+`, "g")) ?? []).map((p) => p.replace(/[.:]+$/, ""))
  return [...new Set([...quoted, ...bare].map((p) => p.trim().replaceAll("\\", "/")))]
}

/**
 * A report is a claim; a cited receipt is checkable. Every cited file must sit inside the evidence
 * folder, be a regular file written since the delegation started, and not be empty.
 */
export function checkEvidence(report: Report, cwd: string, mode: AgentMode, provider: ProviderId, startedAt: number): Finding[] {
  if (!keepsEvidence(mode, provider) || (report.status !== "done" && report.status !== "partial")) return []
  const cited = citedEvidence(`${report.evidence}\n${report.result}`)
  if (!cited.length) {
    return [
      { severity: "check", message: `No saved command output: Evidence cites no file in ${EVIDENCE_DIR}/, so its claims are unchecked.` },
    ]
  }
  const root = path.resolve(cwd, EVIDENCE_DIR)
  const findings: Finding[] = []
  for (const rel of cited) {
    const file = path.resolve(cwd, rel)
    if (!file.startsWith(root + path.sep)) {
      findings.push({ severity: "reject", message: `Evidence path ${rel} points outside ${EVIDENCE_DIR}/.` })
      continue
    }
    let stat: ReturnType<typeof lstatSync> | undefined
    try {
      // lstat: a symlink to some other file is not a receipt.
      stat = lstatSync(file)
    } catch {
      findings.push({ severity: "reject", message: `Evidence file ${rel} does not exist: the cited output was never saved.` })
      continue
    }
    if (!stat.isFile()) findings.push({ severity: "reject", message: `Evidence path ${rel} is not a regular file.` })
    else if (stat.mtimeMs + MTIME_SLACK_MS < startedAt)
      findings.push({ severity: "reject", message: `Evidence file ${rel} predates this task: it is not output from this run.` })
    // Real output can be as short as "v1"; only an empty receipt shows nothing.
    else if (stat.size === 0 || (stat.size < 4096 && !readFileSync(file, "utf8").trim()))
      findings.push({ severity: "reject", message: `Evidence file ${rel} is empty.` })
  }
  return findings
}
