import { describe, expect, test } from "bun:test"
import { renderMarkdown, renderMarkdownBlocks, resultLine } from "../ui/markdown"

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
  test("a chart block becomes an SVG chart; a broken one stays code", () => {
    const html = renderMarkdown(
      '```chart\n{"type":"bar","title":"<b>T</b>","labels":["a","b"],"series":[{"name":"n","values":[1,3]}]}\n```',
    )
    expect(html).toStartWith('<figure class="chart chart-bar">')
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;")
    expect(html.match(/<rect /g)).toHaveLength(2)
    expect(renderMarkdown('```chart\n{"type":"pie"}\n```')).toStartWith("<pre><code>")
    const line = renderMarkdown('```chart\n{"type":"line","labels":["a","b","c"],"series":[{"name":"x","values":[1,2,"3"]}]}\n```')
    expect(line).toContain("<polyline")
  })
  test("tables", () => {
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | `x` |")).toContain("<td><code>x</code></td>")
  })
})

describe("code spans", () => {
  test("escaped backticks inside single-backtick code, as models write them", () => {
    expect(renderMarkdown("`return \\`Goodbye, name.\\``")).toBe("<p><code>return `Goodbye, name.`</code></p>")
  })
  test("a Windows path ending in a backslash still closes where CommonMark says", () => {
    expect(renderMarkdown("Open `C:\\work\\` and run `npm test`.")).toBe(
      "<p>Open <code>C:\\work\\</code> and run <code>npm test</code>.</p>",
    )
  })
  test("an unclosed backtick stays text", () => {
    expect(renderMarkdown("a ` b")).toBe("<p>a ` b</p>")
  })
  test("double backticks show a single backtick inside, and emphasis does not apply in code", () => {
    expect(renderMarkdown("returns `` `Hello, name!` `` and `a*b*c`")).toBe(
      "<p>returns <code>`Hello, name!`</code> and <code>a*b*c</code></p>",
    )
  })
})

describe("resultLine()", () => {
  test("skips a sub-heading at the top of Result", () => {
    expect(resultLine("## Result\n### Verdict\nNo defects found.\n\n## Evidence\nx")).toBe("No defects found.")
  })
  test("first line of the Result section, without list or code marks", () => {
    const report = "## Status\ndone\n\n## Result\n\n- `src/a.ts:12` — **createSession()**\n- more\n\n## Evidence\nran grep"
    expect(resultLine(report)).toBe("src/a.ts:12 — createSession()")
  })
  test("underscores in names survive", () => {
    expect(resultLine("## Result\nReads of `budget.delegate_tokens` in `src/__tests__/`")).toBe(
      "Reads of budget.delegate_tokens in src/__tests__/",
    )
  })
  test("a report without sections falls back to its first line", () => {
    expect(resultLine("\nAll good.\nDetails")).toBe("All good.")
  })
})

describe("visuals", () => {
  test("a workspace picture becomes an image the app resolves; web pictures and script URLs stay text", () => {
    expect(renderMarkdown("See ![chart](out/chart.png)")).toBe(
      '<p>See <img class="md-img" data-src="out/chart.png" alt="chart" loading="lazy"></p>',
    )
    expect(renderMarkdown("![x](https://evil.example/t.png)")).toBe("<p>![x](https://evil.example/t.png)</p>")
    expect(renderMarkdown("![x](javascript:alert(1))")).not.toContain("<img")
    expect(renderMarkdown('![a" onerror="x](p.png)')).not.toContain('onerror="x"')
  })
  test("stat tiles from a stats block, escaped; a broken one stays code", () => {
    const html = renderMarkdown('```stats\n[{"label":"Cost","value":"$0.12","delta":"-8%"},{"label":"<b>","value":"3"}]\n```')
    expect(html).toContain('<div class="stat-tile">')
    expect(html).toContain('stat-delta down">-8%')
    expect(html).toContain("&lt;b&gt;")
    expect(renderMarkdown("```stats\n{oops\n```")).toStartWith("<pre>")
  })
  test("block render keeps each block's source lines, fences with blank lines included", () => {
    const html = renderMarkdownBlocks("# Title\n\nPara one\nline two\n\n```\ncode\n\nmore\n```\n- a")
    expect(html.match(/data-line="(\d+)" data-end="(\d+)"/g)).toEqual([
      'data-line="1" data-end="1"',
      'data-line="3" data-end="4"',
      'data-line="6" data-end="10"',
      'data-line="11" data-end="11"',
    ])
  })
})
