// Stand-in language server for LSP tests. `--pull` advertises pull diagnostics; otherwise it pushes them.
const pull = process.argv.includes("--pull")
let buffer = Buffer.alloc(0)
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }))
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}
const problems = (text) =>
  text.split("\n").flatMap((line, i) =>
    line.includes("BAD")
      ? [
          {
            range: { start: { line: i, character: line.indexOf("BAD") }, end: { line: i, character: line.indexOf("BAD") + 3 } },
            severity: 1,
            message: "BAD is not allowed\nsecond line",
            source: "fake",
            code: 7,
          },
        ]
      : [],
  )
const docs = new Map()
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
    buffer = buffer.subarray(end + 4 + length)
    handle(msg)
  }
})
function handle(msg) {
  const p = msg.params
  switch (msg.method) {
    case "initialize":
      // Ask the client something first, as real servers do; a client that never answers would hang here.
      send({ id: "cfg", method: "workspace/configuration", params: { items: [{ section: "fake" }] } })
      return send({ id: msg.id, result: { capabilities: pull ? { diagnosticProvider: { interFileDependencies: false } } : {} } })
    case "textDocument/didOpen":
    case "textDocument/didChange": {
      const uri = p.textDocument.uri
      docs.set(uri, p.textDocument.text ?? p.contentChanges[0].text)
      if (!pull)
        setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: problems(docs.get(uri)) } }), 20)
      return
    }
    case "textDocument/diagnostic":
      return send({ id: msg.id, result: { kind: "full", items: problems(docs.get(p.textDocument.uri) ?? "") } })
    case "textDocument/definition":
      return send({
        id: msg.id,
        result: [
          {
            targetUri: p.textDocument.uri,
            targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            targetSelectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
          },
        ],
      })
    case "textDocument/references":
      return send({
        id: msg.id,
        result: Array.from({ length: 3 }, (_, i) => ({
          uri: p.textDocument.uri,
          range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
        })),
      })
    case "textDocument/documentSymbol":
      return send({
        id: msg.id,
        result: [
          {
            name: "Box",
            kind: 5,
            range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
            children: [{ name: "open", kind: 6, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } } }],
          },
        ],
      })
    case "shutdown":
      return send({ id: msg.id, result: null })
    case "exit":
      return process.exit(0)
  }
}
