import { describe, expect, test } from "bun:test"
import { applyCompletion, PromptHistory, tokenAt } from "../ui/composer"

describe("tokenAt", () => {
  test("@ after a space or at the start, with what follows it", () => {
    expect(tokenAt("look at @src/ma", 15)).toEqual({ kind: "@", start: 8, query: "src/ma" })
    expect(tokenAt("@", 1)).toEqual({ kind: "@", start: 0, query: "" })
    expect(tokenAt("mail me@x", 9)).toBeUndefined()
    expect(tokenAt("@a b", 4)).toBeUndefined()
  })

  test("/ only at the start of a line", () => {
    expect(tokenAt("/rou", 4)).toEqual({ kind: "/", start: 0, query: "rou" })
    expect(tokenAt("first\n/new", 10)).toEqual({ kind: "/", start: 6, query: "new" })
    expect(tokenAt("see src/a", 9)).toBeUndefined()
    expect(tokenAt("a /b", 4)).toBeUndefined()
  })
})

describe("applyCompletion", () => {
  test("replaces the token and the rest of its word, adds one space", () => {
    const t = { kind: "@" as const, start: 4, query: "ma" }
    expect(applyCompletion("see @ma please", 7, t, "@src/main.ts")).toEqual({ value: "see @src/main.ts please", caret: 17 })
    expect(applyCompletion("see @mai", 8, t, "@src/main.ts")).toEqual({ value: "see @src/main.ts ", caret: 17 })
  })
})

describe("PromptHistory", () => {
  test("up walks back, down walks forward and ends at the draft", () => {
    const h = new PromptHistory(["one", "two"])
    expect(h.up("draft")).toBe("two")
    expect(h.up("two")).toBe("one")
    expect(h.up("one")).toBeUndefined()
    expect(h.down()).toBe("two")
    expect(h.down()).toBe("draft")
    expect(h.down()).toBeUndefined()
  })

  test("push dedupes, moves to the end and caps the length", () => {
    const h = new PromptHistory(["a", "b"], 3)
    h.push("a")
    h.push("c")
    h.push("d")
    h.push("  ")
    expect(h.all).toEqual(["a", "c", "d"])
    expect(h.walking).toBe(false)
  })
})
