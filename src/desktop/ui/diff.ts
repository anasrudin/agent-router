/** Unified diffs for the thread diff view, and review comments on them. Pure, so it is tested. */

export interface DiffLine {
  kind: "add" | "del" | "ctx"
  /** Line number before the change (del, ctx). */
  old?: number
  /** Line number after the change (add, ctx). */
  new?: number
  text: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  /** Set when the file was renamed or deleted. */
  oldPath?: string
  status: "modified" | "added" | "deleted" | "renamed"
  binary: boolean
  hunks: DiffHunk[]
}

const unquote = (p: string) => p.replace(/^"(.*)"$/, "$1")

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: DiffHunk | undefined
  let oldNo = 0
  let newNo = 0
  for (const line of patch.split("\n")) {
    const start = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (start) {
      file = { path: unquote(start[2] as string), oldPath: undefined, status: "modified", binary: false, hunks: [] }
      files.push(file)
      hunk = undefined
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added"
      else if (line.startsWith("deleted file mode")) file.status = "deleted"
      else if (line.startsWith("rename from ")) {
        file.status = "renamed"
        file.oldPath = line.slice("rename from ".length)
      } else if (line.startsWith("Binary files")) file.binary = true
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      oldNo = Number(h[1])
      newNo = Number(h[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith("+")) hunk.lines.push({ kind: "add", new: newNo++, text: line.slice(1) })
    else if (line.startsWith("-")) hunk.lines.push({ kind: "del", old: oldNo++, text: line.slice(1) })
    else if (line.startsWith(" ")) hunk.lines.push({ kind: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) })
    // "\ No newline at end of file" and blank trailing lines carry no content.
  }
  if (file?.status === "deleted") file.oldPath = file.path
  return files
}

export interface ReviewComment {
  file: string
  /** Lines in the new version, or in the old one for comments on deleted lines. */
  start: number
  end: number
  side: "new" | "old"
  text: string
}

export interface ReviewTarget {
  title: string
  agent: string
  taskClass: string
  provider: string
  sessionId?: string
  /** Backends whose sessions can be resumed with a follow-up. */
  resumable: boolean
}

/**
 * The request sent to Conductor: every comment with its exact location, and how to hand them to
 * the delegate that made the change. Comments are quoted so their text stays data.
 */
export function formatReview(target: ReviewTarget, comments: ReviewComment[]): string {
  const where = (c: ReviewComment) => {
    const lines = c.start === c.end ? `Line: ${c.start}` : `Lines: ${c.start}-${c.end}`
    return `${lines}${c.side === "old" ? " (deleted lines, numbered as before the change)" : ""}`
  }
  const body = comments.map((c) => `File: ${c.file}\n${where(c)}\nUser comment: ${JSON.stringify(c.text)}`).join("\n\n")
  const how =
    target.sessionId && target.resumable
      ? `Send them to that delegate as a follow-up: delegate again with resume { provider: "${target.provider}", session_id: "${target.sessionId}" } and the comments quoted in the brief, so it fixes its own change with what it already knows. Then verify the fix as usual.`
      : "That delegate's session cannot be resumed, so brief a delegate (or fix it yourself, if it is small) with the comments quoted, then verify the fix as usual."
  return `Review comments on the changes from thread "${target.title}" (${target.agent} · ${target.taskClass}, ran on ${target.provider}${target.sessionId ? `, session ${target.sessionId}` : ""}):\n\n${body}\n\n${how}`
}
