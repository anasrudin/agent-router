import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BoardStore } from "../boards"
import { nextRun, ScheduleStore } from "../schedules"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "stores-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const H = 3_600_000
const D = 24 * H

describe("nextRun", () => {
  test("one-off schedules have no next run; repeats step from the planned time", () => {
    expect(nextRun(0, "none", 1)).toBeUndefined()
    expect(nextRun(10 * H, "hourly", 10 * H)).toBe(11 * H)
    expect(nextRun(10 * H, "daily", 10 * H + 5)).toBe(34 * H)
  })
  test("a long gap jumps whole steps instead of firing every missed run", () => {
    expect(nextRun(0, "hourly", 5 * H + 1)).toBe(6 * H)
    expect(nextRun(0, "weekly", 20 * D)).toBe(21 * D)
  })
  test("weekdays skip Saturday and Sunday", () => {
    const friday = new Date(2026, 9, 30, 9, 0).getTime()
    expect(new Date(nextRun(friday, "weekdays", friday) as number).getDay()).toBe(1)
  })
})

describe("ScheduleStore", () => {
  const base = { workspace: "/w", prompt: "run the tests", permission: "default" as const }
  test("soonest first; due ones; a one-off is gone after it runs, a repeat moves on", () => {
    const store = new ScheduleStore(path.join(dir, "schedules.json"))
    const later = store.add({ ...base, at: 5000, repeat: "none" })
    const soon = store.add({ ...base, at: 1000, repeat: "hourly" })
    expect(store.list().map((s) => s.id)).toEqual([soon.id, later.id])
    expect(store.due(2000).map((s) => s.id)).toEqual([soon.id])
    store.ran(soon.id, 2000)
    expect(store.list().find((s) => s.id === soon.id)?.at).toBe(1000 + H)
    store.ran(later.id, 6000)
    expect(store.list().map((s) => s.id)).toEqual([soon.id])
    store.remove(soon.id)
    expect(store.list()).toEqual([])
  })
})

describe("BoardStore", () => {
  test("cards per workspace: add, edit, move within and across columns, remove", () => {
    const board = new BoardStore(dir)
    const a = board.upsert("/w", { title: "Login bug" })
    const b = board.upsert("/w", { title: "Docs" })
    const c = board.upsert("/w", { title: "Release", column: "doing" })
    expect(board.get("/w2")).toEqual([])
    expect(board.get("/w/").map((x) => x.title)).toEqual(["Login bug", "Docs", "Release"])
    board.upsert("/w", { id: a.id, notes: "repro: log in twice" })
    expect(board.get("/w")[0]).toMatchObject({ title: "Login bug", notes: "repro: log in twice", column: "todo" })
    expect(board.move("/w", b.id, "todo", 0)).toBe(true)
    expect(
      board
        .get("/w")
        .filter((x) => x.column === "todo")
        .map((x) => x.title),
    ).toEqual(["Docs", "Login bug"])
    board.move("/w", a.id, "doing", 0)
    expect(
      board
        .get("/w")
        .filter((x) => x.column === "doing")
        .map((x) => x.title),
    ).toEqual(["Login bug", "Release"])
    board.move("/w", a.id, "doing", 9)
    expect(
      board
        .get("/w")
        .filter((x) => x.column === "doing")
        .map((x) => x.title),
    ).toEqual(["Release", "Login bug"])
    expect(board.move("/w", "missing", "done", 0)).toBe(false)
    board.upsert("/w", { id: c.id, chatId: "chat-1" })
    expect(board.get("/w").find((x) => x.id === c.id)?.chatId).toBe("chat-1")
    board.remove("/w", b.id)
    expect(board.get("/w")).toHaveLength(2)
  })
})
