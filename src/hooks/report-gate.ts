import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseReport } from "../coordinator/protocol"

/** Claude Code's Stop hook input (fields used here; verified on 2.1.312). */
export interface StopHookInput {
  session_id?: string
  last_assistant_message?: string
}

export type HookDecision = { decision: "block"; reason: string } | undefined

/** Blocks per session before the gate gives up and lets the escalation ladder handle it. */
export const MAX_GATE_BLOCKS = 2

const REASON = `Your final message is not a delegation report, so the harness cannot use it. Reply again with the complete report as your final message, using exactly these Markdown headings:

## Status
done | partial | blocked | failed

## Result

## Changes

## Evidence

## Confidence

## Open questions / risks

Put all of your findings under the headings. Do not redo the work.`

/**
 * Stop hook for Claude delegates: keep the delegate in its session until its final message is a
 * well-formed report, so a formatting slip costs one more turn instead of a whole new attempt.
 */
export function reportGate(input: StopHookInput, stateDir: string, maxBlocks = MAX_GATE_BLOCKS): HookDecision {
  if (parseReport(input.last_assistant_message ?? "").wellFormed) return undefined
  const counter = path.join(stateDir, `${(input.session_id ?? "session").replace(/[^\w-]/g, "_")}.blocks`)
  const blocks = existsSync(counter) ? Number(readFileSync(counter, "utf8")) || 0 : 0
  if (blocks >= maxBlocks) return undefined
  writeFileSync(counter, String(blocks + 1))
  return { decision: "block", reason: REASON }
}
