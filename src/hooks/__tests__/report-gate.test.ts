import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { reportGateSettings } from "../../backends/claude"
import { selfCommand, shellQuote } from "../../self"
import { reportGate } from "../report-gate"

const state = () => mkdtempSync(path.join(tmpdir(), "ar-gate-"))
const good = "## Status\ndone\n\n## Result\nFound it at a.ts:3."

describe("reportGate()", () => {
  test("a well-formed report may stop", () => {
    expect(reportGate({ session_id: "s", last_assistant_message: good }, state())).toBeUndefined()
  })

  test("anything else is blocked with the format, at most twice per session", () => {
    const dir = state()
    const input = { session_id: "s", last_assistant_message: "All done!" }
    expect(reportGate(input, dir)?.reason).toContain("## Status")
    expect(reportGate(input, dir)?.decision).toBe("block")
    expect(reportGate(input, dir)).toBeUndefined()
    expect(reportGate({ ...input, session_id: "other" }, dir)?.decision).toBe("block")
  })

  test("a missing message is blocked, not crashed on", () => {
    expect(reportGate({}, state())?.decision).toBe("block")
  })
})

describe("hook wiring", () => {
  test("quoting survives spaces and quotes in paths", () => {
    const out = spawnSync("sh", ["-c", `printf '%s|' ${shellQuote("C:\\Program Files\\it's")} ${shellQuote("$HOME")}`], {
      encoding: "utf8",
    })
    expect(out.stdout).toBe("C:\\Program Files\\it's|$HOME|")
  })

  test("the Stop hook command runs this CLI's report gate", () => {
    const settings = reportGateSettings()
    try {
      const { hooks } = JSON.parse(require("node:fs").readFileSync(settings.file, "utf8"))
      const command: string = hooks.Stop[0].hooks[0].command
      expect(command).toBe(selfCommand(["hook", "report-gate", "--state", path.dirname(settings.file)]))
      const run = spawnSync("sh", ["-c", command], {
        input: JSON.stringify({ session_id: "t", last_assistant_message: "hi" }),
        encoding: "utf8",
      })
      expect(JSON.parse(run.stdout).decision).toBe("block")
    } finally {
      settings.cleanup()
    }
  })
})
