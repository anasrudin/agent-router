import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import type { ProviderId } from "../config/schema"

export interface ScopedRule {
  /** Workspace-relative path of the rule file, with forward slashes. */
  file: string
  text: string
}

const PER_FILE_LIMIT = 4_000
const TOTAL_LIMIT = 12_000

/** "src/a.ts:10-20" → "src/a.ts". Leaves Windows drive letters ("C:\x") alone. */
function stripLineRange(file: string): string {
  return file.replace(/:\d+(?:-\d+)?$/, "")
}

/** Relevant files as workspace-relative paths with forward slashes; files outside the workspace are dropped. */
function relativeFiles(root: string, files: string[]): string[] {
  return files.flatMap((file) => {
    const abs = path.resolve(root, stripLineRange(file))
    const rel = path.relative(root, abs)
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? [rel.split(path.sep).join("/")] : []
  })
}

/**
 * The AGENTS.md files between each relevant file and the workspace root, root excluded (it is in
 * the system prompt already). Shallow first, so deeper and more specific rules come last.
 */
function agentsMdFiles(root: string, rel: string[]): string[] {
  const dirs = new Set<string>()
  for (const file of rel) {
    let dir = path.posix.dirname(file)
    while (dir !== "." && dir !== "/") {
      dirs.add(dir)
      dir = path.posix.dirname(dir)
    }
  }
  return [...dirs]
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .map((dir) => `${dir}/AGENTS.md`)
    .filter((file) => existsSync(path.join(root, file)))
}

/**
 * `key: value` lines and `- item` lists, for front matter that is not valid YAML. Cursor writes
 * `globs: *.tsx, *.jsx` unquoted, and a leading `*` is a YAML alias.
 */
function looseFrontMatter(text: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  let key: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s+-\s*(.+)$/.exec(line)
    if (item && key) {
      const list = Array.isArray(meta[key]) ? (meta[key] as unknown[]) : []
      meta[key] = [...list, item[1]?.trim()]
      continue
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!kv?.[1]) continue
    key = kv[1]
    const value = (kv[2] ?? "").trim()
    meta[key] = value === "true" ? true : value === "false" ? false : value
  }
  return meta
}

/** Front matter and body of a rule file; a file without front matter has empty meta. */
export function splitFrontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) return { meta: {}, body: text }
  const raw = m[1] ?? ""
  let meta: unknown
  try {
    meta = parseYaml(raw)
  } catch {
    meta = looseFrontMatter(raw)
  }
  return { meta: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}, body: text.slice(m[0].length) }
}

/** Glob lists come as YAML arrays or comma-separated strings. */
function globList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
  return items
    .map((g) =>
      String(g)
        .trim()
        .replace(/^["']|["']$/g, ""),
    )
    .filter(Boolean)
}

/** A pattern without a slash ("*.ts") matches at any depth, as in Cursor and Copilot rules. */
function globMatches(pattern: string, file: string): boolean {
  if (new Bun.Glob(pattern).match(file)) return true
  return !pattern.includes("/") && new Bun.Glob(pattern).match(path.posix.basename(file))
}

/**
 * Whether a rule applies: `always` rules always do; otherwise one of its globs must match a relevant
 * file. A rule with neither (a Cursor "agent requested" rule) is left out.
 */
function applies(globs: string[], always: boolean, rel: string[]): boolean {
  if (always || globs.includes("**") || globs.includes("**/*")) return true
  return globs.some((g) => rel.some((f) => globMatches(g, f)))
}

function listFiles(dir: string, suffixes: string[]): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && suffixes.some((s) => e.name.endsWith(s)))
    .map((e) => path.join(e.parentPath, e.name))
    .sort()
}

/**
 * Rule files other tools keep in the repository, scoped by their own front matter:
 * Copilot (`.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` with `applyTo`),
 * Cursor (`.cursor/rules/*.mdc` with `globs` / `alwaysApply`) and Claude Code (`.claude/rules/*.md`
 * with `paths`; none means always). Claude Code loads its own rules, so they are skipped for it.
 */
function toolRuleFiles(root: string, rel: string[], provider: ProviderId | undefined): { file: string; body: string }[] {
  const out: { file: string; body: string }[] = []
  const read = (abs: string) => readFileSync(abs, "utf8")
  const add = (abs: string, body: string) => out.push({ file: path.relative(root, abs).split(path.sep).join("/"), body })

  const copilot = path.join(root, ".github", "copilot-instructions.md")
  if (existsSync(copilot)) add(copilot, read(copilot))
  for (const abs of listFiles(path.join(root, ".github", "instructions"), [".instructions.md"])) {
    const { meta, body } = splitFrontMatter(read(abs))
    if (applies(globList(meta.applyTo), false, rel)) add(abs, body)
  }
  for (const abs of listFiles(path.join(root, ".cursor", "rules"), [".mdc", ".md"])) {
    const { meta, body } = splitFrontMatter(read(abs))
    if (applies(globList(meta.globs), meta.alwaysApply === true, rel)) add(abs, body)
  }
  if (provider !== "claude") {
    for (const abs of listFiles(path.join(root, ".claude", "rules"), [".md"])) {
      const { meta, body } = splitFrontMatter(read(abs))
      const globs = globList(meta.paths)
      if (applies(globs, globs.length === 0, rel)) add(abs, body)
    }
  }
  return out
}

/** Trim each file to its share of what is left of `budget`; empty files are dropped. */
function capped(sources: { file: string; body: string }[], budget: number): { rules: ScopedRule[]; used: number } {
  const rules: ScopedRule[] = []
  let used = 0
  for (const { file, body } of sources) {
    if (used >= budget) break
    let text = body.trim()
    if (!text) continue
    const limit = Math.min(PER_FILE_LIMIT, budget - used)
    if (text.length > limit) text = `${text.slice(0, limit)}\n\n[truncated at ${limit} characters; read ${file} for the rest]`
    used += text.length
    rules.push({ file, text })
  }
  return { rules, used }
}

/**
 * Rules that apply to a brief's relevant files: other tools' rule files first (broad), then the
 * AGENTS.md files below the root, shallow to deep. AGENTS.md is budgeted first, so always-on rule
 * files from other tools cannot crowd it out; the others get what is left of the total.
 */
export function scopedRules(workspace: string, files: string[], provider?: ProviderId): ScopedRule[] {
  const root = path.resolve(workspace)
  const rel = relativeFiles(root, files)
  const agents = capped(
    agentsMdFiles(root, rel).map((file) => ({ file, body: readFileSync(path.join(root, file), "utf8") })),
    TOTAL_LIMIT,
  )
  const tools = capped(toolRuleFiles(root, rel, provider), TOTAL_LIMIT - agents.used)
  return [...tools.rules, ...agents.rules]
}
