import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { type Diagnostic, type DocumentSymbol, type Location, LspClient } from "./client"
import { type LanguageServer, serverFor, serverSearchPath } from "./servers"

/** Name the delegates' CLIs register this server under; their tools appear as `mcp__lsp__<tool>`. */
export const LSP_MCP_NAME = "lsp"
export const LSP_TOOLS = ["diagnostics", "definition", "references", "symbols"] as const

const MAX_LOCATIONS = 100
const SEVERITY = ["", "error", "warning", "info", "hint"]
const SYMBOL_KINDS = [
  "",
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enum member",
  "struct",
  "event",
  "operator",
  "type parameter",
]

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] })
const fail = (t: string) => ({ ...text(t), isError: true })

/** One language server per kind, started on first use and shared by every call. */
export class LspPool {
  private readonly clients = new Map<string, LspClient>()

  constructor(
    readonly workspace: string,
    private readonly servers: LanguageServer[],
    /** Where node_modules/.bin is: the main workspace when this one is a worktree without it. */
    private readonly toolsRoot = workspace,
  ) {}

  /** The client for a file, or why there is none. */
  async clientFor(file: string): Promise<LspClient | string> {
    const server = serverFor(this.servers, file)
    if (!server) return `No language server for ${path.extname(file) || "files without an extension"} is installed.`
    let client = this.clients.get(server.name)
    if (!client) {
      client = new LspClient(server.command, server.args, this.workspace, serverSearchPath(this.toolsRoot))
      this.clients.set(server.name, client)
    }
    try {
      await client.start()
      return client
    } catch (error) {
      this.clients.delete(server.name)
      return `${server.name} failed to start: ${(error as Error).message}`
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()))
  }
}

/** A workspace file's absolute path, or undefined if it points outside the workspace. */
export function insideWorkspace(workspace: string, file: string): string | undefined {
  const abs = path.resolve(workspace, file)
  const rel = path.relative(workspace, abs)
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? abs : undefined
}

function relPath(workspace: string, uri: string): string {
  const file = uri.startsWith("file:") ? fileURLToPath(uri) : uri
  const rel = path.relative(workspace, file)
  return (rel.startsWith("..") ? file : rel).split(path.sep).join("/")
}

/** "src/a.ts:12:5  const x = foo()" with 1-based positions and the source line, for each location. */
export function formatLocations(workspace: string, locations: Location[]): string {
  const lines = new Map<string, string[]>()
  const sourceLine = (uri: string, line: number) => {
    if (!lines.has(uri)) {
      try {
        lines.set(uri, readFileSync(fileURLToPath(uri), "utf8").split(/\r?\n/))
      } catch {
        lines.set(uri, [])
      }
    }
    return (lines.get(uri)?.[line] ?? "").trim().slice(0, 160)
  }
  const shown = locations.slice(0, MAX_LOCATIONS).map((l) => {
    const pos = `${relPath(workspace, l.uri)}:${l.range.start.line + 1}:${l.range.start.character + 1}`
    const src = sourceLine(l.uri, l.range.start.line)
    return src ? `${pos}  ${src}` : pos
  })
  const more = locations.length > MAX_LOCATIONS ? `\n… and ${locations.length - MAX_LOCATIONS} more` : ""
  return shown.join("\n") + more
}

export function formatDiagnostics(file: string, diagnostics: Diagnostic[]): string {
  if (!diagnostics.length) return `${file}: no problems reported.`
  return diagnostics
    .map((d) => {
      const where = `${file}:${d.range.start.line + 1}:${d.range.start.character + 1}`
      const code = d.code !== undefined ? ` ${d.source ?? ""}(${d.code})` : d.source ? ` ${d.source}` : ""
      return `${where} ${SEVERITY[d.severity ?? 1] ?? "error"}${code}: ${d.message.split("\n")[0]}`
    })
    .join("\n")
}

export function formatSymbols(symbols: DocumentSymbol[], depth = 0): string {
  return symbols
    .map((s) => {
      const range = s.range ?? s.location?.range
      const line = range ? `:${range.start.line + 1}` : ""
      const own = `${"  ".repeat(depth)}${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.name}${line}`
      return s.children?.length ? `${own}\n${formatSymbols(s.children, depth + 1)}` : own
    })
    .join("\n")
}

