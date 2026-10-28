#!/usr/bin/env bun
import path from "node:path"
import { Command, InvalidArgumentError, Option } from "commander"
import type { PermissionMode } from "./backends/Backend"
import { KILL_GRACE_MS } from "./backends/process"
import { conductorSystemPrompt, conductorTier, createSession, runConductor, SELF_ENTRY } from "./conductor/run"
import { loadConfig } from "./config/load"
import { isPlaceholderModel, PROVIDERS, type ProviderId, ProviderId as ProviderSchema, TIERS } from "./config/schema"
import { delegate } from "./coordinator/delegate"
import { Brief } from "./coordinator/protocol"
import { formatResult, type Pins, serveStdio } from "./mcp/server"
import { guessTaskClass, type Overrides, parseOverrides, ULTRAWORK_NOTE } from "./router/classify"
import { Bridge } from "./server/bridge"
import { startServer } from "./server/serve"

const VERSION = "0.1.0"

import { describePlan } from "./config/plans"
import { ledgerContext, newLedgerPath, readLedger } from "./coordinator/ledger"
import { reportGate } from "./hooks/report-gate"
import { serveLspStdio } from "./lsp/mcp"
import { installedServers } from "./lsp/servers"
import { decide, RoutingError } from "./router/policy"

const PERMISSIONS = ["default", "acceptEdits", "bypass"] as const

