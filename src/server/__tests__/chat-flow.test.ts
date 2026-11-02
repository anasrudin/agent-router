import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChatMeta, ServerMessage } from "../protocol"
import { chatTitle, startServer } from "../serve"

/*
 * A whole chat against the real server, with a stand-in `claude` that answers in stream-json and
 * writes down the arguments it was given (to see that the second request resumes the session).
 */
const root = mkdtempSync(path.join(tmpdir(), "chat-flow-"))
const workspace = path.join(root, "ws")
const data = path.join(root, "data")
const argsLog = path.join(root, "args.log")
mkdirSync(path.join(workspace, ".harness"), { recursive: true })
writeFileSync(path.join(workspace, "notes.txt"), "line one\nline two\n")
const fake = path.join(root, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude")
writeFileSync(
  fake,
  `#!/bin/sh
echo "$@" >> "${argsLog}"
# Each turn leaves a mark in the folder, so a git folder gets a turn checkpoint (only in this test's own folders).
case "$PWD" in "${root}"*|"${realpathSync(root)}"*) date +%s%N > touched.txt ;; esac
cat > /dev/null
echo '{"type":"system","subtype":"init","session_id":"sess-1"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"notes.txt"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"line one"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"The answer is in notes.txt:1."}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"done","usage":{"input_tokens":10,"output_tokens":5},"total_cost_usd":0.001}'
`,
)
chmodSync(fake, 0o755)
writeFileSync(path.join(workspace, ".harness", "routing.yaml"), `backends:\n  claude:\n    executable: ${fake}\n`)

const token = "test-token-0123456789abcdef"
const server = startServer({ port: 0, token, version: "test", dataDir: data, scheduleTickMs: 100 })
afterAll(() => {
  server.stop()
  rmSync(root, { recursive: true, force: true })
})

async function uiClient() {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ui?token=${token}`)
  const inbox: ServerMessage[] = []
  const waiters: ((m: ServerMessage) => void)[] = []
  socket.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data)) as ServerMessage
    const w = waiters.shift()
    if (w) w(msg)
    else inbox.push(msg)
  })
  await new Promise((r) => socket.addEventListener("open", r))
  const next = () => {
    const q = inbox.shift()
    return q ? Promise.resolve(q) : new Promise<ServerMessage>((r) => waiters.push(r))
  }
  /** Skip ahead to the first message of this type. */
  const until = async <T extends ServerMessage["type"]>(type: T): Promise<Extract<ServerMessage, { type: T }>> => {
    for (;;) {
      const m = await next()
      if (m.type === type) return m as Extract<ServerMessage, { type: T }>
    }
  }
  // Every connection is greeted with hello, the chat list, the current chat, schedules and terminals.
  await until("hello")
  const chatsAtConnect = (await until("chats")).items
  const currentAtConnect = (await until("chat.current")).chat
  await until("schedules")
  await until("terminals")
  await until("queue")
  await until("budget")
  return { socket, until, chatsAtConnect, currentAtConnect, send: (m: unknown) => socket.send(JSON.stringify(m)) }
}

const start = (prompt: string) => ({ type: "start", prompt, workspace, permission: "default" })

describe.skipIf(process.platform === "win32")("a saved chat", () => {
  let chat: ChatMeta

  test("the first request creates the chat; its messages are saved and listed", async () => {
    const ui = await uiClient()
    expect(ui.chatsAtConnect).toEqual([])
    ui.send(start("@economy Where is line one? Answer with file:line."))
    chat = (await ui.until("chat.current")).chat as ChatMeta
    expect(chat.title).toBe("Where is line one?")
    const result = await ui.until("conductor")
    expect(result.event.type).toBe("session")
    expect(await ui.until("turn.finished")).toMatchObject({ ok: true })
    const listed = (await ui.until("chats")).items
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: chat.id, turns: 1, sessionId: "sess-1" })
    ui.socket.close()
  }, 20_000)

  test("a new window reopens it: the same messages, tool output included", async () => {
    const ui = await uiClient()
    expect(ui.currentAtConnect?.id).toBe(chat.id)
    ui.send({ type: "chat.open", id: chat.id })
    const replay = await ui.until("chat.replay")
    const types = replay.events.map((e) => (e.msg.type === "conductor" ? `conductor.${e.msg.event.type}` : e.msg.type))
    expect(types[0]).toBe("turn.started")
    expect(types).toContain("conductor.text")
    expect(types.at(-1)).toBe("turn.finished")
    const result = replay.events.find((e) => e.msg.type === "conductor" && e.msg.event.type === "tool_result")
    expect(result?.msg).toMatchObject({ event: { id: "tu1", output: "line one" } })
    ui.socket.close()
  })

  test("after a reset and reopening, the next request resumes the chat's Conductor session", async () => {
    const ui = await uiClient()
    ui.send({ type: "reset" })
    expect((await ui.until("chat.current")).chat).toBeUndefined()
    ui.send({ type: "chat.open", id: chat.id })
    await ui.until("chat.replay")
    ui.send(start("And line two?"))
    expect(await ui.until("turn.started")).toMatchObject({ resumed: true })
    await ui.until("turn.finished")
    // Only the turns; health checks call the CLI too.
    const lines = readFileSync(argsLog, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("-p "))
    expect(lines[0]).not.toContain("--resume")
    expect(lines[1]).toContain("--resume sess-1")
    ui.socket.close()
  }, 20_000)

  test("rename, pin, search, then delete", async () => {
    const ui = await uiClient()
    ui.send({ type: "chat.update", id: chat.id, title: "Line hunt", pinned: true })
    expect((await ui.until("chats")).items[0]).toMatchObject({ title: "Line hunt", pinned: true })
    ui.send({ type: "chats.search", requestId: "s1", query: "LINE TWO" })
    const found = await ui.until("chats.found")
    expect(found.hits.map((h) => h.chat.id)).toEqual([chat.id])
    ui.send({ type: "chat.delete", id: chat.id })
    expect((await ui.until("chat.current")).chat).toBeUndefined()
    expect((await ui.until("chats")).items).toEqual([])
    ui.socket.close()
  })

  test("files for @-mentions, and the file viewer stays inside the workspace", async () => {
    const ui = await uiClient()
    ui.send({ type: "files.list", requestId: "f1", workspace, query: "notes" })
    expect((await ui.until("files.listed")).files).toEqual(["notes.txt"])
    ui.send({ type: "file.read", requestId: "f2", workspace, path: "notes.txt" })
    expect(await ui.until("file.content")).toMatchObject({ path: "notes.txt", text: "line one\nline two\n" })
    ui.send({ type: "file.read", requestId: "f3", workspace, path: "../args.log" })
    expect((await ui.until("file.content")).error).toMatch(/outside/)
    ui.socket.close()
  })
})

describe.skipIf(process.platform === "win32")("beside the chat", () => {
  test("a side question and a catch-up are answered by the fast model and saved with the chat", async () => {
    const ui = await uiClient()
    ui.send(start("First request"))
    const chat = (await ui.until("chat.current")).chat as ChatMeta
    await ui.until("turn.finished")
    ui.send({ type: "side.ask", workspace, question: "What is a scout?" })
    expect(await ui.until("quick.started")).toMatchObject({ kind: "side", question: "What is a scout?" })
    const answer = await ui.until("side.answer")
    expect(answer).toMatchObject({ question: "What is a scout?", text: "The answer is in notes.txt:1." })
    ui.send({ type: "catchup", workspace })
    expect((await ui.until("catchup")).text).toBe("The answer is in notes.txt:1.")
    ui.send({ type: "chat.open", id: chat.id })
    const replay = await ui.until("chat.replay")
    expect(replay.events.map((e) => e.msg.type)).toEqual(expect.arrayContaining(["side.answer", "catchup"]))
    // Save to Markdown renders the chat from its record.
    const file = path.join(root, "export.md")
    ui.send({ type: "export.save", requestId: "e1", path: file, chatId: chat.id })
    expect((await ui.until("export.saved")).error).toBeUndefined()
    const md = readFileSync(file, "utf8")
    expect(md).toContain("# First request")
    expect(md).toContain("**By the way**: What is a scout?")
    ui.send({ type: "export.save", requestId: "e2", path: path.join(root, "x.sh"), text: "x" })
    expect((await ui.until("export.saved")).error).toMatch(/\.md/)
    ui.socket.close()
  }, 30_000)

  test("a scheduled request starts a new chat when due", async () => {
    const ui = await uiClient()
    ui.send({ type: "reset" })
    ui.send({
      type: "schedule.add",
      schedule: { workspace, prompt: "Nightly check", at: Date.now() - 1, repeat: "none", permission: "default" },
    })
    expect((await ui.until("schedules")).items).toHaveLength(1)
    expect(await ui.until("turn.started")).toMatchObject({ prompt: "Nightly check" })
    await ui.until("turn.finished")
    ui.send({ type: "schedules.list" })
    expect((await ui.until("schedules")).items).toEqual([])
    ui.socket.close()
  }, 30_000)

  test("the board: add, move, remove, broadcast to every window", async () => {
    const ui = await uiClient()
    ui.send({ type: "board.upsert", workspace, card: { title: "Login bug" } })
    const card = (await ui.until("board")).cards[0]
    expect(card).toMatchObject({ title: "Login bug", column: "todo" })
    ui.send({ type: "board.move", workspace, id: card?.id, column: "doing", index: 0 })
    expect((await ui.until("board")).cards[0]?.column).toBe("doing")
    ui.send({ type: "board.remove", workspace, id: card?.id })
    expect((await ui.until("board")).cards).toEqual([])
    ui.socket.close()
  })

  test("a terminal: open a shell, type, read, and reattach to its scrollback", async () => {
    const ui = await uiClient()
    ui.send({ type: "term.open", requestId: "t1", workspace, kind: "shell", cols: 80, rows: 24 })
    const opened = await ui.until("term.opened")
    const id = opened.terminal?.id as string
    expect(opened.terminal?.cwd).toBe(workspace)
    ui.send({ type: "term.input", id, data: "echo hi-$((20+3))\n" })
    let out = ""
    while (!out.includes("hi-23")) out += (await ui.until("term.output")).data
    ui.send({ type: "term.attach", id })
    expect((await ui.until("term.scrollback")).data).toContain("hi-23")
    ui.send({ type: "term.close", id })
    expect((await ui.until("terminals")).items.some((t) => t.id === id)).toBe(false)
    ui.socket.close()
  }, 20_000)

  test("files are saved from the editor inside the workspace only", async () => {
    const ui = await uiClient()
    ui.send({ type: "file.read", requestId: "r", workspace, path: "notes.txt" })
    const { mtime } = await ui.until("file.content")
    ui.send({ type: "file.write", requestId: "w", workspace, path: "notes.txt", text: "edited\n", expectedMtime: mtime })
    expect((await ui.until("file.saved")).error).toBeUndefined()
    expect(readFileSync(path.join(workspace, "notes.txt"), "utf8")).toBe("edited\n")
    ui.send({ type: "file.write", requestId: "w2", workspace, path: "../evil.txt", text: "x" })
    expect((await ui.until("file.saved")).error).toMatch(/outside/)
    ui.socket.close()
  })
})

describe.skipIf(process.platform === "win32")("a chat in its own worktree", () => {
  test("a new worktree from a branch: the chat runs there, with the project's settings", async () => {
    const repo = path.join(root, "repo")
    mkdirSync(path.join(repo, ".harness"), { recursive: true })
    writeFileSync(path.join(repo, "a.txt"), "a\n")
    writeFileSync(path.join(repo, ".gitignore"), ".harness/\n")
    writeFileSync(path.join(repo, ".harness", "routing.yaml"), `backends:\n  claude:\n    executable: ${fake}\n`)
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: repo })
    git("init", "-q", "-b", "main")
    git("add", ".")
    git("commit", "-qm", "init")
    const ui = await uiClient()
    ui.send({ type: "reset" })
    ui.send({ type: "worktrees.list", requestId: "w", workspace: repo })
    expect((await ui.until("worktrees")).list).toMatchObject({ current: "main", branches: ["main"], worktrees: [] })
    ui.send({ type: "start", prompt: "Try it in a worktree", workspace: repo, permission: "default", worktree: { base: "main" } })
    const chat = (await ui.until("chat.current")).chat as ChatMeta
    expect(chat.runIn).toContain(path.join(".harness", "worktrees", "chat-try-it-in-a-worktree"))
    expect(readFileSync(path.join(chat.runIn as string, ".harness", "routing.yaml"), "utf8")).toContain(fake)
    // The turn changed the folder: its checkpoint pair arrives for review, revert and restore.
    const cp = await ui.until("turn.checkpoint")
    expect(cp.checkpoint.cwd).toBe(chat.runIn as string)
    expect(cp.checkpoint.before).toMatch(/^[0-9a-f]{40}$/)
    expect(await ui.until("turn.finished")).toMatchObject({ ok: true })
    ui.send({ type: "turn.restore", requestId: "rs", workspace: chat.runIn, before: cp.checkpoint.before, label: "t" })
    const restored = await ui.until("turn.restored")
    expect(restored).toMatchObject({ ok: true, files: ["touched.txt"] })
    expect(existsSync(path.join(chat.runIn as string, "touched.txt"))).toBe(false)
    ui.send({ type: "worktrees.list", requestId: "w2", workspace: repo })
    expect((await ui.until("worktrees")).list?.worktrees).toHaveLength(1)
    ui.socket.close()
  }, 30_000)
})

describe.skipIf(process.platform === "win32")("limits, re-runs, templates", () => {
  test("a chat over its budget does not start another turn, unless sent anyway", async () => {
    const ui = await uiClient()
    ui.send({ type: "reset" })
    ui.send(start("Spend a little"))
    await ui.until("turn.finished")
    // The turn's end reports the chat's spend ($0.001 from the stand-in CLI).
    expect((await ui.until("budget")).budget.chatUsd).toBeCloseTo(0.001, 6)
    ui.send({ type: "budget.set", limits: { chatUsd: 0.01, dayUsd: null, warnAt: 0.8 } })
    expect((await ui.until("budget")).budget).toMatchObject({ limits: { chatUsd: 0.01 } })
    ui.send({ type: "budget.set", limits: { chatUsd: 0.001, dayUsd: null, warnAt: 0.8 } })
    expect((await ui.until("budget")).budget.over).toBe("Budget reached: $0.0010 of $0.0010 for this chat.")
    ui.send(start("One more"))
    expect((await ui.until("error")).message).toMatch(/^Budget reached: .* for this chat/)
    ui.send({ ...start("One more"), overBudget: true })
    expect(await ui.until("turn.finished")).toMatchObject({ ok: true })
    await ui.until("budget") // the end of that turn reports it, still over
    ui.send({ type: "budget.set", limits: { chatUsd: null, dayUsd: null, warnAt: 0.8 } })
    expect((await ui.until("budget")).budget.over).toBeUndefined()
    ui.socket.close()
  }, 30_000)

  test("a read-only thread runs again on a pinned backend, with the reasons, linked to the original", async () => {
    const ui = await uiClient()
    const brief = {
      task: "Find where line one is.",
      why: "test",
      relevant_files: [],
      facts: [],
      excerpts: [],
      scope: "",
      mode: "read-only" as const,
      project_rules: [],
      do_not: [],
      acceptance: ["file:line"],
      return_extra: "",
    }
    ui.send({
      type: "thread.rerun",
      workspace,
      threadId: "d-orig",
      taskClass: "search.codebase",
      brief,
      provider: "claude",
      permission: "default",
    })
    const started = await ui.until("delegation.started")
    expect(started).toMatchObject({ rerunOf: "d-orig", provider: "claude", taskClass: "search.codebase" })
    expect(started.why?.[0]).toBe("Claude: pinned by you for this request.")
    for (;;) {
      const m = await ui.until("delegation.finished").catch(() => undefined)
      if (m?.id === started.id) break
    }
    ui.send({
      type: "thread.rerun",
      workspace,
      threadId: "x",
      taskClass: "code.edit",
      brief: { ...brief, mode: "edit" },
      provider: "claude",
      permission: "default",
    })
    expect((await ui.until("error")).message).toMatch(/Only read-only threads/)
    ui.socket.close()
  }, 60_000)

  test("prompt templates: save, list to every window, delete", async () => {
    const ui = await uiClient()
    ui.send({ type: "template.save", workspace, scope: "project", name: "review-pr", text: "Review $ARGUMENTS" })
    expect((await ui.until("templates")).items).toEqual([{ name: "review-pr", scope: "project", text: "Review $ARGUMENTS" }])
    ui.send({ type: "template.delete", workspace, scope: "project", name: "review-pr" })
    expect((await ui.until("templates")).items).toEqual([])
    ui.socket.close()
  })
})

test("chatTitle: the first sentence of the first line, kept short", () => {
  expect(chatTitle("Fix the bug. Then test it.")).toBe("Fix the bug")
  expect(chatTitle("   ")).toBe("Untitled chat")
  expect(chatTitle("x".repeat(100))).toHaveLength(78)
})
