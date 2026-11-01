import { describe, expect, test } from "bun:test"
import type { BackendOptions } from "../../backends/Backend"
import { catalogOptions, checkTiers, detectGeminiModels, loadCatalog, mergeDetected } from "../catalog"

describe("model catalog", () => {
  test("the shipped catalog parses and covers every backend, with a tier suggestion each", () => {
    const catalog = loadCatalog()
    for (const p of ["claude", "openai", "gemini"] as const) {
      const options = catalogOptions(p, catalog)
      expect(options.models.length).toBeGreaterThan(0)
      expect(options.models.every((m) => m.source === "catalog")).toBe(true)
      expect(options.models.some((m) => m.tier === "fast")).toBe(true)
    }
  })

  test("detected models come first with catalog descriptions; authoritative detection drops catalog-only models", () => {
    const detected: BackendOptions = {
      models: [{ id: "gpt-6-luna", reasoning: ["low", "high"] }, { id: "gpt-new" }],
      reasoningLevels: ["low", "high"],
      supportsTrustOverride: false,
    }
    const strict = mergeDetected("openai", detected, { authoritative: true })
    expect(strict.models.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-new"])
    expect(strict.models[0]).toMatchObject({ source: "detected", tier: "fast", reasoning: ["low", "high"] })
    expect(strict.models[0]?.description).toContain("Fast and affordable")
    const loose = mergeDetected("openai", detected, { authoritative: false })
    expect(loose.models.length).toBeGreaterThan(2)
    expect(loose.models.at(-1)?.source).toBe("catalog")
  })

  test("no detection falls back to the catalog", () => {
    expect(mergeDetected("gemini", undefined, { authoritative: false }).models[0]?.id).toBe("gemini-3-flash-preview")
  })
})

describe("Gemini detection through the API", () => {
  test("no key: no request, no detection", async () => {
    let called = false
    const fetcher = (async () => {
      called = true
      return new Response("{}")
    }) as unknown as typeof fetch
    expect(await detectGeminiModels({}, fetcher)).toBeUndefined()
    expect(called).toBe(false)
  })

  test("lists generateContent Gemini models, sending the key in a header", async () => {
    let seen: Headers | undefined
    let url = ""
    const fetcher = (async (input: string, init?: RequestInit) => {
      url = input
      seen = new Headers(init?.headers)
      return Response.json({
        models: [
          { name: "models/gemini-3-flash-preview", description: "Fast. More text.", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
          { name: "models/imagen-4", supportedGenerationMethods: ["predict"] },
        ],
      })
    }) as unknown as typeof fetch
    const options = await detectGeminiModels({ GEMINI_API_KEY: "k-123" }, fetcher)
    expect(options?.models).toEqual([{ id: "gemini-3-flash-preview", description: "Fast" }])
    expect(seen?.get("x-goog-api-key")).toBe("k-123")
    expect(url).not.toContain("k-123")
  })

  test("an API error means no detection", async () => {
    const fetcher = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch
    expect(await detectGeminiModels({ GOOGLE_API_KEY: "k" }, fetcher)).toBeUndefined()
  })
})

describe("checkTiers()", () => {
  const options: BackendOptions = {
    models: [
      { id: "fast-m", tier: "fast", reasoning: ["low", "medium"] },
      { id: "deep-m", tier: "deep" },
    ],
    reasoningLevels: ["low", "medium", "high"],
    supportsTrustOverride: false,
  }

  test("flags unknown models only when detection is authoritative, unsupported efforts, and placeholders", () => {
    const tiers = { fast: "fast-m", standard: "gone-m", deep: "<deep-model>" }
    const reasoning = { fast: "high", standard: "", deep: "" }
    expect(checkTiers(tiers, reasoning, options, true)).toEqual([
      { tier: "fast", model: "fast-m", problem: 'reasoning "high" is not one of low, medium' },
      { tier: "standard", model: "gone-m", problem: "not offered on this account", suggestion: "fast-m" },
      { tier: "deep", model: "<deep-model>", problem: "not set; the CLI default model runs", suggestion: "deep-m" },
    ])
    expect(checkTiers(tiers, reasoning, options, false).map((c) => c.tier)).toEqual(["fast", "deep"])
  })
})