function provider(value: string): ProviderId {
  const name = value === "codex" ? "openai" : value
  const parsed = ProviderSchema.safeParse(name)
  if (!parsed.success) throw new InvalidArgumentError(`expected one of ${PROVIDERS.join(", ")} (or codex)`)
  return parsed.data
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function parsePins(values: string[]): Pins {
  const pins: Pins = { routes: {} }
  for (const v of values) {
    const [cls, p] = v.includes("=") ? v.split("=", 2) : [undefined, v]
    if (cls) pins.routes[cls] = provider(p ?? "")
    else pins.provider = provider(p ?? "")
  }
  return pins
}

const workspaceOption = () => new Option("-w, --workspace <dir>", "workspace root").default(process.cwd())
const permissionOption = () => new Option("--permission <mode>", "harness permission mode").choices(PERMISSIONS).default("default")
const selfOption = () => new Option("--self <provider>", "backend Conductor runs on").argParser(provider).default("claude")
const profileOption = () => new Option("--profile <name>", "routing profile (quality, balanced, economy, or one you define)")
const planOption = () =>
  new Option("--plan <name>", "your subscriptions: claude-heavy, chatgpt-heavy, split, or none (overrides `plan` in the config)")

interface CommonOpts {
  workspace: string
  permission: PermissionMode
  self: ProviderId
  profile?: string
  plan?: string
}

/** The model Conductor runs on under the session's profile, for rendering its prompt. */
function conductorModel(session: Awaited<ReturnType<typeof createSession>>): string | undefined {
  const model = session.config.backends.claude.tiers[conductorTier(session).tier]
  return isPlaceholderModel(model) ? undefined : model
}

const program = new Command()
  // Without this the top-level command also claims `--profile`/`--workspace` written after a subcommand.
  .enablePositionalOptions()
  .name("agent-router")
  .description("Conductor: routes work across Claude Code, Gemini CLI and Codex CLI without lowering quality.")
  .argument("[prompt...]", "request for Conductor; omit for an interactive session")
  .addOption(workspaceOption())
  .addOption(permissionOption())
  .addOption(selfOption())
  .addOption(profileOption())
  .addOption(planOption())
  .option("--show-system-prompt", "print Conductor's rendered system prompt and exit")
  .action(async (words: string[], opts: CommonOpts & { showSystemPrompt?: boolean }) => {
    const workspace = path.resolve(opts.workspace)
    if (opts.showSystemPrompt) {
      const session = await createSession({
        workspace,
        permission: opts.permission,
        selfProvider: opts.self,
        profile: opts.profile,
        plan: opts.plan,
      })
      process.stdout.write(conductorSystemPrompt(session, conductorModel(session)).text)
      return
    }
    const raw = words.length ? words.join(" ") : undefined
    const overrides: Overrides =
      raw === undefined ? { routes: {}, text: "" } : parseOverrides(raw, Object.keys(loadConfig(workspace, null).config.profiles))
    process.exitCode = await runConductor({
      workspace,
      permission: opts.permission,
      selfProvider: opts.self,
      // A keyword in the message (`@economy`, `ultrawork`) beats --profile.
      profile: overrides.profile ?? opts.profile,
      plan: opts.plan,
      // The original wording goes to Conductor too, so it can see and acknowledge the override.
      prompt: raw !== undefined && overrides.ultrawork ? `${raw}\n\n${ULTRAWORK_NOTE}` : raw,
      pins: { provider: overrides.provider, routes: overrides.routes },
      entry: SELF_ENTRY,
      ledger: newLedgerPath(),
    })
  })

program
  .command("doctor")
  .description("check config, prompts and each backend CLI")
  .addOption(workspaceOption())
  .addOption(planOption())
  .action(async (opts: { workspace: string; plan?: string }) => {
    const workspace = path.resolve(opts.workspace)
    const { sources } = loadConfig(workspace, undefined, undefined, opts.plan)
    process.stdout.write(`config: ${sources.join(" + ")} — valid\n`)
    const session = await createSession({ workspace, permission: "default", selfProvider: "claude", plan: opts.plan })
    const plan = session.config.active_plan
    process.stdout.write(
      plan
        ? `plan: ${describePlan(plan)}; Conductor runs on ${conductorTier(session).tier}\n`
        : "plan: none set (`plan:` in routing.yaml or --plan claude-heavy|chatgpt-heavy|split)\n",
    )
    const snap = session.health.snapshot()
    let ok = true
    for (const p of PROVIDERS) {
      const s = snap[p]
      const detection = await session.backends[p].detect()
      const placeholders = TIERS.filter((t) => isPlaceholderModel(session.config.backends[p].tiers[t]))
      const mark = s.installed ? "ok  " : "MISS"
      process.stdout.write(`${mark} ${p.padEnd(7)} ${session.config.backends[p].executable}: ${s.installed ? s.version : s.reason}\n`)
      if (s.installed && detection.testedVersion && !detection.version?.includes(detection.testedVersion)) {
        process.stdout.write(`     warn: adapter tested against ${detection.testedVersion}; installed ${detection.version}\n`)
      }
      if (s.installed && !detection.testedVersion)
        process.stdout.write("     warn: no recorded fixtures for this CLI yet; adapter flags are unverified\n")
      if (placeholders.length)
        process.stdout.write(`     warn: placeholder model for tiers ${placeholders.join(", ")} — CLI default model runs\n`)
      if (p === "claude" && !s.installed) ok = false
    }
    const prompt = conductorSystemPrompt(session, conductorModel(session))
    const profiles = Object.entries(session.config.profiles)
    process.stdout.write(
      profiles.length
        ? `profiles: ${profiles.map(([n, p]) => `${n}${n === session.config.default_profile ? " (default)" : ""} — Conductor on ${p.conductor.tier}`).join("; ")}\n`
        : "profiles: none defined\n",
    )
    process.stdout.write(
      prompt.missing.length ? `warn: unfilled prompt variables ${prompt.missing.join(", ")}\n` : "prompts: all variables filled\n",
    )
    if (!ok) {
      process.stdout.write("Conductor needs the claude backend.\n")
      process.exitCode = 1
    }
  })

program
  .command("route")
  .description("dry-run a routing decision")
  .argument("<task-class>")
  .addOption(workspaceOption())
  .option("--provider <provider>", "pin a provider", provider)
  .option("--author <provider>", "author of the work under review", provider)
  .option("--tokens <n>", "estimated input tokens", (v) => Number.parseInt(v, 10))
  .option("--media <kind>", "media the delegate must read (repeatable)", collect, [])
  .option("--file <path>", "file the brief exposes (repeatable)", collect, [])
  .option("--files-touched <n>", "how many files the change touches", (v) => Number.parseInt(v, 10))
  .option("--task <text>", "task text (risk words can raise the tier)")
  .addOption(profileOption())
  .addOption(planOption())
  .action(
    async (
      taskClass: string,
      opts: {
        workspace: string
        provider?: ProviderId
        author?: ProviderId
        tokens?: number
        media: string[]
        file: string[]
        filesTouched?: number
        task?: string
        profile?: string
        plan?: string
      },
    ) => {
      const session = await createSession({
        workspace: path.resolve(opts.workspace),
        permission: "default",
        selfProvider: "claude",
        profile: opts.profile,
        plan: opts.plan,
      })
      try {
        const decision = decide(session, {
          taskClass,
          override: opts.provider,
          author: opts.author,
          inputTokens: opts.tokens,
          media: opts.media as never,
          files: opts.file,
          filesTouched: opts.filesTouched,
          taskText: opts.task,
        })
        process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`)
      } catch (error) {
        if (!(error instanceof RoutingError)) throw error
        process.stderr.write(`RoutingError (${error.kind}): ${error.message}\n`)
        process.exitCode = 2
      }
    },
  )

program
  .command("delegate")
  .description("run one delegation directly (no Conductor) — for testing routes and adapters")
  .requiredOption("--task <text>", "what to produce")
  .requiredOption("--acceptance <text>", "acceptance criterion (repeatable)", collect, [])
  .option("--class <task-class>", "task class (guessed from --task if omitted)")
  .option("--why <text>", "underlying goal", "Manual delegation from the agent-router CLI.")
  .option("--file <path>", "relevant file (repeatable)", collect, [])
  .option("--fact <text>", "established fact (repeatable)", collect, [])
  .addOption(new Option("--mode <mode>", "delegate mode").choices(["read-only", "run-commands", "edit"]).default("read-only"))
  .option("--provider <provider>", "pin a provider", provider)
  .option("--author <provider>", "author, for code.review", provider)
  .addOption(workspaceOption())
  .addOption(permissionOption())
  .addOption(profileOption())
  .addOption(planOption())
  .action(
    async (opts: {
      task: string
      acceptance: string[]
      class?: string
      why: string
      file: string[]
      fact: string[]
      mode: Brief["mode"]
      provider?: ProviderId
      author?: ProviderId
      workspace: string
      permission: PermissionMode
      profile?: string
      plan?: string
    }) => {
      const session = await createSession({
        workspace: path.resolve(opts.workspace),
        permission: opts.permission,
        selfProvider: "claude",
        profile: opts.profile,
        plan: opts.plan,
      })
      const taskClass = opts.class ?? guessTaskClass(opts.task)
      const brief = Brief.parse({
        task: opts.task,
        why: opts.why,
        relevant_files: opts.file,
        facts: opts.fact,
        mode: opts.mode,
        acceptance: opts.acceptance,
      })
      try {
        const result = await delegate(session, {
          taskClass,
          brief,
          route: { override: opts.provider, author: opts.author },
          onEvent: (p, e) => {
            if (e.type === "tool_call") process.stderr.write(`· [${p}] ${e.name}\n`)
          },
        })
        process.stdout.write(`${formatResult(result)}\n`)
        if (result.status === "error") process.exitCode = 1
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`)
        process.exitCode = 2
      }
    },
  )

