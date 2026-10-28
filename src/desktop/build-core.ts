import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"

/**
 * Compile the CLI into a single executable that Tauri ships as its sidecar
 * (`externalBin` needs the `-<target triple>` suffix).
 */
const triple = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1]
if (!triple) throw new Error("could not read the host target triple from `rustc -vV`")
const outDir = path.join(import.meta.dir, "src-tauri", "binaries")
mkdirSync(outDir, { recursive: true })
const outfile = path.join(outDir, `agent-router-core-${triple}${process.platform === "win32" ? ".exe" : ""}`)
const entry = path.join(import.meta.dir, "..", "cli.ts")
execFileSync(process.execPath, ["build", entry, "--compile", "--outfile", outfile], { stdio: "inherit" })
console.log(`sidecar built: ${outfile}`)
