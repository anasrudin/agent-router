import { z } from "zod"

/** delegation-protocol.md §1 as data. Rendered to markdown by `renderBrief`; never sent as JSON. */
export const Brief = z.object({
  task: z.string().min(1).describe("One or two sentences: what to produce. Start with a verb."),
  why: z.string().min(1).describe("The user's underlying goal, so the delegate can make judgement calls."),
  relevant_files: z.array(z.string()).default([]).describe("Workspace-relative paths, with line ranges where known."),
  facts: z.array(z.string()).default([]).describe("Decisions, constraints and findings already established."),
  excerpts: z.array(z.string()).default([]).describe("Verbatim errors, code, stack traces. Never paraphrased."),
  scope: z.string().default("").describe("What may and may not be touched."),
  mode: z.enum(["read-only", "run-commands", "edit"]).default("read-only"),
  project_rules: z.array(z.string()).default([]),
  do_not: z.array(z.string()).default([]).describe("Known traps; things already tried that failed."),
  acceptance: z.array(z.string()).min(1).describe("Concrete, checkable conditions."),
  return_extra: z.string().default("").describe("Task-specific fields to add to the report."),
})
export type Brief = z.infer<typeof Brief>

const MODE_TEXT: Record<Brief["mode"], string> = {
  "read-only": "read-only",
  "run-commands": "may run commands (no file edits)",
  edit: "may edit files and run commands",
}

const fenced = (text: string) => {
  const fence = text.includes("```") ? "````" : "```"
  return `${fence}\n${text}\n${fence}`
}

export interface RetryNote {
  attempt: number
  provider: string
  problem: string
}

/** `directoryRules`: AGENTS.md files below the root that apply to the relevant files (see scopedAgentsMd). */
export function renderBrief(
  brief: Brief,
  workspace: string,
  previous: RetryNote[] = [],
  directoryRules: { file: string; text: string }[] = [],
): string {
  const sections = [
    `## Task\n${brief.task}`,
    `## Why\n${brief.why}`,
    [
      "## Context",
      `- Workspace: ${workspace}`,
      `- Relevant files:\n${brief.relevant_files.length ? brief.relevant_files.map((f) => `  - ${f}`).join("\n") : "  - none named"}`,
      `- Key facts already established:\n${brief.facts.length ? brief.facts.map((f) => `  - ${f}`).join("\n") : "  - none"}`,
      brief.excerpts.length ? `- Exact excerpts:\n\n${brief.excerpts.map(fenced).join("\n\n")}` : "- Exact excerpts: none",
    ].join("\n"),
    [
      "## Constraints",
      `- Scope: ${brief.scope || "only what the task requires"}`,
      `- Mode: ${MODE_TEXT[brief.mode]}`,
      `- Project rules:\n${brief.project_rules.length ? brief.project_rules.map((r) => `  - ${r}`).join("\n") : "  - follow AGENTS.md if present"}`,
      `- Do not:\n${brief.do_not.length ? brief.do_not.map((r) => `  - ${r}`).join("\n") : "  - nothing extra"}`,
    ].join("\n"),
    ...(directoryRules.length
      ? [
          `## Directory rules\nThese AGENTS.md files apply to the relevant files. Where they differ, the deeper file wins.\n\n${directoryRules
            .map((r) => `### ${r.file}\n${fenced(r.text)}`)
            .join("\n\n")}`,
        ]
      : []),
    `## Acceptance criteria\n${brief.acceptance.map((a) => `- [ ] ${a}`).join("\n")}`,
    `## Return format\nReply using the report format in delegation-protocol.md §2 (## Status, ## Result, ## Changes, ## Evidence, ## Confidence, ## Open questions / risks).${brief.return_extra ? ` ${brief.return_extra}` : ""}`,
  ]
  if (previous.length) {
    sections.push(
      `## Previous attempts\nEarlier attempts at this exact brief failed. Do not repeat them.\n\n${previous
        .map((p) => `### Attempt ${p.attempt} (${p.provider})\n${fenced(p.problem)}`)
        .join("\n\n")}`,
    )
  }
  return `${sections.join("\n\n")}\n`
}

export const REPORT_STATUSES = ["done", "partial", "blocked", "failed"] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export interface Report {
  status?: ReportStatus
  result: string
  changes: string
  evidence: string
  confidence?: "high" | "medium" | "low"
  confidenceReason: string
  openQuestions: string
  /** True when Status and Result were both present: the delegate followed the protocol. */
  wellFormed: boolean
}

/** The §2 section names. Any other heading (a reviewer's "### Findings") belongs to the section above it. */
const REPORT_SECTIONS = ["status", "result", "changes", "evidence", "confidence", "open question", "risks"]

/** Parse delegation-protocol.md §2. Tolerant of heading levels and decoration; strict about Status. */
export function parseReport(text: string): Report {
  const sections = new Map<string, string>()
  const heading = /^#{1,4}\s+(.+?)\s*#*\s*$/gm
  const marks = [...text.matchAll(heading)]
    .map((m) => ({
      index: m.index ?? 0,
      length: m[0].length,
      key: (m[1] ?? "")
        .toLowerCase()
        .replace(/[^a-z /]/g, "")
        .trim(),
    }))
    .filter((m) => REPORT_SECTIONS.some((s) => m.key.startsWith(s)))
  marks.forEach((m, i) => {
    const end = marks[i + 1]?.index ?? text.length
    if (!sections.has(m.key)) sections.set(m.key, text.slice(m.index + m.length, end).trim())
  })
  const get = (...keys: string[]) => {
    for (const [name, body] of sections) if (keys.some((k) => name.startsWith(k))) return body
    return ""
  }
  const statusText = get("status").toLowerCase()
  const status = REPORT_STATUSES.find((s) => new RegExp(`\\b${s}\\b`).test(statusText.split("\n")[0] ?? ""))
  const confidenceText = get("confidence")
  const confidence = (["high", "medium", "low"] as const).find((c) =>
    new RegExp(`\\b${c}\\b`, "i").test(confidenceText.split("\n")[0] ?? ""),
  )
  const result = get("result")
  return {
    status,
    result,
    changes: get("changes"),
    evidence: get("evidence"),
    confidence,
    confidenceReason: confidenceText.replace(/^\s*(high|medium|low)\s*[—-]?\s*/i, ""),
    openQuestions: get("open questions", "open question", "risks"),
    wellFormed: status !== undefined && result !== "",
  }
}
