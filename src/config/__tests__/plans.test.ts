import { beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { conductorTier } from "../../conductor/run"
import { Session } from "../../coordinator/session"
import { HealthTracker } from "../../router/health"
import { decide } from "../../router/policy"
import { fakeRegistry } from "../../test-support"
import { loadConfig, userConfigPath } from "../load"
import { describePlan, frontierProvider, PLAN_PRESETS } from "../plans"

let workspace: string
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "ar-plan-ws-"))
  rmSync(userConfigPath(), { force: true })
})

function projectConfig(yaml: string) {
  mkdirSync(path.join(workspace, ".harness"), { recursive: true })
  writeFileSync(path.join(workspace, ".harness", "routing.yaml"), yaml)
}

function session(plan?: string, profile?: string) {
  return new Session({
    workspace,
    config: loadConfig(workspace, profile, undefined, plan).config,
    backends: fakeRegistry({}),
    selfProvider: "claude",
    permission: "default",
  })
}

/** "provider/tier" and the candidates for each task class. */
function routes(plan: string | undefined, classes: string[]) {
  const { config } = loadConfig(workspace, undefined, undefined, plan)
  const ctx = { config, health: new HealthTracker(2), selfProvider: "claude" as const, spentUsd: 0 }
  return Object.fromEntries(
    classes.map((taskClass) => {
      const d = decide(ctx, { taskClass })
      return [taskClass, { lead: `${d.provider}/${d.tier}`, candidates: d.candidates, second: d.secondOpinion }]
    }),
  )
}

describe("plans", () => {
  test("the backend with clearly more paid capacity is the frontier; a near-even split has none", () => {
    expect(frontierProvider(PLAN_PRESETS["claude-heavy"]?.plan ?? {})).toBe("claude")
    expect(frontierProvider(PLAN_PRESETS["chatgpt-heavy"]?.plan ?? {})).toBe("openai")
    expect(frontierProvider(PLAN_PRESETS.split?.plan ?? {})).toBeUndefined()
    expect(frontierProvider({ claude: 3, openai: 2 })).toBe("claude")
    expect(frontierProvider({ claude: 0, openai: 1 })).toBe("openai")
  })

  test("ChatGPT-heavy: Codex leads every Claude/Codex route, Claude is fallback and second opinion", () => {
    expect(routes("chatgpt-heavy", ["plan", "code.edit", "code.tests", "debug.hard", "search.codebase"])).toEqual({
      plan: { lead: "openai/deep", candidates: ["openai", "claude"], second: undefined },
      "code.edit": { lead: "openai/standard", candidates: ["openai", "claude"], second: undefined },
      "code.tests": { lead: "openai/standard", candidates: ["openai", "claude"], second: undefined },
      "debug.hard": { lead: "openai/deep", candidates: ["openai", "claude"], second: "claude" },
      // Lookups stay on Gemini's request quota.
      "search.codebase": { lead: "gemini/fast", candidates: ["gemini", "claude"], second: undefined },
    })
  })

  test("Claude-heavy: Claude leads, Codex tests move to Claude; Split keeps the shipped routing", () => {
    expect(routes("claude-heavy", ["code.tests", "debug.hard"])).toMatchObject({
      "code.tests": { lead: "claude/standard", candidates: ["claude", "openai"] },
      "debug.hard": { lead: "claude/deep", second: "openai" },
    })
    expect(routes("split", ["plan", "code.tests"])).toEqual(routes("none", ["plan", "code.tests"]))
  })

  test("a backend with no subscription is never chosen", () => {
    projectConfig("plan: { claude: 4, openai: 0, gemini_requests_per_day: 0 }\n")
    const r = routes(undefined, ["code.tests", "debug.hard", "search.codebase"])
    expect(r["code.tests"]).toMatchObject({ lead: "claude/standard", candidates: ["claude"] })
    expect(r["debug.hard"]?.second).toBeUndefined()
    expect(r["search.codebase"]).toMatchObject({ lead: "claude/fast", candidates: ["claude"] })
  })

  test("a small Claude plan keeps Conductor off the top tier; a large one does not", () => {
    expect(conductorTier(session("chatgpt-heavy")).tier).toBe("standard")
    expect(conductorTier(session("claude-heavy")).tier).toBe("deep")
    expect(conductorTier(session("chatgpt-heavy", "economy")).tier).toBe("standard")
  })

  test("delegates at once per backend follow the plan", () => {
    const s = session("claude-heavy")
    expect(s.config.limits.parallel_per_provider).toEqual({ claude: 3, openai: 1, gemini: 2 })
    expect(session().config.limits.parallel_per_provider).toEqual({})
  })

  test("routes you set yourself beat the plan; the plan can be set in the config by name; none turns it off", () => {
    projectConfig("plan: chatgpt-heavy\nroutes:\n  plan: { agent: planner, primary: claude, tier: deep, min_tier: standard }\n")
    expect(routes(undefined, ["plan", "code.edit"])).toMatchObject({
      plan: { lead: "claude/deep" },
      "code.edit": { lead: "openai/standard" },
    })
    expect(routes("none", ["code.edit"])["code.edit"]?.lead).toBe("claude/standard")
  })

  test("a plan keeps what the profile turned off, and your own parallel limit", () => {
    const { config } = loadConfig(workspace, "economy", undefined, "chatgpt-heavy")
    expect(config.routes["debug.hard"]?.second_opinion).toBeUndefined()
    expect(config.routes["debug.hard"]?.primary).toBe("openai")
    projectConfig("limits: { max_parallel_per_provider: 1 }\n")
    expect(session("claude-heavy").config.limits.parallel_per_provider).toEqual({})
  })

  test("unknown plan names fail loudly", () => {
    expect(() => loadConfig(workspace, undefined, undefined, "platinum")).toThrow(/Unknown plan "platinum"/)
  })

  test("described in plain words", () => {
    expect(describePlan(PLAN_PRESETS.split?.plan ?? {})).toBe(
      "Claude $255/mo · ChatGPT $266/mo · Gemini 1000 req/day; frontier work split as routed",
    )
  })
})