const toLocations = (result: unknown): Location[] => {
  const list = Array.isArray(result) ? result : result ? [result] : []
  // LocationLink (targetUri/targetSelectionRange) is turned into a plain Location.
  return list.map((l: Record<string, unknown>) =>
    "targetUri" in l
      ? { uri: l.targetUri as string, range: (l.targetSelectionRange ?? l.targetRange) as Location["range"] }
      : (l as unknown as Location),
  )
}

export function createLspMcpServer(pool: LspPool): McpServer {
  const server = new McpServer({ name: "agent-router-lsp", version: "0.1.0" })
  const fileArg = { file: z.string().describe("Workspace-relative path of the file") }
  const posArgs = {
    ...fileArg,
    line: z.number().int().positive().describe("1-based line"),
    column: z.number().int().positive().describe("1-based column of the symbol"),
  }

  /** Resolve the file, sync it into its server, and run `fn`; every failure becomes a tool error. */
  const withFile = async (file: string, fn: (client: LspClient, abs: string, uri: string) => Promise<ReturnType<typeof text>>) => {
    const abs = insideWorkspace(pool.workspace, file)
    if (!abs) return fail(`${file} is outside the workspace.`)
    const client = await pool.clientFor(abs)
    if (typeof client === "string") return fail(client)
    try {
      return await fn(client, abs, client.sync(abs))
    } catch (error) {
      return fail(`${file}: ${(error as Error).message}`)
    }
  }
  // Every tool only reads. Codex refuses unannotated MCP tools when it cannot ask for approval.
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  const position = (line: number, column: number) => ({ line: line - 1, character: column - 1 })

  server.registerTool(
    "diagnostics",
    {
      description: "Type errors and warnings the language server reports for a file, as it is on disk now. Use after editing.",
      inputSchema: fileArg,
      annotations: readOnly,
    },
    ({ file }) =>
      withFile(file, async (client, abs) => {
        const found = await client.diagnosticsFor(abs)
        return found === undefined ? fail(`${file}: the language server reported nothing in time.`) : text(formatDiagnostics(file, found))
      }),
  )
  server.registerTool(
    "definition",
    { description: "Where the symbol at a position is defined.", inputSchema: posArgs, annotations: readOnly },
    ({ file, line, column }) =>
      withFile(file, async (client, _abs, uri) => {
        const result = await client.request("textDocument/definition", { textDocument: { uri }, position: position(line, column) })
        const locations = toLocations(result)
        return text(locations.length ? formatLocations(pool.workspace, locations) : "No definition found.")
      }),
  )
  server.registerTool(
    "references",
    { description: "Every reference to the symbol at a position, including its declaration.", inputSchema: posArgs, annotations: readOnly },
    ({ file, line, column }) =>
      withFile(file, async (client, _abs, uri) => {
        const result = await client.request("textDocument/references", {
          textDocument: { uri },
          position: position(line, column),
          context: { includeDeclaration: true },
        })
        const locations = toLocations(result)
        return text(locations.length ? formatLocations(pool.workspace, locations) : "No references found.")
      }),
  )
  server.registerTool(
    "symbols",
    {
      description: "Outline of a file: its classes, functions, methods and variables with line numbers.",
      inputSchema: fileArg,
      annotations: readOnly,
    },
    ({ file }) =>
      withFile(file, async (client, _abs, uri) => {
        const result = await client.request<DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri } })
        return text(result?.length ? formatSymbols(result) : "No symbols found.")
      }),
  )
  return server
}

export async function serveLspStdio(workspace: string, servers: LanguageServer[], toolsRoot = workspace): Promise<void> {
  const pool = new LspPool(workspace, servers, toolsRoot)
  const stop = () => void pool.stop().finally(() => process.exit(0))
  process.stdin.once("close", stop)
  process.once("SIGTERM", stop)
  await createLspMcpServer(pool).connect(new StdioServerTransport())
}
