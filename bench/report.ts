// Re-score saved benchmark runs and write RESULTS.md next to them.
//
//   npx bun bench/report.ts bench/results/<date>
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type RunResult, TASKS } from "./tasks"

const dir = path.resolve(process.argv[2] ?? "")
const runs: RunResult[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")))

// The fix task is scored against its workspace at run time; the others are re-scored from the answer.
for (const run of runs) {
  const task = TASKS.find((t) => t.id === run.task)
  if (task && task.id !== "fix") run.score = task.score(run, { dir: "", writable: false })
  writeFileSync(path.join(dir, `${run.task}.${run.profile}.${run.rep}.json`), JSON.stringify(run, null, 2))
}

const usd = (r: RunResult) => r.conductor.usd + r.delegates.reduce((sum, d) => sum + (d.usd ?? 0), 0)
const tokens = (r: RunResult) => r.conductor.input + r.conductor.output
const delegateTokens = (r: RunResult) => r.delegates.reduce((sum, d) => sum + d.tokens.input + d.tokens.output, 0)
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const k = (n: number) => `${Math.round(n / 1000)}k`

const profiles = [...new Set(runs.map((r) => r.profile))]
const tasks = [...new Set(runs.map((r) => r.task))]
const lines: string[] = [`# Profile benchmark — ${path.basename(dir)}`, ""]

lines.push(
  "## Totals per profile",
  "",
  "| Profile | Runs | Passed | Mean cost | Mean Conductor tokens | Mean delegate tokens | Mean time |",
  "|---|---|---|---|---|---|---|",
)
for (const p of profiles) {
  const rs = runs.filter((r) => r.profile === p)
  lines.push(
    `| ${p} | ${rs.length} | ${rs.filter((r) => r.score?.pass).length}/${rs.length} | $${mean(rs.map(usd)).toFixed(3)} | ${k(mean(rs.map(tokens)))} | ${k(mean(rs.map(delegateTokens)))} | ${(mean(rs.map((r) => r.ms)) / 1000).toFixed(0)} s |`,
  )
}

// Each subscription is metered on its own, so totals are split by who ran the tokens.
// A solo-codex baseline runs on Codex itself, with no Conductor on Claude.
const onProvider = (r: RunResult, provider: string) =>
  (r.profile === "solo-codex" ? (provider === "openai" ? tokens(r) : 0) : provider === "claude" ? tokens(r) : 0) +
  r.delegates.filter((d) => d.provider === provider).reduce((sum, d) => sum + d.tokens.input + d.tokens.output, 0)
lines.push(
  "",
  "## By subscription",
  "",
  "| Profile | Claude tokens | Claude cost | Codex tokens | Gemini tokens | All tokens |",
  "|---|---|---|---|---|---|",
)
for (const p of profiles) {
  const rs = runs.filter((r) => r.profile === p)
  const claude = mean(rs.map((r) => onProvider(r, "claude")))
  const openai = mean(rs.map((r) => onProvider(r, "openai")))
  const gemini = mean(rs.map((r) => onProvider(r, "gemini")))
  lines.push(`| ${p} | ${k(claude)} | $${mean(rs.map(usd)).toFixed(3)} | ${k(openai)} | ${k(gemini)} | ${k(claude + openai + gemini)} |`)
}

lines.push(
  "",
  "## Per task",
  "",
  "| Task | Profile | Passed | Mean cost | Mean Conductor tokens | Delegations (provider/tier) | Mean time |",
  "|---|---|---|---|---|---|---|",
)
for (const t of tasks) {
  for (const p of profiles) {
    const rs = runs.filter((r) => r.task === t && r.profile === p)
    if (!rs.length) continue
    const delegations = rs.map((r) => r.delegates.map((d) => `${d.provider}/${d.tier}`).join(" + ") || "none").join("; ")
    lines.push(
      `| ${t} | ${p} | ${rs.filter((r) => r.score?.pass).length}/${rs.length} | $${mean(rs.map(usd)).toFixed(3)} | ${k(mean(rs.map(tokens)))} | ${delegations} | ${(mean(rs.map((r) => r.ms)) / 1000).toFixed(0)} s |`,
    )
  }
}

lines.push("", "## Failed checks", "")
const failed = runs.filter((r) => !r.score?.pass)
if (!failed.length) lines.push("None.")
for (const r of failed) {
  const checks = Object.entries(r.score?.checks ?? {})
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
  lines.push(`- ${r.task} / ${r.profile} / rep ${r.rep}: ${checks.join(", ") || r.error || "no score"}`)
}

lines.push(
  "",
  "## Notes",
  "",
  "- Cost is what the CLIs report. Claude reports USD; Gemini and Codex report tokens only, so their cost shows as $0.",
  "- `explain` and `review` run read-only on this repo (approvals denied). `fix` runs on a fresh copy of `bench/fixture` with approvals allowed and is scored by running its tests.",
  "- Scores are automatic keyword and test checks, not a judgement of answer quality. Read the `answer` field in each JSON for that.",
)
writeFileSync(path.join(dir, "RESULTS.md"), `${lines.join("\n")}\n`)
console.log(lines.join("\n"))
