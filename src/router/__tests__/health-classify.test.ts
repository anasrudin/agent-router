import { describe, expect, test } from "bun:test"
import { guessTaskClass, parseOverrides } from "../classify"
import { HealthTracker } from "../health"

describe("HealthTracker", () => {
  test("hard failures mark unhealthy at once", () => {
    const h = new HealthTracker(2)
    h.recordError("gemini", "not_authenticated", "please login")
    expect(h.isHealthy("gemini")).toBe(false)
  })
  test("soft failures need the configured count, success resets it", () => {
    const h = new HealthTracker(2)
    h.recordError("openai", "failed", "x")
    h.recordSuccess("openai")
    h.recordError("openai", "timeout", "x")
    expect(h.isHealthy("openai")).toBe(true)
    h.recordError("openai", "failed", "x")
    expect(h.isHealthy("openai")).toBe(false)
  })
  test("context overflow and cancel say nothing about health", () => {
    const h = new HealthTracker(1)
    h.recordError("claude", "context_overflow", "too long")
    h.recordError("claude", "cancelled", "user")
    expect(h.isHealthy("claude")).toBe(true)
  })
  test("missing install is unhealthy", () => {
    const h = new HealthTracker(2)
    h.recordDetection("openai", { installed: false, detail: "codex not found on PATH" })
    expect(h.snapshot().openai).toMatchObject({ healthy: false, installed: false, reason: "codex not found on PATH" })
  })
})

describe("parseOverrides()", () => {
  test("@mention pins the provider and is stripped", () => {
    expect(parseOverrides("@codex write tests for utils")).toEqual({ provider: "openai", routes: {}, text: "write tests for utils" })
  })
  test("/route pins one class", () => {
    expect(parseOverrides("/route code.review gemini\nreview my diff")).toEqual({
      provider: undefined,
      routes: { "code.review": "gemini" },
      text: "review my diff",
    })
  })
  test("emails and unknown mentions are left alone", () => {
    expect(parseOverrides("mail a@claude.ai and ping @bob").provider).toBeUndefined()
  })
  const profiles = ["quality", "balanced", "economy"]
  test("@profile picks the profile for this request", () => {
    expect(parseOverrides("@economy rename the helper", profiles)).toEqual({ routes: {}, profile: "economy", text: "rename the helper" })
  })
  test("@profile is only a keyword for profiles the config defines", () => {
    expect(parseOverrides("@turbo go", profiles)).toEqual({ routes: {}, text: "@turbo go" })
    expect(parseOverrides("@economy go").profile).toBeUndefined()
  })
  test("ultrawork / ulw switch on the mode and default to the quality profile", () => {
    expect(parseOverrides("ulw: migrate the auth module", profiles)).toMatchObject({ ultrawork: true, text: "migrate the auth module" })
    expect(parseOverrides("ulw migrate the auth module", profiles)).toEqual({
      routes: {},
      profile: "quality",
      ultrawork: true,
      text: "migrate the auth module",
    })
    expect(parseOverrides("ULTRAWORK @balanced fix it", profiles)).toMatchObject({ ultrawork: true, profile: "balanced", text: "fix it" })
  })
  test("names that merely contain the keyword do not trigger it", () => {
    for (const msg of ["run ulw-plan next", "see ultrawork.md", "the ultraworkflow docs"])
      expect(parseOverrides(msg, profiles).ultrawork).toBeUndefined()
  })
  test("keywords inside code are quoted material, not instructions", () => {
    const msg = "why does this fail?\n```\n// @codex ultrawork\nconst x = 1\n```\nand `@economy` too"
    expect(parseOverrides(msg, profiles)).toEqual({ routes: {}, text: msg })
  })
  test("several keywords together, with text kept intact", () => {
    expect(parseOverrides("@gemini @economy summarise docs/ for me", profiles)).toEqual({
      provider: "gemini",
      routes: {},
      profile: "economy",
      text: "summarise docs/ for me",
    })
  })
})

describe("guessTaskClass()", () => {
  const cases: [string, string][] = [
    ["review the diff on this branch", "code.review"],
    ["find all usages of parseConfig", "search.codebase"],
    ["what is in this screenshot.png", "multimodal"],
    ["implement retry logic", "code.edit"],
    ["hello", "trivial"],
  ]
  for (const [text, cls] of cases) test(text, () => expect(guessTaskClass(text)).toBe(cls))
})
