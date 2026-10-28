// Stand-in CLI for process tests. Behaviour is chosen by the first argument.
import { spawn } from "node:child_process"

const mode = process.argv[2]
if (mode === "group-parent") {
  // Like the router's MCP child: runs a worker in its own process group and cleans it up on SIGTERM.
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" })
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: String(worker.pid) }))
  process.on("SIGTERM", () => {
    // Right after spawn the worker may not have called setsid() yet, so its group may not exist:
    // fall back to the process itself, as the real killTree does.
    try {
      process.kill(-worker.pid, "SIGKILL")
    } catch {
      worker.kill("SIGKILL")
    }
    process.exit(0)
  })
  setInterval(() => {}, 1000)
}
if (mode === "ignore-term") {
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1000)
}
let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (c) => (input += c))
process.stdin.on("end", () => {
  if (mode === "echo") {
    console.log("Some banner the CLI prints first")
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }))
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: `got ${input.length} chars: ${input.slice(0, 20)}`,
        usage: { input_tokens: 3, output_tokens: 4 },
        total_cost_usd: 0.01,
      }),
    )
  } else if (mode === "env") {
    const env = Object.fromEntries(["GIT_TERMINAL_PROMPT", "GIT_PAGER", "GIT_EDITOR", "KEEP_ME"].map((k) => [k, process.env[k]]))
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(env) }))
  } else if (mode === "ratelimit") {
    process.stderr.write("Error: 429 Too Many Requests\n")
    process.exit(1)
  } else if (mode === "silent-ok") {
    process.exit(0)
  } else if (mode === "hang") {
    setInterval(() => {}, 1000)
  }
})
