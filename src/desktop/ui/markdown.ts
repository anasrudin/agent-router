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

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/

interface ListItem {
  indent: number
  ordered: boolean
  start: number
  text: string
  children: ListItem[]
}

/** Items indented deeper than the one before them become its children. */
function nestItems(flat: ListItem[]): ListItem[] {
  const roots: ListItem[] = []
  const stack: ListItem[] = []
  for (const item of flat) {
    while (stack.length && (stack.at(-1) as ListItem).indent >= item.indent) stack.pop()
    const parent = stack.at(-1)
    if (parent) parent.children.push(item)
    else roots.push(item)
    stack.push(item)
  }
  return roots
}

function renderList(items: ListItem[]): string {
  const first = items[0] as ListItem
  // Models often separate numbered items with blank lines; keep counting instead of restarting at 1.
  const open = first.ordered ? (first.start > 1 ? `<ol start="${first.start}">` : "<ol>") : "<ul>"
  const body = items
    .map((it) => `<li>${it.text.split("\n").map(inline).join("<br>")}${it.children.length ? renderList(it.children) : ""}</li>`)
    .join("")
  return `${open}${body}</${first.ordered ? "ol" : "ul"}>`
}

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
    if (LIST_ITEM.test(line)) {
      const flat: ListItem[] = []
      while (i < lines.length) {
        const current = lines[i] as string
        const item = LIST_ITEM.exec(current)
        if (item) {
          const marker = item[2] as string
          flat.push({
            indent: (item[1] as string).replace(/\t/g, "    ").length,
            ordered: /\d/.test(marker),
            start: Number.parseInt(marker, 10) || 1,
            text: (item[3] as string).replace(/^\[( |x)\]\s*/, (_, x) => (x === "x" ? "☑ " : "☐ ")),
            children: [],
          })
        } else if (flat.length && /^\s{2,}\S/.test(current)) {
          // An indented line under an item continues it.
          const last = flat.at(-1) as ListItem
          last.text += `\n${current.trim()}`
        } else break
        i++
      }
      out.push(renderList(nestItems(flat)))
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
      !/^(#{1,4}\s|\s*(`{3,}|~{3,}))/.test(lines[i] as string) &&
      !LIST_ITEM.test(lines[i] as string) &&
      !isTableRow(lines[i] as string)
    ) {
      para.push(lines[i++] as string)
    }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`)
  }
  return out.join("\n")
}
