import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ChatStore, dataDir } from "../chats"

let dir: string
let store: ChatStore
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "chats-"))
  store = new ChatStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const started = (prompt: string) => ({ type: "turn.started" as const, turnId: "t1", prompt, resumed: false })
const text = (t: string) => ({ type: "conductor" as const, turnId: "t1", event: { type: "text" as const, text: t } })

describe("ChatStore", () => {
  test("a new chat is listed with its title and workspace", () => {
    const chat = store.create("/w", "Find where greet is defined")
    expect(chat).toMatchObject({ workspace: "/w", title: "Find where greet is defined", pinned: false, turns: 0 })
    expect(store.list().map((c) => c.id)).toEqual([chat.id])
    expect(store.get(chat.id)?.title).toBe("Find where greet is defined")
  })

  test("events come back in order with their times, and turns are counted", () => {
    const chat = store.create("/w", "t")
    store.append(chat.id, started("hello"), 1000)
    store.append(chat.id, text("hi"), 2000)
    expect(store.events(chat.id)).toEqual([
      { at: 1000, msg: started("hello") },
      { at: 2000, msg: text("hi") },
    ])
    expect(store.get(chat.id)).toMatchObject({ turns: 1, updatedAt: 1000 })
  })

  test("pinned first, then the most recently used", () => {
    const a = store.create("/w", "a")
    const b = store.create("/w", "b")
    const c = store.create("/w", "c")
    store.append(a.id, started("x"), 5000)
    store.append(b.id, started("x"), 9000)
    store.append(c.id, started("x"), 1000)
    store.update(c.id, { pinned: true })
    expect(store.list().map((m) => m.title)).toEqual(["c", "b", "a"])
  })

  test("update renames and records the Conductor session", () => {
    const chat = store.create("/w", "a")
    store.update(chat.id, { title: "Renamed", sessionId: "s-1" })
    expect(store.get(chat.id)).toMatchObject({ title: "Renamed", sessionId: "s-1" })
    expect(store.update("missing", { title: "x" })).toBeUndefined()
  })

  test("delete removes the chat, its events and its ledger", () => {
    const chat = store.create("/w", "a")
    store.append(chat.id, started("x"))
    writeFileSync(store.ledgerPath(chat.id), "{}\n")
    store.delete(chat.id)
    expect(store.get(chat.id)).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  test("ids that could leave the folder are refused", () => {
    expect(store.get("../etc/passwd")).toBeUndefined()
    expect(store.events("../../x")).toEqual([])
    expect(() => store.delete("../x")).not.toThrow()
  })

  test("a torn last line (a crash mid-write) is skipped, the rest kept", () => {
    const chat = store.create("/w", "a")
    store.append(chat.id, started("x"), 1)
    writeFileSync(path.join(dir, `${chat.id}.jsonl`), `${JSON.stringify({ at: 1, msg: started("x") })}\n{"at":2,"msg":{"ty`)
    expect(store.events(chat.id)).toHaveLength(1)
  })

  test("search finds prompts, replies, tasks and reports, with a snippet around the match", () => {
    const a = store.create("/w", "Budget work")
    store.append(a.id, started("Add a token budget to delegations"))
    store.append(a.id, text("The ladder sums tokens in runLadder."))
    const b = store.create("/w2", "Other")
    store.append(b.id, started("Rename the settings dialog"))
    const hits = store.search("runladder")
    expect(hits.map((h) => h.chat.id)).toEqual([a.id])
    expect(hits[0]?.snippet).toContain("runLadder")
    expect(store.search("budget").map((h) => h.chat.id)).toEqual([a.id])
    expect(store.search("SETTINGS").map((h) => h.chat.id)).toEqual([b.id])
    expect(store.search("  ")).toEqual([])
  })
})

describe("dataDir", () => {
  test("an override wins; otherwise the platform's data folder", () => {
    expect(dataDir({ AGENT_ROUTER_DATA_DIR: "/x" }, "linux")).toBe("/x")
    expect(dataDir({ HOME: "/h" }, "linux")).toBe(path.join("/h", ".local", "share", "agent-router"))
    expect(dataDir({ HOME: "/h", XDG_DATA_HOME: "/d" }, "linux")).toBe(path.join("/d", "agent-router"))
    expect(dataDir({ HOME: "/h" }, "darwin")).toBe(path.join("/h", "Library", "Application Support", "agent-router"))
    expect(dataDir({ HOME: "/h", LOCALAPPDATA: "C:\\L" }, "win32")).toBe(path.join("C:\\L", "agent-router"))
  })
})
