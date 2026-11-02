import { execFile, spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { resolveExecutable } from "../backends/process"
import { samePath } from "../coordinator/worktrees"
import type { GitStats, WorktreeList } from "./protocol"

const run = promisify(execFile)

/** Folders never worth listing, for workspaces outside git. */
const SKIP = new Set(["node_modules", ".git", ".harness", "dist", "build", "target", ".next", "out", "coverage", "__pycache__", ".venv"])
const MAX_WALK = 20_000

function walk(root: string): string[] {
  const out: string[] = []
  const stack = [""]
  while (stack.length && out.length < MAX_WALK) {
    const rel = stack.pop() as string
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(child)
      } else if (e.isFile()) out.push(child)
    }
  }
  return out
}

const cache = new Map<string, { at: number; files: string[] }>()
const CACHE_MS = 10_000

/** The workspace's files (git's tracked and untracked-but-not-ignored, or a walk outside git), best matches first. */
export async function listWorkspaceFiles(workspace: string, query: string, limit = 50): Promise<string[]> {
  const hit = cache.get(workspace)
  let files = hit && Date.now() - hit.at < CACHE_MS ? hit.files : undefined
  if (!files) {
    try {
      const { stdout } = await run("git", ["ls-files", "-co", "--exclude-standard"], { cwd: workspace, maxBuffer: 64 * 1024 * 1024 })
      files = stdout.split("\n").filter(Boolean).slice(0, MAX_WALK)
    } catch {
      files = walk(workspace)
    }
    cache.set(workspace, { at: Date.now(), files })
  }
  return rankFiles(files, query, limit)
}

/**
 * Best matches first: the file name containing the query, then the path containing it, then
 * the query's letters in order (fuzzy). Shorter paths win ties.
 */
export function rankFiles(files: string[], query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return files.slice(0, limit)
  const scored: [number, string][] = []
  for (const f of files) {
    const lower = f.toLowerCase()
    const name = lower.slice(lower.lastIndexOf("/") + 1)
    let score: number
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else if (lower.includes(q)) score = 3
    else {
      let i = 0
      for (const c of lower) if (c === q[i]) i++
      if (i < q.length) continue
      score = 4
    }
    scored.push([score * 10_000 + f.length, f])
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([, f]) => f)
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export const MAX_FILE_BYTES = 512 * 1024

/** A text file inside the workspace (symlinks resolved), cut at `maxBytes`. */
export function readWorkspaceFile(
  workspace: string,
  file: string,
  maxBytes = MAX_FILE_BYTES,
): { path: string; text: string; truncated: boolean; mtime: number } {
  const root = realpathSync(workspace)
  const target = path.resolve(root, file)
  if (!inside(root, target)) throw new Error("That file is outside the workspace.")
  if (!existsSync(target)) throw new Error(`No such file: ${path.relative(root, target)}`)
  const real = realpathSync(target)
  if (!inside(root, real)) throw new Error("That file is outside the workspace.")
  const stat = statSync(real)
  if (!stat.isFile()) throw new Error("Not a file.")
  const size = Math.min(stat.size, maxBytes)
  const buf = Buffer.alloc(size)
  const fd = openSync(real, "r")
  try {
    readSync(fd, buf, 0, size, 0)
  } finally {
    closeSync(fd)
  }
  if (buf.subarray(0, 8000).includes(0)) throw new Error("This is a binary file.")
  return {
    path: path.relative(root, target).split(path.sep).join("/"),
    text: buf.toString("utf8"),
    truncated: stat.size > maxBytes,
    mtime: stat.mtimeMs,
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/**
 * An image from the composer, saved in `<workspace>/.harness/attachments` (kept out of git) where
 * Conductor's Read tool can open it. Returns the workspace-relative path.
 */
export function saveAttachment(workspace: string, name: string, base64: string, now = Date.now()): string {
  const base = path.basename(name.replace(/\\/g, "/"))
  if (!IMAGE_EXT.test(base)) throw new Error("Only images can be attached (png, jpg, gif, webp, bmp).")
  const data = Buffer.from(base64, "base64")
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error("That image is too large (10 MB at most).")
  const safe = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(-80)
  const dir = path.join(workspace, ".harness", "attachments")
  mkdirSync(dir, { recursive: true })
  const ignore = path.join(dir, ".gitignore")
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n")
  const rel = `.harness/attachments/${now}-${safe}`
  writeFileSync(path.join(workspace, rel), data)
  return rel
}

/** Uncommitted line changes against HEAD, and the branch; undefined outside a git checkout. */
export function gitStats(workspace: string): GitStats | undefined {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: workspace, encoding: "utf8", timeout: 5000 })
  const head = git("rev-parse", "--abbrev-ref", "HEAD")
  if (head.status !== 0) return undefined
  const diff = git("diff", "--numstat", "HEAD")
  let added = 0
  let removed = 0
  let files = 0
  for (const line of (diff.status === 0 ? diff.stdout : "").split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line)
    if (!m) continue
    files++
    added += Number(m[1]) || 0
    removed += Number(m[2]) || 0
  }
  return { branch: head.stdout.trim(), added, removed, files }
}

