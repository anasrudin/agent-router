import { normalizeUrl } from "./linkify"

/**
 * Side-panel views besides threads: a browser for localhost previews (Ghostex's browser pane)
 * and the workspace's file tree.
 */

export interface BrowserState {
  url: string
  /** Bumped to reload. */
  nonce: number
}

export function renderBrowser(
  body: HTMLElement,
  state: BrowserState,
  o: { navigate: (url: string) => void; external: (url: string) => void; reload: () => void },
) {
  const bar = document.createElement("form")
  bar.className = "preview-bar"
  const input = document.createElement("input")
  input.type = "text"
  input.value = state.url
  input.placeholder = "localhost:5173 or a full address"
  input.setAttribute("aria-label", "Address")
  input.spellcheck = false
  bar.addEventListener("submit", (e) => {
    e.preventDefault()
    const url = normalizeUrl(input.value)
    if (url) o.navigate(url)
  })
  const reload = document.createElement("button")
  reload.type = "button"
  reload.className = "icon-btn"
  reload.title = "Reload"
  reload.setAttribute("aria-label", "Reload")
  reload.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" /></svg>`
  reload.addEventListener("click", o.reload)
  const ext = document.createElement("button")
  ext.type = "button"
  ext.className = "icon-btn"
  ext.title = "Open in your browser"
  ext.setAttribute("aria-label", "Open in your browser")
  ext.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></svg>`
  ext.addEventListener("click", () => state.url && o.external(state.url))
  bar.append(input, reload, ext)
  body.append(bar)
  if (!state.url) {
    const hint = document.createElement("p")
    hint.className = "muted preview-hint"
    hint.textContent = "Preview your dev server here: type its port or address. Local addresses in replies open here too."
    body.append(hint)
    requestAnimationFrame(() => input.focus())
    return
  }
  const frame = document.createElement("iframe")
  frame.className = "preview-frame"
  frame.title = `Preview of ${state.url}`
  frame.src = state.url
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-modals")
  frame.dataset.nonce = String(state.nonce)
  body.append(frame)
}

interface Dir {
  name: string
  path: string
  dirs: Map<string, Dir>
  files: string[]
}

function buildTree(paths: string[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split("/")
    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: new Map(), files: [] }
        dir.dirs.set(part, next)
      }
      dir = next
    }
    dir.files.push(p)
  }
  return root
}

/** The file tree: folders open on click (all open while filtering), files open in the viewer. */
export function renderFileTree(
  body: HTMLElement,
  files: string[] | undefined,
  o: { filter: string; open: Set<string>; openFile: (path: string) => void; setFilter: (q: string) => void; redraw: () => void },
) {
  const search = document.createElement("input")
  search.type = "search"
  search.className = "tree-filter"
  search.placeholder = "Filter files"
  search.setAttribute("aria-label", "Filter files")
  search.value = o.filter
  search.addEventListener("input", () => o.setFilter(search.value))
  body.append(search)
  if (!files) {
    body.append(Object.assign(document.createElement("div"), { className: "muted", textContent: "Loading files…" }))
    return
  }
  const q = o.filter.trim().toLowerCase()
  const shown = q ? files.filter((f) => f.toLowerCase().includes(q)) : files
  const list = document.createElement("ul")
  list.className = "file-tree"
  list.setAttribute("role", "tree")
  const walk = (dir: Dir, parent: HTMLElement, depth: number) => {
    for (const sub of [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const open = Boolean(q) || o.open.has(sub.path)
      const li = document.createElement("li")
      li.setAttribute("role", "treeitem")
      li.setAttribute("aria-expanded", String(open))
      const b = document.createElement("button")
      b.type = "button"
      b.className = "tree-node dir"
      b.style.paddingLeft = `${8 + depth * 14}px`
      b.innerHTML = `<svg class="tree-chev${open ? " open" : ""}" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>`
      b.append(document.createTextNode(sub.name))
      b.addEventListener("click", () => {
        if (o.open.has(sub.path)) o.open.delete(sub.path)
        else o.open.add(sub.path)
        o.redraw()
      })
      li.append(b)
      if (open) {
        const ul = document.createElement("ul")
        ul.setAttribute("role", "group")
        walk(sub, ul, depth + 1)
        li.append(ul)
      }
      parent.append(li)
    }
    for (const f of dir.files.sort()) {
      const li = document.createElement("li")
      li.setAttribute("role", "treeitem")
      const b = document.createElement("button")
      b.type = "button"
      b.className = "tree-node file"
      b.style.paddingLeft = `${22 + depth * 14}px`
      b.textContent = f.slice(f.lastIndexOf("/") + 1)
      b.title = f
      b.addEventListener("click", () => o.openFile(f))
      li.append(b)
      parent.append(li)
    }
  }
  walk(buildTree(shown.slice(0, 5000)), list, 0)
  if (!shown.length) body.append(Object.assign(document.createElement("div"), { className: "muted", textContent: "No files match." }))
  body.append(list)
}
