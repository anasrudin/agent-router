// Single-model baseline: run each task on one CLI directly, without the router, and write one JSON per run
// in the same shape as bench.ts, so report.ts reads both. Profiles are named `solo-<model>`.
//
//   npx bun bench/baseline.ts --reps 2 --budget 2 --out bench/results/<date>-baseline
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { REPO, type RunResult, TASKS, type Task } from "./tasks"

const { values: args } = parseArgs({
  options: {
    reps: { type: "string", default: "2" },
    budget: { type: "string", default: "2" },
    solos: { type: "string", default: "solo-opus,solo-sonnet,solo-codex" },
    tasks: { type: "string", default: "explain,fix,review" },
    out: { type: "string", default: path.join(REPO, "bench/results", `${new Date().toISOString().slice(0, 10)}-baseline`) },
  },
})

// The tools a read-only Claude delegate gets from the router, so neither side has more to work with.
const READ_TOOLS = ["Read", "Bash(grep:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(wc:*)"]
const EDIT_TOOLS = [...READ_TOOLS, "Edit", "Write", "Bash(node:*)"]
const TIMEOUT_MS = 15 * 60_000

function emptyResult(task: Task, solo: string, rep: number): RunResult {
  return {
    task: task.id,
    profile: solo,
    rep,
    ok: false,
    error: "",
    ms: 0,
    conductor: { usd: 0, input: 0, output: 0 },
    delegates: [],
    approvals: [],
    answer: "",
  }
}

function runClaude(result: RunResult, model: string, prompt: string, dir: string, writable: boolean): void {
  const tools = writable ? EDIT_TOOLS : READ_TOOLS
  const run = spawnSync(
    "claude",
    [
      "-p",
      "--output-format",
      "json",
      "--model",
      model,
      "--permission-mode",
      writable ? "acceptEdits" : "dontAsk",
      "--allowedTools",
      ...tools,
      "--disallowedTools",
      "Agent",
      "Task",
    ],
    { cwd: dir, input: prompt, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 1 << 28 },
  )
  try {
    const out = JSON.parse(run.stdout)
    const usage = out.usage ?? {}
    // Same rule as the router's adapters: every prompt-side token, cached or not.
    const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
    result.conductor = { usd: out.total_cost_usd ?? 0, input, output: usage.output_tokens ?? 0 }
    result.answer = out.result ?? ""
    result.ok = out.is_error !== true
  } catch (error) {
    result.error = `${error} ${run.stderr?.slice(0, 500) ?? ""}`
  }
}

function runCodex(result: RunResult, prompt: string, dir: string, writable: boolean): void {
  const sandbox = writable ? "workspace-write" : "read-only"
  const run = spawnSync("codex", ["exec", "--json", "--skip-git-repo-check", "-s", sandbox, "-C", dir, "-"], {
    input: prompt,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 1 << 28,
  })
  for (const line of run.stdout.split("\n")) {
    let msg: { type?: string; usage?: Record<string, number>; item?: { type?: string; text?: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === "turn.completed" && msg.usage) {
      result.conductor.input += msg.usage.input_tokens ?? 0
      result.conductor.output += msg.usage.output_tokens ?? 0
    }
    if (msg.type === "item.completed" && msg.item?.type === "agent_message") result.answer = msg.item.text ?? ""
    if (msg.type === "turn.failed" || msg.type === "error") result.error = line.slice(0, 300)
  }
  result.ok = !result.error && run.status === 0
}

function runOnce(task: Task, solo: string, rep: number): RunResult {
  const ws = task.workspace()
  const result = emptyResult(task, solo, rep)
  const prompt = task.soloPrompt ?? task.prompt
  const started = Date.now()
  if (solo === "solo-codex") runCodex(result, prompt, ws.dir, ws.writable)
  else if (solo.startsWith("solo-")) runClaude(result, solo.slice("solo-".length), prompt, ws.dir, ws.writable)
  else throw new Error(`unknown baseline ${solo}; expected solo-codex or solo-<claude model>`)
  result.ms = Date.now() - started
  result.score = task.score(result, ws)
  return result
}

const outDir = path.resolve(args.out)
mkdirSync(outDir, { recursive: true })
let spent = readdirSync(outDir)
  .filter((f) => f.endsWith(".json"))
  .reduce((sum, f) => sum + JSON.parse(readFileSync(path.join(outDir, f), "utf8")).conductor.usd, 0)
const budget = Number(args.budget)
const tasks = args.tasks.split(",").map((id) => {
  const task = TASKS.find((t) => t.id === id)
  if (!task) throw new Error(`unknown task ${id}`)
  return task
})

for (let rep = 1; rep <= Number(args.reps); rep++) {
  for (const task of tasks) {
    for (const solo of args.solos.split(",")) {
      const file = path.join(outDir, `${task.id}.${solo}.${rep}.json`)
      if (existsSync(file)) continue
      if (spent >= budget) {
        console.log(`budget $${budget} reached ($${spent.toFixed(2)} spent); stopping`)
        process.exit(0)
      }
      console.log(`→ ${task.id} / ${solo} / rep ${rep}`)
      const result = runOnce(task, solo, rep)
      spent += result.conductor.usd
      writeFileSync(file, JSON.stringify(result, null, 2))
      console.log(
        `  ${result.score?.pass ? "PASS" : "FAIL"} $${result.conductor.usd.toFixed(3)} ${result.conductor.input + result.conductor.output} tok ${(result.ms / 1000).toFixed(0)}s ${result.error}`,
      )
    }
  }
}
