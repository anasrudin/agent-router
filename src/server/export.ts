import type { ChatEvent, ChatMeta } from "./protocol"

const PROVIDER: Record<string, string> = { claude: "Claude", gemini: "Gemini", openai: "Codex" }
const time = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 16)

/** The first line of a report's Result section, for a thread's one-line outcome. */
function resultLine(report: string): string {
  const m = /^##\s*Result\s*\n+([\s\S]*?)(?=\n##\s|(?![\s\S]))/m.exec(report)
  const line = (m?.[1] ?? report).split("\n").find((l) => l.trim() && !/^#/.test(l.trim())) ?? ""
  return line.replace(/^[-*]\s+/, "").trim()
}

/**
 * A saved chat as Markdown (Save to Markdown): each request, what Conductor wrote, the tools it
 * used and each delegation's outcome, in the order they happened. Usage and quota are left out.
 */
export function chatMarkdown(chat: ChatMeta, events: ChatEvent[]): string {
  const out: string[] = [`# ${chat.title}`, "", `Workspace: \`${chat.workspace}\`  `, `Started: ${time(chat.createdAt)} UTC`, ""]
  const threads = new Map<string, { agent: string; provider: string; task: string; taskClass: string }>()
  let tools: string[] = []
  const flushTools = () => {
    if (tools.length)
      out.push(
        `<details><summary>${tools.length} tool call${tools.length > 1 ? "s" : ""}</summary>`,
        "",
        ...tools.map((t) => `- ${t}`),
        "",
        "</details>",
        "",
      )
    tools = []
  }
  for (const { at, msg } of events) {
    switch (msg.type) {
      case "turn.started":
        flushTools()
        out.push(`## Request, ${time(at)}`, "", msg.prompt, "", "## Conductor", "")
        break
      case "conductor": {
        const e = msg.event
        if (e.type === "text") {
          flushTools()
          out.push(e.text, "")
        } else if (e.type === "tool_call" && !e.name.startsWith("mcp__router__")) {
          const i = (e.input ?? {}) as Record<string, unknown>
          const detail = String(i.command ?? i.file_path ?? i.pattern ?? i.path ?? "")
          tools.push(`${e.name}${detail ? ` \`${detail.split("\n")[0]}\`` : ""}`)
        } else if (e.type === "error") out.push(`> Error: ${e.message}`, "")
        break
      }
      case "delegation.started":
        threads.set(msg.id, { agent: msg.agent, provider: msg.provider, task: msg.task, taskClass: msg.taskClass })
        break
      case "delegation.finished": {
        flushTools()
        const t = threads.get(msg.id)
        const who = t
          ? `${t.agent} on ${PROVIDER[msg.summary.provider] ?? msg.summary.provider}`
          : (PROVIDER[msg.summary.provider] ?? msg.summary.provider)
        out.push(
          `> **Thread** ${who} (${msg.summary.taskClass}): ${t?.task ?? ""}  `,
          `> ${msg.summary.status}: ${resultLine(msg.summary.report)}`,
          "",
        )
        break
      }
      case "delegation.failed":
        flushTools()
        out.push(`> **Thread failed**: ${msg.error}`, "")
        break
      case "turn.finished":
        flushTools()
        if (!msg.ok && msg.error) out.push(`> Stopped: ${msg.error}`, "")
        break
      case "side.answer":
        out.push(`> **By the way**: ${msg.question}  `, `> ${msg.text.replace(/\n/g, "\n> ")}`, "")
        break
      case "catchup":
        out.push("### Catch-up", "", msg.text, "")
        break
      default:
        break
    }
  }
  flushTools()
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`
}
