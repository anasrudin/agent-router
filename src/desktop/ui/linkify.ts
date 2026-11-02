/**
 * File references in replies and reports (`src/a.ts:354`, `greet.js:10-12`, `README.md`) become
 * buttons that open the file viewer at that line.
 */
export interface FileRef {
  start: number
  end: number
  path: string
  line?: number
  endLine?: number
}

const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|yaml|yml|toml|rs|go|py|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|css|scss|html|vue|svelte|sql|txt|lock|xml|ini|cfg|conf|env|gradle|lua|dart|ex|exs|zig)$/i

const REF = /(?<![\w/.@-])(\/?(?:[\w.-]+\/)*[\w.-]*\w\.[A-Za-z]\w{0,9})(?::(\d+)(?:[-–](\d+))?)?(?![\w/])/g

export function findFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = []
  for (const m of text.matchAll(REF)) {
    const path = m[1] as string
    const line = m[2] ? Number(m[2]) : undefined
    // A bare name ("example.com", "e.g.x") only counts with a line number or a code file's extension.
    if (!path.includes("/") && line === undefined && !CODE_EXT.test(path)) continue
    if (/^https?:|^www\./i.test(path)) continue
    refs.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, path, line, endLine: m[3] ? Number(m[3]) : undefined })
  }
  return refs
}

/** Bare ports and hosts become http:// addresses: "5173" and "localhost:3000" both work. */
export function normalizeUrl(input: string): string | undefined {
  const t = input.trim()
  if (!t) return undefined
  if (/^\d{2,5}$/.test(t)) return `http://localhost:${t}/`
  if (/^https?:\/\//i.test(t)) return t
  if (/^(localhost|127\.0\.0\.1|\[::1\]|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`
  return undefined
}

/** Local web addresses (a dev server) in text, which open in the browser panel. */
export function findLocalUrls(text: string): { start: number; end: number; url: string }[] {
  const out: { start: number; end: number; url: string }[] = []
  for (const m of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s)<>"'`]*)?/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, "")
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + url.length, url })
  }
  return out
}
