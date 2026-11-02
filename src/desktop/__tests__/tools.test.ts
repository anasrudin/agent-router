import { describe, expect, test } from "bun:test"
import { activityLine, editStats, outputTail, shortPath, toolDetail, toolLabel } from "../ui/tools"

describe("tool rows", () => {
  test("labels, MCP prefixes dropped", () => {
    expect(toolLabel("Grep")).toBe("Search")
    expect(toolLabel("mcp__router__check_diff")).toBe("check diff")
  })

  test("the detail that says what it touched", () => {
    expect(toolDetail({ command: "npm test" })).toBe("npm test")
    expect(toolDetail({ file_path: "src/a.ts" })).toBe("src/a.ts")
    expect(toolDetail("/bin/bash -lc ls")).toBe("/bin/bash -lc ls")
    expect(toolDetail(undefined)).toBe("")
  })

  test("edit line counts", () => {
    expect(editStats("Edit", { old_string: "a\nb", new_string: "a\nB\nc\n" })).toEqual({ added: 3, removed: 2 })
    expect(editStats("Write", { content: "x\ny\n" })).toEqual({ added: 2, removed: 0 })
    expect(
      editStats("MultiEdit", {
        edits: [
          { old_string: "a", new_string: "b\nc" },
          { old_string: "", new_string: "d" },
        ],
      }),
    ).toEqual({
      added: 3,
      removed: 1,
    })
    expect(editStats("Read", { file_path: "a" })).toBeUndefined()
  })

  test("the live activity line", () => {
    expect(activityLine("Read", { file_path: "/home/me/repo/src/ui/main.ts" })).toBe("Reading ui/main.ts")
    expect(activityLine("Bash", { command: "npm test\n--watch" })).toBe("Running npm test")
    expect(activityLine("mcp__router__check_diff", {})).toBe("Using check diff")
    expect(activityLine("Grep", { pattern: "x".repeat(200) })).toHaveLength(88)
  })

  test("shortPath and outputTail", () => {
    expect(shortPath("a/b/c/d.ts")).toBe("c/d.ts")
    expect(shortPath("d.ts")).toBe("d.ts")
    expect(outputTail("1\n2\n3\n", 2)).toEqual({ text: "2\n3", more: true })
    expect(outputTail("1\n2", 8)).toEqual({ text: "1\n2", more: false })
    expect(outputTail("…cut\nend", 8).more).toBe(true)
  })
})
