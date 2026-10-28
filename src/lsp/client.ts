import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildInvocation, killTree, NONINTERACTIVE_ENV, resolveExecutable } from "../backends/process"

export interface Position {
  line: number
  character: number
}
export interface Range {
  start: Position
  end: Position
}
export interface Location {
  uri: string
  range: Range
}
export interface Diagnostic {
  range: Range
  severity?: number
  message: string
  source?: string
  code?: string | number
}
export interface DocumentSymbol {
  name: string
  kind: number
  range: Range
  selectionRange?: Range
  children?: DocumentSymbol[]
  /** SymbolInformation (the flat form some servers return) has a location instead of a range. */
  location?: Location
}

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
}

const REQUEST_TIMEOUT_MS = 30_000

/**
 * One key per file however a server spells its URI: servers built on vscode-uri send
 * `file:///c%3A/x` on Windows where Node writes `file:///C:/x`.
 */
export function uriKey(uri: string): string {
  try {
    const file = path.resolve(fileURLToPath(uri.replace(/^file:\/\/\/([a-zA-Z])%3[aA]/, "file:///$1:")))
    return process.platform === "win32" ? file.toLowerCase() : file
  } catch {
    return uri
  }
}

/**
 * A minimal Language Server Protocol client over stdio: JSON-RPC with Content-Length framing,
 * enough for diagnostics, definitions, references and document symbols.
 */
export class LspClient {
  private child: ChildProcess | undefined
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly opened = new Map<string, { version: number; text: string }>()
  private readonly diagnostics = new Map<string, Diagnostic[]>()
  private readonly diagnosticWaiters = new Map<string, (() => void)[]>()
  private exited: Error | undefined
  /** The server's half of `initialize`; decides between pull and push diagnostics. */
  private capabilities: Record<string, unknown> = {}
  private ready: Promise<void> | undefined

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly root: string,
    private readonly searchPath: string,
  ) {}

  start(): Promise<void> {
    this.ready ??= this.launch()
    return this.ready
  }

  private async launch(): Promise<void> {
    const env = { ...process.env, ...NONINTERACTIVE_ENV, PATH: this.searchPath }
    const resolved = resolveExecutable(this.command, env)
    if (!resolved) throw new Error(`${this.command} not found on PATH`)
    const invocation = buildInvocation(resolved, this.args)
    const child = spawn(invocation.command, invocation.args, {
      cwd: this.root,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.verbatim,
      // Same process group as lsp-mcp, so stopping the delegate's group also stops the language server.
    })
    this.child = child
    child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk))
    const fail = (error: Error) => {
      this.exited ??= error
      for (const p of this.pending.values()) p.reject(error)
      this.pending.clear()
    }
    child.on("error", fail)
    child.on("close", (code) => fail(new Error(`${this.command} exited (code ${code})`)))
    child.stdin?.on("error", () => {})

    const init = await this.request<{ capabilities?: Record<string, unknown> }>("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { workspaceFolders: true, configuration: false },
      },
    })
    this.capabilities = init?.capabilities ?? {}
    this.notify("initialized", {})
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) return
      const length = Number(/content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("ascii"))?.[1])
      if (!Number.isFinite(length)) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      if (this.buffer.length < headerEnd + 4 + length) return
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")
      this.buffer = this.buffer.subarray(headerEnd + 4 + length)
      try {
        this.dispatch(JSON.parse(body) as Record<string, unknown>)
      } catch {
        // A malformed message from the server is skipped, not fatal.
      }
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg) && !("method" in msg)) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      const error = msg.error as { message?: string } | undefined
      if (error) p.reject(new Error(error.message ?? "language server error"))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: Diagnostic[] }
      const key = uriKey(params.uri)
      this.diagnostics.set(key, params.diagnostics)
      for (const wake of this.diagnosticWaiters.get(key) ?? []) wake()
      this.diagnosticWaiters.delete(key)
      return
    }
    // Server-to-client requests (configuration, progress, registration) need an answer or some servers stall.
    if (typeof msg.id === "number" || typeof msg.id === "string") {
      const result = msg.method === "workspace/configuration" ? ((msg.params as { items?: unknown[] })?.items ?? []).map(() => null) : null
      this.write({ jsonrpc: "2.0", id: msg.id, result })
    }
  }

  private write(message: unknown): void {
    if (this.exited) throw this.exited
    const body = Buffer.from(JSON.stringify(message), "utf8")
    this.child?.stdin?.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]))
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params })
  }

  request<T>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.exited) return Promise.reject(this.exited)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs / 1000} s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error as Error)
      }
    })
  }

  /** Open (or refresh, if it changed on disk) a file in the server; returns its URI. */
  sync(file: string): string {
    const uri = pathToFileURL(file).href
    const text = readFileSync(file, "utf8")
    const open = this.opened.get(uri)
    if (!open) {
      this.diagnostics.delete(uriKey(uri))
      const languageId = LANGUAGE_IDS[path.extname(file).toLowerCase()] ?? "plaintext"
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } })
      this.opened.set(uri, { version: 1, text })
    } else if (open.text !== text) {
      this.diagnostics.delete(uriKey(uri))
      const version = open.version + 1
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
      this.opened.set(uri, { version, text })
    }
    return uri
  }

  /**
   * Diagnostics for a file. Servers that support pull diagnostics (LSP 3.17, e.g. TypeScript 7)
   * are asked; others publish them after a sync, which is waited for up to `waitMs`.
   */
  async diagnosticsFor(file: string, waitMs = 10_000): Promise<Diagnostic[] | undefined> {
    const uri = this.sync(file)
    if (this.capabilities.diagnosticProvider) {
      const report = await this.request<{ kind?: string; items?: Diagnostic[] } | null>("textDocument/diagnostic", {
        textDocument: { uri },
      })
      return report?.items ?? []
    }
    const key = uriKey(uri)
    if (!this.diagnostics.has(key)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        const waiters = this.diagnosticWaiters.get(key) ?? []
        waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
        this.diagnosticWaiters.set(key, waiters)
      })
    }
    return this.diagnostics.get(key)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return
    try {
      await this.request("shutdown", null, 3_000)
      this.notify("exit", null)
    } catch {
      // Killed below either way.
    }
    await killTree(child, 1_000)
  }
}
