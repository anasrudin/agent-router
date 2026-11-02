import { describe, expect, test } from "bun:test"
import { Terminals } from "../terminals"

describe.skipIf(!Terminals.supported())("Terminals", () => {
  test("a real PTY: input, resize, output, scrollback, exit", async () => {
    let out = ""
    let exited: number | null | undefined
    const terms = new Terminals({ output: (_id, d) => (out += d), exit: (_id, code) => (exited = code) })
    const t = terms.open({ title: "sh", cwd: process.cwd(), command: ["sh"], cols: 80, rows: 24, env: { PS1: "$ " } })
    expect(terms.list()).toEqual([expect.objectContaining({ id: t.id, title: "sh", running: true })])
    terms.input(t.id, "echo ready-$((40+2))\n")
    terms.resize(t.id, 132, 40)
    terms.input(t.id, "stty size\n")
    terms.input(t.id, "exit 3\n")
    for (let i = 0; i < 50 && exited === undefined; i++) await Bun.sleep(50)
    expect(exited).toBe(3)
    expect(out).toContain("ready-42")
    expect(out).toContain("40 132")
    expect(terms.scrollback(t.id)).toBe(out)
    expect(terms.list()[0]?.running).toBe(false)
    terms.close(t.id)
    expect(terms.list()).toEqual([])
  })

  test("closing a terminal ends the shell and what it runs, not only the shell", async () => {
    const pidFile = `${process.env.TMPDIR ?? "/tmp"}/term-child-${process.pid}-${Date.now()}`
    const terms = new Terminals({ output: () => {}, exit: () => {} })
    const t = terms.open({ title: "bash", cwd: process.cwd(), command: ["bash", "--norc", "-i"], cols: 80, rows: 24 })
    terms.input(t.id, `sleep 300 & echo $! > ${pidFile}\n`)
    let child = 0
    for (let i = 0; i < 40 && !child; i++) {
      await Bun.sleep(50)
      child = Number(
        await Bun.file(pidFile)
          .text()
          .catch(() => "0"),
      )
    }
    expect(child).toBeGreaterThan(0)
    terms.close(t.id)
    const alive = () => {
      try {
        process.kill(child, 0)
        return true
      } catch {
        return false
      }
    }
    for (let i = 0; i < 60 && alive(); i++) await Bun.sleep(50)
    expect(alive()).toBe(false)
  })

  test("close kills a running terminal", async () => {
    let exited = false
    const terms = new Terminals({ output: () => {}, exit: () => (exited = true) })
    const t = terms.open({ title: "sleep", cwd: process.cwd(), command: ["sleep", "30"], cols: 80, rows: 24 })
    terms.close(t.id)
    for (let i = 0; i < 40 && !exited; i++) await Bun.sleep(50)
    expect(exited).toBe(true)
  })
})
