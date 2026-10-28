import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fakeRegistry, testSession } from "../../test-support"
import { delegate } from "../delegate"
import { checkEvidence, citedEvidence, EVIDENCE_DIR, keepsEvidence, prepareEvidenceDir } from "../evidence"
import { Brief, parseReport, renderBrief } from "../protocol"

const OUTPUT = "PASS src/a.test.ts\n  ✓ adds (2 ms)\nTests: 1 passed, 1 total\n"

function workspace(): string {
  const ws = mkdtempSync(path.join(tmpdir(), "ar-ev-"))
  prepareEvidenceDir(ws)
  return ws
}

const brief = (mode: Brief["mode"]) => Brief.parse({ task: "Fix it.", why: "Broken.", acceptance: ["tests pass"], mode })

const reportWith = (evidence: string, status = "done") =>
  parseReport(`## Status\n${status}\n## Result\nFixed.\n## Changes\n- a.ts\n## Evidence\n${evidence}\n## Confidence\nhigh`)

describe("citedEvidence()", () => {
  test("a quoted path is taken whole, spaces included", () => {
    expect(citedEvidence("- `npm test` → `.harness/evidence/test output.txt`")).toEqual([".harness/evidence/test output.txt"])
  })

  test("finds paths with either slash, drops trailing punctuation and duplicates", () => {
    expect(
      citedEvidence(
        "- `npm test` passed (.harness/evidence/tests.txt).\n- see .harness\\evidence\\lint.txt: clean, and .harness/evidence/tests.txt",
      ),
    ).toEqual([".harness/evidence/tests.txt", ".harness/evidence/lint.txt"])
  })
})

describe("checkEvidence()", () => {
  test("a real, fresh receipt passes; the folder is ignored by git", () => {
    const ws = workspace()
    const started = Date.now()
    writeFileSync(path.join(ws, EVIDENCE_DIR, "tests.txt"), OUTPUT)
    expect(checkEvidence(reportWith("- npm test: .harness/evidence/tests.txt"), ws, "edit", "claude", started)).toEqual([])
    expect(readFileSync(path.join(ws, EVIDENCE_DIR, ".gitignore"), "utf8")).toBe("*\n")
  })

  test("missing, stale, empty, symlinked and escaping receipts are rejected", () => {
    const ws = workspace()
    const dir = path.join(ws, EVIDENCE_DIR)
    writeFileSync(path.join(dir, "old.txt"), OUTPUT)
    utimesSync(path.join(dir, "old.txt"), new Date(2020, 0, 1), new Date(2020, 0, 1))
    writeFileSync(path.join(dir, "tiny.txt"), " \n")
    writeFileSync(path.join(dir, "short.txt"), "v1\n")
    writeFileSync(path.join(ws, "outside.txt"), OUTPUT)
    // Creating symlinks needs extra privileges on Windows.
    const links = process.platform !== "win32"
    if (links) symlinkSync(path.join(ws, "outside.txt"), path.join(dir, "link.txt"))
    mkdirSync(path.join(dir, "folder.txt"))
    const cited = ["short", "missing", "old", "tiny", ...(links ? ["link"] : []), "folder"]
      .map((n) => `.harness/evidence/${n}.txt`)
      .join("\n")
    const findings = checkEvidence(reportWith(`${cited}\n.harness/evidence/../../outside.txt`), ws, "edit", "claude", Date.now())
    expect(findings.map((f) => [f.severity, f.message.split(" ").slice(0, 3).join(" ")])).toEqual([
      ["reject", "Evidence file .harness/evidence/missing.txt"],
      ["reject", "Evidence file .harness/evidence/old.txt"],
      ["reject", "Evidence file .harness/evidence/tiny.txt"],
      ...(links ? [["reject", "Evidence path .harness/evidence/link.txt"]] : []),
      ["reject", "Evidence path .harness/evidence/folder.txt"],
      ["reject", "Evidence path .harness/evidence/../../outside.txt"],
    ])
  })

  test("no receipt cited is a check, not a reject; read-only work and blocked reports need none", () => {
    const ws = workspace()
    expect(checkEvidence(reportWith("- ran npm test, all passed"), ws, "edit", "claude", Date.now())).toMatchObject([{ severity: "check" }])
    expect(checkEvidence(reportWith("- read a.ts:10"), ws, "read-only", "claude", Date.now())).toEqual([])
    expect(checkEvidence(reportWith("- none", "blocked"), ws, "edit", "claude", Date.now())).toEqual([])
  })

  test("only delegates that can write a file are asked for receipts", () => {
    expect(keepsEvidence("edit", "openai")).toBe(true)
    expect(keepsEvidence("run-commands", "claude")).toBe(true)
    // Codex runs commands in a read-only sandbox; Gemini's headless default declines writes.
    expect(keepsEvidence("run-commands", "openai")).toBe(false)
    expect(keepsEvidence("run-commands", "gemini")).toBe(false)
    expect(keepsEvidence("read-only", "claude")).toBe(false)
    expect(renderBrief(brief("edit"), "/ws")).toContain(EVIDENCE_DIR)
    expect(renderBrief(brief("run-commands"), "/ws")).not.toContain(EVIDENCE_DIR)
    expect(renderBrief(brief("run-commands"), "/ws", [], [], true)).toContain(EVIDENCE_DIR)
    expect(checkEvidence(reportWith("- ran it"), workspace(), "run-commands", "openai", Date.now())).toEqual([])
  })
})

describe("delegate() with evidence", () => {
  test("a done edit citing a receipt it never saved gets a reject finding; the folder exists for it", async () => {
    const text = `## Status\ndone\n## Result\nFixed.\n## Changes\n- a.ts\n## Evidence\n- npm test: .harness/evidence/tests.txt\n## Confidence\nhigh`
    const session = testSession(fakeRegistry({ claude: [{ text }] }))
    const r = await delegate(session, { taskClass: "code.edit", brief: brief("edit") })
    expect(r.findings).toContainEqual({ severity: "reject", message: expect.stringContaining("never saved") })
    expect(readFileSync(path.join(session.workspace, EVIDENCE_DIR, ".gitignore"), "utf8")).toBe("*\n")
  })
})
