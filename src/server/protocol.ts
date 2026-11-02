/**
 * Messages between the desktop UI, the local server (`agent-router serve`), and the router MCP
 * child it starts via Conductor. Plain JSON over WebSocket; the UI imports these types only.
 */
import type { BackendOptions, PermissionMode } from "../backends/Backend"
import type { QuotaSnapshot, QuotaWindow } from "../backends/events"
import type { ProviderId, Tier } from "../config/schema"
import type { ProviderHealth } from "../router/health"

export type SettingsScope = "user" | "project"

export interface BackendSettings {
  tiers: Record<Tier, string>
  /** An empty string means "the CLI's default effort". */
  reasoning: Record<Tier, string>
  trustWorkspace: boolean
}

export type SettingsValues = Record<ProviderId, BackendSettings>

export interface SettingsSnapshot {
  workspace: string
  values: SettingsValues
  /** Config files in effect, lowest priority first. */
  sources: string[]
  paths: Record<SettingsScope, string>
}

export interface ModelTest {
  ok: boolean
  detail: string
  ms: number
}

/** BackendEvent with errors flattened to plain data so it survives JSON. */
export type WireEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown; id?: string }
  /** `id` pairs it with its call; `output` is the tail of what the tool printed, when the CLI says. */
  | { type: "tool_result"; ok: boolean; id?: string; output?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "quota"; windows: QuotaWindow[] }
  | { type: "error"; kind: string; message: string }
  | { type: "done"; text: string }

export interface DelegationSummary {
  status: string
  provider: ProviderId
  tier: Tier
  model?: string
  attempts: { provider: ProviderId; tier: Tier; outcome: string; errorKind?: string; message?: string }[]
  stopReason: string
  costUsd: number
  tokens: { input: number; output: number }
  findings: { severity: string; message: string }[]
  notes: string[]
  worktree?: string
  /** The delegate's session on `provider`, for a follow-up that resumes it. */
  sessionId?: string
  taskClass: string
  /** Edit mode in a git checkout: the thread's before/after snapshots (diff view, Revert). */
  checkpoint?: ThreadCheckpoint
  /** Edit mode: git status lines that appeared during the task, with line counts. */
  changedFiles: string[]
  /** The delegate's report, verbatim. */
  report: string
}

/** coordinator/protocol.ts Brief, as plain data. */
export interface DelegationBrief {
  task: string
  why: string
  relevant_files: string[]
  facts: string[]
  excerpts: string[]
  scope: string
  mode: "read-only" | "run-commands" | "edit"
  project_rules: string[]
  do_not: string[]
  acceptance: string[]
  return_extra: string
}

/** MCP child → server. */
export type BridgeMessage =
  | {
      type: "delegation.started"
      id: string
      taskClass: string
      agent: string
      task: string
      mode: string
      provider: ProviderId
      tier: Tier
      model?: string
      /** Why it went to this backend at this tier, in plain lines (the routing policy's reasons). */
      why?: string[]
      /** The brief as Conductor wrote it, so the thread can be run again elsewhere. */
      brief?: DelegationBrief
      /** Set when the user re-ran an earlier thread on another backend. */
      rerunOf?: string
    }
  | { type: "delegation.event"; id: string; provider: ProviderId; event: WireEvent }
  | { type: "delegation.finished"; id: string; summary: DelegationSummary }
  | { type: "delegation.failed"; id: string; error: string }
  | { type: "approval.request"; id: string; tool: string; input: Record<string, unknown> }

/** Server → MCP child. */
export type BridgeReply = { type: "approval.response"; id: string; allow: boolean; message?: string }

