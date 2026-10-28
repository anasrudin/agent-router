import type { BackendEvent } from "../backends/events"

export type WatchdogTrip = { kind: "stalled" | "tool_loop"; message: string }

export interface WatchdogOptions {
  /** Abort when the delegate produces no event at all for this long. */
  stallMs: number
  /** Abort when the delegate makes the same tool call this many times in a row. */
  maxIdenticalToolCalls: number
  onTrip: (trip: WatchdogTrip) => void
}

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` fingerprint the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

/**
 * Catches a delegate that is alive but not making progress, long before delegate_timeout_seconds:
 * one that has gone silent, or one stuck repeating the same tool call. Trips at most once.
 */
export class Watchdog {
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastCall = ""
  private repeats = 0
  private tripped = false
  private stopped = false

  constructor(private readonly options: WatchdogOptions) {
    this.arm()
  }

  observe(event: BackendEvent): void {
    if (this.tripped || this.stopped) return
    this.arm()
    if (event.type !== "tool_call") return
    const fingerprint = `${event.name}:${stableStringify(event.input)}`
    this.repeats = fingerprint === this.lastCall ? this.repeats + 1 : 1
    this.lastCall = fingerprint
    if (this.repeats >= this.options.maxIdenticalToolCalls) {
      this.trip({ kind: "tool_loop", message: `made the same ${event.name} call ${this.repeats} times in a row` })
    }
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }

  private arm(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(
      () => this.trip({ kind: "stalled", message: `no output for ${Math.round(this.options.stallMs / 1000)} s` }),
      this.options.stallMs,
    )
  }

  private trip(trip: WatchdogTrip): void {
    if (this.tripped) return
    this.tripped = true
    clearTimeout(this.timer)
    this.options.onTrip(trip)
  }
}
