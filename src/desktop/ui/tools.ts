/**
 * How a tool call reads in the transcript: its label, the one detail that says what it touched,
 * the line counts of an edit, and the live "Reading x…" line while the turn works.
 */

const LABELS: Record<string, string> = {
  Read: "Read",
  Grep: "Search",
  Glob: "Find files",
  Bash: "Run",
  Edit: "Edit",
  MultiEdit: "Edit",
  Write: "Write",
  WebFetch: "Fetch",
  WebSearch: "Web search",
  TodoWrite: "Plan",
}

const ACTIVITY: Record<string, string> = {
  Read: "Reading",
  Grep: "Searching for",
  Glob: "Finding",
  Bash: "Running",
  Edit: "Editing",
  MultiEdit: "Editing",
  Write: "Writing",
  WebFetch: "Fetching",
  WebSearch: "Searching the web for",
}

/** MCP tools drop their server prefix: mcp__router__check_diff reads "check_diff". */
export function toolLabel(name: string): string {
  return LABELS[name] ?? name.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ")
}

export function toolDetail(input: unknown): string {
  if (typeof input === "string") return input
  const i = (input ?? {}) as Record<string, unknown>
  const detail = i.command ?? i.file_path ?? i.pattern ?? i.path ?? i.url ?? i.query ?? i.task_class ?? i.description ?? ""
  return String(detail)
}

/** A path shown short: the last two parts. */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/") || p
}

const lineCount = (s: unknown) => (typeof s === "string" && s.length ? s.replace(/\n$/, "").split("\n").length : 0)

/** Lines an Edit or Write call adds and removes, read from its input. */
export function editStats(name: string, input: unknown): { added: number; removed: number } | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  if (name === "Edit") return { added: lineCount(i.new_string), removed: lineCount(i.old_string) }
  if (name === "MultiEdit" && Array.isArray(i.edits)) {
    let added = 0
    let removed = 0
    for (const e of i.edits as Record<string, unknown>[]) {
      added += lineCount(e?.new_string)
      removed += lineCount(e?.old_string)
    }
    return { added, removed }
  }
  if (name === "Write") return { added: lineCount(i.content), removed: 0 }
  return undefined
}

/** What the turn is doing now, for the working line: "Reading main.ts". */
export function activityLine(name: string, input: unknown): string {
  const verb = ACTIVITY[name]
  const detail = toolDetail(input)
  const what = /^(Read|Edit|MultiEdit|Write)$/.test(name) ? shortPath(detail) : detail.split("\n")[0]
  const text = verb ? `${verb} ${what}`.trim() : `Using ${toolLabel(name)}`
  return text.length > 90 ? `${text.slice(0, 87)}…` : text
}

/** The last `lines` lines of a tool's output, and whether more came before them. */
export function outputTail(output: string, lines = 8): { text: string; more: boolean } {
  const all = output.replace(/\s+$/, "").split("\n")
  return { text: all.slice(-lines).join("\n"), more: all.length > lines || output.startsWith("…") }
}
