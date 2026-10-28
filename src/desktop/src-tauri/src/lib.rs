use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent};

#[derive(Clone, serde::Serialize)]
struct ServerInfo {
    url: String,
    token: String,
}

/// The agent-router core (`agent-router serve`), owned by the app for its whole lifetime.
struct Core {
    info: Result<ServerInfo, String>,
    process: Mutex<Option<(Child, Option<ChildStdin>)>>,
}

#[tauri::command]
fn server_info(core: tauri::State<Core>) -> Result<ServerInfo, String> {
    core.info.clone()
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("no randomness for the session token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Apps started from a desktop launcher on macOS/Linux get a minimal PATH, which hides CLIs
/// installed under the user's home (claude, gemini, codex). Ask the login shell for the real one.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell).args(["-lc", "printf %s \"$PATH\""]).stdin(Stdio::null()).output().ok()?;
    let path = String::from_utf8(out.stdout).ok()?;
    (!path.trim().is_empty()).then_some(path)
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<String> {
    None
}

/// Development builds run the TypeScript core from the repository with the project's own Bun;
/// release builds run the compiled sidecar shipped next to the app, with the bundled prompts.
fn core_command(app: &tauri::AppHandle) -> Result<Command, String> {
    if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
        // The npm `bun` package names its binary bun.exe on every platform.
        let bun = repo.join("node_modules").join("bun").join("bin").join("bun.exe");
        if !bun.exists() {
            return Err(format!("{} not found; run `npm install` in the repository", bun.display()));
        }
        let mut command = Command::new(bun);
        command.arg(repo.join("src").join("cli.ts"));
        Ok(command)
    } else {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().ok_or("app executable has no parent folder")?;
        let name = if cfg!(windows) { "agent-router-core.exe" } else { "agent-router-core" };
        let mut command = Command::new(dir.join(name));
        let assets = app.path().resource_dir().map_err(|e| e.to_string())?.join("agent-harness-prompts");
        command.env("AGENT_ROUTER_ASSETS", assets);
        Ok(command)
    }
}

fn start_core(app: &tauri::AppHandle) -> Result<(ServerInfo, Child, ChildStdin), String> {
    let token = random_token()?;
    let mut command = core_command(app)?;
    command
        .args(["serve", "--port", "0"])
        // Passed by environment, not argv, so other local users cannot read it from the process list.
        .env("AGENT_ROUTER_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(path) = login_shell_path() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("could not start the agent-router core: {e}"))?;
    let stdin = child.stdin.take().ok_or("core stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("core stdout unavailable")?;

    // The first stdout line announces the port; keep draining afterwards so the pipe never fills.
    let (ready_tx, ready_rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        if let Some(Ok(first)) = lines.next() {
            let _ = ready_tx.send(first);
        }
        for _ in lines {}
    });
    let line = match ready_rx.recv_timeout(Duration::from_secs(30)) {
        Ok(line) => line,
        Err(_) => {
            let _ = child.kill();
            return Err("the agent-router core did not report ready within 30 seconds".into());
        }
    };
    let ready: serde_json::Value = serde_json::from_str(&line).map_err(|e| format!("unexpected core output {line:?}: {e}"))?;
    let port = ready["port"].as_u64().ok_or_else(|| format!("core ready line has no port: {line}"))?;
    Ok((ServerInfo { url: format!("ws://127.0.0.1:{port}"), token }, child, stdin))
}

/// Closing stdin asks the core to cancel Conductor and exit; kill it if it has not within 3 seconds.
fn stop_core(core: &Core) {
    let Some((mut child, stdin)) = core.process.lock().ok().and_then(|mut p| p.take()) else { return };
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let core = match start_core(app.handle()) {
                Ok((info, child, stdin)) => Core { info: Ok(info), process: Mutex::new(Some((child, Some(stdin)))) },
                Err(error) => {
                    eprintln!("agent-router: {error}");
                    Core { info: Err(error), process: Mutex::new(None) }
                }
            };
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![server_info])
        .build(tauri::generate_context!())
        .expect("error while building the agent-router desktop app");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_core(&handle.state::<Core>());
        }
    });
}