/** UI → server. */
export type ClientMessage =
  | {
      type: "start"
      prompt: string
      workspace: string
      permission: PermissionMode
      profile?: string
      plan?: string
      /** A new chat only: run it in a new worktree from `base`, or in an existing worktree at `path`. */
      worktree?: { base: string } | { path: string }
      /** Run even though a budget is reached (the user said so). */
      overBudget?: boolean
    }
  | { type: "cancel" }
  /** A thread's diff between its checkpoints. */
  | { type: "thread.diff"; requestId: string; workspace: string; checkpoint: ThreadCheckpoint }
  /** Undo a thread's changes in its checkout. */
  | { type: "thread.revert"; requestId: string; workspace: string; checkpoint: ThreadCheckpoint; title: string }
  /** A delegate worktree: preview bringing its work in, apply it, or remove the worktree. */
  | {
      type: "worktree.action"
      requestId: string
      workspace: string
      worktree: string
      action: "preview" | "apply" | "remove"
      force?: boolean
      title: string
    }
  /** Drop a queued request. */
  | { type: "queue.remove"; id: string }
  /** Run a queued request next: now if idle (also resumes a paused queue), otherwise right after the current turn. */
  | { type: "queue.send"; id: string }
  /** Drag to reorder. */
  | { type: "queue.move"; id: string; to: number }
  /** Take a request out of the queue (Edit puts its text back in the composer). */
  | { type: "queue.take"; id: string }
  /** Stop the running turn and run this request now. */
  | { type: "queue.interrupt"; id: string }
  /** Write a Markdown file where the save dialog said: a chat rendered from its record, or the given text. */
  | { type: "export.save"; requestId: string; path: string; chatId?: string; text?: string }
  /** A side question for the fast model, with the chat as context; the answer is not part of Conductor's chat. */
  | { type: "side.ask"; workspace: string; question: string }
  /** A short summary of where the chat stands. */
  | { type: "catchup"; workspace: string }
  | { type: "worktrees.list"; requestId: string; workspace: string }
  | { type: "schedules.list" }
  | { type: "schedule.add"; schedule: Omit<Schedule, "id" | "createdAt"> }
  | { type: "schedule.remove"; id: string }
  | { type: "board.get"; workspace: string }
  | { type: "board.upsert"; workspace: string; card: Partial<Card> }
  | { type: "board.remove"; workspace: string; id: string }
  | { type: "board.move"; workspace: string; id: string; column: CardColumn; index: number }
  | { type: "term.list" }
  /** A shell, or Conductor's own session in the Claude Code CLI (`claude --resume`), in the chat's folder. */
  | { type: "term.open"; requestId: string; workspace: string; kind: "shell" | "conductor"; cols: number; rows: number; draft?: string }
  | { type: "term.attach"; id: string }
  | { type: "term.input"; id: string; data: string }
  | { type: "term.resize"; id: string; cols: number; rows: number }
  | { type: "term.close"; id: string }
  | { type: "file.write"; requestId: string; workspace: string; path: string; text: string; expectedMtime?: number }
  | { type: "open.url"; url: string }
  /** A workspace image as a data URL, for pictures in replies and attachments. */
  | { type: "file.image"; requestId: string; workspace: string; path: string }
  /** A saved chat as Markdown, to read beside the open one. */
  | { type: "chat.markdown"; requestId: string; id: string }
  | { type: "usage.summary"; requestId: string }
  /** Run a read-only thread's brief again, pinned to another backend, without Conductor. */
  | {
      type: "thread.rerun"
      workspace: string
      threadId: string
      taskClass: string
      brief: DelegationBrief
      provider: ProviderId
      permission: PermissionMode
      profile?: string
    }
  /** Put the chat's folder back to how it was before a turn (undoable). */
  | { type: "turn.restore"; requestId: string; workspace: string; before: string; label: string }
  | { type: "budget.get" }
  | { type: "budget.set"; limits: BudgetLimits }
  | { type: "routing.get"; requestId: string; workspace: string }
  | { type: "routing.save"; requestId: string; workspace: string; scope: SettingsScope; routes: RouteEdit[] }
  | { type: "route.test"; requestId: string; workspace: string; text: string; taskClass?: string; profile?: string }
  | { type: "advanced.get"; requestId: string; workspace: string }
  | { type: "advanced.save"; requestId: string; workspace: string; scope: SettingsScope; values: Record<string, unknown> }
  | { type: "profiles.get"; requestId: string; workspace: string }
  | { type: "profile.save"; requestId: string; workspace: string; scope: SettingsScope; profile: ProfileRow }
  | { type: "profile.delete"; requestId: string; workspace: string; scope: SettingsScope; name: string }
  | { type: "profile.default"; requestId: string; workspace: string; scope: SettingsScope; name: string }
  | { type: "templates.list"; workspace: string }
  | { type: "template.save"; workspace: string; scope: SettingsScope; name: string; text: string }
  | { type: "template.delete"; workspace: string; scope: SettingsScope; name: string }
  | { type: "ide.status" }
  | { type: "ide.install" }
  | { type: "ide.start"; workspace: string }
  | { type: "ide.stop" }
  | { type: "open.editor"; workspace: string; path: string; line?: number }
  | { type: "reset" }
  /** Every saved chat, all workspaces (the sidebar groups them). */
  | { type: "chats.list" }
  /** Make a saved chat the current one: its messages are replayed and the next request resumes it. */
  | { type: "chat.open"; id: string }
  | { type: "chat.update"; id: string; title?: string; pinned?: boolean }
  | { type: "chat.delete"; id: string }
  | { type: "chats.search"; requestId: string; query: string }
  /** Workspace files matching `query`, for @-mentions. */
  | { type: "files.list"; requestId: string; workspace: string; query: string; limit?: number }
  /** A workspace file's text, for the file viewer. */
  | { type: "file.read"; requestId: string; workspace: string; path: string }
  /** An image pasted or dropped in the composer, saved where Conductor can read it. */
  | { type: "attachment.save"; requestId: string; workspace: string; name: string; data: string }
  | { type: "status"; workspace: string }
  | { type: "approval"; id: string; allow: boolean; message?: string }
  | { type: "settings.get"; workspace: string }
  | { type: "settings.save"; workspace: string; scope: SettingsScope; values: SettingsValues }
  | {
      type: "settings.test"
      requestId: string
      workspace: string
      provider: ProviderId
      model: string
      reasoning: string
      trustWorkspace: boolean
    }

