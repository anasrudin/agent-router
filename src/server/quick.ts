import { createClaudeParser } from "../backends/claude/parse"
import { NONINTERACTIVE_ENV, runProcess } from "../backends/process"
import type { ChatEvent } from "./protocol"

/**
 * One short answer from Claude's fast model, outside Conductor's conversation: no tools, no MCP
 * servers, its own throwaway session. Used for side questions (/btw) and catch-up summaries,
 * which should cost a cent, not a Conductor turn.
 */
export async function quickAsk(opts: {
  executable: string
  model?: string
  cwd: string
  prompt: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ text: string; costUsd?: number; error?: string }> {
  const proc = runProcess({
    command: opts.executable,
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(opts.model ? ["--model", opts.model] : []),
      // No tools and no MCP servers: it answers from what it is given.
      "--tools",
      "",
      "--strict-mcp-config",
    ],
    cwd: opts.cwd,
    env: NONINTERACTIVE_ENV,
    stdin: opts.prompt,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 120_000,
  })
  const parser = createClaudeParser()
  const texts: string[] = []
  let costUsd: number | undefined
  let error: string | undefined
  for await (const line of proc.lines) {
    for (const event of parser.line(line)) {
      if (event.type === "text") texts.push(event.text)
      else if (event.type === "usage" && event.usage.costUsd !== undefined) costUsd = event.usage.costUsd
      else if (event.type === "error") error = event.error.message
    }
  }
  const exit = await proc.exit
  if (exit.spawnError) error = `${opts.executable}: ${exit.spawnError.message}`
  else if (!error && exit.code !== 0) error = exit.stderr.trim().slice(-500) || `exited with code ${exit.code}`
  return { text: texts.join("\n\n").trim(), costUsd, error }
}

/** What the chat said, most recent last, cut from the start to fit `max` characters. */
export function transcriptDigest(events: ChatEvent[], max = 12_000): string {
  const parts: string[] = []
  const tasks = new Map<string, string>()
  for (const { msg } of events) {
    if (msg.type === "turn.started") parts.push(`User: ${msg.prompt}`)
    else if (msg.type === "conductor" && msg.event.type === "text") parts.push(`Conductor: ${msg.event.text}`)
    else if (msg.type === "delegation.started") tasks.set(msg.id, `${msg.agent} (${msg.taskClass}): ${msg.task}`)
    else if (msg.type === "delegation.finished")
      parts.push(`Thread ${tasks.get(msg.id) ?? msg.id} finished ${msg.summary.status}: ${msg.summary.report.slice(0, 600)}`)
    else if (msg.type === "delegation.failed") parts.push(`Thread ${tasks.get(msg.id) ?? msg.id} failed: ${msg.error}`)
    else if (msg.type === "turn.finished" && !msg.ok) parts.push(`The turn stopped: ${msg.error ?? "error"}`)
  }
  let text = parts.join("\n\n")
  if (text.length > max) text = `…${text.slice(-max)}`
  return text
}

export function sideQuestionPrompt(question: string, digest: string): string {
  return [
    "You answer a quick side question from a developer. A coding agent (Conductor) is working in their project; the recent conversation is below for context only.",
    "Answer briefly and directly (a few sentences or a short list). You cannot read files or run tools; if you would need to, say what to check.",
    "",
    "<conversation>",
    digest || "(nothing yet)",
    "</conversation>",
    "",
    `Question: ${question}`,
  ].join("\n")
}

export function catchUpPrompt(digest: string): string {
  return [
    "Summarize where this coding session stands for a developer who just came back to it. Use at most 6 short bullets under three bold labels, only those that apply: **Done**, **In progress**, **Needs you**. Name files and decisions concretely. No preamble.",
    "",
    "<conversation>",
    digest || "(nothing yet)",
    "</conversation>",
  ].join("\n")
}
