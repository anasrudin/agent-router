import type { ProviderId, RoutingConfig } from "../config/schema"
import type { Backend } from "./Backend"
import { createClaudeBackend } from "./claude"
import { createGeminiBackend } from "./gemini"
import { createCodexBackend } from "./openai"

export type BackendRegistry = Record<ProviderId, Backend>

export function createBackends(config: RoutingConfig): BackendRegistry {
  return {
    claude: createClaudeBackend(config.backends.claude),
    gemini: createGeminiBackend(config.backends.gemini),
    openai: createCodexBackend(config.backends.openai),
  }
}
