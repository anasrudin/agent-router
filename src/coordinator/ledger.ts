import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/** One line per delegation event in a Conductor chat, so its state survives context compaction. */
export interface LedgerEntry {
  at: string
  id: string
  event: "started" | "finished" | "failed"
  taskClass: string
  task: string
  background: boolean
  provider?: string
  tier?: string
  status?: string
  sessionId?: string
  worktree?: string
  error?: string
}

/** A fresh ledger path for a new chat, under the OS temp folder (it only matters while the chat lasts). */
export function newLedgerPath(): string {
  const dir = path.join(tmpdir(), "agent-router-ledgers")
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `chat-${randomUUID()}.jsonl`)
}

export function appendLedger(file: string | undefined, entry: Omit<LedgerEntry, "at">): void {
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // The ledger is a recovery aid; losing a line must never fail a delegation.
  }
}

export function readLedger(file: string): LedgerEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as LedgerEntry] : []
      } catch {
        return []
      }
    })
}

/**
 * Each Conductor turn starts its own MCP server, so anything still "started" when one starts
 * belonged to a turn that ended (or was killed) before the delegation finished.
 */
export function closeInterrupted(file: string | undefined): void {
  if (!file) return
  const latest = new Map<string, LedgerEntry>()
  for (const e of readLedger(file)) latest.set(e.id, e)
  for (const e of latest.values()) {
    if (e.event !== "started") continue
    const { at: _at, ...rest } = e
    appendLedger(file, { ...rest, event: "failed", error: "interrupted: the turn ended before it finished" })
  }
}

const MAX_LISTED = 25

/** What Conductor needs to know after its context was compacted: what ran, what to resume, what is still running. */
export function ledgerContext(entries: LedgerEntry[]): string | undefined {
  const latest = new Map<string, LedgerEntry>()
  for (const e of entries) latest.set(e.id, { ...latest.get(e.id), ...e })
  if (!latest.size) return undefined
  const all = [...latest.values()]
  const running = all.filter((e) => e.event === "started")
  const finished = all.filter((e) => e.event !== "started").slice(-MAX_LISTED)
  const line = (e: LedgerEntry) =>
    [
      `- ${e.id} · ${e.taskClass} · ${e.task.slice(0, 160)}`,
      e.provider ? ` · ran on ${e.provider}/${e.tier}` : "",
      e.status ? ` · ${e.status}` : "",
      e.error ? ` · error: ${e.error.slice(0, 200)}` : "",
      e.sessionId ? ` · resume with { provider: "${e.provider}", session_id: "${e.sessionId}" }` : "",
      e.worktree ? ` · worktree ${e.worktree} (not merged unless you merged it)` : "",
    ].join("")
  const parts = ["## agent-router: delegations in this chat (restored after compaction)"]
  if (running.length) {
    parts.push("Still running in the background. Collect each with delegation_result before your final answer:", ...running.map(line))
  }
  if (finished.length) parts.push("Finished (oldest first). Resume a session instead of restarting work:", ...finished.map(line))
  return parts.join("\n")
}
