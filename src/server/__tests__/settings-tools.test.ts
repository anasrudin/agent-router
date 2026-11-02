import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { olderThan, semver } from "../../doctor"
import { saveAdvanced } from "../advanced"
import { ChatStore } from "../chats"
import { historyDiff, listHistory, restoreHistory } from "../confighistory"
import { dataStats, exportChats, pruneChats } from "../datastore"
import { lineDiff } from "../linediff"
import { exportProfiles, importProfiles, readProfiles, saveProfile } from "../profiles"
import type { ChatMeta, ServerMessage } from "../protocol"
import { saveRouting } from "../routing"
import { profileCosts } from "../usage"

let ws: string
let userDir: string
const saved = process.env.AGENT_ROUTER_CONFIG_DIR
const projectFile = () => path.join(ws, ".harness", "routing.yaml")
beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "settings-tools-"))
  userDir = mkdtempSync(path.join(tmpdir(), "settings-tools-user-"))
  process.env.AGENT_ROUTER_CONFIG_DIR = userDir
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.AGENT_ROUTER_CONFIG_DIR
  else process.env.AGENT_ROUTER_CONFIG_DIR = saved
})

describe("line diff", () => {
  test("removals before additions, unchanged runs cut to context", () => {
    const a = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n")
    const b = ["a", "b", "c", "d", "E", "f", "g", "h", "i"].join("\n")
    const d = lineDiff(a, b, 1)
    expect(d.map((l) => `${l.k}${l.t}`)).toEqual(["…", " d", "-e", "+E", " f", "…", " h", "+i"])
    expect(lineDiff("", "x: 1\n")).toEqual([{ k: "+", t: "x: 1" }])
    expect(lineDiff("same\n", "same\n")).toEqual([{ k: "…", t: "" }])
  })
})

