/**
 * The built-in editor (Ghostex ships an IDE that loads on demand; this is the light version):
 * CodeMirror 6 for a workspace file, with the language picked from its extension. It loads the
 * first time a file is edited.
 */
export interface EditorHandle {
  text(): string
  focus(): void
  destroy(): void
}

async function language(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  if (/^(ts|tsx|js|jsx|mjs|cjs)$/.test(ext)) {
    const { javascript } = await import("@codemirror/lang-javascript")
    return javascript({ typescript: ext.startsWith("ts"), jsx: ext.endsWith("x") })
  }
  if (ext === "py") return (await import("@codemirror/lang-python")).python()
  if (ext === "json") return (await import("@codemirror/lang-json")).json()
  if (ext === "md" || ext === "markdown") return (await import("@codemirror/lang-markdown")).markdown()
  if (/^(css|scss)$/.test(ext)) return (await import("@codemirror/lang-css")).css()
  if (/^(html|htm|vue|svelte)$/.test(ext)) return (await import("@codemirror/lang-html")).html()
  if (ext === "rs") return (await import("@codemirror/lang-rust")).rust()
  return []
}

export async function createEditor(
  parent: HTMLElement,
  opts: { doc: string; path: string; line?: number; changed: (dirty: boolean) => void; save: () => void },
): Promise<EditorHandle> {
  const [{ EditorView, basicSetup }, { keymap }, { EditorState }, { oneDark }, lang] = await Promise.all([
    import("codemirror"),
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/theme-one-dark"),
    language(opts.path),
  ])
  const dark = matchMedia("(prefers-color-scheme: dark)").matches
  const original = opts.doc
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        basicSetup,
        lang,
        ...(dark ? [oneDark] : []),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              opts.save()
              return true
            },
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.changed(u.state.doc.toString() !== original)
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--color-panel)" },
          ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
          ".cm-gutters": { backgroundColor: "var(--color-panel)", borderRight: "1px solid var(--color-rule)" },
        }),
      ],
    }),
  })
  if (opts.line) {
    const line = view.state.doc.line(Math.min(Math.max(1, opts.line), view.state.doc.lines))
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) })
  }
  return { text: () => view.state.doc.toString(), focus: () => view.focus(), destroy: () => view.destroy() }
}
