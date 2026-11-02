import { describe, expect, test } from "bun:test"
import { PromptQueue } from "../serve"

const start = (prompt: string) => ({ type: "start" as const, prompt, workspace: "/w", permission: "default" as const })

describe("PromptQueue", () => {
  test("first in, first out", () => {
    const q = new PromptQueue()
    q.add(start("a"))
    q.add(start("b"))
    expect(q.next()?.prompt).toBe("a")
    expect(q.next()?.prompt).toBe("b")
    expect(q.next()).toBeUndefined()
  })

  test("paused (after Stop): nothing starts, and the items stay", () => {
    const q = new PromptQueue()
    q.add(start("a"))
    q.paused = true
    expect(q.next()).toBeUndefined()
    expect(q.view()).toEqual({ items: [{ id: "q-1", prompt: "a" }], paused: true })
  })

  test("send next moves an item to the front; remove drops it", () => {
    const q = new PromptQueue()
    q.add(start("a"))
    const b = q.add(start("b"))
    const c = q.add(start("c"))
    expect(q.promote(c)).toBe(true)
    q.remove(b)
    expect(q.view().items.map((i) => i.prompt)).toEqual(["c", "a"])
    expect(q.promote("missing")).toBe(false)
  })

  test("an empty queue never shows as paused; clear resets it", () => {
    const q = new PromptQueue()
    q.paused = true
    expect(q.view().paused).toBe(false)
    q.add(start("a"))
    q.clear()
    expect(q.view()).toEqual({ items: [], paused: false })
  })
  test("move puts an item at a position, clamped to the ends", () => {
    const q = new PromptQueue()
    const a = q.add(start("a"))
    q.add(start("b"))
    const c = q.add(start("c"))
    expect(q.move(c, 0)).toBe(true)
    expect(q.view().items.map((i) => i.prompt)).toEqual(["c", "a", "b"])
    expect(q.move(c, 99)).toBe(true)
    expect(q.view().items.map((i) => i.prompt)).toEqual(["a", "b", "c"])
    expect(q.move(a, -5)).toBe(true)
    expect(q.view().items.map((i) => i.prompt)).toEqual(["a", "b", "c"])
    expect(q.move("missing", 0)).toBe(false)
  })

  test("take removes an item and gives back its text (Edit puts it back in the composer)", () => {
    const q = new PromptQueue()
    const a = q.add(start("a"))
    expect(q.take(a)).toBe("a")
    expect(q.take(a)).toBeUndefined()
    expect(q.view().items).toEqual([])
  })
})
