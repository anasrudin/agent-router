import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { resolveExecutable } from "../backends/process"

/**
 * VS Code in the app (Ghostex's built-in IDE, loaded on demand): an installed `openvscode-server`
 * or `code-server`, or openvscode-server downloaded into the app's data folder on request.
 */
export interface IdeBinary {
  kind: "openvscode-server" | "code-server"
  path: string
}

/** The server to run: on PATH first, then one this app downloaded. */
export function findIde(dataDir: string, env: NodeJS.ProcessEnv = process.env): IdeBinary | undefined {
  for (const kind of ["openvscode-server", "code-server"] as const) {
    const found = resolveExecutable(kind, env)
    if (found) return { kind, path: found }
  }
  const dir = path.join(dataDir, "ide")
  if (!existsSync(dir)) return undefined
  for (const entry of readdirSync(dir).sort().reverse()) {
    const bin = path.join(dir, entry, "bin", "openvscode-server")
    if (existsSync(bin)) return { kind: "openvscode-server", path: bin }
  }
  return undefined
}

/** The command line that serves `folder` on 127.0.0.1:`port`, guarded by `token`. */
export function ideCommand(bin: IdeBinary, folder: string, port: number, token: string): { args: string[]; url: string } {
  if (bin.kind === "code-server") {
    return {
      args: [bin.path, "--bind-addr", `127.0.0.1:${port}`, "--auth", "none", "--disable-telemetry", "--disable-update-check", folder],
      url: `http://127.0.0.1:${port}/?folder=${encodeURIComponent(folder)}`,
    }
  }
  return {
    args: [
      bin.path,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--connection-token",
      token,
      "--default-folder",
      folder,
      "--telemetry-level",
      "off",
    ],
    url: `http://127.0.0.1:${port}/?tkn=${token}&folder=${encodeURIComponent(folder)}`,
  }
}

/** openvscode-server ships Linux builds; the asset for this machine from a GitHub release, if any. */
export function pickAsset(
  assets: { name: string; browser_download_url: string }[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { name: string; url: string } | undefined {
  if (platform !== "linux") return undefined
  const want = arch === "arm64" ? "linux-arm64" : arch === "arm" ? "linux-armhf" : "linux-x64"
  const a = assets.find((x) => x.name.endsWith(`-${want}.tar.gz`))
  return a ? { name: a.name, url: a.browser_download_url } : undefined
}

/** A free local port, by asking the OS for one. */
export async function freePort(): Promise<number> {
  const { createServer } = await import("node:net")
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

/** Download the latest openvscode-server for this machine into `<dataDir>/ide` (Linux only). */
export async function installIde(dataDir: string, progress: (text: string) => void): Promise<void> {
  const res = await fetch("https://api.github.com/repos/gitpod-io/openvscode-server/releases/latest", {
    headers: { accept: "application/vnd.github+json", "user-agent": "agent-router" },
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest openvscode-server release.`)
  const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] }
  const asset = pickAsset(release.assets)
  if (!asset) throw new Error("openvscode-server has no build for this system; install code-server instead.")
  const dir = path.join(dataDir, "ide")
  const { mkdirSync, rmSync } = await import("node:fs")
  mkdirSync(dir, { recursive: true })
  progress(`Downloading ${asset.name}…`)
  const download = await fetch(asset.url)
  if (!download.ok || !download.body) throw new Error(`Download failed (${download.status}).`)
  const total = Number(download.headers.get("content-length") ?? 0)
  const file = path.join(dir, asset.name)
  const sink = Bun.file(file).writer()
  let got = 0
  let last = 0
  for await (const chunk of download.body as unknown as AsyncIterable<Uint8Array>) {
    sink.write(chunk)
    got += chunk.length
    if (total && got - last > total / 20) {
      last = got
      progress(`Downloading ${asset.name}: ${Math.round((got / total) * 100)}%`)
    }
  }
  await sink.end()
  progress("Unpacking…")
  const tar = Bun.spawnSync(["tar", "-xzf", file, "-C", dir])
  rmSync(file, { force: true })
  if (tar.exitCode !== 0) throw new Error(`Unpacking failed: ${tar.stderr.toString().slice(-300)}`)
}