/** coordinator/merge.ts MergePreview, as plain data. */
export interface WorktreePreview {
  worktree: string
  branch?: string
  files: string[]
  conflicts: string[]
  appliesCleanly: boolean
  applyError?: string
  unmergedCommits: number
}

export interface ThreadCheckpoint {
  before: string
  after?: string
  cwd: string
}

export interface QueuedPrompt {
  id: string
  prompt: string
}

export interface ChatMeta {
  id: string
  workspace: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  turns: number
  /** Conductor's Claude session, resumed by the chat's next request. */
  sessionId?: string
  /** The worktree the chat runs in, when it was started in one. */
  runIn?: string
}

/** One message the UI was sent, with when (epoch ms). */
export interface ChatEvent {
  at: number
  msg: ServerMessage
}

export interface ChatHit {
  chat: ChatMeta
  snippet: string
}

export interface WorktreeList {
  /** The checked-out branch of the workspace. */
  current: string
  branches: string[]
  worktrees: { path: string; branch: string }[]
}

export interface UsageSummary {
  days: { day: string; costUsd: number; tokens: number }[]
  providers: Record<ProviderId, { costUsd: number; tokens: number; threads: number }>
  chats: number
  turns: number
  costUsd: number
  tokens: number
}

export interface AdvancedField {
  key: string
  group: string
  label: string
  type: "bool" | "int" | "number" | "list" | "string"
  nullable?: boolean
  min?: number
  max?: number
  help?: string
  value: boolean | number | string | string[] | null
}

export interface ProfileRow {
  name: string
  label: string
  description: string
  /** Conductor's own tier and effort. */
  tier: Tier
  reasoning: string
  guidance: string
  /** Per task class, the tier this profile sets (absent: the route's own). */
  routeTiers: Record<string, Tier>
  routePrimary: Record<string, ProviderId>
  /** Ships with the harness: can be changed, not deleted. */
  builtIn: boolean
}

export interface PromptTemplate {
  name: string
  scope: SettingsScope
  text: string
}

export interface RouteRow {
  taskClass: string
  agent: string
  primary: ProviderId | "self" | "auto_not_author"
  fallback: ProviderId[]
  tier: Tier
  minTier: Tier
}

export interface RouteEdit {
  taskClass: string
  primary: RouteRow["primary"]
  fallback: ProviderId[]
  tier: Tier
}

export interface RouteTest {
  taskClass: string
  provider?: ProviderId
  tier?: Tier
  model?: string
  agent?: string
  why: string[]
  error?: string
}

/** Spending limits the server enforces (null: none). `warnAt` is the share of a limit (or of a quota window) that warns. */
export interface BudgetLimits {
  chatUsd: number | null
  dayUsd: number | null
  warnAt: number
}

export interface BudgetState {
  limits: BudgetLimits
  chatUsd: number
  dayUsd: number
  over?: string
  near?: string
}

export interface IdeState {
  /** missing: nothing to run; installing: downloading openvscode-server; ready: can start; running: at `url`. */
  state: "missing" | "installing" | "ready" | "running"
  url?: string
  kind?: string
  /** Whether this app can download openvscode-server here (Linux). */
  canInstall: boolean
  progress?: string
  error?: string
}

export type Repeat = "none" | "hourly" | "daily" | "weekdays" | "weekly"

/** A prompt to send later. Without `chatId` it starts a new chat in `workspace`. */
export interface Schedule {
  id: string
  workspace: string
  chatId?: string
  prompt: string
  /** The next run, epoch ms. */
  at: number
  repeat: Repeat
  profile?: string
  permission: PermissionMode
  createdAt: number
  lastRun?: number
}

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  command: string
  running: boolean
}

export type CardColumn = "todo" | "doing" | "review" | "done"

export interface Card {
  id: string
  title: string
  notes: string
  column: CardColumn
  /** The chat that ran this card, once run. */
  chatId?: string
  createdAt: number
  updatedAt: number
}

/** The workspace's uncommitted changes against HEAD. */
export interface GitStats {
  branch: string
  added: number
  removed: number
  files: number
}

export interface ProfileInfo {
  name: string
  label: string
  description: string
}

