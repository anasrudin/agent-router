import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse } from "yaml"
import { RoutingConfig } from "./schema"

/** Walk up from the running module, so the same lookup works from `src/` and from a bundled `dist/cli.js`. */
function findAssetsRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "agent-harness-prompts")
    if (existsSync(path.join(candidate, "config", "routing.yaml"))) return candidate
    if (path.dirname(dir) === dir) throw new Error(`agent-harness-prompts/ not found above ${start}`)
  }
}

/** Prompts and default config shipped with the harness. A packaged app points AGENT_ROUTER_ASSETS at its bundled copy. */
export const ASSETS_ROOT = process.env.AGENT_ROUTER_ASSETS ?? findAssetsRoot(import.meta.dir)
export const DEFAULT_CONFIG_PATH = path.join(ASSETS_ROOT, "config", "routing.yaml")

export function projectConfigPath(workspace: string): string {
  return path.join(workspace, ".harness", "routing.yaml")
}

/** Per-user overrides for every project, in the platform's usual config location. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.AGENT_ROUTER_CONFIG_DIR) return path.join(env.AGENT_ROUTER_CONFIG_DIR, "routing.yaml")
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
  const base =
    platform === "win32"
      ? (env.APPDATA ?? path.join(home, "AppData", "Roaming"))
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : (env.XDG_CONFIG_HOME ?? path.join(home, ".config"))
  return path.join(base, "agent-router", "routing.yaml")
}

type Plain = Record<string, unknown>

function isPlain(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Objects merge key by key; arrays and scalars from the override replace the base. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlain(base) || !isPlain(override)) return override === undefined ? base : override
  const out: Plain = { ...base }
  for (const [key, value] of Object.entries(override)) out[key] = deepMerge(base[key], value)
  return out
}

function readYaml(file: string): unknown {
  return parse(readFileSync(file, "utf8")) ?? {}
}

export interface LoadedConfig {
  config: RoutingConfig
  sources: string[]
}

/** Shipped defaults, then the user's overrides, then the project's. Later layers win key by key. */
export function configLayers(workspace: string, defaultPath = DEFAULT_CONFIG_PATH): string[] {
  return [defaultPath, userConfigPath(), projectConfigPath(workspace)].filter((file, i) => i === 0 || existsSync(file))
}

export function mergeLayers(files: string[], replace?: { file: string; raw: unknown }): unknown {
  return files.reduce<unknown>((acc, file) => deepMerge(acc, file === replace?.file ? replace.raw : readYaml(file)), {})
}

export function validateConfig(raw: unknown, sources: string[]): RoutingConfig {
  const result = RoutingConfig.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Invalid routing config (${sources.join(" + ")}):\n${issues}`)
  }
  return result.data
}

/** A profile's `second_opinion: null` means "none": drop the key rather than fail validation. */
function dropNullSecondOpinions(raw: unknown): unknown {
  const routes = (raw as { routes?: Record<string, Record<string, unknown>> })?.routes ?? {}
  for (const route of Object.values(routes)) if (route?.second_opinion === null) delete route.second_opinion
  return raw
}

/**
 * Load the layered config. A profile's overlay sits directly above the shipped defaults, so
 * anything the user or the project set explicitly still wins over the profile.
 */
export function loadConfig(workspace: string, profile?: string | null, defaultPath = DEFAULT_CONFIG_PATH): LoadedConfig {
  const sources = configLayers(workspace, defaultPath)
  const plain = validateConfig(mergeLayers(sources), sources)
  // null: the files exactly as written, no profile (what the Models dialog edits).
  const name = profile === null ? undefined : profile || plain.default_profile
  if (!name) return { config: plain, sources }
  const chosen = plain.profiles[name]
  if (!chosen) throw new Error(`Unknown profile "${name}". Known: ${Object.keys(plain.profiles).join(", ") || "none"}`)
  const [base, ...rest] = sources.map(readYaml)
  const raw = [chosen.overlay, ...rest].reduce<unknown>((acc, layer) => deepMerge(acc, layer), base)
  const config = validateConfig(dropNullSecondOpinions(raw), [...sources, `profile ${name}`])
  config.active_profile = name
  return { config, sources: [...sources, `profile ${name}`] }
}