describe("preview, history and going back", () => {
  test("a preview writes nothing; a save is recorded; restore puts the file back", () => {
    const preview = saveAdvanced(ws, "project", { "limits.max_parallel_agents": 2 }, { preview: true })
    expect(existsSync(projectFile())).toBe(false)
    expect(preview.diff.filter((l) => l.k === "+").map((l) => l.t.trim())).toContain("max_parallel_agents: 2")

    saveAdvanced(ws, "project", { "limits.max_parallel_agents": 2 })
    writeFileSync(projectFile(), `# kept\n${readFileSync(projectFile(), "utf8")}`)
    saveRouting(ws, "project", [{ taskClass: "search.codebase", primary: "claude", fallback: ["gemini"], tier: "fast" }])
    const items = listHistory(ws)
    expect(items.map((i) => i.what)).toEqual(["Routing: 1 task", "Advanced: 1 setting"])
    expect(items[0]?.scope).toBe("project")
    expect(historyDiff(items[0]?.id as string).some((l) => l.k === "+" && l.t.includes("primary: claude"))).toBe(true)

    // Back to before the routing change: the comment added by hand survives, the route goes.
    restoreHistory(ws, items[0]?.id as string)
    const text = readFileSync(projectFile(), "utf8")
    expect(text).toContain("# kept")
    expect(text).not.toContain("search.codebase")
    // Back to before the first change: the file did not exist.
    restoreHistory(ws, items[1]?.id as string)
    expect(existsSync(projectFile())).toBe(false)
    expect(listHistory(ws)[0]?.what).toStartWith("Went back to before")
    expect(() => restoreHistory(ws, "../../etc/passwd")).toThrow(/Unknown change/)
  })

  test("an empty file that existed comes back empty, not deleted", () => {
    mkdirSync(path.dirname(projectFile()), { recursive: true })
    writeFileSync(projectFile(), "")
    saveAdvanced(ws, "project", { "limits.max_parallel_agents": 2 })
    restoreHistory(ws, listHistory(ws)[0]?.id as string)
    expect(existsSync(projectFile())).toBe(true)
    expect(readFileSync(projectFile(), "utf8")).toBe("")
  })

  test("another project's change cannot be restored here", () => {
    saveAdvanced(ws, "project", { "limits.max_parallel_agents": 2 })
    const id = listHistory(ws)[0]?.id as string
    const other = mkdtempSync(path.join(tmpdir(), "settings-tools-other-"))
    try {
      expect(listHistory(other)).toEqual([])
      expect(() => restoreHistory(other, id)).toThrow(/another project/)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe("sharing profiles", () => {
  test("export a profile as YAML and import it into another layer, checked like any change", () => {
    const q = readProfiles(ws).profiles.find((p) => p.name === "economy")
    if (!q) throw new Error("no economy profile")
    saveProfile(ws, "project", { ...q, name: "night", label: "Night", builtIn: false })
    const text = exportProfiles(ws, ["night"])
    expect(text).toStartWith("profiles:\n  night:")
    rmSync(projectFile())
    const r = importProfiles(ws, "user", text)
    expect(r.names).toEqual(["night"])
    expect(readProfiles(ws).profiles.some((p) => p.name === "night")).toBe(true)
    expect(() => importProfiles(ws, "project", "Bad: {}")).toThrow(/not a profile name/)
    expect(() => importProfiles(ws, "project", "night:\n  conductor:\n    tier: huge\n")).toThrow()
    expect(() => importProfiles(ws, "project", ": : :")).toThrow()
  })
})

describe("cost per profile", () => {
  test("each turn's spend counts against the profile it ran with", () => {
    const meta = { id: "x" } as ChatMeta
    const ev = (msg: unknown) => ({ at: 0, msg: msg as ServerMessage })
    const costs = profileCosts([
      {
        meta,
        events: [
          ev({ type: "turn.started", turnId: "t1", prompt: "a", resumed: false, profile: "economy" }),
          ev({ type: "conductor", turnId: "t1", event: { type: "usage", costUsd: 0.02 } }),
          ev({ type: "delegation.finished", summary: { costUsd: 0.01 } }),
          ev({ type: "turn.started", turnId: "t2", prompt: "b", resumed: true }),
          ev({ type: "conductor", turnId: "t2", event: { type: "usage", costUsd: 5 } }),
          ev({ type: "turn.started", turnId: "t3", prompt: "c", resumed: true, profile: "economy" }),
          ev({ type: "conductor", turnId: "t3", event: { type: "usage", costUsd: 0.03 } }),
        ],
      },
    ])
    expect(costs.economy?.turns).toBe(2)
    expect(costs.economy?.usd).toBeCloseTo(0.06)
    expect(Object.keys(costs)).toEqual(["economy"])
  })
})

describe("data folder", () => {
  test("stats, archive or delete old unpinned chats, export as Markdown", () => {
    const root = mkdtempSync(path.join(tmpdir(), "settings-tools-data-"))
    try {
      const store = new ChatStore(path.join(root, "chats"))
      const now = Date.now()
      const old = store.create(ws, "Old one", now - 40 * 86_400_000)
      const pinned = store.create(ws, "Old pinned", now - 40 * 86_400_000)
      store.update(pinned.id, { pinned: true })
      store.create(ws, "New one", now)
      store.append(old.id, { type: "turn.started", turnId: "t", prompt: "hello there", resumed: false }, now - 40 * 86_400_000)
      const stats = dataStats(root, store, now)
      expect(stats).toMatchObject({ chats: 3, olderThan30: 1, archived: 0 })
      expect(stats.bytes).toBeGreaterThan(0)

      const exported = exportChats(root, store)
      expect(exported.count).toBe(3)
      expect(readFileSync(path.join(exported.dir, `${new Date(old.createdAt).toISOString().slice(0, 10)}-old-one.md`), "utf8")).toContain(
        "hello there",
      )

      // The open chat is never cleared out.
      expect(pruneChats(root, store, 30, "archive", now, old.id)).toBe(0)
      expect(pruneChats(root, store, 30, "archive", now)).toBe(1)
      expect(store.get(old.id)).toBeUndefined()
      expect(existsSync(path.join(root, "archive", `${old.id}.jsonl`))).toBe(true)
      expect(dataStats(root, store, now)).toMatchObject({ chats: 2, archived: 1 })
      expect(pruneChats(root, store, 1, "delete", now)).toBe(0)
      expect(() => pruneChats(root, store, 0, "delete", now)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("CLI versions", () => {
  test("read x.y.z from a version line and compare", () => {
    expect(semver("2.1.316 (Claude Code)")).toBe("2.1.316")
    expect(semver("codex-cli 0.165.0")).toBe("0.165.0")
    expect(semver(undefined)).toBeUndefined()
    expect(olderThan("2.1.316", "2.1.320")).toBe(true)
    expect(olderThan("2.2.0", "2.1.320")).toBe(false)
    expect(olderThan("1.0.0", "1.0.0")).toBe(false)
  })
})
