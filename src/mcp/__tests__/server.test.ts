import { describe, expect, test } from "bun:test"
import type { PermissionMode } from "../../backends/Backend"
import { approvalDecision, mcpToolName } from "../server"

const delegateCall = (mode?: string) => ({ task_class: "code.edit", brief: mode ? { mode } : {} })

describe("approvalDecision() — headless permission prompts", () => {
  const cases: [PermissionMode, string, Record<string, unknown>, "allow" | "deny"][] = [
    ["default", mcpToolName("delegate"), delegateCall("read-only"), "allow"],
    ["default", mcpToolName("delegate"), delegateCall(), "allow"],
    ["default", mcpToolName("delegate"), delegateCall("run-commands"), "deny"],
    ["default", mcpToolName("delegate"), delegateCall("edit"), "deny"],
    ["default", "Bash", { command: "rm -rf build" }, "deny"],
    ["acceptEdits", mcpToolName("delegate"), delegateCall("edit"), "allow"],
    ["acceptEdits", "Bash", { command: "bun test" }, "deny"],
    ["bypass", "Bash", { command: "bun test" }, "allow"],
  ]
  for (const [permission, tool, input, behavior] of cases) {
    test(`${permission}: ${tool} ${JSON.stringify(input)} → ${behavior}`, () => {
      const decision = approvalDecision(permission, tool, input)
      expect(decision.behavior).toBe(behavior)
      if (decision.behavior === "allow") expect(decision.updatedInput).toEqual(input)
      else expect(decision.message).toContain("--permission")
    })
  }
})
