import { execFileSync } from "node:child_process"
import path from "node:path"

export interface Worktree {
  path: string
  branch: string
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"])
}

/** Give a parallel writer its own checkout so two writers never touch one file (conductor.md §6). */
export function createWorktree(workspace: string, label: string): Worktree {
  const root = repoRoot(workspace)
  const slug = `${
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "task"
  }-${Date.now().toString(36)}`
  const wtPath = path.join(root, ".harness", "worktrees", slug)
  const branch = `agent-router/${slug}`
  try {
    git(root, ["rev-parse", "--verify", "HEAD"])
  } catch {
    throw new Error("Worktree isolation needs at least one commit in the repository.")
  }
  git(root, ["worktree", "add", "-b", branch, wtPath, "HEAD"])
  return { path: wtPath, branch }
}

/** Removing a worktree discards its uncommitted work, so callers only do this on explicit request. */
export function removeWorktree(workspace: string, worktree: Worktree): void {
  git(repoRoot(workspace), ["worktree", "remove", "--force", worktree.path])
}
