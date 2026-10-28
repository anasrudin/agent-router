import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export interface ScopedRule {
  /** Workspace-relative path of the AGENTS.md file, with forward slashes. */
  file: string
  text: string
}

const PER_FILE_LIMIT = 4_000
const TOTAL_LIMIT = 12_000

/** "src/a.ts:10-20" → "src/a.ts". Leaves Windows drive letters ("C:\x") alone. */
function stripLineRange(file: string): string {
  return file.replace(/:\d+(?:-\d+)?$/, "")
}

/**
 * The AGENTS.md files between each relevant file and the workspace root, root excluded (it is in
 * the system prompt already). Shallow first, so deeper and more specific rules come last.
 */
export function scopedAgentsMd(workspace: string, files: string[]): ScopedRule[] {
  const root = path.resolve(workspace)
  const dirs = new Set<string>()
  for (const file of files) {
    let dir = path.dirname(path.resolve(root, stripLineRange(file)))
    if (dir !== root && !dir.startsWith(root + path.sep)) continue
    while (dir !== root && dir.startsWith(root + path.sep)) {
      dirs.add(dir)
      dir = path.dirname(dir)
    }
  }
  const rules: ScopedRule[] = []
  let total = 0
  for (const dir of [...dirs].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))) {
    const file = path.join(dir, "AGENTS.md")
    if (!existsSync(file) || total >= TOTAL_LIMIT) continue
    let text = readFileSync(file, "utf8").trim()
    const limit = Math.min(PER_FILE_LIMIT, TOTAL_LIMIT - total)
    if (text.length > limit) text = `${text.slice(0, limit)}\n\n[truncated at ${limit} characters; read ${file} for the rest]`
    total += text.length
    rules.push({ file: path.relative(root, file).split(path.sep).join("/"), text })
  }
  return rules
}
