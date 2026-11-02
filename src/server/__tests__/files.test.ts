import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  editorCommand,
  gitStats,
  listWorkspaceFiles,
  listWorktrees,
  mentionedFiles,
  openerCommand,
  rankFiles,
  readWorkspaceFile,
  readWorkspaceImage,
  saveAttachment,
  writeWorkspaceFile,
} from "../files"

let ws: string
beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "files-"))
  mkdirSync(path.join(ws, "src", "ui"), { recursive: true })
  mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true })
  writeFileSync(path.join(ws, "src", "ui", "main.ts"), "one\ntwo\nthree\n")
  writeFileSync(path.join(ws, "src", "serve.ts"), "x\n")
  writeFileSync(path.join(ws, "README.md"), "# hi\n")
  writeFileSync(path.join(ws, "node_modules", "pkg", "index.js"), "")
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const git = (...args: string[]) => spawnSync("git", args, { cwd: ws, encoding: "utf8" })

describe("rankFiles", () => {
  test("a name match beats a path match; letters in order also match", () => {
    const files = ["src/main/other.ts", "docs/main.md", "src/ui/main.ts", "lib/m-a-i-n.ts"]
    expect(rankFiles(files, "main.ts")[0]).toBe("src/ui/main.ts")
    expect(rankFiles(files, "smt")).toContain("src/ui/main.ts")
    expect(rankFiles(files, "zzz")).toEqual([])
    expect(rankFiles(files, "", 2)).toHaveLength(2)
  })
})

describe("listWorkspaceFiles", () => {
  test("outside git: walks the folder, skipping node_modules", async () => {
    const files = await listWorkspaceFiles(ws, "")
    expect(files.sort()).toEqual(["README.md", "src/serve.ts", "src/ui/main.ts"])
  })

  test("in git: tracked and untracked files, not ignored ones", async () => {
    git("init", "-q")
    writeFileSync(path.join(ws, ".gitignore"), "node_modules\nsecret.txt\n")
    writeFileSync(path.join(ws, "secret.txt"), "s")
    const files = await listWorkspaceFiles(ws, "")
    expect(files).toContain("src/ui/main.ts")
    expect(files).not.toContain("secret.txt")
    expect(files.some((f) => f.startsWith("node_modules"))).toBe(false)
  })
})

