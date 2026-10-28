# Configuration

Configuration is YAML, validated by `src/config/schema.ts`. Three layers are merged key by key, later winning:

1. The shipped `agent-harness-prompts/config/routing.yaml`. It is the full annotated reference.
2. Your user file: `~/.config/agent-router/routing.yaml` (Linux), `%APPDATA%\agent-router\routing.yaml` (Windows), `~/Library/Application Support/agent-router/routing.yaml` (macOS).
3. The project file `<workspace>/.harness/routing.yaml`.

The desktop app's **Models** dialog writes to the user or project file. Run `agent-router doctor` to see which files were loaded and whether they validate.

## `backends`

One entry per CLI: `claude`, `gemini`, `openai` (Codex).

| Key | Meaning |
|---|---|
| `executable` | Command to run (`claude`, `gemini`, `codex`). |
| `tiers.fast / standard / deep` | Model per tier. A placeholder like `<gemini-pro-model>`, or an empty value, means the CLI's default. |
| `reasoning.<tier>` | Effort per tier: Claude `--effort`, Codex `model_reasoning_effort`. Gemini ignores it. |
| `strengths`, `max_context_tokens`, `multimodal` | Used by routing (large inputs, media). |
| `trust_workspace` | Gemini only: run in folders Gemini has not been told to trust. |
| `extra_args` | Appended to every invocation. |

## `routes`

One entry per task class:

```yaml
code.edit: { agent: worker, primary: claude, tier: standard, min_tier: standard, fallback: [openai], review: true }
```

| Key | Meaning |
|---|---|
| `agent` | Agent prompt from `agent-harness-prompts/prompts/agents/`, or `conductor` for work Conductor does itself. |
| `primary` | A provider, `self` (Conductor's own backend), or `auto_not_author` (any provider except the work's author; for reviews). |
| `tier`, `min_tier` | Starting tier, and the floor that no profile can go below. |
| `fallback` | Providers to try, in order, when the primary fails. |
| `review` | `true`: always ask for an independent review. `when_escalated`: only when the work was raised to deep tier. |
| `second_opinion` | A provider that gets the same question independently (debugging, architecture). |

Shipped classes: `trivial`, `search.codebase`, `read.large`, `research.docs`, `plan`, `code.edit`, `code.tests`, `debug.hard`, `architecture`, `code.review`, `multimodal`, `docs.write`.

## `escalation`

| Key | Default | Meaning |
|---|---|---|
| `to_deep_when.files_touched_gt` | 5 | Raise to deep tier when a change touches more files than this. |
| `to_deep_when.previous_attempt_failed` | true | Raise after a failed attempt. |
| `to_deep_when.task_mentions` | — | Risk words (auth, security, payment, …). |
| `to_deep_when.classes` | `[code.edit]` | Task classes these triggers apply to. |
| `max_attempts_per_subtask` | 4 | Attempts across the whole escalation ladder. |

## `limits`

| Key | Default | Meaning |
|---|---|---|
| `max_parallel_agents` | 3 | Delegations running at once in a session. |
| `max_parallel_per_provider` | 2 | Delegations running at once on one backend. |
| `parallel_writers_need_worktree` | true | Parallel edit delegates must use `isolation: "worktree"`. |
| `delegate_timeout_seconds` | 900 | Hard limit per attempt. |
| `delegate_stall_seconds` | 300 | Watchdog: stop an attempt that emits nothing for this long. |
| `max_identical_tool_calls` | 12 | Watchdog: stop an attempt that repeats the same tool call this many times in a row. |
| `backend_unhealthy_after_errors` | 2 | Consecutive errors before a backend is marked unhealthy. |

## `checks`

```yaml
checks:
  commands: ["npm run typecheck", "npm test"]
  timeout_seconds: 600
```

Shell commands run after every edit-mode delegation that ends `done` or `partial`, in the delegate's worktree if it had one. A non-zero exit becomes a `reject` finding with the end of the output. They run only under `acceptEdits` or `bypass`. Under `default`, Conductor gets a finding asking it to run them itself. Under `acceptEdits`, Claude edit delegates may run exactly these commands. A command containing parentheses is not added to the delegate's allow list, because Claude Code's rule syntax uses them.

## `budget`

| Key | Default | Meaning |
|---|---|---|
| `session_usd` | null | Spending cap for a session, from the CLIs' reported cost. Once it is spent, new delegations are refused and Conductor is told to ask you. |
| `warn_at_fraction` | 0.8 | Accepted but not used yet. |

## `privacy`

| Key | Meaning |
|---|---|
| `never_send` | Globs that may not leave the machine. A delegation whose brief exposes a matching file is refused. Shipped: `.env*`, `*.pem`, `*.key`, `secrets/**`. |
| `provider_restrictions.<provider>.deny_paths` | Globs a provider must not receive. Routing skips that provider for briefs that expose them. |

## `profiles` and `default_profile`

A profile sets Conductor's own tier and effort, adds Conductor rules (`guidance`), and applies an `overlay`. An overlay may change routes' `tier`, `fallback`, `review` and `second_opinion`, backends' `reasoning`, and the escalation triggers and attempt count. It cannot change `min_tier`, privacy or budget: a profile trades depth above the quality floor, never below it.

```yaml
profiles:
  thrifty:
    label: Thrifty
    description: Standard tier everywhere, no second opinions.
    conductor: { tier: standard }
    guidance: Do small lookups yourself.
    overlay:
      routes:
        plan: { tier: standard }
        debug.hard: { second_opinion: null }
      backends:
        openai: { reasoning: { deep: medium } }
```

You can pick a profile in the app's **Profile** menu, with `--profile <name>`, or with `@<name>` in a request. The keyword wins. Values you set yourself in the user or project file beat the profile's overlay.

## Request keywords

| Keyword | Effect |
|---|---|
| `@claude`, `@gemini`, `@codex` | Pin that backend for the request. |
| `/route <class> <provider>` (own line) | Pin one task class. |
| `@<profile>` | Use that profile for this request. |
| `ultrawork`, `ulw` (optionally followed by `:`) | Quality profile, and Conductor must finish the whole task and verify it before answering. |

Keywords inside fenced code blocks or inline code are ignored.
