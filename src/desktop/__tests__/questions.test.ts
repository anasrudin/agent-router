import { describe, expect, test } from "bun:test"
import { formatAnswers, MAX_CHOICES, MAX_QUESTIONS, parseQuestions, splitQuestions } from "../ui/questions"

const FORM = `{"title": "Before I start",
 "questions": [
   {"id": "store", "question": "Where should sessions live?", "choices": [{"label": "Redis", "description": "shared", "recommended": true}, "In memory"]},
   {"id": "flags", "question": "Which flags?", "choices": ["a", "b", "c"], "multiple": true},
   {"question": "How long?", "type": "text", "choices": ["ignored"]}]}`

describe("parseQuestions()", () => {
  test("choices as objects or strings; text questions have none; ids default by position", () => {
    const form = parseQuestions(FORM)
    expect(form?.title).toBe("Before I start")
    expect(form?.questions.map((q) => [q.id, q.choices.length, q.multiple])).toEqual([
      ["store", 2, false],
      ["flags", 3, true],
      ["q3", 0, false],
    ])
    expect(form?.questions[0]?.choices[0]).toEqual({ label: "Redis", description: "shared", recommended: true })
  })

  test("not a form: bad JSON, no questions, a question without text", () => {
    expect(parseQuestions("{nope")).toBeUndefined()
    expect(parseQuestions('{"questions": []}')).toBeUndefined()
    expect(parseQuestions('{"questions": [{"choices": ["a"]}]}')).toBeUndefined()
  })

  test("caps questions and choices", () => {
    const many = {
      questions: Array.from({ length: 30 }, (_, i) => ({ question: `Q${i}`, choices: Array.from({ length: 40 }, (_, j) => `c${j}`) })),
    }
    const form = parseQuestions(JSON.stringify(many))
    expect(form?.questions).toHaveLength(MAX_QUESTIONS)
    expect(form?.questions[0]?.choices).toHaveLength(MAX_CHOICES)
  })
})

describe("splitQuestions()", () => {
  test("markdown around a questions block; a broken block stays as text", () => {
    const text = `I need two decisions.\n\n\`\`\`questions\n${FORM}\n\`\`\`\n\nThen I will start.`
    expect(splitQuestions(text).map((s) => s.kind)).toEqual(["markdown", "questions", "markdown"])
    const broken = "Here:\n```questions\n{not json\n```"
    expect(splitQuestions(broken)).toEqual([{ kind: "markdown", text: broken }])
  })
})

describe("formatAnswers()", () => {
  test("lettered picks, own answers quoted, skips left to judgement", () => {
    const form = parseQuestions(FORM)
    if (!form) throw new Error("form")
    const text = formatAnswers(form, {
      store: { picked: ["Redis"] },
      flags: { picked: ["a", "c"], other: 'also "d"' },
      q3: { picked: [], skipped: true },
    })
    expect(formatAnswers(form, { q3: { picked: [], other: "Two weeks" } })).toContain('3. How long?\n   Answer: "Two weeks"')
    expect(text).toContain("Answers to your questions (Before I start):")
    expect(text).toContain("1. Where should sessions live?\n   Answer: A. Redis")
    expect(text).toContain('2. Which flags?\n   Answer: A. a; C. c; Other: "also \\"d\\""')
    expect(text).toContain("3. How long?\n   Answer: (skipped: use your judgement)")
  })
})
