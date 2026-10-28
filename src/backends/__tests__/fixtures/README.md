# Adapter fixtures

All CLI output here is **recorded** from real runs on 2026-10-28.

| File                          | Source                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-stream.jsonl`         | Claude Code 2.1.312: `echo 'Reply with exactly: pong' \| claude -p --output-format stream-json --verbose --model haiku --strict-mcp-config`                         |
| `gemini-stream.jsonl`         | Gemini CLI 0.66.0, `gemini-3-flash-preview`, a run that calls `read_file` (`--output-format stream-json --approval-mode default --skip-trust`, in a scratch folder) |
| `gemini-quota.jsonl`          | Gemini CLI 0.66.0, `gemini-3-pro-preview` on a free-tier API key: quota error                                                                                       |
| `gemini-untrusted.stderr.txt` | Gemini CLI 0.66.0 stderr when run headless in an untrusted folder (exit code 55)                                                                                    |
| `codex-exec.jsonl`            | Codex CLI 0.165.0, default model `gpt-6-luna`, a run that executes `cat note.txt` (`codex exec --json --skip-git-repo-check --sandbox read-only -`)                 |
| `codex-mcp.jsonl`             | Codex CLI 0.165.0, the `mcp_tool_call` lines of a run calling the harness's `lsp` MCP server (`-c mcp_servers.lsp.command=… -c mcp_servers.lsp.args=[…]`)           |
| `codex-models.json`           | Codex CLI 0.165.0 `codex debug models`, pruned to the fields the adapter reads (the raw catalog also holds each model's base instructions, ~260 KB)                 |
| `codex-unauthorized.jsonl`    | Codex CLI 0.165.0 before login: reconnect noise, then a 401                                                                                                         |

`fake-cli.mjs` is a stand-in executable for process-level tests (stdin, exit codes, timeouts, process groups).