program
  .command("mcp", { hidden: true })
  .description("serve the router's MCP tools over stdio (started by Conductor's CLI)")
  .addOption(workspaceOption())
  .addOption(permissionOption())
  .addOption(selfOption())
  .addOption(profileOption())
  .addOption(planOption())
  .option("--pin <provider|class=provider>", "routing pin from the user's message (repeatable)", collect, [])
  .option("--bridge <url>", "desktop server to report delegations and approval prompts to")
  .option("--ledger <file>", "record this chat's delegations here (read back after context compaction)")
  .action(async (opts: CommonOpts & { pin: string[]; bridge?: string; ledger?: string }) => {
    const session = await createSession({
      workspace: path.resolve(opts.workspace),
      permission: opts.permission,
      selfProvider: opts.self,
      profile: opts.profile,
      plan: opts.plan,
    })
    // Conductor closing our stdin, or a stop signal to its process group, means it has gone:
    // stop every delegate it started (each in its own process group) before exiting.
    const lifetime = new AbortController()
    const shutdown = () => {
      if (lifetime.signal.aborted) return
      lifetime.abort()
      setTimeout(() => process.exit(0), KILL_GRACE_MS + 500)
    }
    process.stdin.once("close", shutdown)
    process.once("SIGTERM", shutdown)
    process.once("SIGINT", shutdown)
    const bridge = opts.bridge ? await Bridge.connect(opts.bridge).catch(() => undefined) : undefined
    await serveStdio(session, parsePins(opts.pin), { bridge, signal: lifetime.signal, ledger: opts.ledger })
  })

