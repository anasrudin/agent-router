import type { BudgetLimits, ChatEvent, ChatMeta, UsageSummary } from "./protocol"

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

/** What a chat has cost so far: Conductor's reported cost and every finished thread's. */
export function chatCost(events: ChatEvent[]): number {
  let usd = 0
  for (const { msg } of events) {
    if (msg.type === "conductor" && msg.event.type === "usage") usd += msg.event.costUsd ?? 0
    else if (msg.type === "delegation.finished") usd += msg.summary.costUsd
  }
  return usd
}

export interface BudgetCheck {
  over?: string
  /** Near a limit (at or past `warnAt` of it), for a warning. */
  near?: string
}

/** Dollars as people read them; amounts under a cent keep four decimals. */
export const usd = (n: number) => `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`

/** Whether a chat or today's spend is over (or near) the limits; undefined limits never trip. */
export function checkBudget(limits: BudgetLimits, chatUsd: number, dayUsd: number): BudgetCheck {
  const check: BudgetCheck = {}
  for (const [limit, spent, what] of [
    [limits.chatUsd, chatUsd, "this chat"],
    [limits.dayUsd, dayUsd, "today"],
  ] as const) {
    if (limit === null || limit === undefined || limit <= 0) continue
    if (spent >= limit) check.over ??= `Budget reached: ${usd(spent)} of ${usd(limit)} for ${what}.`
    else if (spent >= limit * limits.warnAt) check.near ??= `Near the budget: ${usd(spent)} of ${usd(limit)} for ${what}.`
  }
  return check
}

/**
 * What requests cost under each profile, across saved chats: each turn's Conductor and thread
 * spend counted against the profile it ran with (older turns that did not record one are left out).
 */
export function profileCosts(chats: { meta: ChatMeta; events: ChatEvent[] }[]): Record<string, { turns: number; usd: number }> {
  const out: Record<string, { turns: number; usd: number }> = {}
  for (const { events } of chats) {
    let current: { turns: number; usd: number } | undefined
    for (const { msg } of events) {
      if (msg.type === "turn.started") {
        current = undefined
        if (msg.profile) {
          current = out[msg.profile] ?? { turns: 0, usd: 0 }
          out[msg.profile] = current
          current.turns++
        }
      } else if (current && msg.type === "conductor" && msg.event.type === "usage") current.usd += msg.event.costUsd ?? 0
      else if (current && msg.type === "delegation.finished") current.usd += msg.summary.costUsd
    }
  }
  return out
}
