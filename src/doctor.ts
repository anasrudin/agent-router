import { conductorSystemPrompt, conductorTier, createSession } from "./conductor/run"
import { checkTiers } from "./config/catalog"
import { loadConfig } from "./config/load"
import { describePlan } from "./config/plans"
import { isPlaceholderModel, PROVIDERS, type ProviderId, TIERS } from "./config/schema"
import type { DoctorReport } from "./server/protocol"

export { olderThan, semver } from "./server/versions"

/** How each CLI is usually updated, and the npm package that says what its latest version is. */
export const CLI_UPDATES: Record<ProviderId, { command: string; npm: string }> = {
  claude: { command: "claude update", npm: "@anthropic-ai/claude-code" },
  gemini: { command: "npm install -g @google/gemini-cli@latest", npm: "@google/gemini-cli" },
  openai: { command: "npm install -g @openai/codex@latest", npm: "@openai/codex" },
}

const NAME: Record<ProviderId, string> = { claude: "Claude", gemini: "Gemini", openai: "Codex" }

/** The config, the plan, each backend CLI and its tiers, the profiles and Conductor's prompt, as findings. */
export async function runDoctor(workspace: string, plan?: string): Promise<DoctorReport> {
  const { sources } = loadConfig(workspace, undefined, undefined, plan)
  const session = await createSession({ workspace, permission: "default", selfProvider: "claude", plan })
  const findings: DoctorReport["findings"] = []
  const active = session.config.active_plan
  const snap = session.health.snapshot()
  const backends: DoctorReport["backends"] = []
  for (const p of PROVIDERS) {
    const s = snap[p]
    const cfg = session.config.backends[p]
    const detection = await session.backends[p].detect()
    backends.push({
      provider: p,
      executable: cfg.executable,
      installed: Boolean(s.installed),
      version: s.version,
      reason: s.reason,
      testedVersion: detection.testedVersion,
      updateCommand: CLI_UPDATES[p].command,
    })
    if (!s.installed) {
      findings.push({
        level: p === "claude" ? "error" : "warn",
        provider: p,
        text: `${NAME[p]} is not available (${s.reason ?? "not found"}): ${p === "claude" ? "Conductor needs it." : "its work goes to the other backends."}`,
        fix: { tab: "advanced", hint: "Set its command under Advanced → Backend commands, or install the CLI." },
      })
      const placeholders = TIERS.filter((t) => isPlaceholderModel(cfg.tiers[t]))
      if (placeholders.length)
        findings.push({
          level: "warn",
          provider: p,
          text: `${NAME[p]}: tiers ${placeholders.join(", ")} use a placeholder model, so the CLI's default model runs.`,
          fix: { tab: "models" },
        })
      continue
    }
    if (detection.testedVersion && !detection.version?.includes(detection.testedVersion))
      findings.push({
        level: "warn",
        provider: p,
        text: `${NAME[p]}: the adapter was tested against ${detection.testedVersion}; ${detection.version} is installed.`,
      })
    if (!detection.testedVersion)
      findings.push({ level: "warn", provider: p, text: `${NAME[p]}: no recorded fixtures for this CLI yet, so its flags are unverified.` })
    const options = await session.backends[p].options()
    for (const c of checkTiers(cfg.tiers, cfg.reasoning, options, options.authoritative ?? false))
      findings.push({
        level: "warn",
        provider: p,
        text: `${NAME[p]} tiers.${c.tier} ${c.model}: ${c.problem}${c.suggestion ? ` (try ${c.suggestion})` : ""}`,
        fix: { tab: "models" },
      })
  }
  const profiles = Object.entries(session.config.profiles)
  const model = session.config.backends.claude.tiers[conductorTier(session).tier]
  const prompt = conductorSystemPrompt(session, isPlaceholderModel(model) ? undefined : model)
  if (prompt.missing.length)
    findings.push({ level: "warn", text: `Conductor's prompt has unfilled variables: ${prompt.missing.join(", ")}` })
  return {
    sources,
    plan: active ? `${describePlan(active)}; Conductor runs on ${conductorTier(session).tier}` : undefined,
    profiles: profiles.map(([n, p]) => ({ name: n, tier: p.conductor.tier, isDefault: n === session.config.default_profile })),
    backends,
    findings,
    ok: Boolean(snap.claude.installed),
  }
}

/** The newest published version of each CLI, from the npm registry (only when asked). */
export async function latestVersions(timeoutMs = 6000): Promise<Partial<Record<ProviderId, string>>> {
  const out: Partial<Record<ProviderId, string>> = {}
  await Promise.all(
    PROVIDERS.map(async (p) => {
      try {
        const res = await fetch(`https://registry.npmjs.org/${CLI_UPDATES[p].npm}/latest`, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) return
        const body = (await res.json()) as { version?: unknown }
        if (typeof body.version === "string") out[p] = body.version
      } catch {
        // Offline or blocked: that CLI just has no "latest".
      }
    }),
  )
  return out
}
