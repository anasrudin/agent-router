import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadConfig, projectConfigPath, userConfigPath } from "../../config/load"
import { readSettings, type SettingsValues, saveSettings } from "../settings"

let workspace: string
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "ar-settings-ws-"))
  rmSync(userConfigPath(), { force: true })
})

const edit = (fn: (v: SettingsValues) => void): SettingsValues => {
  const values = structuredClone(readSettings(workspace).values)
  fn(values)
  return values
}

describe("readSettings()", () => {
  test("reflects the shipped defaults", () => {
    const { values, paths } = readSettings(workspace)
    expect(values.openai).toEqual({
      tiers: { fast: "gpt-6-luna", standard: "gpt-6-luna", deep: "gpt-6-luna" },
      reasoning: { fast: "low", standard: "medium", deep: "xhigh" },
      trustWorkspace: false,
    })
    expect(values.claude.reasoning).toEqual({ fast: "", standard: "", deep: "high" })
    expect(paths.project).toBe(projectConfigPath(workspace))
  })
})

describe("saveSettings()", () => {
  test("project file holds only what differs, and takes effect", () => {
    const saved = saveSettings(
      workspace,
      "project",
      edit((v) => {
        v.gemini.tiers.deep = "gemini-3-flash-preview"
        v.gemini.trustWorkspace = true
      }),
    )
    expect(saved.shadowed).toEqual([])
    const text = readFileSync(projectConfigPath(workspace), "utf8")
    expect(text).toBe("backends:\n  gemini:\n    tiers:\n      deep: gemini-3-flash-preview\n    trust_workspace: true\n")
    expect(loadConfig(workspace).config.backends.gemini.trust_workspace).toBe(true)
  })

  test("choosing the CLI default effort over an inherited one writes an explicit empty value", () => {
    saveSettings(
      workspace,
      "project",
      edit((v) => (v.claude.reasoning.deep = "")),
    )
    expect(readFileSync(projectConfigPath(workspace), "utf8")).toContain('deep: ""')
    expect(loadConfig(workspace).config.backends.claude.reasoning.deep).toBe("")
  })

  test("setting a value back to the inherited one removes the override", () => {
    saveSettings(
      workspace,
      "project",
      edit((v) => (v.openai.reasoning.fast = "medium")),
    )
    saveSettings(
      workspace,
      "project",
      edit((v) => (v.openai.reasoning.fast = "low")),
    )
    expect(readFileSync(projectConfigPath(workspace), "utf8").trim()).toBe("{}")
  })

  test("comments and unrelated keys in an existing file survive", () => {
    mkdirSync(path.dirname(projectConfigPath(workspace)), { recursive: true })
    writeFileSync(projectConfigPath(workspace), "# keep me\nlimits:\n  max_parallel_agents: 2 # two is plenty\n")
    saveSettings(
      workspace,
      "project",
      edit((v) => (v.claude.tiers.fast = "sonnet")),
    )
    const text = readFileSync(projectConfigPath(workspace), "utf8")
    expect(text).toContain("# keep me")
    expect(text).toContain("max_parallel_agents: 2 # two is plenty")
    expect(text).toContain("fast: sonnet")
  })

  test("user scope applies to every project but a project file still wins, and says so", () => {
    mkdirSync(path.dirname(projectConfigPath(workspace)), { recursive: true })
    writeFileSync(projectConfigPath(workspace), "backends:\n  claude:\n    tiers:\n      fast: opus\n")
    const saved = saveSettings(
      workspace,
      "user",
      edit((v) => (v.claude.tiers.fast = "sonnet")),
    )
    expect(existsSync(userConfigPath())).toBe(true)
    expect(saved.shadowed).toEqual(["claude fast model"])
    const other = mkdtempSync(path.join(tmpdir(), "ar-settings-other-"))
    expect(loadConfig(other).config.backends.claude.tiers.fast).toBe("sonnet")
  })

  test("bad values are refused and nothing is written", () => {
    expect(() =>
      saveSettings(
        workspace,
        "project",
        edit((v) => (v.claude.tiers.fast = "rm -rf /")),
      ),
    ).toThrow(/not a model id/)
    expect(() =>
      saveSettings(
        workspace,
        "project",
        edit((v) => (v.openai.reasoning.deep = "HIGH!")),
      ),
    ).toThrow(/reasoning level/)
    expect(existsSync(projectConfigPath(workspace))).toBe(false)
  })
})
