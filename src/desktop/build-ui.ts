import { copyFileSync, mkdirSync } from "node:fs"
import path from "node:path"

/** Bundle the desktop UI into src/desktop/dist, which Tauri serves as the webview's frontend. */
const ui = path.join(import.meta.dir, "ui")
const dist = path.join(import.meta.dir, "dist")
mkdirSync(dist, { recursive: true })
const result = await Bun.build({ entrypoints: [path.join(ui, "main.ts")], outdir: dist, target: "browser", minify: true })
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const file of ["index.html", "styles.css"]) copyFileSync(path.join(ui, file), path.join(dist, file))
console.log(`desktop UI built into ${dist}`)
