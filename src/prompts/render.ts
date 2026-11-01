import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parse } from "yaml"
import { ASSETS_ROOT } from "../config/load"

export const PROMPTS_DIR = path.join(ASSETS_ROOT, "prompts")

export interface PromptFile {
  meta: Record<string, unknown>
  body: string
}

export function splitFrontmatter(source: string): PromptFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { meta: {}, body: source }
  const meta = parse(match[1] ?? "") as unknown
  return {
    meta: typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {},
    body: source.slice(match[0].length),
  }
}

export function readPrompt(relative: string, dir = PROMPTS_DIR): PromptFile {
  // A Windows checkout may turn every newline into CRLF; the model would pay for each \r.
  return splitFrontmatter(readFileSync(path.join(dir, relative), "utf8").replace(/\r\n/g, "\n"))
}

export interface AgentInfo {
  name: string
  description: string
  mode: "read-only" | "edit"
}

export function listAgents(dir = PROMPTS_DIR): AgentInfo[] {
  const agentsDir = path.join(dir, "agents")
  if (!existsSync(agentsDir)) return []
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const { meta } = readPrompt(path.join("agents", f), dir)
      return {
        name: String(meta.name ?? path.basename(f, ".md")),
        description: String(meta.description ?? ""),
        mode: meta.mode === "edit" ? "edit" : "read-only",
      }
    })
}

export interface Rendered {
  text: string
  /** Variables the template uses that no value was supplied for; left in place so they are visible. */
  missing: string[]
}

export function render(template: string, vars: Record<string, string>): Rendered {
  const missing = new Set<string>()
  const text = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      missing.add(name)
      return whole
    }
    return value
  })
  return { text, missing: [...missing] }
}

/**
 * Delegates never write briefs, so they get the protocol without its §1 (the brief template and
 * rules for senders). Every turn of a delegate re-sends its system prompt, so this adds up.
 */
export function protocolForDelegates(protocol: string): string {
  return protocol.replace(/^## 1\. [\s\S]*?(?=^## 2\. )/m, "")
}

/**
 * Conductor writes briefs through the delegate tool, whose schema already lists every brief field,
 * so it gets the brief rules without the template, the report sections as a list rather than a
 * template, and no §3 (advice for delegates handing back code). Its system prompt is written to
 * the prompt cache at the start of every chat, so each section it does not need costs every time.
 */
export function protocolForConductor(protocol: string): string {
  return protocol
    .replace(/(^## 1\. [^\n]*\n)[\s\S]*?(?=^### Brief rules)/m, "$1\nThe delegate tool's `brief` fields are the brief.\n\n")
    .replace(
      /(^## 2\. [^\n]*\n)[\s\S]*?(?=^### Report rules)/m,
      "$1\nEvery delegate replies with `## Status` (done | partial | blocked | failed), `## Result`, `## Changes`, `## Evidence`, `## Confidence` and `## Open questions / risks`.\n\n",
    )
    .replace(/^---\s*\n+## 3\. [\s\S]*$/m, "")
    .trimEnd()
}

/** The shared files every prompt says to "always also follow". Windows rules only apply on Windows. */
function sharedSections(dir: string, platform: NodeJS.Platform, delegate: boolean): string {
  const protocol = readPrompt(path.join("shared", "delegation-protocol.md"), dir).body
  const parts = [delegate ? protocolForDelegates(protocol) : protocolForConductor(protocol)]
  if (platform === "win32") parts.push(readPrompt(path.join("shared", "windows.md"), dir).body)
  return parts.map((p) => p.trim()).join("\n\n---\n\n")
}

export function composeSystemPrompt(
  main: string,
  vars: Record<string, string>,
  options: { dir?: string; platform?: NodeJS.Platform; delegate?: boolean } = {},
): Rendered {
  const dir = options.dir ?? PROMPTS_DIR
  const { body } = readPrompt(main, dir)
  return render(`${body.trim()}\n\n---\n\n${sharedSections(dir, options.platform ?? process.platform, options.delegate ?? false)}\n`, vars)
}

export function agentPromptPath(agent: string): string {
  return path.join("agents", `${agent}.md`)
}
