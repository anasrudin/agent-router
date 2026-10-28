import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { fakeRegistry, report, testSession } from "../../test-support"
import { DelegationError, delegate } from "../delegate"
import { Brief } from "../protocol"

const brief = (mode: Brief["mode"] = "read-only") =>
  Brief.parse({ task: "Find where config is loaded.", why: "User wants to add a setting.", acceptance: ["paths with line numbers"], mode })

describe("delegate()", () => {
  test("happy path: routed to primary, report parsed, cost tracked", async () => {
    const backends = fakeRegistry({ gemini: [{ text: report("done"), sessionId: "g1", costUsd: 0.02 }] })
    const session = testSession(backends)
    const r = await delegate(session, { taskClass: "search.codebase", brief: brief() })
    expect(r).toMatchObject({ status: "done", provider: "gemini", tier: "fast", sessionId: "g1", stopReason: "succeeded" })
    expect(session.spentUsd).toBeCloseTo(0.02)
    const call = backends.gemini.calls[0]
    expect(call?.prompt).toContain("## Acceptance criteria\n- [ ] paths with line numbers")
    expect(call?.systemPrompt).toContain("You are **Scout**")
    expect(call?.systemPrompt).toContain("Delegation Protocol")
    expect(call?.systemPrompt).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  test("malformed report → retry in same session with the rejection quoted", async () => {
    const backends = fakeRegistry({
      claude: [
        { text: "I did it!", sessionId: "c1" },
        { text: report("done"), sessionId: "c1" },
      ],
    })
    const r = await delegate(testSession(backends), { taskClass: "plan", brief: brief() })
    expect(r.status).toBe("done")
    expect(r.attempts.map((a) => a.outcome)).toEqual(["report_failed", "ok"])
    expect(backends.claude.calls[1]?.resumeSessionId).toBe("c1")
    expect(backends.claude.calls[1]?.prompt).toContain("## Previous attempts")
    expect(backends.claude.calls[1]?.prompt).toContain("I did it!")
  })

  test("dead backend → fallback without retrying, health updated", async () => {
    const backends = fakeRegistry({ gemini: [{ error: "missing_executable" }], claude: [{ text: report("done") }] })
    const session = testSession(backends)
    const r = await delegate(session, { taskClass: "search.codebase", brief: brief() })
    expect(r.provider).toBe("claude")
    expect(r.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual(["gemini:backend_error", "claude:ok"])
    expect(session.health.isHealthy("gemini")).toBe(false)
  })

  test("full ladder: retry, fallback, tier up, then stop with error", async () => {
    const backends = fakeRegistry({
      claude: [{ error: "failed" }, { error: "timeout" }, { error: "failed" }],
      openai: [{ text: report("failed") }],
    })
    const r = await delegate(testSession(backends), { taskClass: "code.edit", brief: brief("edit") })
    expect(r.status).toBe("error")
    expect(r.attempts.map((a) => `${a.provider}/${a.tier}`)).toEqual([
      "claude/standard",
      "claude/standard",
      "openai/standard",
      "claude/deep",
    ])
    expect(r.stopReason).toContain("max attempts")
    expect(backends.claude.calls[2]?.model).toBe("opus")
  })

  test("blocked report stops immediately and is returned", async () => {
    const backends = fakeRegistry({ claude: [{ text: report("blocked") }] })
    const r = await delegate(testSession(backends), { taskClass: "plan", brief: brief() })
    expect(r.status).toBe("blocked")
    expect(r.attempts).toHaveLength(1)
  })

  test("user pin is honoured and never switched", async () => {
    const backends = fakeRegistry({ openai: [{ error: "rate_limited" }] })
    const r = await delegate(testSession(backends), { taskClass: "plan", brief: brief(), route: { override: "openai" } })
    expect(r.status).toBe("error")
    expect(r.attempts.map((a) => a.provider)).toEqual(["openai"])
    expect(backends.claude.calls).toHaveLength(0)
  })

  test("review runs on a provider other than the author", async () => {
    const backends = fakeRegistry({ openai: [{ text: report("done") }] })
    const r = await delegate(testSession(backends), { taskClass: "code.review", brief: brief(), route: { author: "claude" } })
    expect(r.provider).toBe("openai")
    expect(backends.openai.calls[0]?.systemPrompt).toContain("You are **Reviewer**")
  })

  test("findings flag a done edit with no changes listed", async () => {
    const backends = fakeRegistry({ claude: [{ text: report("done", "") }] })
    const r = await delegate(testSession(backends), { taskClass: "code.edit", brief: brief("edit") })
    expect(r.findings.map((f) => f.severity)).toContain("reject")
  })

  test("trivial work is refused: Conductor does it itself", async () => {
    await expect(delegate(testSession(fakeRegistry({})), { taskClass: "trivial", brief: brief() })).rejects.toThrow(DelegationError)
  })

  test("second writer in the same workspace is refused without a worktree", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const backends = fakeRegistry({ claude: [{ text: report("done", "- a.ts — x") }] })
    const original = backends.claude.run
    backends.claude.run = async function* (o) {
      await gate
      yield* original(o)
    }
    const session = testSession(backends)
    const first = delegate(session, { taskClass: "code.edit", brief: brief("edit") })
    await expect(delegate(session, { taskClass: "code.edit", brief: brief("edit") })).rejects.toThrow(/worktree/)
    release()
    expect((await first).status).toBe("done")
    expect(session.activeWritersInWorkspace).toBe(0)
  })

  describe("watchdog", () => {
    const limits = (stall: number, repeats = 12) => ({ limits: { delegate_stall_seconds: stall, max_identical_tool_calls: repeats } })

    test("a silent delegate is stopped and the ladder moves on without a same-backend retry", async () => {
      const backends = fakeRegistry({ gemini: [{ hang: true }], claude: [{ text: report("done") }] })
      const r = await delegate(testSession(backends, limits(1)), { taskClass: "search.codebase", brief: brief() })
      expect(r.attempts.map((a) => `${a.provider}:${a.errorKind ?? a.outcome}`)).toEqual(["gemini:stalled", "claude:ok"])
      expect(r.attempts[0]?.message).toContain("no output for 1 s")
    })

    test("a delegate repeating one tool call is stopped as a loop", async () => {
      const backends = fakeRegistry({ gemini: [{ loop: 50, text: report("done") }], claude: [{ text: report("done") }] })
      const r = await delegate(testSession(backends, limits(60, 5)), { taskClass: "search.codebase", brief: brief() })
      expect(r.attempts.map((a) => `${a.provider}:${a.errorKind ?? a.outcome}`)).toEqual(["gemini:tool_loop", "claude:ok"])
    })

    test("repeats below the limit are fine", async () => {
      const backends = fakeRegistry({ gemini: [{ loop: 4, text: report("done") }] })
      const r = await delegate(testSession(backends, limits(60, 5)), { taskClass: "search.codebase", brief: brief() })
      expect(r.status).toBe("done")
    })

    test("a user cancel during a silent run is a cancel, not a stall", async () => {
      const backends = fakeRegistry({ gemini: [{ hang: true }] })
      const abort = new AbortController()
      const run = delegate(testSession(backends, limits(60)), { taskClass: "search.codebase", brief: brief(), signal: abort.signal })
      setTimeout(() => abort.abort(), 50)
      const r = await run
      expect(r.attempts.map((a) => a.errorKind)).toEqual(["cancelled"])
      expect(r.stopReason).toBe("cancelled")
    })

    test("a stalled delegate that can resume is nudged in its own session once, then the ladder takes over", async () => {
      const backends = fakeRegistry({
        claude: [
          { hang: true, sessionId: "c1" },
          { text: report("done"), sessionId: "c1" },
        ],
      })
      const r = await delegate(testSession(backends, limits(1)), { taskClass: "plan", brief: brief() })
      expect(r.attempts.map((a) => `${a.provider}:${a.errorKind ?? a.outcome}`)).toEqual(["claude:stalled", "claude:ok"])
      const second = backends.claude.calls[1]
      expect(second?.resumeSessionId).toBe("c1")
      expect(second?.prompt).toContain("no output for 1 s")
      expect(second?.prompt).not.toContain("## Acceptance criteria")
    })

    test("a second stall is not nudged again", async () => {
      const backends = fakeRegistry({
        claude: [
          { hang: true, sessionId: "c1" },
          { hang: true, sessionId: "c1" },
        ],
        openai: [{ text: report("done") }],
      })
      const r = await delegate(testSession(backends, limits(1)), { taskClass: "plan", brief: brief() })
      expect(r.attempts.map((a) => `${a.provider}:${a.errorKind ?? a.outcome}`)).toEqual(["claude:stalled", "claude:stalled", "openai:ok"])
      expect(backends.openai.calls[0]?.prompt).toContain("## Acceptance criteria")
    })

    test("a looping delegate is told to change approach", async () => {
      const backends = fakeRegistry({ claude: [{ loop: 50, text: report("done"), sessionId: "c1" }, { text: report("done") }] })
      const r = await delegate(testSession(backends, limits(60, 5)), { taskClass: "plan", brief: brief() })
      expect(r.status).toBe("done")
      expect(backends.claude.calls[1]?.prompt).toContain("Change your approach")
    })
  })

  test("an adapter that throws is a failed attempt, and the ladder moves on", async () => {
    const backends = fakeRegistry({ claude: [{ throws: "Argument not safe to pass through cmd.exe" }], openai: [{ text: report("done") }] })
    const r = await delegate(testSession(backends), { taskClass: "plan", brief: brief() })
    expect(r.status).toBe("done")
    expect(r.attempts[0]).toMatchObject({ provider: "claude", errorKind: "failed", message: expect.stringContaining("cmd.exe") })
  })

  test("with two attempts, a stall goes to another backend instead of spending the last on a nudge", async () => {
    const backends = fakeRegistry({ claude: [{ hang: true, sessionId: "c1" }], openai: [{ text: report("done") }] })
    const session = testSession(backends, {
      limits: { delegate_stall_seconds: 1 },
      escalation: { max_attempts_per_subtask: 2 },
    })
    const r = await delegate(session, { taskClass: "plan", brief: brief() })
    expect(r.attempts.map((a) => `${a.provider}:${a.errorKind ?? a.outcome}`)).toEqual(["claude:stalled", "openai:ok"])
  })

  describe("context window full", () => {
    test("mid-task: a fresh session on the same backend, told what already changed", async () => {
      const backends = fakeRegistry({
        claude: [{ error: "context_overflow", toolCalls: 7, sessionId: "c1" }, { text: report("done") }],
      })
      const r = await delegate(testSession(backends), { taskClass: "plan", brief: brief() })
      expect(r.attempts.map((a) => `${a.provider}:${a.errorKind ?? a.outcome}`)).toEqual(["claude:context_overflow", "claude:ok"])
      const second = backends.claude.calls[1]
      expect(second?.resumeSessionId).toBeUndefined()
      expect(second?.prompt).toContain("ran out of context window after 7 tool calls")
      expect(second?.prompt).toContain("No files were changed yet.")
    })

    test("edits that were uncommitted before the task are not credited to the delegate", async () => {
      const backends = fakeRegistry({ claude: [{ error: "context_overflow", toolCalls: 3 }, { text: report("done") }] })
      const session = testSession(backends)
      const git = (...args: string[]) => spawnSync("git", args, { cwd: session.workspace })
      git("init", "-q")
      writeFileSync(path.join(session.workspace, "mine.txt"), "the user's own work in progress")
      await delegate(session, { taskClass: "plan", brief: brief() })
      expect(backends.claude.calls[1]?.prompt).toContain("No files were changed yet.")
      expect(backends.claude.calls[1]?.prompt).not.toContain("mine.txt")
    })

    test("a brief too large to start with goes straight to another backend", async () => {
      const backends = fakeRegistry({ claude: [{ error: "context_overflow" }], openai: [{ text: report("done") }] })
      const r = await delegate(testSession(backends), { taskClass: "plan", brief: brief() })
      expect(r.attempts.map((a) => `${a.provider}:${a.errorKind ?? a.outcome}`)).toEqual(["claude:context_overflow", "openai:ok"])
    })
  })
})
