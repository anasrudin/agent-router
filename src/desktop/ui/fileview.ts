import { findFileRefs, findLocalUrls } from "./linkify"

/**
 * Wrap every file reference under `root` (outside code blocks and links) in a button that opens
 * the file viewer, and every local web address in one that opens the browser panel.
 */
export function linkifyFileRefs(root: HTMLElement, open: (path: string, line?: number) => void, openUrl?: (url: string) => void): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.parentElement as HTMLElement).closest("pre, a, button, .file-link") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text)
  for (const node of texts) {
    const value = node.nodeValue ?? ""
    const urls = openUrl ? findLocalUrls(value).map((u) => ({ ...u, kind: "url" as const })) : []
    const files = findFileRefs(value)
      .filter((f) => !urls.some((u) => f.start < u.end && f.end > u.start))
      .map((f) => ({ ...f, kind: "file" as const }))
    const refs = [...urls, ...files].sort((a, b) => a.start - b.start)
    if (!refs.length) continue
    const frag = document.createDocumentFragment()
    let at = 0
    for (const ref of refs) {
      frag.append(value.slice(at, ref.start))
      const b = document.createElement("button")
      b.type = "button"
      b.className = "file-link"
      b.textContent = value.slice(ref.start, ref.end)
      if (ref.kind === "url") {
        b.title = `Preview ${ref.url} in the browser panel`
        b.addEventListener("click", (e) => {
          e.stopPropagation()
          openUrl?.(ref.url)
        })
      } else {
        b.title = `Open ${ref.path}${ref.line ? ` at line ${ref.line}` : ""}`
        b.addEventListener("click", (e) => {
          e.stopPropagation()
          open(ref.path, ref.line)
        })
      }
      frag.append(b)
      at = ref.end
    }
    frag.append(value.slice(at))
    node.replaceWith(frag)
  }
}

export interface FileContent {
  path: string
  text: string
  truncated: boolean
  /** When it was read, to refuse saving over a newer version. */
  mtime?: number
  error?: string
}

/**
 * A workspace file in the side panel, as Ghostex's Files pane shows one: line numbers, the
 * referenced line (or range) marked and scrolled to the middle.
 */
export function renderFileView(container: HTMLElement, file: FileContent, line?: number, endLine?: number): void {
  container.replaceChildren()
  if (file.error) {
    const err = document.createElement("div")
    err.className = "error"
    err.textContent = file.error
    container.append(err)
    return
  }
  const view = document.createElement("div")
  view.className = "file-view mono"
  view.setAttribute("role", "region")
  view.setAttribute("aria-label", `${file.path}${line ? `, line ${line}` : ""}`)
  const lines = file.text.replace(/\n$/, "").split("\n")
  const last = endLine ?? line
  let target: HTMLElement | undefined
  lines.forEach((text, i) => {
    const n = i + 1
    const row = document.createElement("div")
    row.className = "file-line"
    row.dataset.line = String(n)
    if (line !== undefined && n >= line && n <= (last ?? line)) row.classList.add("marked")
    const num = document.createElement("span")
    num.className = "file-num"
    num.textContent = String(n)
    const code = document.createElement("span")
    code.className = "file-code"
    code.textContent = text || " "
    row.append(num, code)
    view.append(row)
    if (n === line) target = row
  })
  container.append(view)
  if (file.truncated) {
    const note = document.createElement("div")
    note.className = "muted"
    note.textContent = "The file is cut off here: it is too large to show in full."
    container.append(note)
  }
  if (target) requestAnimationFrame(() => target?.scrollIntoView({ block: "center" }))
}
