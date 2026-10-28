import { describe, expect, test } from "bun:test"
import { fakeRegistry, report, testSession } from "../../test-support"
import { runCheck, runConfiguredChecks } from "../checks"
import { delegate } from "../delegate"
import { Brief } from "../protocol"

const cwd = process.cwd()
// cmd.exe runs checks on Windows, so failing commands avoid POSIX shell syntax.
const FAIL_3 = `node -e "console.error('broken'); process.exit(3)"`
const FAIL_1 = `node -e "console.error('2 tests failed'); process.exit(1)"`

describe("runCheck()", () => {
  test("passing and failing commands, with the output tail", async () => {
    expect(await runCheck("echo fine", cwd, 10_000)).toMatchObject({ ok: true, code: 0, output: "fine" })
    expect(await runCheck(FAIL_3, cwd, 10_000)).toMatchObject({ ok: false, code: 3, output: "broken" })
  })

  test("a command that runs too long is killed and fails", async () => {
    const started = Date.now()
    const r = await runCheck("sleep 30", cwd, 300)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("cancelling stops it", async () => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 100)
    expect((await runCheck("sleep 30", cwd, 60_000, abort.signal)).output).toContain("cancelled")
  })
})

describe("runConfiguredChecks()", () => {
  test("never runs commands in Ask-before-changes mode; tells Conductor to", async () => {
    const r = await runConfiguredChecks(["touch should-not-exist"], cwd, "default", 10_000)
    expect(r.results).toEqual([])
    expect(r.findings[0]?.message).toContain("Run them yourself: touch should-not-exist")
  })

  test("only failures become findings", async () => {
    const r = await runConfiguredChecks(["true", "exit 1"], cwd, "acceptEdits", 10_000)
    expect(r.results.map((c) => c.ok)).toEqual([true, false])
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ severity: "reject" })
  })
})

describe("delegate() with project checks", () => {
  const brief = (mode: Brief["mode"]) => Brief.parse({ task: "Fix it.", why: "Broken.", acceptance: ["tests pass"], mode })
  const config = { checks: { commands: ["echo typecheck ok", FAIL_1] } }

  test("a failing check after an edit is a reject finding", async () => {
    const backends = fakeRegistry({ claude: [{ text: report("done", "- a.ts — fixed") }] })
    const r = await delegate(testSession(backends, config, "acceptEdits"), { taskClass: "code.edit", brief: brief("edit") })
    expect(r.checks.map((c) => [c.command, c.ok])).toEqual([
      ["echo typecheck ok", true],
      [FAIL_1, false],
    ])
    expect(r.findings.some((f) => f.severity === "reject" && f.message.includes("2 tests failed"))).toBe(true)
  })

  test("read-only work and failed reports run no checks", async () => {
    const backends = fakeRegistry({
      gemini: [{ text: report("done") }],
      claude: [{ text: report("failed") }, { text: report("failed") }, { text: report("failed") }, { text: report("failed") }],
      openai: [{ text: report("failed") }, { text: report("failed") }],
    })
    const session = testSession(backends, config, "acceptEdits")
    expect((await delegate(session, { taskClass: "search.codebase", brief: brief("read-only") })).checks).toEqual([])
    expect((await delegate(session, { taskClass: "code.edit", brief: brief("edit") })).checks).toEqual([])
  })
})
