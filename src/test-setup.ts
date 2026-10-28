import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Settings saved in the desktop app live in the user's config folder; tests must never see them.
process.env.AGENT_ROUTER_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), "ar-user-config-"))
