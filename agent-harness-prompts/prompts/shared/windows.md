# Windows Rules (shared by all agents)

The harness runs natively on Windows. All three backend CLIs and every agent must follow these rules. Most cross-model failures on Windows come from Unix assumptions.

## Shell
- Default shell is **PowerShell 7** (`pwsh`). Write PowerShell, not bash, unless the harness tells you a POSIX shell (Git Bash, WSL) is active.
- Common translations:
  | Unix | PowerShell |
  |---|---|
  | `ls -la` | `Get-ChildItem -Force` |
  | `cat file` | `Get-Content file` |
  | `rm -rf dir` | `Remove-Item -Recurse -Force dir` (needs approval) |
  | `export X=1` | `$env:X = "1"` |
  | `cmd1 && cmd2` | `cmd1; if ($?) { cmd2 }` (or `&&` in pwsh 7+) |
  | `which x` | `Get-Command x` |
  | `grep -r` | use the harness Grep tool (ripgrep), not `Select-String` loops |
  | `touch f` | `New-Item f -ItemType File -Force` |
- Prefer the harness's own file tools (Read, Write, Edit, Glob, Grep) over shell commands for file work.
- Quote paths that may contain spaces: `"C:\Users\Jane Doe\project"`.
- Never run interactive commands that wait for input (editors, pagers, `git rebase -i`). Use non-interactive flags (`--no-pager`, `-y`, `--yes`) where safe.

## Paths
- Use absolute Windows paths in briefs and reports: `C:\work\app\src\index.ts`.
- In code and config inside the repo, keep the project's own convention (usually forward slashes in JS/TS imports).
- Be aware of the 260-character path limit; avoid deeply nested temp paths.
- Paths are case-insensitive on disk but may be case-sensitive in git and tooling. Match the exact case the repo uses.

## Files
- Preserve each file's existing line endings (CRLF or LF) and encoding. Do not convert a whole file when editing one line.
- New files: follow `.gitattributes` / `.editorconfig`; otherwise UTF-8 without BOM and LF for source code.
- Files can be locked by another process (editor, dev server, antivirus). If a write fails with "being used by another process", report it; do not loop.

## Processes
- Long-running processes (dev servers, watchers) must be started in the background through the harness, never in the foreground.
- To stop a process, use the harness's process tools or `Stop-Process -Id <pid>`, never kill by name broadly (`taskkill /IM node.exe /F` kills the user's other work).

## Environment
- Never print the full environment or `$env:` dump; it may contain secrets.
- Do not modify the registry, system PATH, execution policy, or Windows Defender settings. Ask the user to do it if needed.
