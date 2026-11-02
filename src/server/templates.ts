import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { PromptTemplate, SettingsScope } from "./protocol"

/**
 * Prompt templates, as /commands of your own: one Markdown file each, in the project
 * (`.harness/prompts/<name>.md`, shared through git) or for you everywhere (the data folder).
 * `$ARGUMENTS` in a template is replaced by what follows the command.
 */
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

export function templateDirs(workspace: string, dataDir: string): Record<SettingsScope, string> {
  return { project: path.join(workspace, ".harness", "prompts"), user: path.join(dataDir, "prompts") }
}

export function listTemplates(workspace: string, dataDir: string): PromptTemplate[] {
  const dirs = templateDirs(workspace, dataDir)
  const out = new Map<string, PromptTemplate>()
  // The project's own template wins over yours of the same name.
  for (const scope of ["user", "project"] as const) {
    const dir = dirs[scope]
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).sort()) {
      const name = f.replace(/\.md$/, "")
      if (!f.endsWith(".md") || !TEMPLATE_NAME.test(name)) continue
      out.set(name, { name, scope, text: readFileSync(path.join(dir, f), "utf8").trim() })
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function saveTemplate(workspace: string, dataDir: string, scope: SettingsScope, name: string, text: string): void {
  if (!TEMPLATE_NAME.test(name)) throw new Error("A template name is lowercase letters, digits and dashes (up to 40), like review-pr.")
  if (!text.trim()) throw new Error("A template needs some text.")
  const dir = templateDirs(workspace, dataDir)[scope]
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${name}.md`), `${text.trim()}\n`)
}

export function deleteTemplate(workspace: string, dataDir: string, scope: SettingsScope, name: string): void {
  if (!TEMPLATE_NAME.test(name)) return
  rmSync(path.join(templateDirs(workspace, dataDir)[scope], `${name}.md`), { force: true })
}
