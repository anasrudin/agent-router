import { beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { conductorTier, conductorTools } from "../../conductor/run"
import { Session } from "../../coordinator/session"
import { promptVars } from "../../prompts/vars"
import { HealthTracker } from "../../router/health"
import { decide, type RouteRequest } from "../../router/policy"
import { fakeRegistry } from "../../test-support"
import { loadConfig, userConfigPath } from "../load"

let workspace: string
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "ar-profile-ws-"))
  rmSync(userConfigPath(), { force: true })
})

function route(profile: string, req: RouteRequest) {
  const { config } = loadConfig(workspace, profile)
  return decide({ config, health: new HealthTracker(2), selfProvider: "claude", spentUsd: 0 }, req)
}

function session(profile: string) {
  return new Session({
    workspace,
    config: loadConfig(workspace, profile).config,
    backends: fakeRegistry({}),
    selfProvider: "claude",
    permission: "default",
  })
}

describe("profiles", () => {
  test("quality is the default and changes nothing", () => {
    const plain = loadConfig(workspace, null).config
    const quality = loadConfig(workspace).config
    expect(quality.active_profile).toBe("quality")
    expect(quality.routes).toEqual(plain.routes)
    expect(quality.backends).toEqual(plain.backends)
  })

  const cases: [string, string, RouteRequest, Record<string, unknown>][] = [
    ["quality", "plan stays deep", { taskClass: "plan" }, { tier: "deep", model: "opus" }],
    ["balanced", "plain plan drops to standard", { taskClass: "plan" }, { tier: "standard", model: "sonnet" }],
    ["balanced", "risky plan escalates to deep", { taskClass: "plan", taskText: "migrate the payment flow" }, { tier: "deep" }],
    [
      "balanced",
      "plain edit skips review",
      { taskClass: "code.edit", taskText: "rename a helper" },
      { tier: "standard", reviewRequired: false },
    ],
    [
      "balanced",
      "risky edit escalates and is reviewed",
      { taskClass: "code.edit", taskText: "fix auth token refresh" },
      { tier: "deep", reviewRequired: true },
    ],
    [
      "balanced",
      "floors hold: debug stays deep with second opinion",
      { taskClass: "debug.hard" },
      { tier: "deep", secondOpinion: "openai" },
    ],
    ["economy", "risky plan stays standard", { taskClass: "plan", taskText: "migrate the payment flow" }, { tier: "standard" }],
    [
      "economy",
      "debug keeps its deep floor but no second opinion",
      { taskClass: "debug.hard" },
      { tier: "deep", secondOpinion: undefined },
    ],
    [
      "economy",
      "review drops to standard, never below the floor",
      { taskClass: "code.review", author: "claude" },
      { provider: "openai", tier: "standard" },
    ],
    ["economy", "five files is not enough to escalate", { taskClass: "code.edit", filesTouched: 8 }, { tier: "standard" }],
  ]
  for (const [profile, name, req, expected] of cases) {
    test(`[${profile}] ${name}`, () => expect(route(profile, req)).toMatchObject(expected))
  }

  test("reasoning effort and attempts per profile", () => {
    expect(loadConfig(workspace, "balanced").config.backends.openai.reasoning.deep).toBe("high")
    expect(loadConfig(workspace, "economy").config.backends.openai.reasoning).toEqual({ fast: "low", standard: "low", deep: "medium" })
    expect(loadConfig(workspace, "economy").config.escalation.max_attempts_per_subtask).toBe(3)
  })

  test("Conductor tier and effort follow the profile", () => {
    expect(conductorTier(session("quality"))).toEqual({ tier: "deep", reasoning: "high" })
    expect(conductorTier(session("balanced"))).toEqual({ tier: "standard", reasoning: "high" })
    expect(conductorTier(session("economy"))).toEqual({ tier: "standard", reasoning: undefined })
  })

  test("the profile's rules reach Conductor's prompt", () => {
    expect(promptVars(session("balanced"), "sonnet").CONDITIONAL_RULES).toContain("## Routing profile: Balanced")
    expect(promptVars(session("quality"), "opus").CONDITIONAL_RULES).toBe("")
  })

  test("an explicit user setting beats the profile", () => {
    mkdirSync(path.dirname(userConfigPath()), { recursive: true })
    writeFileSync(userConfigPath(), "backends:\n  openai:\n    reasoning:\n      deep: xhigh\n")
    expect(loadConfig(workspace, "balanced").config.backends.openai.reasoning.deep).toBe("xhigh")
  })

  test("a profile may not lower a quality floor", () => {
    mkdirSync(path.dirname(userConfigPath()), { recursive: true })
    writeFileSync(
      userConfigPath(),
      "profiles:\n  cheap:\n    label: Cheap\n    description: x\n    conductor: { tier: fast }\n    overlay:\n      routes:\n        debug.hard: { min_tier: fast }\n",
    )
    expect(() => loadConfig(workspace, "cheap")).toThrow(/min_tier|Unrecognized key/)
  })

  test("a profile tier below the floor is lifted back to the floor", () => {
    mkdirSync(path.dirname(userConfigPath()), { recursive: true })
    writeFileSync(
      userConfigPath(),
      "profiles:\n  cheap:\n    label: Cheap\n    description: x\n    conductor: { tier: fast }\n    overlay:\n      routes:\n        debug.hard: { tier: fast }\n",
    )
    expect(route("cheap", { taskClass: "debug.hard" }).tier).toBe("deep")
  })

  test("offload: Codex edits, lookups fall back to Codex before Claude, planning stays on Claude", () => {
    expect(route("offload", { taskClass: "code.edit", taskText: "rename a helper" })).toMatchObject({
      provider: "openai",
      tier: "standard",
      reviewRequired: false,
    })
    expect(route("offload", { taskClass: "search.codebase" }).candidates).toEqual(["gemini", "openai", "claude"])
    expect(route("offload", { taskClass: "plan" }).provider).toBe("claude")
    expect(route("offload", { taskClass: "architecture" })).toMatchObject({ provider: "claude", tier: "deep" })
    expect(conductorTier(session("offload"))).toMatchObject({ tier: "standard", reasoning: "high" })
    // Conductor cannot edit, so changes have to go through Codex.
    expect(conductorTools(session("offload"))).toEqual(["Read", "Bash"])
    expect(conductorTools(session("balanced"))).toEqual(["Read", "Edit", "Write", "Bash"])
  })

  test("offload under a Claude-heavy plan: the plan's frontier still leads edits", () => {
    const { config } = loadConfig(workspace, "offload", undefined, "claude-heavy")
    const decision = decide({ config, health: new HealthTracker(2), selfProvider: "claude", spentUsd: 0 }, { taskClass: "code.edit" })
    expect(decision.provider).toBe("claude")
  })

  test("unknown profile names are refused", () => {
    expect(() => loadConfig(workspace, "turbo")).toThrow(/Unknown profile "turbo"/)
  })
})
