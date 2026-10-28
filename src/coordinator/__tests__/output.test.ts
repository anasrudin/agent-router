import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { capOutput } from "../output"

describe("capOutput()", () => {
  test("short output passes through untouched and writes nothing", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ar-out-"))
    expect(capOutput("## Status\ndone", ws, "openai-code.review", 100)).toBe("## Status\ndone")
    expect(existsSync(path.join(ws, ".harness"))).toBe(false)
  })

  test("long output keeps head and tail, saves the whole text, and keeps it out of git", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ar-out-"))
    const text = `## Status\ndone\n${"x".repeat(1000)}\n## Confidence\nhigh`
    const capped = capOutput(text, ws, "openai/code.review", 200)
    expect(capped.startsWith("## Status\ndone")).toBe(true)
    expect(capped.endsWith("## Confidence\nhigh")).toBe(true)
    const dir = path.join(ws, ".harness", "outputs")
    const saved = readdirSync(dir).filter((f) => f.endsWith(".md"))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toContain("openai_code.review")
    expect(capped).toContain(path.join(dir, saved[0] as string))
    // The saved file's path varies in length by OS temp folder, so leave it out of the size check.
    expect(capped.replace(path.join(dir, saved[0] as string), "").length).toBeLessThan(400)
    expect(readFileSync(path.join(dir, saved[0] as string), "utf8")).toBe(text)
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("*\n")
  })
})
