import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyWorktree, previewMerge, removeDelegateWorktree } from "../merge"
import { createWorktree } from "../worktrees"

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-merge-"))
  const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim()
  git(dir, "init", "-q")
  git(dir, "config", "core.autocrlf", "false")
  writeFileSync(path.join(dir, "a.ts"), "one\ntwo\nthree\n")
  writeFileSync(path.join(dir, "b.ts"), "bee\n")
  git(dir, "add", ".")
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  const wt = createWorktree(dir, "worker-code.edit")
  const at = (root: string, f: string) => path.join(root, f)
  return { dir, wt, git, at, read: (root: string, f: string) => readFileSync(at(root, f), "utf8") }
}

// Each test makes real git repositories and worktrees; Windows runners can take longer than bun's 5 s.
setDefaultTimeout(30_000)

describe("worktree merge", () => {
  test("preview, apply as uncommitted changes, then remove the worktree and its branch", () => {
    const s = setup()
    writeFileSync(s.at(s.wt.path, "a.ts"), "one\nTWO\nthree\n")
    writeFileSync(s.at(s.wt.path, "new.ts"), "fresh\n")
    const preview = previewMerge(s.dir, s.wt.path)
    expect(preview).toMatchObject({ files: ["a.ts", "new.ts"], conflicts: [], appliesCleanly: true, unmergedCommits: 0 })

    // Not in the workspace yet: removing would lose it.
    expect(removeDelegateWorktree(s.dir, s.wt.path).ok).toBe(false)

    const applied = applyWorktree(s.dir, s.wt.path)
    expect(applied.ok).toBe(true)
    expect(s.read(s.dir, "a.ts")).toBe("one\nTWO\nthree\n")
    expect(s.read(s.dir, "new.ts")).toBe("fresh\n")
    expect(s.git(s.dir, "log", "--oneline").split("\n")).toHaveLength(1) // nothing committed

    const removed = removeDelegateWorktree(s.dir, s.wt.path)
    expect(removed).toMatchObject({ ok: true })
    expect(removed.message).toContain(`its branch ${s.wt.branch}`)
    expect(existsSync(s.wt.path)).toBe(false)
    expect(s.git(s.dir, "branch", "--list", s.wt.branch)).toBe("")
  })

  test("a conflicting commit on the workspace shows in the preview; apply is refused and touches nothing", () => {
    const s = setup()
    writeFileSync(s.at(s.wt.path, "a.ts"), "one\nworktree\nthree\n")
    writeFileSync(s.at(s.dir, "a.ts"), "one\nmain\nthree\n")
    s.git(s.dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "main moved on")
    const preview = previewMerge(s.dir, s.wt.path)
    expect(preview.conflicts).toEqual(["a.ts"])
    expect(preview.appliesCleanly).toBe(false)
    const applied = applyWorktree(s.dir, s.wt.path)
    expect(applied.ok).toBe(false)
    expect(applied.message).toContain("Nothing was touched")
    expect(s.read(s.dir, "a.ts")).toBe("one\nmain\nthree\n")
  })

  test("uncommitted edits in the workspace on the same lines: no merge conflict with HEAD, but it does not apply", () => {
    const s = setup()
    writeFileSync(s.at(s.wt.path, "a.ts"), "one\nworktree\nthree\n")
    writeFileSync(s.at(s.dir, "a.ts"), "one\nmy edit\nthree\n")
    const preview = previewMerge(s.dir, s.wt.path)
    expect(preview.conflicts).toEqual([])
    expect(preview.appliesCleanly).toBe(false)
    expect(preview.applyError).toContain("a.ts")
  })

  test("force removes a worktree with unapplied changes; only delegate worktrees are accepted", () => {
    const s = setup()
    writeFileSync(s.at(s.wt.path, "b.ts"), "changed\n")
    expect(removeDelegateWorktree(s.dir, s.wt.path, true).ok).toBe(true)
    expect(existsSync(s.wt.path)).toBe(false)
    expect(() => previewMerge(s.dir, s.dir)).toThrow("not one of this workspace's delegate worktrees")
    expect(() => previewMerge(s.dir, path.join(s.dir, ".harness", "worktrees", "..", ".."))).toThrow("delegate worktrees")
  })

  test("the workspace path and git's path for it may differ (symlink, Windows short name)", () => {
    const s = setup()
    // git reports the real path; the user's workspace path is a link to it.
    const link = path.join(mkdtempSync(path.join(tmpdir(), "ar-link-")), "ws")
    symlinkSync(s.dir, link, process.platform === "win32" ? "junction" : "dir")
    writeFileSync(s.at(s.wt.path, "b.ts"), "changed\n")
    expect(previewMerge(link, s.wt.path).files).toEqual(["b.ts"])
  })

  test("a branch with its own commits is kept on remove", () => {
    const s = setup()
    writeFileSync(s.at(s.wt.path, "b.ts"), "committed in the worktree\n")
    s.git(s.wt.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "delegate commit")
    const preview = previewMerge(s.dir, s.wt.path)
    expect(preview).toMatchObject({ files: ["b.ts"], unmergedCommits: 1 })
    expect(applyWorktree(s.dir, s.wt.path).ok).toBe(true)
    const removed = removeDelegateWorktree(s.dir, s.wt.path)
    expect(removed.message).toContain(`kept branch ${s.wt.branch}, which has 1 commit`)
    expect(s.git(s.dir, "branch", "--list", s.wt.branch)).toContain(s.wt.branch)
  })
})
