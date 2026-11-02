import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expandTemplate } from "../../desktop/ui/composer"
import { deleteTemplate, listTemplates, saveTemplate } from "../templates"

let ws: string
let data: string
beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "tpl-ws-"))
  data = mkdtempSync(path.join(tmpdir(), "tpl-data-"))
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

describe("prompt templates", () => {
  test("yours and the project's, the project's winning on a name clash; delete", () => {
    saveTemplate(ws, data, "user", "review-pr", "Review the PR: $ARGUMENTS")
    saveTemplate(ws, data, "user", "notes", "Write release notes")
    saveTemplate(ws, data, "project", "review-pr", "Project review of $ARGUMENTS")
    expect(listTemplates(ws, data)).toEqual([
      { name: "notes", scope: "user", text: "Write release notes" },
      { name: "review-pr", scope: "project", text: "Project review of $ARGUMENTS" },
    ])
    deleteTemplate(ws, data, "project", "review-pr")
    expect(listTemplates(ws, data).find((t) => t.name === "review-pr")?.scope).toBe("user")
  })
  test("names are checked; text is needed", () => {
    expect(() => saveTemplate(ws, data, "user", "Bad Name", "x")).toThrow(/lowercase/)
    expect(() => saveTemplate(ws, data, "user", "../x", "x")).toThrow(/lowercase/)
    expect(() => saveTemplate(ws, data, "user", "ok", "  ")).toThrow(/text/)
  })
  test("arguments fill $ARGUMENTS, or follow the text", () => {
    expect(expandTemplate("Review $ARGUMENTS carefully", "#12")).toBe("Review #12 carefully")
    expect(expandTemplate("Write notes", "for 0.2")).toBe("Write notes\n\nfor 0.2")
    expect(expandTemplate("Write notes", "")).toBe("Write notes")
  })
})
