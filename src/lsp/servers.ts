import { readFileSync } from "node:fs"
import path from "node:path"
import { resolveExecutable } from "../backends/process"

export interface LanguageServer {
  /** Shown in tool output and `lsp.servers` config keys. */
  name: string
  command: string
  args: string[]
  extensions: string[]
}

/** Well-known servers, used when installed. A project can add or override them under `lsp.servers`. */
export const DEFAULT_SERVERS: LanguageServer[] = [
  {
    name: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  },
  { name: "pyright", command: "pyright-langserver", args: ["--stdio"], extensions: [".py"] },
  { name: "pylsp", command: "pylsp", args: [], extensions: [".py"] },
  { name: "gopls", command: "gopls", args: [], extensions: [".go"] },
  { name: "rust-analyzer", command: "rust-analyzer", args: [], extensions: [".rs"] },
  { name: "clangd", command: "clangd", args: [], extensions: [".c", ".h", ".cc", ".cpp", ".hpp"] },
]

/** PATH plus the project's own node_modules/.bin, where typescript-language-server often lives. */
export function serverSearchPath(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const sep = process.platform === "win32" ? ";" : ":"
  return [path.join(workspace, "node_modules", ".bin"), env.PATH ?? env.Path ?? ""].filter(Boolean).join(sep)
}

/** Configured servers whose executable is installed, first match per extension winning. */
export function availableServers(workspace: string, configured: LanguageServer[], exists?: (file: string) => boolean): LanguageServer[] {
  const env = { ...process.env, PATH: serverSearchPath(workspace) }
  return configured.filter((s) => resolveExecutable(s.command, env, process.platform, exists) !== undefined)
}

export function serverFor(servers: LanguageServer[], file: string): LanguageServer | undefined {
  const ext = path.extname(file).toLowerCase()
  return servers.find((s) => s.extensions.includes(ext))
}

/**
 * TypeScript 7 (the native port) has no tsserver.js for typescript-language-server to drive, but
 * its own `tsc --lsp --stdio` is a language server. The project's node_modules/.bin comes first on
 * the search path, so `tsc` is the project's own.
 */
export function typescriptServer(workspace: string): LanguageServer {
  const base = DEFAULT_SERVERS[0] as LanguageServer
  try {
    const pkg = JSON.parse(readFileSync(path.join(workspace, "node_modules", "typescript", "package.json"), "utf8")) as { version?: string }
    if (Number.parseInt(pkg.version ?? "", 10) >= 7) return { ...base, command: "tsc", args: ["--lsp", "--stdio"] }
  } catch {
    // No local TypeScript: typescript-language-server finds a global one, or fails to start and says so.
  }
  return base
}

/** Configured servers first (they replace a built-in of the same name), then the built-ins. */
export function mergeServers(configured: LanguageServer[], workspace?: string): LanguageServer[] {
  const names = new Set(configured.map((s) => s.name))
  const defaults = DEFAULT_SERVERS.map((s) => (s.name === "typescript" && workspace ? typescriptServer(workspace) : s))
  return [...configured, ...defaults.filter((s) => !names.has(s.name))]
}

const installed = new Map<string, LanguageServer[]>()

/** Installed servers for a workspace, looked up once per process (a PATH scan per delegation adds up). */
export function installedServers(workspace: string, configured: LanguageServer[]): LanguageServer[] {
  const key = `${workspace}\0${JSON.stringify(configured)}`
  let found = installed.get(key)
  if (!found) {
    found = availableServers(workspace, mergeServers(configured, workspace))
    installed.set(key, found)
  }
  return found
}
