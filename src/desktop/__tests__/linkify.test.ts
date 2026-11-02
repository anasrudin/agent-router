import { describe, expect, test } from "bun:test"
import { findFileRefs, findLocalUrls, normalizeUrl } from "../ui/linkify"

const paths = (t: string) => findFileRefs(t).map((r) => [r.path, r.line, r.endLine])

describe("findFileRefs", () => {
  test("paths with and without lines", () => {
    expect(paths("see src/coordinator/delegate.ts:354 and greet.js:10-12.")).toEqual([
      ["src/coordinator/delegate.ts", 354, undefined],
      ["greet.js", 10, 12],
    ])
    expect(paths("README.md, /home/me/ws/a.rs:3")).toEqual([
      ["README.md", undefined, undefined],
      ["/home/me/ws/a.rs", 3, undefined],
    ])
  })

  test("not files: web addresses, versions, prose, emails", () => {
    expect(paths("visit example.com or https://x.io/a.ts, v1.2.3, e.g. this, me@mail.com")).toEqual([])
  })

  test("offsets cover the reference and its line", () => {
    const [ref] = findFileRefs("at a/b.ts:9 now")
    expect(ref).toMatchObject({ start: 3, end: 11 })
  })
})

describe("addresses", () => {
  test("normalizeUrl: ports and bare hosts become http addresses", () => {
    expect(normalizeUrl("5173")).toBe("http://localhost:5173/")
    expect(normalizeUrl("localhost:3000/app")).toBe("http://localhost:3000/app")
    expect(normalizeUrl("https://x.dev")).toBe("https://x.dev")
    expect(normalizeUrl("example.com")).toBe("http://example.com")
    expect(normalizeUrl("not a url")).toBeUndefined()
    expect(normalizeUrl("")).toBeUndefined()
  })
  test("findLocalUrls: dev servers only, trailing punctuation dropped", () => {
    const t = "Running at http://localhost:5173/, also http://127.0.0.1:8080/api. Docs: https://x.dev"
    expect(findLocalUrls(t).map((u) => u.url)).toEqual(["http://localhost:5173/", "http://127.0.0.1:8080/api"])
  })
})