program
  .command("lsp-mcp", { hidden: true })
  .description("serve code-navigation tools backed by installed language servers over stdio (attached to delegates)")
  .addOption(workspaceOption())
  .option("--tools-root <dir>", "where to find the project's node_modules/.bin (the main workspace, for a worktree)")
  .action(async (opts: { workspace: string; toolsRoot?: string }) => {
    const workspace = path.resolve(opts.workspace)
    const toolsRoot = path.resolve(opts.toolsRoot ?? workspace)
    const { config } = loadConfig(workspace)
    await serveLspStdio(workspace, installedServers(toolsRoot, config.lsp.servers), toolsRoot)
  })

// Claude Code hook commands. A hook must never break the run it guards: any error lets it continue.
const hook = program.command("hook", { hidden: true }).description("Claude Code hook handlers (started by the CLIs, not by people)")

async function runHook(handler: (input: Record<string, unknown>) => unknown): Promise<void> {
  try {
    const raw = await new Response(Bun.stdin.stream()).text()
    const output = handler(raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {})
    if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (error) {
    process.stderr.write(`agent-router hook: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

hook
  .command("report-gate")
  .description("Stop hook: keep a delegate going until its final message is a well-formed report")
  .requiredOption("--state <dir>", "folder for the per-session block counters")
  .action((opts: { state: string }) => runHook((input) => reportGate(input, opts.state)))

hook
  .command("compact-context")
  .description("SessionStart(compact) hook: give Conductor back its delegation ledger after compaction")
  .requiredOption("--ledger <file>", "the chat's delegation ledger")
  .action((opts: { ledger: string }) =>
    runHook(() => {
      const context = ledgerContext(readLedger(opts.ledger))
      return context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } : undefined
    }),
  )

program
  .command("serve")
  .description("local server for the desktop app (127.0.0.1 only; token from AGENT_ROUTER_TOKEN)")
  .option("--port <n>", "port, 0 for any free port", (v) => Number.parseInt(v, 10), 0)
  .action((opts: { port: number }) => {
    const token = process.env.AGENT_ROUTER_TOKEN
    if (!token || token.length < 16) {
      process.stderr.write("AGENT_ROUTER_TOKEN must be set to a random secret of at least 16 characters.\n")
      process.exitCode = 2
      return
    }
    const server = startServer({ port: opts.port, token, version: VERSION })
    // The desktop shell reads this line to learn the port.
    process.stdout.write(`${JSON.stringify({ event: "ready", port: server.port })}\n`)
    // The shell holds our stdin open; when it closes, the app is gone and so are we.
    process.stdin.resume()
    process.stdin.once("close", () => {
      server.stop()
      process.exit(0)
    })
  })

await program.parseAsync()
