import { randomUUID } from "node:crypto"
import type { TerminalInfo } from "./protocol"

const SCROLLBACK = 256 * 1024
const FLUSH_MS = 16

interface Term extends TerminalInfo {
  proc: Bun.Subprocess
  buffer: string
  pending: string
  timer?: ReturnType<typeof setTimeout>
}

export interface TerminalEvents {
  output(id: string, data: string): void
  exit(id: string, code: number | null): void
}

/**
 * Real terminals (a PTY each, through Bun's spawn `terminal` option) for the desktop app's
 * terminal dock. They outlive the window: a reloaded window lists them and gets each one's
 * scrollback, as Ghostex keeps sessions across restarts of its UI. POSIX only for now.
 */
export class Terminals {
  private terms = new Map<string, Term>()

  constructor(private readonly events: TerminalEvents) {}

  static supported(platform: NodeJS.Platform = process.platform): boolean {
    return platform !== "win32"
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map(({ id, title, cwd, command, running }) => ({ id, title, cwd, command, running }))
  }

  open(spec: { title: string; cwd: string; command: string[]; cols: number; rows: number; env?: Record<string, string> }): TerminalInfo {
    if (!Terminals.supported()) throw new Error("The terminal needs Linux or macOS for now.")
    const id = randomUUID()
    const decoder = new TextDecoder()
    const term: Term = {
      id,
      title: spec.title,
      cwd: spec.cwd,
      command: spec.command.join(" "),
      running: true,
      buffer: "",
      pending: "",
      proc: undefined as unknown as Bun.Subprocess,
    }
    term.proc = Bun.spawn(spec.command, {
      cwd: spec.cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...spec.env },
      terminal: {
        cols: clamp(spec.cols, 20, 500),
        rows: clamp(spec.rows, 5, 200),
        data: (_t, bytes) => this.write(term, decoder.decode(bytes, { stream: true })),
      },
    })
    this.terms.set(id, term)
    void term.proc.exited.then((code) => {
      this.flush(term)
      term.running = false
      this.events.exit(id, code)
    })
    return { id, title: term.title, cwd: term.cwd, command: term.command, running: true }
  }

  private write(term: Term, data: string) {
    term.buffer = (term.buffer + data).slice(-SCROLLBACK)
    term.pending += data
    term.timer ??= setTimeout(() => this.flush(term), FLUSH_MS)
  }

  private flush(term: Term) {
    clearTimeout(term.timer)
    term.timer = undefined
    if (!term.pending) return
    const data = term.pending
    term.pending = ""
    this.events.output(term.id, data)
  }

  /** The scrollback, for a window that attaches to a running terminal. */
  scrollback(id: string): string {
    return this.terms.get(id)?.buffer ?? ""
  }

  input(id: string, data: string): void {
    const t = this.terms.get(id)
    if (t?.running) t.proc.terminal?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id)
    if (t?.running) t.proc.terminal?.resize(clamp(cols, 20, 500), clamp(rows, 5, 200))
  }

  /**
   * Closing the PTY hangs up the whole session (the shell and what it runs, such as a dev
   * server); a plain kill would reach only the shell, which ignores SIGTERM. Anything still
   * alive after a moment is killed.
   */
  close(id: string): void {
    const t = this.terms.get(id)
    if (!t) return
    this.terms.delete(id)
    clearTimeout(t.timer)
    if (!t.running) return
    t.proc.terminal?.close()
    const force = setTimeout(() => {
      if (t.running) t.proc.kill("SIGKILL")
    }, 1500)
    void t.proc.exited.then(() => clearTimeout(force))
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id)
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)))
