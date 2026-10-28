import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { uriKey } from "../client"
import { createLspMcpServer, insideWorkspace, LspPool } from "../mcp"
import { availableServers, type LanguageServer, mergeServers, typescriptServer } from "../servers"

const FAKE = path.join(import.meta.dir, "fixtures", "fake-lsp.mjs")

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "ar-lsp-"))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

const pools: LspPool[] = []
afterAll(async () => {
  await Promise.all(pools.map((p) => p.stop()))
})

async function connect(ws: string, args: string[]) {
  const server: LanguageServer = { name: "fake", command: process.execPath, args: [FAKE, ...args], extensions: [".ts"] }
  const pool = new LspPool(ws, [server])
  pools.push(pool)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await createLspMcpServer(pool).connect(a)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(b)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args })
    return { error: !!r.isError, text: (r.content as { text: string }[])[0]?.text ?? "" }
  }
  return { client, call }
}

describe.each([
  ["push", []],
  ["pull", ["--pull"]],
])("lsp MCP tools (%s diagnostics)", (_mode, args) => {
  const ws = workspace({ "src/box.ts": "class Box {\n  open() {}\n  BAD\n}\n" })

  test("diagnostics, refreshed after the file changes on disk", async () => {
    const { call } = await connect(ws, args)
    expect(await call("diagnostics", { file: "src/box.ts" })).toEqual({
      error: false,
      text: "src/box.ts:3:3 error fake(7): BAD is not allowed",
    })
    writeFileSync(path.join(ws, "src/box.ts"), "class Box {\n  open() {}\n}\n")
    expect(await call("diagnostics", { file: "src/box.ts" })).toEqual({ error: false, text: "src/box.ts: no problems reported." })
  })

  test("definition, references and symbols, 1-based with the source line", async () => {
    const { call } = await connect(ws, args)
    expect((await call("definition", { file: "src/box.ts", line: 2, column: 3 })).text).toBe("src/box.ts:1:5  class Box {")
    expect((await call("references", { file: "src/box.ts", line: 1, column: 7 })).text.split("\n")).toEqual([
      "src/box.ts:1:1  class Box {",
      "src/box.ts:2:1  open() {}",
      "src/box.ts:3:1  }",
    ])
    expect((await call("symbols", { file: "src/box.ts" })).text).toBe("class Box:1\n  method open:2")
  })
})

describe("lsp MCP tool errors", () => {
  test("outside the workspace, unknown languages and a server that cannot start are tool errors, not crashes", async () => {
    const ws = workspace({ "a.ts": "", "notes.md": "" })
    const { call } = await connect(ws, [])
    expect(await call("diagnostics", { file: "../../etc/passwd" })).toMatchObject({ error: true, text: expect.stringContaining("outside") })
    expect(await call("symbols", { file: "notes.md" })).toMatchObject({ error: true, text: expect.stringContaining("No language server") })
    expect(await call("symbols", { file: "missing.ts" })).toMatchObject({ error: true })

    const pool = new LspPool(ws, [{ name: "gone", command: "no-such-language-server-xyz", args: [], extensions: [".ts"] }])
    expect(await pool.clientFor(path.join(ws, "a.ts"))).toContain("not found")
  })

  test("a file has one key however its URI is spelled", () => {
    const file = path.join(tmpdir(), "a b", "x.ts")
    expect(uriKey(pathToFileURL(file).href)).toBe(
      uriKey(
        `file://${file
          .split(path.sep)
          .join("/")
          .replace(/^([A-Za-z]):/, "/$1:")}`,
      ),
    )
    if (process.platform === "win32") expect(uriKey("file:///c%3A/x/y.ts")).toBe(uriKey("file:///C:/x/y.ts"))
  })

  test("only paths inside the workspace resolve", () => {
    expect(insideWorkspace("/ws", "src/a.ts")).toBe(path.resolve("/ws/src/a.ts"))
    expect(insideWorkspace("/ws", "../x")).toBeUndefined()
    expect(insideWorkspace("/ws", "/etc/passwd")).toBeUndefined()
    expect(insideWorkspace("/ws", ".")).toBeUndefined()
  })
})

describe("server selection", () => {
  test("TypeScript 7 projects use its built-in server; older ones typescript-language-server", () => {
    const ts7 = workspace({ "node_modules/typescript/package.json": '{"version":"7.0.2"}' })
    const ts5 = workspace({ "node_modules/typescript/package.json": '{"version":"5.9.3"}' })
    expect(typescriptServer(ts7)).toMatchObject({ command: "tsc", args: ["--lsp", "--stdio"] })
    expect(typescriptServer(ts5)).toMatchObject({ command: "typescript-language-server", args: ["--stdio"] })
    expect(typescriptServer(workspace({}))).toMatchObject({ command: "typescript-language-server" })
  })

  test("configured servers replace built-ins by name and come first; only installed ones are offered", () => {
    const mine = { name: "pyright", command: "basedpyright-langserver", args: ["--stdio"], extensions: [".py"] }
    const merged = mergeServers([mine])
    expect(merged[0]).toEqual(mine)
    expect(merged.filter((s) => s.name === "pyright")).toHaveLength(1)
    const installed = availableServers("/ws", merged, (f) => /basedpyright-langserver|gopls/.test(f))
    expect(installed.map((s) => s.name)).toEqual(["pyright", "gopls"])
  })
})
