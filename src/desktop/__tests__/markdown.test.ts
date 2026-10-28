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
  test("nested lists nest instead of flattening into one numbered list", () => {
    expect(renderMarkdown("1. **Register.** In cli.ts:\n   - add .version()\n   - keep `-V`\n2. Test\n   - spawn it")).toBe(
      "<ol><li><strong>Register.</strong> In cli.ts:<ul><li>add .version()</li><li>keep <code>-V</code></li></ul></li><li>Test<ul><li>spawn it</li></ul></li></ol>",
    )
  })
  test("an indented line continues its item; a paragraph after a list is a paragraph", () => {
    expect(renderMarkdown("- first\n  more of first\n- second\n\nAfter <b>")).toBe(
      "<ul><li>first<br>more of first</li><li>second</li></ul>\n<p>After &lt;b&gt;</p>",
    )
  })
  test("code fences are verbatim and escaped", () => {
    expect(renderMarkdown("```ts\nconst a = <T>() => 1\n```")).toBe("<pre><code>const a = &lt;T&gt;() =&gt; 1</code></pre>")
  })
  test("tables", () => {
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | `x` |")).toContain("<td><code>x</code></td>")
  })
})
