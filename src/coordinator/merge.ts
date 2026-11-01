import { execFileSync, spawnSync } from "node:child_process"
import path from "node:path"
import { snapshot } from "./checkpoints"
import { isDelegateWorktree } from "./worktrees"

/**
 * Bringing a delegate worktree's work back into the workspace. A worktree delegate leaves its
 * changes uncommitted, like any delegate, so its state is taken as a snapshot commit (see
 * checkpoints.ts) and its changes are applied to the workspace as uncommitted changes too: the
 * user still decides what to commit. Nothing here commits to the user's branch.
 */
export interface MergePreview {
  worktree: string
  branch?: string
  /** Files the worktree changed relative to where it started. */
  files: string[]
  /** Files that conflict with the workspace's HEAD (git merge-tree; nothing is touched). */
  conflicts: string[]
  /** Whether the changes apply cleanly to the workspace as it is now, uncommitted edits included. */
  appliesCleanly: boolean
  /** Why they do not apply, from git apply --check. */
  applyError?: string
  /** Commits on the worktree's branch that the workspace's HEAD does not have. */
  unmergedCommits: number
}

const EXCLUDE = ":(exclude).harness"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim()
}

/** A path that is one of this workspace's delegate worktrees, resolved; anything else throws. */
export function delegateWorktree(workspace: string, worktree: string): string {
  if (!isDelegateWorktree(workspace, worktree)) {
    throw new Error(`${worktree} is not one of this workspace's delegate worktrees (.harness/worktrees/*).`)
  }
  return path.resolve(workspace, worktree)
}

interface WorktreeState {
  base: string
  snap: string
  branch?: string
  patch: string
  files: string[]
}

function worktreeState(worktree: string): WorktreeState {
  const base = git(worktree, ["rev-parse", "HEAD"])
  const snap = snapshot(worktree, `merge-${path.basename(worktree)}-${Date.now().toString(36)}`)
  if (!snap) throw new Error(`Could not snapshot ${worktree}.`)
  let branch: string | undefined
  try {
    branch = git(worktree, ["symbolic-ref", "--short", "HEAD"])
  } catch {
    branch = undefined
  }
  // The branch's own commits count too, if the delegate made any: diff from where it forked.
  const root = git(worktree, ["rev-parse", "--show-toplevel"])
  const fork = forkPoint(root, base)
  const patch = git(worktree, ["diff", "--binary", "--no-color", "--no-ext-diff", fork, snap, "--", ".", EXCLUDE])
  const files = git(worktree, ["diff", "--name-only", fork, snap, "--", ".", EXCLUDE]).split("\n").filter(Boolean)
  return { base: fork, snap, branch, patch, files }
}

/** Where the worktree's branch left the main checkout's history. */
function forkPoint(worktreeRoot: string, head: string): string {
  const main = git(worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  const mainHead = git(path.dirname(main), ["rev-parse", "HEAD"])
  try {
    return git(worktreeRoot, ["merge-base", head, mainHead])
  } catch {
    return head
  }
}

export function previewMerge(workspace: string, worktreePath: string): MergePreview {
  const worktree = delegateWorktree(workspace, worktreePath)
  const root = git(workspace, ["rev-parse", "--show-toplevel"])
  const state = worktreeState(worktree)
  // merge-tree computes the merge in memory: exit 1 lists conflicted files after the tree id.
  const merge = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", state.snap], {
    cwd: root,
    encoding: "utf8",
  })
  const conflicts = merge.status === 1 ? merge.stdout.trim().split("\n").slice(1).filter(Boolean) : []
  if (merge.status !== 0 && merge.status !== 1) throw new Error(`git merge-tree failed: ${merge.stderr.trim()}`)
  const check = state.patch
    ? spawnSync("git", ["apply", "--check", "--whitespace=nowarn"], { cwd: root, input: `${state.patch}\n`, encoding: "utf8" })
    : undefined
  const head = git(root, ["rev-parse", "HEAD"])
  const unmerged = Number(git(root, ["rev-list", "--count", `${head}..${git(worktree, ["rev-parse", "HEAD"])}`]))
  return {
    worktree,
    branch: state.branch,
    files: state.files,
    conflicts,
    appliesCleanly: !check || check.status === 0,
    applyError: check && check.status !== 0 ? check.stderr.trim().slice(0, 2000) : undefined,
    unmergedCommits: unmerged,
  }
}

/** Apply the worktree's changes to the workspace as uncommitted changes, all or nothing. */
export function applyWorktree(workspace: string, worktreePath: string): { ok: boolean; message: string; files: string[] } {
  const worktree = delegateWorktree(workspace, worktreePath)
  const root = git(workspace, ["rev-parse", "--show-toplevel"])
  const state = worktreeState(worktree)
  if (!state.patch) return { ok: true, message: "The worktree has no changes to apply.", files: [] }
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, input: `${state.patch}\n`, encoding: "utf8" })
  const check = run(["apply", "--check", "--whitespace=nowarn"])
  if (check.status !== 0) {
    return {
      ok: false,
      message: `Not applied: the changes do not apply cleanly to the workspace as it is now (it changed the same lines). Nothing was touched.\n${check.stderr.trim().slice(0, 2000)}`,
      files: state.files,
    }
  }
  const apply = run(["apply", "--whitespace=nowarn"])
  if (apply.status !== 0) return { ok: false, message: `git apply failed: ${apply.stderr.trim().slice(0, 2000)}`, files: state.files }
  return {
    ok: true,
    message: `Applied ${state.files.length} file${state.files.length === 1 ? "" : "s"} from ${path.basename(worktree)} to the workspace, uncommitted.`,
    files: state.files,
  }
}

/**
 * Remove a delegate worktree once its work is in (or is not wanted). Its uncommitted changes go
 * with it, so without `force` it refuses while they are not yet in the workspace. The branch is
 * deleted only when it has no commits the workspace's HEAD lacks.
 */
export function removeDelegateWorktree(workspace: string, worktreePath: string, force = false): { ok: boolean; message: string } {
  const worktree = delegateWorktree(workspace, worktreePath)
  const root = git(workspace, ["rev-parse", "--show-toplevel"])
  const state = worktreeState(worktree)
  if (!force && state.patch) {
    const contained = spawnSync("git", ["apply", "-R", "--check", "--whitespace=nowarn"], {
      cwd: root,
      input: `${state.patch}\n`,
      encoding: "utf8",
    })
    if (contained.status !== 0) {
      return {
        ok: false,
        message: `Not removed: its changes (${state.files.join(", ")}) are not in the workspace yet. Apply them first, or remove with force to discard them.`,
      }
    }
  }
  const ahead = Number(git(root, ["rev-list", "--count", `HEAD..${git(worktree, ["rev-parse", "HEAD"])}`]))
  git(root, ["worktree", "remove", "--force", worktree])
  let branchNote = ""
  if (state.branch) {
    if (ahead === 0) {
      git(root, ["branch", "-D", state.branch])
      branchNote = ` and its branch ${state.branch}`
    } else {
      branchNote = `; kept branch ${state.branch}, which has ${ahead} commit${ahead === 1 ? "" : "s"} the workspace lacks`
    }
  }
  return { ok: true, message: `Removed ${path.basename(worktree)}${branchNote}.` }
}
