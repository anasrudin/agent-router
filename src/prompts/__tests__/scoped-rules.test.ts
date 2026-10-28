import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Brief, renderBrief } from "../../coordinator/protocol"
import { scopedRules } from "../scoped-rules"

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "ar-rules-"))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

describe("scopedRules()", () => {
  const ws = workspace({
    "AGENTS.md": "root rules",
    "src/AGENTS.md": "src rules",
    "src/api/AGENTS.md": "api rules",
    "src/api/handler.ts": "",
    "docs/AGENTS.md": "docs rules",
  })

  test("collects AGENTS.md from each file's folder up to, not including, the root; shallow first", () => {
    expect(scopedRules(ws, ["src/api/handler.ts:10-20"])).toEqual([
      { file: "src/AGENTS.md", text: "src rules" },
      { file: "src/api/AGENTS.md", text: "api rules" },
    ])
  })

  test("shared folders are listed once; unrelated folders are not listed", () => {
    expect(scopedRules(ws, ["src/api/handler.ts", "src/api/routes.ts", "src/util.ts"]).map((r) => r.file)).toEqual([
      "src/AGENTS.md",
      "src/api/AGENTS.md",
    ])
  })

  test("paths outside the workspace are ignored", () => {
    expect(scopedRules(ws, ["../elsewhere/AGENTS.md", "/etc/passwd"])).toEqual([])
  })

  test("long files are truncated", () => {
    const big = workspace({ "pkg/AGENTS.md": "x".repeat(10_000) })
    const [rule] = scopedRules(big, ["pkg/index.ts"])
    expect(rule?.text.length).toBeLessThan(4_200)
    expect(rule?.text).toContain("[truncated at 4000 characters")
  })

  test("the brief carries them under Directory rules", () => {
    const brief = Brief.parse({ task: "t", why: "w", acceptance: ["a"], relevant_files: ["src/api/handler.ts"] })
    const text = renderBrief(brief, ws, [], scopedRules(ws, brief.relevant_files))
    expect(text).toContain("## Directory rules")
    expect(text).toContain("### src/api/AGENTS.md\n```\napi rules\n```")
    expect(text).not.toContain("root rules")
    expect(renderBrief(brief, ws)).not.toContain("## Directory rules")
  })
})

describe("scopedRules() from other tools' rule files", () => {
  const ws = workspace({
    ".github/copilot-instructions.md": "copilot always",
    ".github/instructions/ts.instructions.md": '---\napplyTo: "**/*.ts"\n---\nts via copilot',
    ".github/instructions/py.instructions.md": '---\napplyTo: "**/*.py"\n---\npy via copilot',
    ".cursor/rules/react.mdc": "---\ndescription: React\nglobs: *.tsx, *.jsx\nalwaysApply: false\n---\nreact via cursor",
    ".cursor/rules/style.mdc": "---\nalwaysApply: true\n---\nstyle via cursor",
    ".cursor/rules/ask.mdc": "---\ndescription: only when asked\n---\nagent requested",
    ".claude/rules/api.md": "---\npaths:\n  - src/api/**\n---\napi via claude rules",
    ".claude/rules/general.md": "general via claude rules",
    "src/api/AGENTS.md": "api agents",
  })
  const texts = (files: string[], provider?: "claude" | "gemini" | "openai") => scopedRules(ws, files, provider).map((r) => r.text)

  test("front matter scopes each rule to matching files; AGENTS.md comes last", () => {
    expect(texts(["src/api/handler.ts"], "gemini")).toEqual([
      "copilot always",
      "ts via copilot",
      "style via cursor",
      "api via claude rules",
      "general via claude rules",
      "api agents",
    ])
    expect(texts(["web/App.tsx"], "openai")).toEqual(["copilot always", "react via cursor", "style via cursor", "general via claude rules"])
  })

  test("Claude delegates load .claude/rules themselves, so the brief leaves them out", () => {
    expect(texts(["src/api/handler.ts"], "claude")).toEqual(["copilot always", "ts via copilot", "style via cursor", "api agents"])
  })

  test("with no relevant files only always-on rules apply", () => {
    expect(texts([], "gemini")).toEqual(["copilot always", "style via cursor", "general via claude rules"])
  })

  test("broken front matter does not break the brief", () => {
    const bad = workspace({ ".cursor/rules/bad.mdc": "---\nglobs: [unclosed\n---\nbody" })
    expect(scopedRules(bad, ["a.ts"], "gemini")).toEqual([])
  })
})

describe("scopedRules() budget", () => {
  test("always-on rule files from other tools cannot crowd out a directory's AGENTS.md", () => {
    const big = "x".repeat(5_000)
    const ws = workspace({
      ".github/copilot-instructions.md": big,
      ".cursor/rules/a.mdc": `---\nalwaysApply: true\n---\n${big}`,
      ".cursor/rules/b.mdc": `---\nalwaysApply: true\n---\n${big}`,
      "pkg/AGENTS.md": "pkg rules",
    })
    const rules = scopedRules(ws, ["pkg/index.ts"], "gemini")
    expect(rules.at(-1)).toEqual({ file: "pkg/AGENTS.md", text: "pkg rules" })
    expect(rules.reduce((n, r) => n + r.text.length, 0)).toBeLessThan(12_300)
  })
})
