import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ProviderQuota, QuotaSnapshot, QuotaWindow } from "../backends/events"
import { PROVIDERS, type ProviderId } from "../config/schema"

export type { ProviderQuota, QuotaSnapshot, QuotaWindow }

/** "5h", "7d", "30d" from a window length in minutes. */
export function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d opus",
  seven_day_sonnet: "7d sonnet",
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

/**
 * Claude Code's stream-json `rate_limit_event`. `unifiedWindows` holds every window
 * (`utilization` 0–1, `resetsAt` in epoch seconds, `status` allowed | allowed_warning | rejected);
 * older builds send only the top-level window.
 */
export function parseClaudeRateLimit(info: Record<string, unknown>): QuotaWindow[] {
  const windows = (info.unifiedWindows ?? {}) as Record<string, Record<string, unknown>>
  const entries = Object.keys(windows).length
    ? Object.entries(windows)
    : typeof info.rateLimitType === "string"
      ? [[info.rateLimitType, { utilization: info.utilization, resetsAt: info.resetsAt, status: info.status }] as const]
      : []
  return entries.map(([type, w]) => {
    const used = num(w.utilization) ?? 0
    const reset = num(w.resetsAt)
    return {
      label: CLAUDE_WINDOWS[type] ?? type,
      usedFraction: Math.min(1, Math.max(0, used)),
      resetsAt: reset ? reset * 1000 : undefined,
      limited: w.status === "rejected" || used >= 1,
    }
  })
}

/** Codex's `rate_limits` (rollout files and app-server): `primary`/`secondary` with `used_percent` 0–100. */
export function parseCodexRateLimits(limits: Record<string, unknown>): QuotaWindow[] {
  const reached = limits.rate_limit_reached_type != null
  const out: QuotaWindow[] = []
  for (const key of ["primary", "secondary"]) {
    const w = limits[key] as Record<string, unknown> | null | undefined
    if (!w) continue
    const used = (num(w.used_percent) ?? 0) / 100
    const minutes = num(w.window_minutes)
    const reset = num(w.resets_at)
    out.push({
      label: minutes ? windowLabel(minutes) : key,
      usedFraction: Math.min(1, Math.max(0, used)),
      resetsAt: reset ? reset * 1000 : undefined,
      limited: used >= 1 || (reached && key === "primary"),
    })
  }
  return out
}

/** Codex writes each thread to `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. */
export function findCodexRollout(threadId: string, home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")): string | undefined {
  const root = path.join(home, "sessions")
  if (!existsSync(root)) return undefined
  // Newest days first: the thread just ran.
  const desc = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort().reverse() : [])
  for (const y of desc(root))
    for (const m of desc(path.join(root, y)))
      for (const d of desc(path.join(root, y, m)).slice(0, 3)) {
        const dir = path.join(root, y, m, d)
        const hit = readdirSync(dir).find((f) => f.endsWith(`${threadId}.jsonl`))
        if (hit) return path.join(dir, hit)
      }
  return undefined
}

/** The last `rate_limits` a Codex thread recorded, or undefined. */
export function readCodexQuota(threadId: string, home?: string): QuotaWindow[] | undefined {
  const file = findCodexRollout(threadId, home)
  if (!file) return undefined
  const lines = readFileSync(file, "utf8").trimEnd().split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (!line.includes('"rate_limits"')) continue
    try {
      const found = findKey(JSON.parse(line), "rate_limits")
      if (found && typeof found === "object") return parseCodexRateLimits(found as Record<string, unknown>)
    } catch {
      // A line cut off mid-write: try an earlier one.
    }
  }
  return undefined
}

function findKey(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (key in record) return record[key]
  for (const v of Object.values(record)) {
    const hit = findKey(v, key)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Quota is per account, not per workspace, and every Conductor turn starts a fresh MCP server: one file for all. */
export function defaultQuotaFile(): string {
  const base =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
      : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache"))
  return path.join(base, "agent-router", "quota.json")
}

/** The latest usage windows per provider, shared through a file so separate processes see each other's reports. */
export class QuotaTracker {
  private data: QuotaSnapshot = {}

  constructor(
    /** null keeps quota in memory only. */
    private readonly file: string | null = defaultQuotaFile(),
    private readonly now: () => number = Date.now,
  ) {
    this.load()
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as QuotaSnapshot
      for (const p of PROVIDERS) if (parsed[p]?.windows) this.data[p] = parsed[p]
    } catch {
      // A corrupt cache is just no data.
    }
  }

  record(provider: ProviderId, windows: QuotaWindow[]): void {
    if (!windows.length) return
    // Another process may have written since we loaded; keep its other providers.
    this.load()
    this.data[provider] = { windows, at: this.now() }
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data))
    } catch {
      // Quota is advisory; failing to save it must never fail a delegation.
    }
  }

  /** Current windows; one whose reset time has passed counts as empty again. */
  windows(provider: ProviderId): QuotaWindow[] {
    const now = this.now()
    return (this.data[provider]?.windows ?? []).map((w) =>
      w.resetsAt !== undefined && w.resetsAt <= now ? { ...w, usedFraction: 0, limited: false, resetsAt: undefined } : w,
    )
  }

  /** The window that blocks this provider until it resets, if any. */
  blocking(provider: ProviderId): QuotaWindow | undefined {
    return this.windows(provider).find((w) => w.limited)
  }

  /** The fullest window. */
  fullest(provider: ProviderId): QuotaWindow | undefined {
    return this.windows(provider).reduce<QuotaWindow | undefined>((a, w) => (!a || w.usedFraction > a.usedFraction ? w : a), undefined)
  }

  snapshot(): QuotaSnapshot {
    return Object.fromEntries(
      PROVIDERS.filter((p) => this.data[p]).map((p) => [p, { windows: this.windows(p), at: this.data[p]?.at ?? 0 }]),
    ) as QuotaSnapshot
  }
}

/** "5h 72%, resets 14:10" */
export function describeWindow(w: QuotaWindow): string {
  const reset = w.resetsAt
    ? `, resets ${new Date(w.resetsAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : ""
  return `${w.label} ${Math.round(w.usedFraction * 100)}%${w.limited ? " (limit reached)" : ""}${reset}`
}
