// Profile benchmark: run each task under each routing profile through `agent-router serve`,
// record cost, tokens, delegations and an automatic score, and write one JSON per run.
//
//   npx bun bench/bench.ts --reps 2 --budget 3.5 --out bench/results/<date>
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"
import { REPO, type RunResult, TASKS, type Task } from "./tasks"

const { values: args } = parseArgs({
  options: {
    reps: { type: "string", default: "2" },
    budget: { type: "string", default: "3.5" },
    profiles: { type: "string", default: "quality,balanced,economy" },
    tasks: { type: "string", default: "explain,fix,review" },
    out: { type: "string", default: path.join(REPO, "bench/results", new Date().toISOString().slice(0, 10)) },
  },
})

async function runOnce(task: Task, profile: string, rep: number): Promise<RunResult> {
  const ws = task.workspace()
  const token = crypto.randomUUID() + crypto.randomUUID()
  const server = spawn(path.join(REPO, "node_modules/bun/bin/bun.exe"), [path.join(REPO, "src/cli.ts"), "serve", "--port", "0"], {
    env: { ...process.env, AGENT_ROUTER_TOKEN: token },
    stdio: ["pipe", "pipe", "inherit"],
  })
  const result: RunResult = {
    task: task.id,
    profile,
    rep,
    ok: false,
    error: "",
    ms: 0,
    conductor: { usd: 0, input: 0, output: 0 },
    delegates: [],
    approvals: [],
    answer: "",
  }
  try {
    const stdout = server.stdout
    if (!stdout) throw new Error("server has no stdout")
    const first = await new Promise<string>((resolve) => createInterface({ input: stdout }).once("line", resolve))
    const port = JSON.parse(first).port as number
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ui?token=${token}`)
    const classes = new Map<string, string>()
    const started = Date.now()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        result.error = "benchmark timeout (15 min)"
        socket.send(JSON.stringify({ type: "cancel" }))
        setTimeout(resolve, 5_000)
      }, 15 * 60_000)
      socket.addEventListener("message", (e) => {
        const msg = JSON.parse(String(e.data))
        if (msg.type === "hello") {
          const permission = ws.writable ? "acceptEdits" : "default"
          socket.send(JSON.stringify({ type: "start", prompt: task.prompt, workspace: ws.dir, permission, profile }))
        }
        if (msg.type === "conductor" && msg.event.type === "usage") {
          result.conductor.usd += msg.event.costUsd ?? 0
          result.conductor.input += msg.event.inputTokens
          result.conductor.output += msg.event.outputTokens
        }
        if (msg.type === "conductor" && msg.event.type === "done") result.answer = msg.event.text
        if (msg.type === "delegation.started") classes.set(msg.id, msg.taskClass)
        if (msg.type === "delegation.finished") {
          const s = msg.summary
          result.delegates.push({
            taskClass: classes.get(msg.id),
            provider: s.provider,
            model: s.model,
            tier: s.tier,
            usd: s.costUsd,
            tokens: s.tokens,
            status: s.status,
            attempts: s.attempts.map(
              (a: { provider: string; tier: string; outcome: string; errorKind?: string }) =>
                `${a.provider}/${a.tier}: ${a.errorKind ?? a.outcome}`,
            ),
          })
        }
        if (msg.type === "approval.request") {
          // Only the throwaway fixture copy is writable; the real repo stays read-only.
          result.approvals.push({ tool: msg.tool, allowed: ws.writable })
          socket.send(
            JSON.stringify({ type: "approval", id: msg.id, allow: ws.writable, message: ws.writable ? undefined : "benchmark: read-only" }),
          )
        }
        if (msg.type === "turn.finished") {
          clearTimeout(timer)
          result.ok = msg.ok
          result.error ||= msg.error ?? ""
          resolve()
        }
      })
    })
    result.ms = Date.now() - started
    socket.close()
    result.score = task.score(result, ws)
  } catch (error) {
    result.error = String(error)
  } finally {
    server.stdin?.end()
  }
  return result
}

const totalUsd = (r: RunResult) => r.conductor.usd + r.delegates.reduce((sum, d) => sum + (d.usd ?? 0), 0)

const outDir = path.resolve(args.out)
mkdirSync(outDir, { recursive: true })
let spent = readdirSync(outDir)
  .filter((f) => f.endsWith(".json"))
  .reduce((sum, f) => sum + totalUsd(JSON.parse(readFileSync(path.join(outDir, f), "utf8"))), 0)
const budget = Number(args.budget)
const profiles = args.profiles.split(",")
const tasks = args.tasks.split(",").map((id) => {
  const task = TASKS.find((t) => t.id === id)
  if (!task) throw new Error(`unknown task ${id}`)
  return task
})

// Interleave so a budget stop leaves every cell with the same number of reps, give or take one.
for (let rep = 1; rep <= Number(args.reps); rep++) {
  for (const task of tasks) {
    for (const profile of profiles) {
      const file = path.join(outDir, `${task.id}.${profile}.${rep}.json`)
      if (existsSync(file)) continue
      if (spent >= budget) {
        console.log(`budget $${budget} reached ($${spent.toFixed(2)} spent); stopping`)
        process.exit(0)
      }
      console.log(`→ ${task.id} / ${profile} / rep ${rep}`)
      const result = await runOnce(task, profile, rep)
      spent += totalUsd(result)
      writeFileSync(file, JSON.stringify(result, null, 2))
      const d = result.delegates.map((x) => `${x.provider}/${x.tier}`).join(" ") || "none"
      console.log(
        `  ${result.score?.pass ? "PASS" : "FAIL"} $${totalUsd(result).toFixed(3)} ${result.conductor.input + result.conductor.output} tok ${(result.ms / 1000).toFixed(0)}s delegates: ${d} (total $${spent.toFixed(2)})`,
      )
    }
  }
}
