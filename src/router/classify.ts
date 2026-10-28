import type { ProviderId } from "../config/schema"

const MENTIONS: Record<string, ProviderId> = { "@claude": "claude", "@gemini": "gemini", "@codex": "openai", "@openai": "openai" }
const PROVIDER_NAMES: Record<string, ProviderId> = { claude: "claude", gemini: "gemini", codex: "openai", openai: "openai" }

export interface Overrides {
  /** A bare `@provider` mention: pins every class in this message. */
  provider?: ProviderId
  /** `/route <class> <provider>` lines: pin one class. */
  routes: Record<string, ProviderId>
  /** `@<profile>` (e.g. `@economy`) or `ultrawork`: the routing profile for this request. */
  profile?: string
  /** `ultrawork` / `ulw`: work to completion and verify everything before answering. */
  ultrawork?: boolean
  /** The message with override syntax removed. */
  text: string
}

export const ULTRAWORK_PROFILE = "quality"

/** Appended to the prompt in ultrawork mode, so Conductor knows what the keyword asks of it. */
export const ULTRAWORK_NOTE =
  "(agent-router: ultrawork mode. Finish the whole task without stopping to ask unless you are truly blocked. Before answering, verify the work: run the build and tests, and get an independent review of any code change.)"

/** Code the user pasted is quoted material, not instructions: keywords inside it do not count. */
function maskCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)|`[^`\n]*`/g, (code) => code.replace(/[^\n]/g, " "))
}

/** Extract conductor.md §4 rule 1 overrides and mode keywords from a user message. */
export function parseOverrides(message: string, profiles: string[] = []): Overrides {
  const routes: Record<string, ProviderId> = {}
  let provider: ProviderId | undefined
  let profile: string | undefined
  let ultrawork = false
  const masked = maskCode(message)
  // Masking keeps every offset, so a match in `masked` locates the same text in `message`.
  const cut: [number, number][] = []
  for (const m of masked.matchAll(/^[ \t]*\/route[ \t]+(\S+)[ \t]+(\S+)[ \t]*$/gm)) {
    const p = PROVIDER_NAMES[(m[2] ?? "").toLowerCase()]
    if (!p) continue
    routes[m[1] as string] = p
    cut.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  }
  for (const m of masked.matchAll(/(^|\s)@(\w+)\b/g)) {
    const name = (m[2] ?? "").toLowerCase()
    const start = (m.index ?? 0) + (m[1] ?? "").length
    const p = MENTIONS[`@${name}`]
    if (p) provider = p
    else if (profiles.includes(name)) profile = name
    else continue
    cut.push([start, start + name.length + 1])
  }
  // "ulw-plan" or "ultrawork.md" are names of things, not the keyword.
  for (const m of masked.matchAll(/(^|\s)(ultrawork|ulw)(?![\w.-])(:?)/gi)) {
    ultrawork = true
    const start = (m.index ?? 0) + (m[1] ?? "").length
    cut.push([start, start + (m[2] ?? "").length + (m[3] ?? "").length])
  }
  let text = message
  for (const [a, b] of cut.sort((x, y) => y[0] - x[0])) text = text.slice(0, a) + text.slice(b)
  if (ultrawork && !profile) profile = ULTRAWORK_PROFILE
  return {
    provider,
    routes,
    ...(profile ? { profile } : {}),
    ...(ultrawork ? { ultrawork } : {}),
    text: text.replace(/[ \t]{2,}/g, " ").trim(),
  }
}

/** Rough token estimate for capability-fit checks. 3.5 chars/token over-counts slightly, which errs toward the bigger context. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3.5)
}

const HEURISTICS: [string, RegExp][] = [
  ["multimodal", /\.(png|jpe?g|gif|webp|pdf|mp4|mov)\b|screenshot|mockup|diagram/i],
  ["code.review", /\breview\b/i],
  ["debug.hard", /\b(debug|crash|stack ?trace|regression|flaky|root cause)\b/i],
  ["architecture", /\b(architecture|design (decision|trade))/i],
  ["plan", /\b(plan|break (it )?down|roadmap)\b/i],
  ["code.tests", /\b(tests?|coverage|spec)\b/i],
  ["research.docs", /\b(docs|documentation|api reference|library)\b/i],
  ["search.codebase", /\b(find|where is|search|usages?|call sites?)\b/i],
  ["docs.write", /\b(readme|changelog|write docs)\b/i],
  ["code.edit", /\b(implement|add|fix|refactor|change|rename|update)\b/i],
]

/**
 * Best-effort keyword guess, used only when a caller (e.g. `agent-router delegate`) omits the class.
 * Conductor classifies with judgement; this is a convenience, not a classifier of record.
 */
export function guessTaskClass(text: string): string {
  return HEURISTICS.find(([, pattern]) => pattern.test(text))?.[0] ?? "trivial"
}
