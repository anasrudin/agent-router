/**
 * Question forms. Conductor runs headless and cannot ask interactively, so when it needs the user
 * to decide it ends its turn with a ```questions block of JSON; the desktop app shows it as a
 * form and sends the answers back as the next request. Schema adapted from Ghostex's question
 * forms (github.com/maddada/Ghostex, MIT). Pure, so it is tested.
 */

export interface QuestionChoice {
  label: string
  description?: string
  recommended?: boolean
}

export interface Question {
  id: string
  question: string
  /** Absent or empty: a free-text answer. */
  choices: QuestionChoice[]
  /** More than one choice may be picked. */
  multiple: boolean
}

export interface QuestionForm {
  title?: string
  questions: Question[]
}

export const MAX_QUESTIONS = 20
export const MAX_CHOICES = 26

/** Validate a questions block; undefined when it is not a usable form. */
export function parseQuestions(json: string): QuestionForm | undefined {
  let doc: unknown
  try {
    doc = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== "object") return undefined
  const raw = (doc as { questions?: unknown }).questions
  if (!Array.isArray(raw) || !raw.length) return undefined
  const questions: Question[] = []
  for (const [i, q] of raw.slice(0, MAX_QUESTIONS).entries()) {
    if (!q || typeof q !== "object") return undefined
    const r = q as Record<string, unknown>
    if (typeof r.question !== "string" || !r.question.trim()) return undefined
    const choices: QuestionChoice[] = Array.isArray(r.choices)
      ? r.choices.slice(0, MAX_CHOICES).flatMap((c): QuestionChoice[] => {
          if (typeof c === "string" && c.trim()) return [{ label: c.trim() }]
          if (c && typeof c === "object" && typeof (c as QuestionChoice).label === "string") {
            const choice = c as QuestionChoice
            return [{ label: choice.label, description: choice.description, recommended: choice.recommended === true }]
          }
          return []
        })
      : []
    questions.push({
      id: typeof r.id === "string" && r.id ? r.id : `q${i + 1}`,
      question: r.question.trim(),
      choices: r.type === "text" ? [] : choices,
      multiple: r.multiple === true,
    })
  }
  const title = (doc as { title?: unknown }).title
  return { title: typeof title === "string" && title.trim() ? title.trim() : undefined, questions }
}

export type Segment = { kind: "markdown"; text: string } | { kind: "questions"; form: QuestionForm; raw: string }

/** Split a reply into markdown and question forms. A block that does not parse stays as markdown (a code block). */
export function splitQuestions(text: string): Segment[] {
  const out: Segment[] = []
  const re = /^```questions[^\S\n]*\n([\s\S]*?)\n```[^\S\n]*$/gm
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const form = parseQuestions(m[1] as string)
    if (!form) continue
    if (m.index > last) out.push({ kind: "markdown", text: text.slice(last, m.index) })
    out.push({ kind: "questions", form, raw: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: "markdown", text: text.slice(last) })
  return out.filter((s) => s.kind === "questions" || s.text.trim())
}

/** One answer: the picked choice labels, the user's own words, or skipped. */
export interface Answer {
  picked: string[]
  other?: string
  skipped?: boolean
}

export const letter = (i: number) => String.fromCharCode(65 + i)

/** The request sent back to Conductor. Answers are quoted so their text stays data. */
export function formatAnswers(form: QuestionForm, answers: Record<string, Answer>): string {
  const lines = form.questions.map((q, i) => {
    const a = answers[q.id]
    let value: string
    if (!a || a.skipped || (!a.picked.length && !a.other?.trim())) value = "(skipped: use your judgement)"
    else {
      const parts = a.picked.map((label) => {
        const index = q.choices.findIndex((c) => c.label === label)
        return index >= 0 ? `${letter(index)}. ${label}` : label
      })
      // A free-text question's answer is the answer itself; with choices it is "Other".
      if (a.other?.trim()) parts.push(q.choices.length ? `Other: ${JSON.stringify(a.other.trim())}` : JSON.stringify(a.other.trim()))
      value = parts.join("; ")
    }
    return `${i + 1}. ${q.question}\n   Answer: ${value}`
  })
  return `Answers to your questions${form.title ? ` (${form.title})` : ""}:\n\n${lines.join("\n\n")}`
}
