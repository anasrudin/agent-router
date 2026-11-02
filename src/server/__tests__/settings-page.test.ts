import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig } from "../../config/load"
import { ADVANCED, coerce, readAdvanced, saveAdvanced } from "../advanced"
import { deleteProfile, readProfiles, saveProfile, setDefaultProfile } from "../profiles"

let ws: string
let userDir: string
const saved = process.env.AGENT_ROUTER_CONFIG_DIR
const projectFile = () => path.join(ws, ".harness", "routing.yaml")
beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "settings-page-"))
  userDir = mkdtempSync(path.join(tmpdir(), "settings-page-user-"))
  process.env.AGENT_ROUTER_CONFIG_DIR = userDir
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
  if (saved === undefined) delete process.env.AGENT_ROUTER_CONFIG_DIR
  else process.env.AGENT_ROUTER_CONFIG_DIR = saved
})

describe("advanced settings", () => {
  test("read every field from the merged config; write only changes; back to inherited removes them", () => {
    const fields = readAdvanced(ws)
    expect(fields.find((f) => f.key === "limits.delegate_timeout_seconds")?.value).toBe(900)
    const shippedNever = fields.find((f) => f.key === "privacy.never_send")?.value as string[]
    expect(shippedNever).toContain("**/*.pem")
    mkdirSync(path.join(ws, ".harness"), { recursive: true })
    writeFileSync(projectFile(), "# keep me\n")
    saveAdvanced(ws, "project", {
      "limits.delegate_timeout_seconds": 1200,
      "privacy.never_send": [...shippedNever, "private/**", " "],
      "budget.delegate_tokens": "",
    })
    const text = readFileSync(projectFile(), "utf8")
    expect(text).toContain("# keep me")
    expect(text).toContain("delegate_timeout_seconds: 1200")
    expect(text).not.toContain("delegate_tokens")
    const c = loadConfig(ws, null).config
    expect(c.limits.delegate_timeout_seconds).toBe(1200)
    expect(c.privacy.never_send).toEqual([...shippedNever, "private/**"])
    saveAdvanced(ws, "project", { "limits.delegate_timeout_seconds": 900, "privacy.never_send": shippedNever })
    expect(readFileSync(projectFile(), "utf8")).not.toContain("limits")
  })

  test("values are checked against their field", () => {
    const f = (key: string) => ADVANCED.find((x) => x.key === key) as (typeof ADVANCED)[number]
    expect(() => coerce(f("limits.max_identical_tool_calls"), 1)).toThrow(/at least 2/)
    expect(() => coerce(f("limits.quota_avoid_at"), 1.5)).toThrow(/at most 1/)
    expect(() => coerce(f("limits.max_parallel_agents"), 2.5)).toThrow(/whole/)
    expect(() => coerce(f("lsp.enabled"), "yes")).toThrow(/on or off/)
    expect(coerce(f("telemetry.events_file"), "")).toBeNull()
    expect(() => saveAdvanced(ws, "project", { "nope.key": 1 })).toThrow(/Unknown setting/)
  })
})

describe("profiles", () => {
  test("built-in profiles are listed; a new one is saved, set as default, then deleted", () => {
    const { profiles, defaultProfile } = readProfiles(ws)
    expect(profiles.find((p) => p.name === "quality")).toMatchObject({ builtIn: true, tier: "deep" })
    expect(defaultProfile).toBe("quality")
    saveProfile(ws, "project", {
      name: "night",
      label: "Night",
      description: "Cheap overnight runs",
      tier: "standard",
      reasoning: "",
      guidance: "Keep it short.",
      routeTiers: { plan: "standard" },
      routePrimary: { "search.codebase": "claude" },
      builtIn: false,
    })
    const night = readProfiles(ws).profiles.find((p) => p.name === "night")
    expect(night).toMatchObject({
      label: "Night",
      tier: "standard",
      routeTiers: { plan: "standard" },
      routePrimary: { "search.codebase": "claude" },
      builtIn: false,
    })
    setDefaultProfile(ws, "project", "night")
    expect(readProfiles(ws).defaultProfile).toBe("night")
    deleteProfile(ws, "project", "night")
    expect(readProfiles(ws).profiles.some((p) => p.name === "night")).toBe(false)
    expect(readProfiles(ws).defaultProfile).toBe("quality")
    // Deleting the file's last profile leaves no empty profiles map behind.
    expect(readFileSync(projectFile(), "utf8")).not.toContain("profiles")
  })

  test("a built-in profile can be changed (only the change is written) but not deleted; the floor holds", () => {
    const q = readProfiles(ws).profiles.find((p) => p.name === "quality") as NonNullable<
      ReturnType<typeof readProfiles>["profiles"][number]
    >
    saveProfile(ws, "project", { ...q, label: "Quality+" })
    const text = readFileSync(projectFile(), "utf8")
    expect(text).toContain("Quality+")
    expect(text).not.toContain("description")
    expect(() => deleteProfile(ws, "project", "balanced")).toThrow(/not defined/)
    expect(() => saveProfile(ws, "project", { ...q, routeTiers: { architecture: "fast" } })).toThrow(/floor/)
    expect(() => saveProfile(ws, "project", { ...q, name: "Bad Name" })).toThrow(/lowercase/)
  })
})
