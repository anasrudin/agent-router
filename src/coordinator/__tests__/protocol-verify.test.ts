import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { listAgents } from "../../prompts/render"
import { Brief, parseReport, renderBrief } from "../protocol"
import { checkReport, scanDiff, workingTreeDiff } from "../verify"

describe("renderBrief()", () => {
  const brief = Brief.parse({
    task: "Fix the crash.",
    why: "Users lose work.",
    relevant_files: ["src/a.ts:10-20"],
    excerpts: ["TypeError: x is undefined\n    at a.ts:12", "```js\ncode\n```"],
    acceptance: ["`bun test` passes"],
    mode: "edit",
  })
  const text = renderBrief(brief, "C:\\work\\app", [{ attempt: 1, provider: "claude", problem: "timeout" }])
  test("has every protocol section in order", () => {
    const order = [
      "## Task",
      "## Why",
      "## Context",
      "## Constraints",
      "## Acceptance criteria",
      "## Return format",
      "## Previous attempts",
    ]
    const positions = order.map((h) => text.indexOf(h))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
  test("excerpts are verbatim and fences cannot break out", () => {
    expect(text).toContain("TypeError: x is undefined\n    at a.ts:12")
    expect(text).toContain("````\n```js\ncode\n```\n````")
  })
  test("windows workspace path kept as-is", () => expect(text).toContain("- Workspace: C:\\work\\app"))
})

describe("parseReport()", () => {
  test("standard report", () => {
    const r = parseReport(
      "## Status\ndone\n\n## Result\nok\n\n## Evidence\nran tests\n\n## Confidence\nmedium — partial coverage\n\n## Open questions / risks\nnone",
    )
    expect(r).toMatchObject({
      status: "done",
      result: "ok",
      confidence: "medium",
      confidenceReason: "partial coverage",
      openQuestions: "none",
      wellFormed: true,
    })
  })
  test("bold status and ### headings", () => {
    expect(parseReport("### Status\n**partial**\n### Result\nhalf").status).toBe("partial")
  })
  test("sub-headings inside Result stay in Result", () => {
    // Recorded from Codex as the reviewer: rejected as malformed before sub-headings were allowed.
    const r = parseReport(
      "## Status\ndone\n\n## Result\n\n### Verdict\nrequest-changes\n\n### Findings\n- major — escalation.ts:61\n\n## Changes\nNone.\n\n## Evidence\nRead it.\n\n## Confidence\nhigh — traced",
    )
    expect(r).toMatchObject({ status: "done", changes: "None.", evidence: "Read it.", confidence: "high", wellFormed: true })
    expect(r.result).toContain("### Verdict\nrequest-changes")
    expect(r.result).toContain("escalation.ts:61")
  })
  test("free text is not well formed", () => {
    expect(parseReport("All done, tests pass!").wellFormed).toBe(false)
  })
  test("checkReport flags missing evidence and low confidence", () => {
    const r = parseReport("## Status\ndone\n## Result\nx\n## Confidence\nlow — guessed")
    const msgs = checkReport(r, Brief.parse({ task: "t", why: "w", acceptance: ["a"] })).map((f) => f.message)
    expect(msgs.some((m) => m.includes("No Evidence"))).toBe(true)
    expect(msgs.some((m) => m.includes("Low confidence: guessed"))).toBe(true)
  })
})

describe("scanDiff()", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "+// @ts-ignore",
    "+  try { go() } catch {}",
    "-// @ts-ignore removed lines are fine",
    "+  it.skip('works', () => {})",
    "+  // TODO: implement",
    "+  const fine = 1",
  ].join("\n")
  test("flags each shortcut on added lines only", () => {
    const labels = scanDiff(diff).map((f) => f.message.split(": ")[1])
    expect(labels).toEqual(["TypeScript check suppressed", "swallowed error", "test skipped or focused", "placeholder code"])
  })
  test("deleted test file", () => {
    const del = "diff --git a/x.test.ts b/x.test.ts\ndeleted file mode 100644\n--- a/x.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-test()"
    expect(scanDiff(del).some((f) => f.message.startsWith("test file deleted"))).toBe(true)
  })
})

describe("workingTreeDiff()", () => {
  test("includes untracked files without touching the index", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ar-git-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
    git("init", "-q")
    writeFileSync(path.join(dir, "new.ts"), "// @ts-ignore\n")
    const diff = workingTreeDiff(dir)
    expect(diff).toContain("+// @ts-ignore")
    expect(git("status", "--porcelain")).toBe("?? new.ts\n")
  })
})

describe("prompt assets", () => {
  test("all seven agents load with a mode", () => {
    expect(listAgents().map((a) => a.name)).toEqual(["architect", "librarian", "looker", "planner", "reviewer", "scout", "worker"])
    expect(listAgents().find((a) => a.name === "worker")?.mode).toBe("edit")
  })
})
