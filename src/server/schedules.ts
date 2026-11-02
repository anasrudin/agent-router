import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Repeat, Schedule } from "./protocol"

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The first run after `now` on the schedule's rhythm, counted from its last planned time. */
export function nextRun(at: number, repeat: Repeat, now: number): number | undefined {
  if (repeat === "none") return undefined
  const step = repeat === "hourly" ? HOUR : repeat === "weekly" ? 7 * DAY : DAY
  let next = at + step
  // Jump whole steps when the app was closed for a long time, rather than firing each one missed.
  if (next <= now) next += Math.ceil((now - next + 1) / step) * step
  if (repeat === "weekdays") {
    for (let d = new Date(next); d.getDay() === 0 || d.getDay() === 6; d = new Date(next)) next += DAY
  }
  return next
}

/**
 * Prompts to send later (the composer's Schedule): kept in the data folder, fired by the server
 * while the app is open. A one-off schedule is removed once it runs; a repeating one moves on.
 */
export class ScheduleStore {
  constructor(readonly file: string) {}

  list(): Schedule[] {
    if (!existsSync(this.file)) return []
    try {
      return (JSON.parse(readFileSync(this.file, "utf8")) as Schedule[]).sort((a, b) => a.at - b.at)
    } catch {
      return []
    }
  }

  private save(items: Schedule[]) {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(items, null, 2))
  }

  add(s: Omit<Schedule, "id" | "createdAt">, now = Date.now()): Schedule {
    const item: Schedule = { ...s, id: randomUUID(), createdAt: now }
    this.save([...this.list(), item])
    return item
  }

  remove(id: string): void {
    this.save(this.list().filter((s) => s.id !== id))
  }

  due(now = Date.now()): Schedule[] {
    return this.list().filter((s) => s.at <= now)
  }

  /** After a run: gone if one-off, otherwise its next time. */
  ran(id: string, now = Date.now()): void {
    const items = this.list()
    const s = items.find((x) => x.id === id)
    if (!s) return
    const next = nextRun(s.at, s.repeat, now)
    this.save(next === undefined ? items.filter((x) => x !== s) : items.map((x) => (x === s ? { ...x, at: next, lastRun: now } : x)))
  }
}
