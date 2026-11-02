import { describe, expect, test } from "bun:test"
import { formatAnnotations } from "../ui/annotations"

describe("formatAnnotations", () => {
  test("numbered, with where, the quote (one line, clipped) and the mark", () => {
    const text = formatAnnotations([
      {
        id: "a",
        source: { kind: "file", path: "src/a.ts", start: 3, end: 5 },
        quote: "const x =\n  1",
        mark: "tests",
        note: "cover the empty case",
      },
      { id: "b", source: { kind: "report", title: "Find greet", agent: "scout" }, quote: "x".repeat(400), mark: "clarify" },
      { id: "c", source: { kind: "file", path: "README.md", start: 1, end: 1 }, quote: "Title", mark: "good" },
    ])
    const lines = text.split("\n")
    expect(lines[2]).toBe('1. [Needs tests] src/a.ts lines 3-5, "const x = 1": cover the empty case')
    expect(lines[3]).toStartWith('2. [Clarify] the report of thread "Find greet" (scout), "xxx')
    expect(lines[3]?.length).toBeLessThan(380)
    expect(lines[4]).toBe('3. [Looks good] README.md line 1, "Title"')
  })
})