export interface BackendStatus {
  health: Record<ProviderId, ProviderHealth>
  /** Live subscription usage windows, as last reported by each CLI. */
  quota: QuotaSnapshot
  executables: Record<ProviderId, string>
  profiles: ProfileInfo[]
  defaultProfile?: string
  /** Subscription presets, and the plan the config sets (described), if any. */
  plans: ProfileInfo[]
  configuredPlan?: string
  /** Undefined outside a git checkout. */
  git?: GitStats
}

/** Server → UI. Bridge messages are forwarded as-is. */
export type ServerMessage =
  | { type: "hello"; version: string; cwd: string }
  | { type: "status"; workspace: string; backends: BackendStatus }
  | {
      type: "turn.started"
      turnId: string
      /** The request this turn runs, so every window shows it when it actually starts (queued ones later). */
      prompt: string
      resumed: boolean /** Keywords in the message that changed routing, e.g. "economy profile". */
      mode?: string
    }
  | { type: "thread.diff"; requestId: string; patch: string; truncated: boolean; error?: string }
  | { type: "thread.reverted"; requestId: string; ok: boolean; message: string; files: string[] }
  | { type: "worktree.result"; requestId: string; ok: boolean; message: string; preview?: WorktreePreview }
  /** Requests waiting for the current turn. `paused` after a cancelled turn: nothing starts until the user says. */
  | { type: "queue"; items: QueuedPrompt[]; paused: boolean }
  | { type: "conductor"; turnId: string; event: WireEvent }
  | { type: "turn.finished"; turnId: string; ok: boolean; error?: string }
  | { type: "error"; message: string }
  | { type: "chats"; items: ChatMeta[] }
  /** The chat requests now go to (a new one is created by its first request); undefined after a reset. */
  | { type: "chat.current"; chat?: ChatMeta }
  /** A reopened chat's messages, oldest first, to render as they were. */
  | { type: "chat.replay"; chat: ChatMeta; events: ChatEvent[]; running: boolean }
  | { type: "chats.found"; requestId: string; hits: ChatHit[] }
  /** A side question (/btw) or a catch-up summary is being answered by a fast model, outside Conductor's chat. */
  | { type: "quick.started"; id: string; kind: "side" | "catchup"; question?: string; chatId?: string }
  | { type: "side.answer"; id: string; question: string; text: string; error?: string; chatId?: string }
  | { type: "catchup"; id: string; text: string; error?: string; chatId?: string }
  | { type: "files.listed"; requestId: string; files: string[] }
  | { type: "file.content"; requestId: string; path: string; text: string; truncated: boolean; mtime?: number; error?: string }
  | { type: "file.saved"; requestId: string; path: string; mtime?: number; error?: string }
  | { type: "export.saved"; requestId: string; path: string; error?: string }
  | { type: "worktrees"; requestId: string; list?: WorktreeList }
  | { type: "schedules"; items: Schedule[] }
  | { type: "board"; workspace: string; cards: Card[] }
  | { type: "terminals"; items: TerminalInfo[] }
  | { type: "term.opened"; requestId: string; terminal?: TerminalInfo; error?: string }
  | { type: "term.output"; id: string; data: string }
  | { type: "term.scrollback"; id: string; data: string }
  | { type: "term.exit"; id: string; code: number | null }
  | { type: "file.imaged"; requestId: string; dataUrl?: string; error?: string }
  | { type: "chat.markdowned"; requestId: string; text?: string; title?: string; error?: string }
  | { type: "usage"; requestId: string; summary: UsageSummary }
  | { type: "ide"; ide: IdeState }
  /** A turn's own checkpoints: the whole turn's changes (Conductor's and its threads') to review or revert. */
  | { type: "turn.checkpoint"; turnId: string; checkpoint: ThreadCheckpoint }
  | { type: "turn.restored"; requestId: string; ok: boolean; message: string; files: string[]; undo?: string }
  | { type: "budget"; budget: BudgetState }
  | { type: "routing"; requestId: string; routes: RouteRow[]; profiles: string[]; error?: string }
  | { type: "routing.saved"; requestId: string; path?: string; error?: string }
  | { type: "route.tested"; requestId: string; result: RouteTest }
  | { type: "templates"; items: PromptTemplate[] }
  | { type: "advanced"; requestId: string; fields: AdvancedField[]; error?: string }
  | { type: "profiles"; requestId: string; profiles: ProfileRow[]; defaultProfile?: string; classes: string[]; error?: string }
  /** A settings write (advanced, profiles): where it went, or why not. */
  | { type: "config.saved"; requestId: string; path?: string; error?: string }
  | { type: "attachment.saved"; requestId: string; path: string; error?: string }
  | { type: "settings"; snapshot: SettingsSnapshot; options: Record<ProviderId, BackendOptions> }
  | { type: "settings.saved"; path: string; shadowed: string[]; snapshot: SettingsSnapshot }
  | { type: "settings.error"; message: string }
  | ({ type: "settings.tested"; requestId: string } & ModelTest)
  | BridgeMessage
