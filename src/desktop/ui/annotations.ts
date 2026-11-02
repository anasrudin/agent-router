/**
 * Notes on what Conductor and its threads produced, as Ghostex annotates plans and pages: select
 * text in a file or a report, mark it, and every note goes to Conductor as numbered feedback.
 */
export type Mark = "good" | "clarify" | "tests" | "note"

export const MARK_LABELS: Record<Mark, string> = { good: "Looks good", clarify: "Clarify", tests: "Needs tests", note: "Note" }

export type NoteSource =
  | { kind: "file"; path: string; start: number; end: number }
  | { kind: "report"; title: string; agent: string }
  | { kind: "drawing"; path: string; shape: string }

export interface Annotation {
  id: string
  source: NoteSource
  quote: string
  mark: Mark
  note?: string
}

function where(s: NoteSource): string {
  if (s.kind === "report") return `the report of thread "${s.title}" (${s.agent})`
  if (s.kind === "drawing") return `the drawing ${s.path}, shape "${s.shape}"`
  return `${s.path} ${s.start === s.end ? `line ${s.start}` : `lines ${s.start}-${s.end}`}`
}

const clip = (text: string, max = 300) => {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The request the notes become: numbered, each with where it points, the text quoted and the mark. */
export function formatAnnotations(notes: Annotation[]): string {
  const lines = notes.map((n, i) => {
    const note = n.note?.trim() ? `: ${n.note.trim()}` : ""
    return `${i + 1}. [${MARK_LABELS[n.mark]}] ${where(n.source)}, "${clip(n.quote)}"${note}`
  })
  return [
    "Feedback on your work, as numbered notes. Act on each one (a thread's notes go to that thread's delegate when it can resume), and say what you did per number.",
    "",
    ...lines,
  ].join("\n")
}
