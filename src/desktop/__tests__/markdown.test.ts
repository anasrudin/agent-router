import { describe, expect, test } from "bun:test"
import { renderMarkdown } from "../ui/markdown"

describe("renderMarkdown()", () => {
  test("escapes HTML from model output", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)"> **hi**')).toBe(
      "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; <strong>hi</strong></p>",
    )
  })
  test("numbered items split by blank lines keep their numbers", () => {
    expect(renderMarkdown("1. one\n\n2. two")).toBe('<ol><li>one</li></ol>\n<ol start="2"><li>two</li></ol>')
  })
  test("code fences are verbatim and escaped", () => {
    expect(renderMarkdown("```ts\nconst a = <T>() => 1\n```")).toBe("<pre><code>const a = &lt;T&gt;() =&gt; 1</code></pre>")
  })
  test("tables", () => {
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | `x` |")).toContain("<td><code>x</code></td>")
  })
})
