import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Project memory: lasting facts and standing instructions for one workspace ("tests need
 * `make test-local`", "never touch billing/"), kept in a Markdown file people can edit too.
 * Conductor's prompt carries them, every brief carries them, and they survive compaction and new
 * chats, so nobody re-discovers or re-states them.
 */
export const MEMORY_FILE = path.join(".harness", "memory.md")
export const NOTE_CHAR_LIMIT = 600
export const NOTES_MAX = 60

const HEADER = `# Project memory

Lasting facts and standing instructions for agent-router's agents in this project. One note per
line, starting with "- ". Edit freely; Conductor adds notes with its remember tool.

`

export function memoryPath(workspace: string): string {
  return path.join(workspace, MEMORY_FILE)
}

export function readNotes(workspace: string): string[] {
  const file = memoryPath(workspace)
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

function writeNotes(workspace: string, notes: string[]): void {
  const file = memoryPath(workspace)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${HEADER}${notes.map((n) => `- ${n}`).join("\n")}\n`)
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()

export function numbered(notes: string[]): string {
  return notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : "(no notes)"
}

export function remember(workspace: string, note: string): { ok: boolean; message: string } {
  const clean = note.replace(/\s+/g, " ").trim()
  if (!clean) return { ok: false, message: "The note is empty." }
  if (clean.length > NOTE_CHAR_LIMIT) {
    return { ok: false, message: `Notes are at most ${NOTE_CHAR_LIMIT} characters (this one is ${clean.length}). Shorten it.` }
  }
  const notes = readNotes(workspace)
  if (notes.some((n) => normalise(n) === normalise(clean))) {
    return { ok: true, message: `Already saved.\n\n${numbered(notes)}` }
  }
  if (notes.length >= NOTES_MAX) {
    return { ok: false, message: `Memory is full (${NOTES_MAX} notes). Forget one first.\n\n${numbered(notes)}` }
  }
  notes.push(clean)
  writeNotes(workspace, notes)
  return { ok: true, message: `Saved to ${MEMORY_FILE}.\n\n${numbered(notes)}` }
}

export function forget(workspace: string, number: number): { ok: boolean; message: string } {
  const notes = readNotes(workspace)
  if (!Number.isInteger(number) || number < 1 || number > notes.length) {
    return { ok: false, message: `There is no note ${number}.\n\n${numbered(notes)}` }
  }
  const [removed] = notes.splice(number - 1, 1)
  writeNotes(workspace, notes)
  return { ok: true, message: `Forgot: ${removed}\n\n${numbered(notes)}` }
}

/** For Conductor's system prompt. */
export function memoryForConductor(workspace: string): string {
  const notes = readNotes(workspace)
  if (!notes.length) return `(none yet; ${MEMORY_FILE})`
  return `\n\n<project-memory file="${MEMORY_FILE}">\n${numbered(notes)}\n</project-memory>\n`
}
