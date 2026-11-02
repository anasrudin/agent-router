import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readRouting, saveRouting, testRoute } from "../routing"

let ws: string
let userDir: string
const saved = process.env.AGENT_ROUTER_CONFIG_DIR
beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "routing-"))
  userDir = mkdtempSync(path.join(tmpdir(), "routing-user-"))
  process.env.AGENT_ROUTER_CONFIG_DIR = userDir
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.AGENT_ROUTER_CONFIG_DIR
  else process.env.AGENT_ROUTER_CONFIG_DIR = saved
})

describe("routing editor", () => {
  test("reads every route, writes only the change, keeps comments, refuses a tier under the floor", () => {
    const rows = readRouting(ws).routes
    expect(rows.find((r) => r.taskClass === "search.codebase")).toMatchObject({ primary: "gemini", fallback: ["claude"], tier: "fast" })
    mkdirSync(path.join(ws, ".harness"), { recursive: true })
    writeFileSync(path.join(ws, ".harness", "routing.yaml"), "# my settings\nlimits: {}\n")
    saveRouting(ws, "project", [{ taskClass: "search.codebase", primary: "claude", fallback: ["gemini"], tier: "fast" }])
    const text = readFileSync(path.join(ws, ".harness", "routing.yaml"), "utf8")
    expect(text).toContain("# my settings")
    expect(text).toContain("search.codebase")
    expect(text).not.toContain("tier:")
    expect(readRouting(ws).routes.find((r) => r.taskClass === "search.codebase")).toMatchObject({ primary: "claude", fallback: ["gemini"] })
    // Back to the default removes the override again.
    saveRouting(ws, "project", [{ taskClass: "search.codebase", primary: "gemini", fallback: ["claude"], tier: "fast" }])
    expect(readFileSync(path.join(ws, ".harness", "routing.yaml"), "utf8")).not.toContain("routes")
    expect(() => saveRouting(ws, "project", [{ taskClass: "architecture", primary: "claude", fallback: [], tier: "fast" }])).toThrow(
      /floor/,
    )
    expect(() => saveRouting(ws, "project", [{ taskClass: "nope", primary: "claude", fallback: [], tier: "fast" }])).toThrow(/Unknown/)
  })

  test("a dry run guesses the class and explains the choice", async () => {
    const r = await testRoute(ws, "find where the login handler is defined")
    expect(r.taskClass).toBe("search.codebase")
    expect(r.why.length).toBeGreaterThan(0)
    expect(r.error ?? r.provider).toBeTruthy()
  })
})