/**
 * Workspace files the request names with `@path` (the composer's @-menu, pasted images), so
 * Conductor is told plainly which files the user means. Paths that are not files are left alone.
 */
export function mentionedFiles(prompt: string, workspace: string): string[] {
  const found = new Set<string>()
  for (const m of prompt.matchAll(/(^|\s)@([\w./\\-]*[\w-]\.?[\w-]*)/g)) {
    const rel = m[2] as string
    if (!/[./\\]/.test(rel)) continue
    const full = path.resolve(workspace, rel)
    if (!inside(workspace, full)) continue
    try {
      if (statSync(full).isFile()) found.add(rel)
    } catch {}
  }
  return [...found]
}

/**
 * Save a file from the editor, inside the workspace only. With `expectedMtime` (the time it had
 * when opened), a file changed on disk since then is refused rather than overwritten.
 */
export function writeWorkspaceFile(workspace: string, file: string, text: string, expectedMtime?: number): { path: string; mtime: number } {
  const root = realpathSync(workspace)
  const target = path.resolve(root, file)
  if (!inside(root, target)) throw new Error("That file is outside the workspace.")
  const link = lstatSync(target, { throwIfNoEntry: false })
  if (link?.isSymbolicLink() && !existsSync(target)) {
    // A dangling link: writing would create its target, wherever it points.
    const pointsTo = path.resolve(path.dirname(target), readlinkSync(target))
    if (!inside(root, pointsTo)) throw new Error("That file is outside the workspace.")
  }
  if (existsSync(target)) {
    const real = realpathSync(target)
    if (!inside(root, real)) throw new Error("That file is outside the workspace.")
    const stat = statSync(real)
    if (!stat.isFile()) throw new Error("Not a file.")
    if (expectedMtime !== undefined && Math.abs(stat.mtimeMs - expectedMtime) > 1)
      throw new Error("The file changed on disk since you opened it. Reopen it to see the new version.")
  } else if (!inside(root, realpathSync(path.dirname(target)))) throw new Error("That file is outside the workspace.")
  writeFileSync(target, text)
  return { path: path.relative(root, target).split(path.sep).join("/"), mtime: statSync(target).mtimeMs }
}

/** The OS's opener for a web address (http and https only). */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!/^https?:\/\/[^\s"<>|^`]+$/i.test(url)) throw new Error("Only http and https addresses open in the browser.")
  if (platform === "darwin") return ["open", url]
  // Not through cmd.exe, which would treat & in a query string as a command separator.
  if (platform === "win32") return ["rundll32", "url.dll,FileProtocolHandler", url]
  return ["xdg-open", url]
}

/** VS Code's command to open a workspace file at a line, if `code` is on PATH. */
export function editorCommand(workspace: string, file: string, line?: number): string[] {
  const root = realpathSync(workspace)
  const target = path.resolve(root, file)
  if (!inside(root, target)) throw new Error("That file is outside the workspace.")
  const code = resolveExecutable("code")
  if (!code) throw new Error("VS Code's `code` command is not on PATH (in VS Code: Shell Command: Install 'code' command in PATH).")
  return [code, "-g", line ? `${target}:${line}` : target]
}

/** Branches to start a chat's worktree from, and the worktrees that exist (not the workspace itself). */
export function listWorktrees(workspace: string): WorktreeList | undefined {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: workspace, encoding: "utf8", timeout: 5000 })
  const head = git("rev-parse", "--abbrev-ref", "HEAD")
  if (head.status !== 0) return undefined
  const branches = git("branch", "--format=%(refname:short)").stdout.split("\n").filter(Boolean)
  const worktrees: { path: string; branch: string }[] = []
  let cur: { path: string; branch: string } | undefined
  for (const line of git("worktree", "list", "--porcelain").stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: "" }
      worktrees.push(cur)
    } else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "")
  }
  return {
    current: head.stdout.trim(),
    branches,
    // git may spell the workspace differently (Windows short names, slashes, case): compare as the platform does.
    worktrees: worktrees.filter((w) => existsSync(w.path) && !samePath(w.path, workspace)),
  }
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
}
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** A workspace image as a data URL (an <img> never runs an SVG's scripts). */
export function readWorkspaceImage(workspace: string, file: string): string {
  const root = realpathSync(workspace)
  const target = path.resolve(root, file)
  if (!inside(root, target)) throw new Error("That file is outside the workspace.")
  const type = IMAGE_TYPES[path.extname(target).slice(1).toLowerCase()]
  if (!type) throw new Error("Not an image.")
  if (!existsSync(target)) throw new Error(`No such file: ${path.relative(root, target)}`)
  const real = realpathSync(target)
  if (!inside(root, real)) throw new Error("That file is outside the workspace.")
  const stat = statSync(real)
  if (stat.size > MAX_IMAGE_BYTES) throw new Error("That image is too large to show (8 MB at most).")
  return `data:${type};base64,${readFileSync(real).toString("base64")}`
}
