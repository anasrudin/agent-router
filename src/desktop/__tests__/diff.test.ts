import { describe, expect, test } from "bun:test"
import { formatReview, parseUnifiedDiff } from "../ui/diff"

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 45e303f..29ce252 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ function f() {
 keep
-old line
+new line
+added
 tail
\\ No newline at end of file
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ`

describe("parseUnifiedDiff()", () => {
  const files = parseUnifiedDiff(PATCH)

  test("numbers lines on both sides", () => {
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: "ctx", old: 10, new: 10, text: "keep" },
      { kind: "del", old: 11, text: "old line" },
      { kind: "add", new: 11, text: "new line" },
      { kind: "add", new: 12, text: "added" },
      { kind: "ctx", old: 12, new: 13, text: "tail" },
    ])
  })

  test("deleted, renamed and binary files", () => {
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["src/a.ts", "modified", false],
      ["gone.ts", "deleted", false],
      ["new/name.ts", "renamed", false],
      ["logo.png", "modified", true],
    ])
    expect(files[2]?.oldPath).toBe("old/name.ts")
  })
})

describe("formatReview()", () => {
  const target = { title: "Fix login", agent: "worker", taskClass: "code.edit", provider: "openai", sessionId: "t-1", resumable: true }

  test("each comment with its file and lines, and how to resume the delegate", () => {
    const text = formatReview(target, [
      { file: "src/a.ts", start: 11, end: 12, side: "new", text: 'Use "const" here' },
      { file: "src/a.ts", start: 11, end: 11, side: "old", text: "Keep this" },
    ])
    expect(text).toContain('thread "Fix login" (worker · code.edit, ran on openai, session t-1)')
    expect(text).toContain('File: src/a.ts\nLines: 11-12\nUser comment: "Use \\"const\\" here"')
    expect(text).toContain("Line: 11 (deleted lines, numbered as before the change)")
    expect(text).toContain('resume { provider: "openai", session_id: "t-1" }')
  })

  test("a backend that cannot resume gets a fresh brief instead", () => {
    const text = formatReview({ ...target, provider: "gemini", resumable: false }, [
      { file: "a", start: 1, end: 1, side: "new", text: "x" },
    ])
    expect(text).toContain("cannot be resumed")
    expect(text).not.toContain("resume {")
  })
})