describe("readWorkspaceFile", () => {
  test("reads a file by its workspace path, or an absolute path inside it", () => {
    expect(readWorkspaceFile(ws, "src/ui/main.ts")).toMatchObject({ path: "src/ui/main.ts", text: "one\ntwo\nthree\n", truncated: false })
    expect(readWorkspaceFile(ws, path.join(ws, "README.md")).path).toBe("README.md")
  })

  test("refuses paths outside the workspace, through .. or a symlink", () => {
    expect(() => readWorkspaceFile(ws, "../../etc/passwd")).toThrow(/outside/)
    // A folder outside the workspace, linked in (a junction on Windows, which needs no admin rights).
    const outside = mkdtempSync(path.join(tmpdir(), "files-outside-"))
    try {
      writeFileSync(path.join(outside, "hostname"), "secret")
      symlinkSync(outside, path.join(ws, "etc-link"), "junction")
      expect(() => readWorkspaceFile(ws, "etc-link/hostname")).toThrow(/outside/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("binary files and large files", () => {
    writeFileSync(path.join(ws, "img.bin"), Buffer.from([0x89, 0x50, 0, 1, 2]))
    expect(() => readWorkspaceFile(ws, "img.bin")).toThrow(/binary/)
    writeFileSync(path.join(ws, "big.txt"), "a".repeat(100))
    expect(readWorkspaceFile(ws, "big.txt", 10)).toMatchObject({ text: "a".repeat(10), truncated: true })
    expect(() => readWorkspaceFile(ws, "nope.ts")).toThrow(/No such file/)
  })
})

describe("saveAttachment", () => {
  test("saves under .harness/attachments, kept out of git, with a safe name", () => {
    const rel = saveAttachment(ws, "../../evil name.png", Buffer.from("png").toString("base64"), 1234)
    expect(rel).toBe(".harness/attachments/1234-evil-name.png")
    expect(readFileSync(path.join(ws, rel), "utf8")).toBe("png")
    expect(readFileSync(path.join(ws, ".harness", "attachments", ".gitignore"), "utf8")).toBe("*\n")
  })

  test("refuses what is not an image, and anything too big", () => {
    expect(() => saveAttachment(ws, "run.sh", "eA==")).toThrow(/image/)
    expect(() => saveAttachment(ws, "a.png", Buffer.alloc(11 * 1024 * 1024).toString("base64"))).toThrow(/too large/)
    expect(existsSync(path.join(ws, ".harness", "attachments", "run.sh"))).toBe(false)
  })
})

describe("gitStats", () => {
  test("undefined outside git; lines added and removed against HEAD inside", () => {
    expect(gitStats(ws)).toBeUndefined()
    git("init", "-q", "-b", "main")
    git("-c", "user.email=a@b", "-c", "user.name=a", "add", ".")
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init")
    writeFileSync(path.join(ws, "src", "ui", "main.ts"), "one\nTWO\nthree\nfour\n")
    expect(gitStats(ws)).toEqual({ branch: "main", added: 2, removed: 1, files: 1 })
  })
})

describe("mentionedFiles", () => {
  test("@paths that are workspace files; keywords and missing files are not", () => {
    const prompt = "@economy look at @src/ui/main.ts and @README.md, not @missing.ts or @../../etc/passwd\n@src/serve.ts"
    expect(mentionedFiles(prompt, ws)).toEqual(["src/ui/main.ts", "README.md", "src/serve.ts"])
    expect(mentionedFiles("email me@src/ui/main.ts", ws)).toEqual([])
  })
})

describe("writeWorkspaceFile", () => {
  test("saves inside the workspace; refuses outside and files changed since they were opened", () => {
    const { mtime } = readWorkspaceFile(ws, "README.md")
    const saved = writeWorkspaceFile(ws, "README.md", "# new\n", mtime)
    expect(saved.path).toBe("README.md")
    expect(readFileSync(path.join(ws, "README.md"), "utf8")).toBe("# new\n")
    expect(() => writeWorkspaceFile(ws, "README.md", "x", mtime - 10_000)).toThrow(/changed on disk/)
    expect(() => writeWorkspaceFile(ws, "../evil.txt", "x")).toThrow(/outside/)
    expect(writeWorkspaceFile(ws, "src/new.ts", "n").path).toBe("src/new.ts")
    const outside = mkdtempSync(path.join(tmpdir(), "outside-"))
    symlinkSync(path.join(outside, "pwned.txt"), path.join(ws, "dangling.txt"))
    expect(() => writeWorkspaceFile(ws, "dangling.txt", "x")).toThrow(/outside/)
    expect(existsSync(path.join(outside, "pwned.txt"))).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })
})

describe("openers", () => {
  test("only http(s) addresses, with the platform's opener", () => {
    expect(openerCommand("http://localhost:5173/", "linux")).toEqual(["xdg-open", "http://localhost:5173/"])
    expect(openerCommand("https://x.dev", "darwin")).toEqual(["open", "https://x.dev"])
    expect(openerCommand("https://x.dev/?a=1&b=2", "win32")).toEqual(["rundll32", "url.dll,FileProtocolHandler", "https://x.dev/?a=1&b=2"])
    expect(() => openerCommand("http://localhost/|calc")).toThrow(/http/)
    expect(() => openerCommand("file:///etc/passwd")).toThrow(/http/)
    expect(() => openerCommand("https://x.dev; rm -rf /")).toThrow(/http/)
  })
  test("the editor command stays inside the workspace", () => {
    expect(() => editorCommand(ws, "../x.ts")).toThrow(/outside/)
  })
})

describe("listWorktrees", () => {
  test("branches and the worktrees beside the workspace", () => {
    expect(listWorktrees(ws)).toBeUndefined()
    git("init", "-q", "-b", "main")
    git("-c", "user.email=a@b", "-c", "user.name=a", "add", ".")
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init")
    git("worktree", "add", "-q", "-b", "feature", path.join(ws, ".harness", "worktrees", "f"))
    const list = listWorktrees(ws)
    expect(list?.current).toBe("main")
    expect(list?.branches.sort()).toEqual(["feature", "main"])
    expect(list?.worktrees.map((w) => w.branch)).toEqual(["feature"])
  })
})

describe("readWorkspaceImage", () => {
  test("a data URL for images inside the workspace only", () => {
    writeFileSync(path.join(ws, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(readWorkspaceImage(ws, "pic.png")).toBe("data:image/png;base64,iVBORw==")
    expect(() => readWorkspaceImage(ws, "README.md")).toThrow(/Not an image/)
    expect(() => readWorkspaceImage(ws, "../x.png")).toThrow(/outside/)
  })
})
