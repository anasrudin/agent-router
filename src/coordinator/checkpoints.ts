import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Snapshots of the working tree before and after an edit delegation, as commits under
 * refs/agent-router/checkpoints/. Built with a throwaway index (GIT_INDEX_FILE), so the user's
 * branch, index and files are never touched. Only one delegate writes in a checkout at a time
 * (parallel writers get worktrees), so the diff between a thread's two checkpoints is exactly
 * what that thread changed: the thread's diff view and its Revert button come from here.
 */
export interface Checkpoint {
  /** Commit of the working tree before the delegate started. */
  before: string
  /** Commit after it finished; absent while it runs. */
  after?: string
  /** The checkout the delegate worked in (workspace or worktree). */
  cwd: string
}

const SHA = /^[0-9a-f]{40}$/
const REF_PREFIX = "refs/agent-router/checkpoints"
/** Harness state is not the delegate's work. */
const EXCLUDE = ":(exclude).harness"

function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

/** The working tree, untracked files included (.gitignore respected), as a commit on top of HEAD. */
export function snapshot(cwd: string, label: string): string | undefined {
  let head: string
  try {
    head = git(cwd, ["rev-parse", "--verify", "HEAD"])
  } catch {
    return undefined // not a repository, or no commit yet
  }
  const dir = mkdtempSync(path.join(tmpdir(), "ar-index-"))
  const env = { GIT_INDEX_FILE: path.join(dir, "index") }
  try {
    git(cwd, ["read-tree", head], env)
    git(cwd, ["add", "-A", "--", ".", EXCLUDE], env)
    const tree = git(cwd, ["write-tree"], env)
    const commit = git(cwd, ["commit-tree", tree, "-p", head, "-m", `agent-router checkpoint: ${label}`], {
      GIT_AUTHOR_NAME: "agent-router",
      GIT_AUTHOR_EMAIL: "agent-router@localhost",
      GIT_COMMITTER_NAME: "agent-router",
      GIT_COMMITTER_EMAIL: "agent-router@localhost",
    })
    // A ref keeps the commit from being garbage-collected while the thread can still be reverted.
    git(cwd, ["update-ref", `${REF_PREFIX}/${label.replace(/[^\w.-]+/g, "_")}`, commit])
    pruneCheckpoints(cwd)
    return commit
  } catch {
    return undefined
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Keep the newest refs only, so checkpoints do not pile up; older threads just lose Revert. */
export const CHECKPOINTS_KEPT = 200

function pruneCheckpoints(cwd: string, keep = CHECKPOINTS_KEPT): void {
  const refs = git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", `${REF_PREFIX}/`])
    .split("\n")
    .filter(Boolean)
  if (refs.length <= keep) return
  const input = refs
    .slice(keep)
    .map((r) => `delete ${r}\n`)
    .join("")
  git(cwd, ["update-ref", "--stdin"], {}, input)
}

function assertCheckpoint(c: Checkpoint): asserts c is Required<Checkpoint> {
  if (!SHA.test(c.before) || !c.after || !SHA.test(c.after)) throw new Error("Not a checkpoint pair.")
}

export const DIFF_CHAR_LIMIT = 400_000

/** What the thread changed, as a unified diff (capped), for the diff view. */
export function checkpointDiff(c: Checkpoint): { patch: string; truncated: boolean } {
  assertCheckpoint(c)
  const patch = git(c.cwd, ["diff", "--no-color", "--no-ext-diff", "-M", c.before, c.after, "--", ".", EXCLUDE])
  return patch.length > DIFF_CHAR_LIMIT ? { patch: patch.slice(0, DIFF_CHAR_LIMIT), truncated: true } : { patch, truncated: false }
}

/** Files the thread changed, from git. */
export function checkpointFiles(c: Checkpoint): string[] {
  assertCheckpoint(c)
  return git(c.cwd, ["diff", "--name-only", "-M", c.before, c.after, "--", ".", EXCLUDE]).split("\n").filter(Boolean)
}

/**
 * Undo the thread's changes in the working tree by applying its diff in reverse. All or nothing:
 * if a file has changed since (by you or a later thread), nothing is touched and the reason is
 * returned. The index is left alone, like the delegate left it.
 */
export function revertCheckpoint(c: Checkpoint): { ok: boolean; message: string; files: string[] } {
  assertCheckpoint(c)
  const files = checkpointFiles(c)
  if (!files.length) return { ok: true, message: "The thread changed no files.", files }
  const patch = git(c.cwd, ["diff", "--binary", "--no-color", "--no-ext-diff", c.before, c.after, "--", ".", EXCLUDE])
  // Diff paths are relative to the repository root, so apply from there.
  const root = git(c.cwd, ["rev-parse", "--show-toplevel"])
  const check = spawnSync("git", ["apply", "-R", "--check", "--whitespace=nowarn"], { cwd: root, input: `${patch}\n`, encoding: "utf8" })
  if (check.status !== 0) {
    return {
      ok: false,
      message: `Not reverted: the files have changed since this thread finished, so its changes no longer undo cleanly.\n${check.stderr.trim().slice(0, 2000)}`,
      files,
    }
  }
  const apply = spawnSync("git", ["apply", "-R", "--whitespace=nowarn"], { cwd: root, input: `${patch}\n`, encoding: "utf8" })
  if (apply.status !== 0) return { ok: false, message: `git apply failed: ${apply.stderr.trim().slice(0, 2000)}`, files }
  return { ok: true, message: `Reverted ${files.length} file${files.length > 1 ? "s" : ""}.`, files }
}
