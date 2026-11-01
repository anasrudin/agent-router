import type { Detection } from "../backends/Backend"
import type { BackendErrorKind } from "../backends/events"
import { PROVIDERS, type ProviderId } from "../config/schema"

export interface ProviderHealth {
  healthy: boolean
  installed?: boolean
  version?: string
  consecutiveErrors: number
  reason?: string
  /** A rate limit with a known reset: healthy again from this time (epoch ms). */
  retryAt?: number
}

/** Problems that will not clear by retrying within this session. */
const HARD_FAILURES: ReadonlySet<BackendErrorKind> = new Set([
  "missing_executable",
  "not_authenticated",
  "untrusted_workspace",
  "rate_limited",
])

/** Errors that say nothing about the backend itself. */
const NEUTRAL: ReadonlySet<BackendErrorKind> = new Set(["cancelled", "context_overflow"])

export class HealthTracker {
  private readonly state = new Map<ProviderId, ProviderHealth>()

  constructor(
    private readonly unhealthyAfterErrors: number,
    private readonly now: () => number = Date.now,
  ) {
    for (const p of PROVIDERS) this.state.set(p, { healthy: true, consecutiveErrors: 0 })
  }

  private get(provider: ProviderId): ProviderHealth {
    const s = this.state.get(provider)
    if (!s) throw new Error(`unknown provider ${provider}`)
    return s
  }

  recordDetection(provider: ProviderId, detection: Detection): void {
    const s = this.get(provider)
    s.installed = detection.installed
    s.version = detection.version
    if (!detection.installed) {
      s.healthy = false
      s.reason = detection.detail ?? "not installed"
    }
  }

  /** `retryAt`: for a rate limit whose reset time is known, when the backend may be used again. */
  recordError(provider: ProviderId, kind: BackendErrorKind, message: string, retryAt?: number): void {
    if (NEUTRAL.has(kind)) return
    const s = this.get(provider)
    s.consecutiveErrors += 1
    if (HARD_FAILURES.has(kind) || s.consecutiveErrors >= this.unhealthyAfterErrors) {
      s.healthy = false
      s.reason = `${kind}: ${message.slice(0, 200)}`
      s.retryAt = kind === "rate_limited" && retryAt && retryAt > this.now() ? retryAt : undefined
    }
  }

  recordSuccess(provider: ProviderId): void {
    const s = this.get(provider)
    s.consecutiveErrors = 0
  }

  isHealthy(provider: ProviderId): boolean {
    const s = this.get(provider)
    if (!s.healthy && s.retryAt !== undefined && this.now() >= s.retryAt) {
      // The rate-limit window has reset.
      Object.assign(s, { healthy: true, consecutiveErrors: 0, reason: undefined, retryAt: undefined })
    }
    return s.healthy
  }

  snapshot(): Record<ProviderId, ProviderHealth> {
    return Object.fromEntries(PROVIDERS.map((p) => [p, { ...this.get(p) }])) as Record<ProviderId, ProviderHealth>
  }
}
