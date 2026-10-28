/**
 * Small markdown renderer for Conductor and delegate output. Everything is escaped first, so
 * model output can never inject markup; only the constructs below are turned back into HTML.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line)
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim())

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const marker = fence[2] as string
      const body: string[] = []
      i++
      while (i < lines.length && !(lines[i] as string).trim().startsWith(marker)) body.push(lines[i++] as string)
      i++
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min((heading[1] as string).length + 2, 6)
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`)
      i++
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] as string)) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i] as string)) rows.push(cells(lines[i++] as string))
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      )
      continue
    }
    const list = /^\s*([-*]|\d+\.)\s+/.exec(line)
    if (list) {
      const ordered = /\d/.test(list[1] as string)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] as string)) {
        items.push((lines[i++] as string).replace(/^\s*([-*]|\d+\.)\s+/, "").replace(/^\[( |x)\]\s*/, (_, x) => (x === "x" ? "☑ " : "☐ ")))
      }
      // Models often separate numbered items with blank lines; keep counting instead of restarting at 1.
      const start = ordered ? Number.parseInt(list[1] as string, 10) : 1
      const open = ordered ? (start > 1 ? `<ol start="${start}">` : "<ol>") : "<ul>"
      out.push(`${open}${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`)
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      (lines[i] as string).trim() &&
      !/^(#{1,4}\s|\s*([-*]|\d+\.)\s|\s*(`{3,}|~{3,}))/.test(lines[i] as string) &&
      !isTableRow(lines[i] as string)
    ) {
      para.push(lines[i++] as string)
    }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`)
  }
  return out.join("\n")
}
