import type { ChatEvent, ChatMeta, UsageSummary } from "./protocol"

const DAY = 86_400_000
const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10)

/**
 * Spend and tokens across saved chats: per day (the last `days` days, oldest first), per backend
 * (Conductor counts as Claude; delegates by the backend that finished them), and in total.
 * Only what the CLIs reported: Gemini and Codex report tokens, not cost.
 */
export function usageSummary(chats: { meta: ChatMeta; events: ChatEvent[] }[], now = Date.now(), days = 14): UsageSummary {
  const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY
  const perDay = new Map<string, { costUsd: number; tokens: number }>()
  for (let i = 0; i < days; i++) perDay.set(dayKey(start + i * DAY), { costUsd: 0, tokens: 0 })
  const providers: UsageSummary["providers"] = {
    claude: { costUsd: 0, tokens: 0, threads: 0 },
    gemini: { costUsd: 0, tokens: 0, threads: 0 },
    openai: { costUsd: 0, tokens: 0, threads: 0 },
  }
  let turns = 0
  let costUsd = 0
  let tokens = 0
  const add = (at: number, cost: number, toks: number) => {
    costUsd += cost
    tokens += toks
    const d = perDay.get(dayKey(at))
    if (d) {
      d.costUsd += cost
      d.tokens += toks
    }
  }
  for (const { events } of chats) {
    for (const { at, msg } of events) {
      if (msg.type === "turn.started") turns++
      else if (msg.type === "conductor" && msg.event.type === "usage") {
        const t = msg.event.inputTokens + msg.event.outputTokens
        add(at, msg.event.costUsd ?? 0, t)
        providers.claude.costUsd += msg.event.costUsd ?? 0
        providers.claude.tokens += t
      } else if (msg.type === "delegation.finished") {
        const s = msg.summary
        const t = s.tokens.input + s.tokens.output
        add(at, s.costUsd, t)
        const p = providers[s.provider]
        p.costUsd += s.costUsd
        p.tokens += t
        p.threads++
      }
    }
  }
  return {
    days: [...perDay].map(([day, v]) => ({ day, ...v })),
    providers,
    chats: chats.length,
    turns,
    costUsd,
    tokens,
  }
}
