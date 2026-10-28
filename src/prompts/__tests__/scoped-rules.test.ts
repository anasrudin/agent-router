import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Brief, renderBrief } from "../../coordinator/protocol"
import { scopedAgentsMd } from "../scoped-rules"

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "ar-rules-"))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

describe("scopedAgentsMd()", () => {
  const ws = workspace({
    "AGENTS.md": "root rules",
    "src/AGENTS.md": "src rules",
    "src/api/AGENTS.md": "api rules",
    "src/api/handler.ts": "",
    "docs/AGENTS.md": "docs rules",
  })

  test("collects AGENTS.md from each file's folder up to, not including, the root; shallow first", () => {
    expect(scopedAgentsMd(ws, ["src/api/handler.ts:10-20"])).toEqual([
      { file: "src/AGENTS.md", text: "src rules" },
      { file: "src/api/AGENTS.md", text: "api rules" },
    ])
  })

  test("shared folders are listed once; unrelated folders are not listed", () => {
    expect(scopedAgentsMd(ws, ["src/api/handler.ts", "src/api/routes.ts", "src/util.ts"]).map((r) => r.file)).toEqual([
      "src/AGENTS.md",
      "src/api/AGENTS.md",
    ])
  })

  test("paths outside the workspace are ignored", () => {
    expect(scopedAgentsMd(ws, ["../elsewhere/AGENTS.md", "/etc/passwd"])).toEqual([])
  })

  test("long files are truncated", () => {
    const big = workspace({ "pkg/AGENTS.md": "x".repeat(10_000) })
    const [rule] = scopedAgentsMd(big, ["pkg/index.ts"])
    expect(rule?.text.length).toBeLessThan(4_200)
    expect(rule?.text).toContain("[truncated at 4000 characters")
  })

  test("the brief carries them under Directory rules", () => {
    const brief = Brief.parse({ task: "t", why: "w", acceptance: ["a"], relevant_files: ["src/api/handler.ts"] })
    const text = renderBrief(brief, ws, [], scopedAgentsMd(ws, brief.relevant_files))
    expect(text).toContain("## Directory rules")
    expect(text).toContain("### src/api/AGENTS.md\n```\napi rules\n```")
    expect(text).not.toContain("root rules")
    expect(renderBrief(brief, ws)).not.toContain("## Directory rules")
  })
})
