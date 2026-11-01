import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { trustedCheckpoint } from "../../server/serve"
import { fakeRegistry, report, testSession } from "../../test-support"
import { checkpointDiff, checkpointFiles, revertCheckpoint, snapshot } from "../checkpoints"
import { delegate } from "../delegate"
import { Brief } from "../protocol"

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-cp-"))
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim()
  git("init", "-q")
  writeFileSync(path.join(dir, "a.ts"), "one\ntwo\n")
  writeFileSync(path.join(dir, "gone.ts"), "bye\n")
  writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n")
  git("add", ".")
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  return {
    dir,
    git,
    write: (f: string, s: string) => writeFileSync(path.join(dir, f), s),
    read: (f: string) => readFileSync(path.join(dir, f), "utf8"),
  }
}

describe("checkpoints", () => {
  test("the diff between two snapshots is exactly the thread's work, untracked files included", () => {
    const r = repo()
    r.write("a.ts", "one\ntwo\nmine (uncommitted, before the thread)\n")
    const before = snapshot(r.dir, "t-before") as string
    r.write("a.ts", "one\nTWO\nmine (uncommitted, before the thread)\n")
    r.write("new.ts", "fresh\n")
    rmSync(path.join(r.dir, "gone.ts"))
    r.write("ignored.log", "noise\n")
    mkdirSync(path.join(r.dir, ".harness"), { recursive: true })
    r.write(".harness/memory.md", "- note\n")
    const after = snapshot(r.dir, "t-after") as string
    const c = { before, after, cwd: r.dir }
    expect(checkpointFiles(c).sort()).toEqual(["a.ts", "gone.ts", "new.ts"])
    const { patch } = checkpointDiff(c)
    expect(patch).toContain("-two\n+TWO")
    // The uncommitted line from before the thread is context, not part of its change.
    expect(patch).not.toContain("+mine (uncommitted")
    expect(r.git("for-each-ref", "refs/agent-router/checkpoints/", "--format=%(refname)")).toContain("t-after")
  })

  test("snapshots never touch the user's index or branch", () => {
    const r = repo()
    r.write("a.ts", "staged change\n")
    r.git("add", "a.ts")
    const head = r.git("rev-parse", "HEAD")
    snapshot(r.dir, "x")
    expect(r.git("diff", "--cached", "--name-only")).toBe("a.ts")
    expect(r.git("rev-parse", "HEAD")).toBe(head)
    expect(r.git("status", "--porcelain")).toBe("M  a.ts")
  })

  test("revert undoes the thread's changes and keeps what was there before it", () => {
    const r = repo()
    r.write("a.ts", "one\ntwo\nmine\n")
    const before = snapshot(r.dir, "b") as string
    r.write("a.ts", "one\nTWO\nmine\n")
    r.write("new.ts", "fresh\n")
    rmSync(path.join(r.dir, "gone.ts"))
    const after = snapshot(r.dir, "a") as string
    const result = revertCheckpoint({ before, after, cwd: r.dir })
    expect(result).toMatchObject({ ok: true, message: "Reverted 3 files." })
    expect(r.read("a.ts")).toBe("one\ntwo\nmine\n")
    expect(existsSync(path.join(r.dir, "new.ts"))).toBe(false)
    expect(r.read("gone.ts")).toBe("bye\n")
  })

  test("revert is refused, touching nothing, when a file changed since the thread", () => {
    const r = repo()
    const before = snapshot(r.dir, "b") as string
    r.write("a.ts", "one\nTWO\n")
    r.write("new.ts", "fresh\n")
    const after = snapshot(r.dir, "a") as string
    r.write("a.ts", "rewritten by hand\n")
    const result = revertCheckpoint({ before, after, cwd: r.dir })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("have changed since this thread finished")
    expect(r.read("a.ts")).toBe("rewritten by hand\n")
    expect(r.read("new.ts")).toBe("fresh\n")
  })

  test("no repository or no commit: no checkpoint", () => {
    expect(snapshot(mkdtempSync(path.join(tmpdir(), "ar-norepo-")), "x")).toBeUndefined()
  })
})

describe("checkpoints around an edit delegation", () => {
  test("the result carries before/after snapshots whose diff is what the delegate wrote", async () => {
    const backends = fakeRegistry({ claude: [{ text: report("done"), sessionId: "c1" }] })
    const session = testSession(backends, {}, "acceptEdits")
    const r = repo()
    // Reuse the session but point it at the repository.
    Object.assign(session, { workspace: r.dir })
    let wrote = false
    const result = await delegate(session, {
      taskClass: "code.edit",
      brief: Brief.parse({ task: "Change a.ts.", why: "w", acceptance: ["done"], mode: "edit" }),
      checkpointId: "job-1",
      onEvent: () => {
        if (wrote) return
        wrote = true
        r.write("a.ts", "one\nchanged by the delegate\n")
      },
    })
    expect(result.checkpoint?.after).toMatch(/^[0-9a-f]{40}$/)
    expect(checkpointFiles(result.checkpoint as Required<NonNullable<typeof result.checkpoint>>)).toEqual(["a.ts"])
    expect(r.git("for-each-ref", "--format=%(refname:short)", "refs/agent-router/checkpoints/")).toContain("job-1-before")
  })

  test("read-only delegations take no snapshots", async () => {
    const backends = fakeRegistry({ gemini: [{ text: report("done") }] })
    const session = testSession(backends)
    const result = await delegate(session, {
      taskClass: "search.codebase",
      brief: Brief.parse({ task: "Find X.", why: "w", acceptance: ["a"] }),
    })
    expect(result.checkpoint).toBeUndefined()
  })
})

describe("trustedCheckpoint()", () => {
  const sha = "a".repeat(40)
  test("accepts the workspace and its delegate worktrees only, with full commit ids", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ar-ws-"))
    const wt = path.join(ws, ".harness", "worktrees", "worker-1")
    mkdirSync(wt, { recursive: true })
    expect(trustedCheckpoint(ws, { before: sha, after: sha, cwd: ws }).cwd).toBe(ws)
    expect(trustedCheckpoint(ws, { before: sha, after: sha, cwd: wt }).cwd).toBe(wt)
    expect(() => trustedCheckpoint(ws, { before: sha, after: sha, cwd: tmpdir() })).toThrow("not this workspace")
    expect(() => trustedCheckpoint(ws, { before: sha, after: sha, cwd: path.join(wt, "..", "..") })).toThrow("not this workspace")
    expect(() => trustedCheckpoint(ws, { before: "HEAD~1", after: sha, cwd: ws })).toThrow("Not a checkpoint")
  })
})
