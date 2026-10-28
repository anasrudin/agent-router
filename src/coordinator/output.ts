import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

/** About 10k tokens: enough for any well-formed report, small enough not to flood Conductor's context. */
export const OUTPUT_CHAR_LIMIT = 40_000

/**
 * Keep an oversized delegate output out of Conductor's context: save it in full under
 * .harness/outputs and return the head and tail with a pointer to the file.
 */
export function capOutput(text: string, workspace: string, label: string, limit = OUTPUT_CHAR_LIMIT): string {
  if (text.length <= limit) return text
  const dir = path.join(workspace, ".harness", "outputs")
  mkdirSync(dir, { recursive: true })
  const ignore = path.join(dir, ".gitignore")
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n")
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^\w.-]+/g, "_")}.md`)
  writeFileSync(file, text)
  const head = text.slice(0, Math.floor(limit * 0.75))
  const tail = text.slice(text.length - Math.floor(limit * 0.25))
  const omitted = text.length - head.length - tail.length
  return `${head}\n\n[… ${omitted} characters omitted. Full output: ${file}. Read only the part you need, with offset and limit.]\n\n${tail}`
}
