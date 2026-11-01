import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClaudeParser } from "../../backends/claude/parse"
import type { BackendEvent } from "../../backends/events"
import { withRolloutQuota } from "../../backends/openai/index"
import { testConfig } from "../../test-support"
import { HealthTracker } from "../health"
import { decide, type PolicyContext } from "../policy"
import { parseClaudeRateLimit, parseCodexRateLimits, QuotaTracker, readCodexQuota, windowLabel } from "../quota"

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

describe("parsing usage windows", () => {
  test("Claude rate_limit_event, as recorded from Claude Code 2.1.312", () => {
    const fixture = readFileSync(path.join(import.meta.dir, "../../backends/__tests__/fixtures/claude-stream.jsonl"), "utf8")
    const line = fixture.split("\n").find((l) => l.includes('"rate_limit_event"')) as string
    const events = createClaudeParser().line(line)
    expect(events).toEqual([{ type: "quota", windows: [{ label: "5h", usedFraction: 0, resetsAt: 1793196000_000, limited: false }] }])
  })

  test("Claude windows: rejected or full is limited; older builds send one top-level window", () => {
    const windows = parseClaudeRateLimit({
      unifiedWindows: {
        five_hour: { utilization: 0.93, resetsAt: 100, status: "allowed_warning" },
        seven_day: { utilization: 0.4, resetsAt: 200, status: "rejected" },
      },
    })
    expect(windows).toEqual([
      { label: "5h", usedFraction: 0.93, resetsAt: 100_000, limited: false },
      { label: "7d", usedFraction: 0.4, resetsAt: 200_000, limited: true },
    ])
    expect(parseClaudeRateLimit({ rateLimitType: "five_hour", utilization: 1, status: "allowed" })[0]?.limited).toBe(true)
  })

  test("Codex rate_limits: percent to fraction, window minutes to a label", () => {
    expect(
      parseCodexRateLimits({
        primary: { used_percent: 15, window_minutes: 300, resets_at: 10 },
        secondary: { used_percent: 100, window_minutes: 10080, resets_at: 20 },
        rate_limit_reached_type: null,
      }),
    ).toEqual([
      { label: "5h", usedFraction: 0.15, resetsAt: 10_000, limited: false },
      { label: "7d", usedFraction: 1, resetsAt: 20_000, limited: true },
    ])
    expect(windowLabel(43200)).toBe("30d")
  })

  test("reads the last rate_limits from the thread's rollout file", () => {
    const home = mkdtempSync(path.join(tmpdir(), "ar-codex-"))
    const dir = path.join(home, "sessions", "2026", "11", "01")
    mkdirSync(dir, { recursive: true })
    const event = (pct: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", rate_limits: { primary: { used_percent: pct, window_minutes: 300 } } },
      })
    writeFileSync(path.join(dir, "rollout-2026-11-01T10-00-00-thread-1.jsonl"), `${event(10)}\n${event(42)}\n{"cut off`)
    expect(readCodexQuota("thread-1", home)).toEqual([{ label: "5h", usedFraction: 0.42, resetsAt: undefined, limited: false }])
    expect(readCodexQuota("other-thread", home)).toBeUndefined()
  })

  test("Codex quota is reported after the run, just before its final event", async () => {
    async function* run(): AsyncGenerator<BackendEvent> {
      yield { type: "session", sessionId: "t1" }
      yield { type: "done", text: "ok" }
    }
    const events: BackendEvent[] = []
    for await (const e of withRolloutQuota(run(), () => [{ label: "5h", usedFraction: 0.5, limited: false }])) events.push(e)
    expect(events.map((e) => e.type)).toEqual(["session", "quota", "done"])
  })
})

describe("QuotaTracker", () => {
  test("a window whose reset has passed counts as empty", () => {
    let now = NOW
    const q = new QuotaTracker(null, () => now)
    q.record("claude", [{ label: "5h", usedFraction: 1, resetsAt: NOW + HOUR, limited: true }])
    expect(q.blocking("claude")?.label).toBe("5h")
    now = NOW + HOUR
    expect(q.blocking("claude")).toBeUndefined()
    expect(q.fullest("claude")?.usedFraction).toBe(0)
  })

  test("shared through its file, keeping other providers' reports", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "ar-quota-")), "quota.json")
    const a = new QuotaTracker(file, () => NOW)
    const b = new QuotaTracker(file, () => NOW)
    a.record("claude", [{ label: "5h", usedFraction: 0.5, limited: false }])
    b.record("openai", [{ label: "30d", usedFraction: 0.2, limited: false }])
    const c = new QuotaTracker(file, () => NOW)
    expect(Object.keys(c.snapshot()).sort()).toEqual(["claude", "openai"])
  })
})

describe("routing with live quota", () => {
  const ctx = (quota: QuotaTracker, patch: unknown = {}): PolicyContext => ({
    config: testConfig(patch),
    health: new HealthTracker(2),
    quota,
    selfProvider: "claude",
    spentUsd: 0,
  })

  test("a backend whose window is full is skipped until it resets", () => {
    const q = new QuotaTracker(null, () => NOW)
    q.record("claude", [{ label: "5h", usedFraction: 1, resetsAt: NOW + HOUR, limited: true }])
    const d = decide(ctx(q), { taskClass: "plan" })
    expect(d.provider).toBe("openai")
    expect(d.notes.join(" ")).toContain("skip claude: quota: 5h 100% (limit reached)")
  })

  test("a nearly full backend goes to the back of the line", () => {
    const q = new QuotaTracker(null)
    q.record("claude", [{ label: "5h", usedFraction: 0.95, limited: false }])
    const d = decide(ctx(q), { taskClass: "plan" })
    expect(d.provider).toBe("openai")
    expect(d.candidates.at(-1)).toBe("claude")
    expect(d.notes.join(" ")).toContain("prefer others: claude 5h 95%")
  })

  test("quota_avoid_at: 1 turns the preference off, and a pin always wins", () => {
    const q = new QuotaTracker(null)
    q.record("claude", [{ label: "5h", usedFraction: 0.95, limited: false }])
    expect(decide(ctx(q, { limits: { quota_avoid_at: 1 } }), { taskClass: "plan" }).provider).toBe("claude")
    expect(decide(ctx(q), { taskClass: "plan", override: "claude" }).provider).toBe("claude")
  })
})

describe("rate limits with a known reset", () => {
  test("the backend is healthy again once the window resets", () => {
    let now = NOW
    const h = new HealthTracker(2, () => now)
    h.recordError("claude", "rate_limited", "429", NOW + HOUR)
    expect(h.isHealthy("claude")).toBe(false)
    now = NOW + HOUR
    expect(h.isHealthy("claude")).toBe(true)
  })

  test("without a reset time it stays down for the session, as before", () => {
    const h = new HealthTracker(2)
    h.recordError("gemini", "rate_limited", "quota")
    expect(h.isHealthy("gemini")).toBe(false)
  })
})
