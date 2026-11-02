import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { findIde, ideCommand, pickAsset } from "../ide"
import type { ChatEvent, ChatMeta } from "../protocol"
import { usageSummary } from "../usage"

const DAY = 86_400_000
const meta = (id: string): ChatMeta => ({ id, workspace: "/w", title: id, createdAt: 0, updatedAt: 0, pinned: false, turns: 1 })
const summary = (provider: "claude" | "gemini" | "openai", costUsd: number, input: number) => ({
  status: "done",
  provider,
  tier: "fast" as const,
  attempts: [],
  stopReason: "succeeded",
  costUsd,
  tokens: { input, output: 0 },
  findings: [],
  notes: [],
  changedFiles: [],
  taskClass: "plan",
  report: "",
})

describe("usageSummary", () => {
  test("per day, per backend and in total, from Conductor's usage and finished threads", () => {
    const now = Date.UTC(2026, 10, 2, 12)
    const events: ChatEvent[] = [
      { at: now - DAY, msg: { type: "turn.started", turnId: "t", prompt: "x", resumed: false } },
      {
        at: now - DAY,
        msg: { type: "conductor", turnId: "t", event: { type: "usage", inputTokens: 100, outputTokens: 10, costUsd: 0.5 } },
      },
      { at: now, msg: { type: "delegation.finished", id: "d", summary: summary("gemini", 0, 1000) } },
      { at: now - 30 * DAY, msg: { type: "delegation.finished", id: "e", summary: summary("claude", 0.25, 50) } },
    ]
    const u = usageSummary([{ meta: meta("a"), events }], now, 7)
    expect(u.days).toHaveLength(7)
    expect(u.days.at(-1)).toEqual({ day: "2026-11-02", costUsd: 0, tokens: 1000 })
    expect(u.days.at(-2)).toEqual({ day: "2026-11-01", costUsd: 0.5, tokens: 110 })
    expect(u.providers.claude).toEqual({ costUsd: 0.75, tokens: 160, threads: 1 })
    expect(u.providers.gemini).toEqual({ costUsd: 0, tokens: 1000, threads: 1 })
    expect(u).toMatchObject({ chats: 1, turns: 1, costUsd: 0.75, tokens: 1160 })
  })
})

describe("ide", () => {
  test("openvscode-server's command carries a token; code-server's binds locally with no auth page", () => {
    const o = ideCommand({ kind: "openvscode-server", path: "/b/openvscode-server" }, "/w s", 7001, "tok")
    expect(o.args).toContain("--connection-token")
    expect(o.args).toContain("127.0.0.1")
    expect(o.url).toBe("http://127.0.0.1:7001/?tkn=tok&folder=%2Fw%20s")
    const c = ideCommand({ kind: "code-server", path: "/b/code-server" }, "/w", 7002, "tok")
    expect(c.args.slice(1, 5)).toEqual(["--bind-addr", "127.0.0.1:7002", "--auth", "none"])
  })

  test("pickAsset: the Linux build for this architecture, none elsewhere", () => {
    const assets = ["x-linux-x64.tar.gz", "x-linux-arm64.tar.gz", "x-linux-armhf.tar.gz"].map((name) => ({
      name,
      browser_download_url: `u/${name}`,
    }))
    expect(pickAsset(assets, "linux", "x64")?.name).toBe("x-linux-x64.tar.gz")
    expect(pickAsset(assets, "linux", "arm64")?.name).toBe("x-linux-arm64.tar.gz")
    expect(pickAsset(assets, "darwin", "arm64")).toBeUndefined()
  })

  test("findIde: PATH first, then a download in the data folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ide-"))
    try {
      expect(findIde(dir, { PATH: "" })).toBeUndefined()
      const bin = path.join(dir, "ide", "openvscode-server-v1.99.0-linux-x64", "bin")
      mkdirSync(bin, { recursive: true })
      writeFileSync(path.join(bin, "openvscode-server"), "")
      expect(findIde(dir, { PATH: "" })).toEqual({ kind: "openvscode-server", path: path.join(bin, "openvscode-server") })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
