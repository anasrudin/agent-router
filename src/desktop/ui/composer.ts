/**
 * The composer's helpers, as Ghostex's composer has them: `@` opens a menu of workspace files,
 * `/` at the start of a line a menu of commands, ArrowUp at the start recalls earlier requests,
 * and a pasted, dropped or picked image is saved to the workspace and mentioned by path.
 */

export interface Token {
  kind: "@" | "/"
  /** Where the token starts (its @ or /). */
  start: number
  query: string
}

/** The @mention or /command being typed at the caret, if any. */
export function tokenAt(value: string, caret: number): Token | undefined {
  const before = value.slice(0, caret)
  const m = /(^|\s)([@/])([^\s@]*)$/.exec(before)
  if (!m) return undefined
  const kind = m[2] as "@" | "/"
  const start = (m.index ?? 0) + (m[1] as string).length
  // A command only at the start of a line, so a path like a/b never opens the menu.
  if (kind === "/" && start > 0 && value[start - 1] !== "\n") return undefined
  return { kind, start, query: m[3] as string }
}

/** Replace the token with `insert` (and a space after it), returning the new text and caret. */
export function applyCompletion(value: string, caret: number, token: Token, insert: string): { value: string; caret: number } {
  const after = value.slice(caret).replace(/^\S*/, "")
  const text = `${insert} `
  return { value: value.slice(0, token.start) + text + after.replace(/^ /, ""), caret: token.start + text.length }
}

/** Earlier requests, newest last, walked with ArrowUp and ArrowDown; the unsent draft comes back at the end. */
export class PromptHistory {
  private index: number
  private draft = ""

  constructor(
    private entries: string[] = [],
    private readonly limit = 100,
  ) {
    this.index = entries.length
  }

  get all(): string[] {
    return [...this.entries]
  }

  push(prompt: string) {
    const text = prompt.trim()
    if (!text) return
    this.entries = [...this.entries.filter((e) => e !== text), text].slice(-this.limit)
    this.index = this.entries.length
    this.draft = ""
  }

  /** The previous request, or undefined at the oldest. */
  up(current: string): string | undefined {
    if (this.index === 0) return undefined
    if (this.index === this.entries.length) this.draft = current
    this.index -= 1
    return this.entries[this.index]
  }

  /** The next request, the draft after the newest, or undefined when not walking. */
  down(): string | undefined {
    if (this.index >= this.entries.length) return undefined
    this.index += 1
    return this.index === this.entries.length ? this.draft : this.entries[this.index]
  }

  get walking(): boolean {
    return this.index < this.entries.length
  }

  reset() {
    this.index = this.entries.length
  }
}

export interface Command {
  name: string
  hint: string
  /** Text put in the composer in place of the command; without it, `run` acts at once. */
  insert?: string
  run?: () => void
}
