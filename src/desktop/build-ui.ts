import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"

/** Bundle the desktop UI into src/desktop/dist, which Tauri serves as the webview's frontend. */
const ui = path.join(import.meta.dir, "ui")
const dist = path.join(import.meta.dir, "dist")
mkdirSync(dist, { recursive: true })
// Old chunks would pile up: each build names its own.
for (const f of readdirSync(dist)) if (/^chunk-.*\.js$/.test(f)) rmSync(path.join(dist, f))
// Split, so the terminal (xterm.js) and the editor (CodeMirror) load the first time they open.
const result = await Bun.build({
  entrypoints: [path.join(ui, "main.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const file of ["index.html", "styles.css"]) copyFileSync(path.join(ui, file), path.join(dist, file))
copyFileSync(path.join(import.meta.dir, "..", "..", "node_modules", "@xterm", "xterm", "css", "xterm.css"), path.join(dist, "xterm.css"))

// The interface faces Ghostex uses (all SIL OFL), bundled so the app needs no network for fonts.
const fonts = path.join(dist, "fonts")
mkdirSync(fonts, { recursive: true })
const modules = path.join(import.meta.dir, "..", "..", "node_modules", "@fontsource-variable")
for (const [name, file] of <[string, string][]>[
  ["inter.woff2", "inter/files/inter-latin-wght-normal.woff2"],
  ["dm-sans.woff2", "dm-sans/files/dm-sans-latin-wght-normal.woff2"],
  ["jetbrains-mono.woff2", "jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2"],
]) {
  copyFileSync(path.join(modules, file), path.join(fonts, name))
}
console.log(`desktop UI built into ${dist}`)
