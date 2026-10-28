import { execFileSync, spawnSync } from "node:child_process"
import type { Brief, Report } from "./protocol"

export interface Finding {
  severity: "reject" | "check"
  message: string
}

/**
 * conductor.md §5: a report is a claim. These are the structural checks the harness can make
 * without judgement; Conductor still runs the build/tests and reads the diff itself.
 */
export function checkReport(report: Report, brief: Brief): Finding[] {
  const findings: Finding[] = []
  if (!report.wellFormed)
    findings.push({ severity: "reject", message: "Report does not follow delegation-protocol §2 (missing Status or Result)." })
  if (report.status === "done" && brief.mode === "edit" && !report.changes.trim()) {
    findings.push({ severity: "reject", message: "Status is done in edit mode but Changes lists no files." })
  }
  if (!report.evidence.trim() || /^none\.?$/i.test(report.evidence.trim())) {
    findings.push({ severity: "check", message: "No Evidence: nothing in the report is backed by a command or citation." })
  }
  if (report.confidence === "low")
    findings.push({ severity: "check", message: `Low confidence: ${report.confidenceReason || "no reason given"}` })
  if (report.confidence === undefined && report.wellFormed) findings.push({ severity: "check", message: "Confidence not stated." })
  const open = report.openQuestions.trim()
  if (open && !/^(none|n\/a|-)\.?$/i.test(open))
    findings.push({ severity: "check", message: "Open questions / risks to resolve before building on this." })
  if (report.status === "partial")
    findings.push({ severity: "check", message: "Partial result: re-brief the remainder; do not present as complete." })
  return findings
}

const RED_FLAGS: [RegExp, string][] = [
  [/@ts-(ignore|nocheck)/, "TypeScript check suppressed"],
  [/@ts-expect-error/, "TypeScript error suppressed"],
  [/eslint-disable|biome-ignore|# ?noqa|# ?type: ?ignore|#\s*pylint:\s*disable/, "lint/type suppression"],
  [/\b(it|test|describe)\.(skip|only)\(|\bx(it|describe)\(|@pytest\.mark\.skip|t\.Skip\(/, "test skipped or focused"],
  [/TODO:?\s*implement|rest of (the )?code|\.\.\. ?existing code/i, "placeholder code"],
  [/catch\s*(\([^)]*\))?\s*\{\s*\}|except[^:\n]*:\s*pass\b/, "swallowed error"],
]

/** A whole-line comment in the common syntaxes; group 1 is its text. */
const COMMENT = /^\s*(?:\/\/+|#+|\/\*+|\*|<!--|--)\s*(.*?)\s*(?:\*\/|-->)?$/

const CHANGE_VERB = /^(?:added|changed|updated|modified|fixed|removed|replaced|refactored|moved|renamed)\s+(\w+)/i
/** "Added to PATH by…", "Updated by the scheduler": the verb describes the code, not the edit. */
const PASSIVE_NEXT = /^(?:by|to|from|when|if|in|on|at|after|before|during|via|with|automatically|here|later)$/i
const BE_VERB = /\b(?:is|are|was|were|be|been|being)\b/i
/** "Updated nightly by cron": an agent named with "by" means the verb is passive. */
const BY_AGENT = /\bby\b/i
/** Prose files, where "## Fixed crash" and "* Added support" are headings and changelog entries, not comments. */
const PROSE_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i
const NARRATION_PHRASE =
  /\b(?:as requested|per (?:the )?(?:user|request|instructions|task)|according to the (?:task|request|instructions))\b|^(?:now|here) we\b/i

/**
 * Comments that narrate the edit instead of explaining the code ("Added null check", "as
 * requested", "Now we..."). They mean nothing to the next reader once the change is merged.
 * "Removed entries are kept for undo" describes the code, so a passive reading is let through.
 */
export function narratesChange(comment: string): boolean {
  if (NARRATION_PHRASE.test(comment)) return true
  const verb = CHANGE_VERB.exec(comment)
  return !!verb && !PASSIVE_NEXT.test(verb[1] ?? "") && !BE_VERB.test(comment) && !BY_AGENT.test(comment)
}

const MAX_NARRATION_FINDINGS = 10

/** Scan the added lines of a unified diff for shortcuts that fake success (conductor.md §5). */
export function scanDiff(diff: string): Finding[] {
  const findings: Finding[] = []
  let file = ""
  let narration = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "")
      continue
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    for (const [pattern, label] of RED_FLAGS) {
      if (pattern.test(line)) findings.push({ severity: "reject", message: `${file}: ${label}: ${line.slice(1).trim().slice(0, 160)}` })
    }
    const comment = PROSE_FILE.test(file) ? undefined : COMMENT.exec(line.slice(1))?.[1]
    if (comment && narratesChange(comment) && narration++ < MAX_NARRATION_FINDINGS) {
      findings.push({ severity: "check", message: `${file}: comment narrates the change, not the code: ${comment.slice(0, 160)}` })
    }
  }
  const removedTests = /^--- a\/.*\.(test|spec)\.[a-z]+\n\+\+\+ \/dev\/null/m.exec(diff)
  if (removedTests) findings.push({ severity: "reject", message: `test file deleted: ${removedTests[0].split("\n")[0]?.slice(6)}` })
  return findings
}

/** Uncommitted changes in a working tree, including untracked files, as one unified diff. */
export function workingTreeDiff(cwd: string): string {
  const maxBuffer = 32 * 1024 * 1024
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer })
  const hasHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd }).status === 0
  const tracked = hasHead ? git(["diff", "HEAD", "--no-color", "--no-ext-diff"]) : ""
  // Verification must not touch the index, so untracked files are diffed against /dev/null one by one.
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
  const added = untracked.map(
    (file) =>
      spawnSync("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file], {
        cwd,
        encoding: "utf8",
        maxBuffer,
      }).stdout,
  )
  return [tracked, ...added].filter(Boolean).join("\n")
}
