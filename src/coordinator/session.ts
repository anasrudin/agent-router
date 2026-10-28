import os from "node:os"
import type { PermissionMode } from "../backends/Backend"
import type { BackendRegistry } from "../backends/registry"
import { PROVIDERS, type ProviderId, type RoutingConfig } from "../config/schema"
import { HealthTracker } from "../router/health"
import type { PolicyContext } from "../router/policy"

/** Caps concurrent delegates at limits.max_parallel_agents. */
export class Semaphore {
  private active = 0
  private readonly waiting: (() => void)[] = []
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is handed straight to the next waiter, so a newcomer can never slip in between.
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active += 1
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}

export interface SessionOptions {
  workspace: string
  config: RoutingConfig
  backends: BackendRegistry
  selfProvider: ProviderId
  permission: PermissionMode
}

/** State shared by every delegation in one Conductor session. */
export class Session implements PolicyContext {
  readonly workspace: string
  readonly config: RoutingConfig
  readonly backends: BackendRegistry
  readonly selfProvider: ProviderId
  readonly permission: PermissionMode
  readonly health: HealthTracker
  /** Name of the routing profile in effect, if any. */
  readonly profile?: string
  readonly slots: Semaphore
  /** One queue per backend (limits.max_parallel_per_provider), so parallel work spreads instead of piling onto one CLI's rate limit. */
  private readonly providerSlots = new Map<ProviderId, Semaphore>()
  spentUsd = 0
  /** Edit-mode delegates currently writing in the main workspace (not a worktree). */
  activeWritersInWorkspace = 0

  constructor(options: SessionOptions) {
    this.workspace = options.workspace
    this.config = options.config
    this.backends = options.backends
    this.selfProvider = options.selfProvider
    this.permission = options.permission
    this.profile = options.config.active_profile
    this.health = new HealthTracker(options.config.limits.backend_unhealthy_after_errors)
    this.slots = new Semaphore(options.config.limits.max_parallel_agents)
  }

  providerSlot(provider: ProviderId): Semaphore {
    let slot = this.providerSlots.get(provider)
    if (!slot) {
      slot = new Semaphore(this.config.limits.max_parallel_per_provider)
      this.providerSlots.set(provider, slot)
    }
    return slot
  }

  async detectBackends(): Promise<void> {
    await Promise.all(PROVIDERS.map(async (p) => this.health.recordDetection(p, await this.backends[p].detect())))
  }

  addCost(usd: number | undefined): void {
    if (usd) this.spentUsd += usd
  }

  budgetLine(): string {
    const cap = this.config.budget.session_usd
    return cap === null ? `no cap (spent $${this.spentUsd.toFixed(2)})` : `$${cap} (spent $${this.spentUsd.toFixed(2)})`
  }

  backendsStatusLine(): string {
    const snap = this.health.snapshot()
    return PROVIDERS.map((p) => {
      const s = snap[p]
      const state = s.installed === false ? "not installed" : s.healthy ? "healthy" : `unhealthy: ${s.reason}`
      return `${p} (${this.config.backends[p].executable}${s.version ? ` ${s.version}` : ""}): ${state}`
    }).join("; ")
  }

  platformLine(): string {
    return process.platform === "win32" ? os.release() : `n/a — running on ${os.type()} ${os.release()}, not Windows`
  }
}
