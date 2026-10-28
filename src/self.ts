import { existsSync } from "node:fs"
import path from "node:path"

/** True inside a `bun build --compile` binary, where the script is embedded in the executable. */
const COMPILED = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN")

/** How to start this same program again (MCP child, CLI hooks), from source, a bundle, or a compiled binary. */
export const SELF_ENTRY: { runtime: string; script?: string } = COMPILED
  ? { runtime: process.execPath }
  : { runtime: process.execPath, script: selfScript() }

/** src/cli.ts when running from source (whatever script imported us); otherwise the bundle being run. */
function selfScript(): string {
  const source = path.join(import.meta.dir, "cli.ts")
  return existsSync(source) ? source : path.resolve(process.argv[1] ?? source)
}

/** POSIX single-quoting. Claude Code runs hook commands through a POSIX shell (Git Bash on Windows). */
export const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`

/** A shell command line that runs `agent-router <args>`, for hook definitions. */
export function selfCommand(args: string[], entry = SELF_ENTRY): string {
  return [entry.runtime, ...(entry.script ? [entry.script] : []), ...args].map(shellQuote).join(" ")
}
