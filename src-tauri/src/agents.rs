//! Agents tool: structured turns from the local CLIs, and the Claude Code sessions on this PC.
//! Session listing uses `claude agents --json`, which Claude Code
//! documents as the way to read them from outside. Only that command's output is used: no hooks, nothing from
//! `~/.claude`, no sign-in.
//!
//! The CLI is found here, started with fixed arguments and no shell (so there is nothing to inject into), without a
//! console window, and ended after TIMEOUT. The page parses the text (src/features/agents/sessions.ts).
//! Errors are codes the page turns into text: not-found, too-old, timeout, too-big, busy, failed, and for a chat turn
//! also session-lost and `cli:<what the CLI said>`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const ARGS: [&str; 2] = ["agents", "--json"];
const TIMEOUT: Duration = Duration::from_secs(5);
/// A list of hundreds of sessions is a few hundred KB; more than this is not that.
const MAX_OUTPUT: usize = 1024 * 1024;
/// Codex reports every step of a turn on stdout, tool output included, so a long turn is far larger than its answer.
const MAX_CHAT_OUTPUT: usize = 16 * 1024 * 1024;
const CHAT_TIMEOUT: Duration = Duration::from_secs(600);
/// What is kept of the reason a CLI gives for failing.
const MAX_REASON: usize = 300;
/// Enough of stderr to tell an old CLI from a failing one.
const MAX_ERR: usize = 4096;
/// Once the process has ended, how long its pipes may still hand over the last bytes.
const GRACE: Duration = Duration::from_millis(300);

/// One run at a time; the page asks again only after an answer, this keeps a bug there from piling up processes.
static RUNNING: AtomicBool = AtomicBool::new(false);

struct Busy;

impl Drop for Busy {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn agents_list() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(list).await.map_err(|_| "failed".to_string())?.map_err(String::from)
}

fn list() -> Result<String, &'static str> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("busy");
    }
    let _busy = Busy;
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let found = candidates(std::env::var_os("PATH").as_deref(), home().as_deref(), appdata.as_deref());
    for exe in found.iter().filter(|p| p.is_file()) {
        match run(exe, &ARGS, TIMEOUT, MAX_OUTPUT) {
            // Listed but not startable (no right to run it): the next candidate may be the working one.
            Err("not-started") => continue,
            done => return done,
        }
    }
    Err("not-found")
}

/// The user's home folder, the same on Windows and a Mac.
fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Where `claude` may be, in the order a shell finds it: PATH first, then the folders the installers use. Those cover a
/// PC whose PATH, as this process got it, is older than the install (Crest starts with Windows), and a Mac app opened
/// from the Finder, which has no shell PATH. Only absolute folders: a relative one would depend on the working folder.
fn candidates(path: Option<&std::ffi::OsStr>, home: Option<&Path>, appdata: Option<&Path>) -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in search_dirs(path, home, appdata) {
        for name in names {
            let exe = dir.join(name);
            if !out.contains(&exe) {
                out.push(exe);
            }
        }
    }
    out
}

fn search_dirs(path: Option<&std::ffi::OsStr>, home: Option<&Path>, appdata: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
        if !cfg!(windows) {
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            dirs.push(home.join(".claude").join("local"));
            dirs.push(home.join(".npm-global").join("bin"));
        }
    }
    if let Some(appdata) = appdata.filter(|_| cfg!(windows)) {
        dirs.push(appdata.join("npm"));
    }
    dirs.retain(|d| d.is_absolute());
    dirs
}

/// A pipe read on its own thread, at most `cap` bytes of it kept.
struct Pipe {
    bytes: Mutex<Vec<u8>>,
    over: AtomicBool,
}

impl Pipe {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
    }
}

/// Past the cap the read stops (`stop_when_over`: the caller ends the process) or the rest is dropped (stderr, which
/// must still be emptied so the process never blocks on it).
fn drain(mut src: impl Read + Send + 'static, cap: usize, stop_when_over: bool) -> (Arc<Pipe>, JoinHandle<()>) {
    let pipe = Arc::new(Pipe { bytes: Mutex::new(Vec::new()), over: AtomicBool::new(false) });
    let mine = pipe.clone();
    let reader = thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = src.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let mut bytes = mine.bytes.lock().unwrap_or_else(|e| e.into_inner());
            let room = cap.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..n.min(room)]);
            if n > room {
                mine.over.store(true, Ordering::SeqCst);
                if stop_when_over {
                    break;
                }
            }
        }
    });
    (pipe, reader)
}

/// The process, and on Windows the job that holds it: an npm `.cmd` shim runs node as a child, which ending the shim
/// alone would leave running.
struct Running {
    child: Child,
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl Running {
    fn kill(&mut self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.kill();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};

    /// Plain job, no limits: closing it ends nothing, so a finished run leaves no side effects. Only `kill` ends what it holds.
    pub struct Job(OwnedHandle);

    impl Job {
        /// None when Windows refuses (Crest itself sits in a job that forbids nesting); the process alone is ended then.
        pub fn hold(child: &std::process::Child) -> Option<Job> {
            unsafe {
                let job = OwnedHandle::from_raw_handle(CreateJobObjectW(None, None).ok()?.0);
                AssignProcessToJobObject(HANDLE(job.as_raw_handle()), HANDLE(child.as_raw_handle())).ok()?;
                Some(Job(job))
            }
        }

        pub fn kill(&self) {
            let _ = unsafe { TerminateJobObject(HANDLE(self.0.as_raw_handle()), 1) };
        }
    }
}

/// An old CLI has no `agents --json` and says so on stderr (Claude Code's own parser: "unknown option").
fn is_too_old(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    ["unknown option", "unknown command", "unknown argument", "unexpected argument"].iter().any(|p| s.contains(p))
}

fn run(exe: &Path, args: &[&str], timeout: Duration, cap: usize) -> Result<String, &'static str> {
    let mut cmd = Command::new(exe);
    // On Windows std starts a .cmd shim through cmd.exe and escapes its arguments itself; ours are fixed.
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Claude Code treats the working folder as a project, and cmd.exe looks there first for a bare command (the `node` of
    // an npm shim): the user's home, which other users cannot write to, not Temp. Without a home the folder is Crest's own.
    if let Some(home) = home() {
        cmd.current_dir(home);
    }
    #[cfg(windows)]
    crate::convert::hide_console(&mut cmd);
    #[cfg(target_os = "macos")]
    finder_path(&mut cmd, exe);

    let done = capture(cmd, None, timeout, cap)?;
    if !done.success {
        return Err(if is_too_old(&done.stderr) { "too-old" } else { "failed" });
    }
    Ok(done.stdout)
}

/// A Mac app opened from the Finder has no shell PATH, which a node script's `env node` needs.
#[cfg(target_os = "macos")]
fn finder_path(cmd: &mut Command, exe: &Path) {
    let mut dirs: Vec<PathBuf> = exe.parent().map(Path::to_path_buf).into_iter().collect();
    dirs.extend(std::env::var_os("PATH").iter().flat_map(std::env::split_paths));
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    if let Ok(path) = std::env::join_paths(dirs) {
        cmd.env("PATH", path);
    }
}

/// A process that ended by itself, and what it wrote.
struct Finished {
    success: bool,
    stdout: String,
    stderr: String,
}

fn capture(cmd: Command, input: Option<String>, timeout: Duration, cap: usize) -> Result<Finished, &'static str> {
    capture_progress(cmd, input, timeout, cap, None, |_| {})
}

// A byte cursor keeps partial JSON/UTF-8 in the pipe until a whole line is available.
fn new_lines(pipe: &Pipe, offset: &mut usize, final_read: bool) -> String {
    let bytes = pipe.bytes.lock().unwrap_or_else(|e| e.into_inner());
    let unread = &bytes[*offset..];
    let count = if final_read { unread.len() } else { unread.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1) };
    let text = String::from_utf8_lossy(&unread[..count]).into_owned();
    *offset += count;
    text
}

fn capture_progress(mut cmd: Command, input: Option<String>, timeout: Duration, cap: usize, cancel: Option<&AtomicBool>, mut progress: impl FnMut(&str)) -> Result<Finished, &'static str> {
    let mut child = cmd.spawn().map_err(|_| "not-started")?;
    let stdout = child.stdout.take().ok_or("failed")?;
    let stderr = child.stderr.take().ok_or("failed")?;
    #[cfg(windows)]
    let job = job::Job::hold(&child);
    let mut running = Running {
        child,
        #[cfg(windows)]
        job,
    };
    let (out, out_reader) = drain(stdout, cap, true);
    let (err, err_reader) = drain(stderr, MAX_ERR, false);
    if let (Some(mut stdin), Some(input)) = (running.child.stdin.take(), input) {
        thread::spawn(move || { let _ = stdin.write_all(input.as_bytes()); });
    }

    let deadline = Instant::now() + timeout;
    let mut offset = 0;
    let status = loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            running.kill();
            return Err("cancelled");
        }
        let lines = new_lines(&out, &mut offset, false);
        if !lines.is_empty() { progress(&lines); }
        if out.over.load(Ordering::SeqCst) {
            running.kill();
            return Err("too-big");
        }
        match running.child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                running.kill();
                return Err("timeout");
            }
            Err(_) => {
                running.kill();
                return Err("failed");
            }
        }
    };
    // The readers end with the pipes. Something the CLI started and left running can hold a pipe open: wait a moment,
    // then take what arrived rather than waiting for it.
    let until = Instant::now() + GRACE;
    while !(out_reader.is_finished() && err_reader.is_finished()) && Instant::now() < until {
        thread::sleep(Duration::from_millis(10));
    }
    // A process that still holds this run's pipes after the CLI has exited is a leftover of the run; ending the job closes
    // the pipes, or both readers would wait for it, and a poll every few seconds would add two such threads each time.
    #[cfg(windows)]
    if !(out_reader.is_finished() && err_reader.is_finished()) {
        if let Some(job) = &running.job {
            job.kill();
        }
    }
    if out.over.load(Ordering::SeqCst) {
        return Err("too-big");
    }
    let lines = new_lines(&out, &mut offset, true);
    if !lines.is_empty() { progress(&lines); }
    Ok(Finished { success: status.success(), stdout: out.text(), stderr: err.text() })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Gemini,
}

/// Turns running at once: request id, the project folder (normalised) and the cancel flag. One per project, a few in all.
static ACTIVE_TURNS: Mutex<Vec<(String, String, Arc<AtomicBool>)>> = Mutex::new(Vec::new());
const MAX_TURNS: usize = 4;

struct Turn(String);

impl Drop for Turn {
    fn drop(&mut self) {
        let mut active = ACTIVE_TURNS.lock().unwrap_or_else(|error| error.into_inner());
        active.retain(|(id, _, _)| id != &self.0);
    }
}

/// The same folder however it is written: case (Windows), separators and a trailing one.
fn folder_key(cwd: &str) -> String {
    cwd.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// What the page gets while a turn runs: the thinking so far and the reply so far.
#[derive(serde::Serialize, Clone, PartialEq, Default)]
pub struct Progress {
    thinking: String,
    text: String,
}

#[tauri::command]
pub fn agents_cancel(request_id: String) -> bool {
    let active = ACTIVE_TURNS.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((_, _, cancelled)) = active.iter().find(|(id, _, _)| id == &request_id) {
        cancelled.store(true, Ordering::SeqCst);
        return true;
    }
    false
}

const PROJECTS_FILE: &str = "agent-projects.json";
const MAX_PROJECTS_FILE: usize = 32 * 1024 * 1024;

fn projects_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::portable::app_data_dir(app).map(|dir| dir.join(PROJECTS_FILE)).map_err(|_| "app-data".to_string())
}

/// The saved projects of the chat as the page wrote them, or nothing if there is no file yet.
#[tauri::command]
pub fn agents_projects_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = projects_path(&app)?;
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() as usize > MAX_PROJECTS_FILE => return Err("too-big".into()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("failed".into()),
    }
    std::fs::read_to_string(path).map(Some).map_err(|_| "failed".to_string())
}

/// Written whole, through a temporary file, so a crash in the middle leaves the old copy.
#[tauri::command]
pub fn agents_projects_save(app: tauri::AppHandle, data: String) -> Result<(), String> {
    if data.len() > MAX_PROJECTS_FILE { return Err("too-big".into()); }
    let path = projects_path(&app)?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|_| "failed".to_string())?; }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, data).map_err(|_| "failed".to_string())?;
    std::fs::rename(&temp, &path).map_err(|_| "failed".to_string())
}

/// `session` continues that conversation in the CLI itself, which then needs only the new message.
#[tauri::command]
pub async fn agents_chat(agent: Agent, cwd: String, model: String, effort: String, prompt: String, session: Option<String>, request_id: String, allow_edits: Option<bool>, progress: tauri::ipc::Channel<Progress>) -> Result<AgentReply, String> {
    if !valid_session(&request_id) { return Err("invalid-input".into()); }
    let cancelled = Arc::new(AtomicBool::new(false));
    let turn = {
        let mut active = ACTIVE_TURNS.lock().unwrap_or_else(|error| error.into_inner());
        let key = folder_key(&cwd);
        // One agent per project at a time (two would write over each other's files), and a few in all.
        if active.len() >= MAX_TURNS || active.iter().any(|(id, folder, _)| folder == &key || id == &request_id) { return Err("busy".into()); }
        active.push((request_id.clone(), key, cancelled.clone()));
        Turn(request_id)
    };
    let allow_edits = allow_edits.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = turn;
        chat(agent, cwd, model, effort, prompt, session, allow_edits, progress, &cancelled)
    }).await.map_err(|_| "failed".to_string())?
}

fn chat(agent: Agent, cwd: String, model: String, effort: String, prompt: String, session: Option<String>, allow_edits: bool, progress: tauri::ipc::Channel<Progress>, cancelled: &AtomicBool) -> Result<AgentReply, String> {
    if !matches!(effort.as_str(), "low" | "medium" | "high")
        || model.is_empty() || model.len() > 100 || !model.bytes().all(|c| c.is_ascii_alphanumeric() || b"-._".contains(&c))
        || prompt.trim().is_empty() || prompt.encode_utf16().count() > 12_000 || prompt.contains('\0')
        || session.as_deref().is_some_and(|id| !valid_session(id))
    {
        return Err("invalid-input".into());
    }
    let cwd = PathBuf::from(cwd);
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("invalid-directory".into());
    }
    if cancelled.load(Ordering::SeqCst) { return Err("cancelled".into()); }
    let executable = chat_executable(&agent).ok_or("not-found")?;
    let mut command = Command::new(&executable);
    command.current_dir(cwd).args(chat_args(&agent, &model, &effort, session.as_deref(), allow_edits))
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        crate::convert::hide_console(&mut command);
        // cmd.exe looks in the working folder first for the `node` of an npm shim, and here that folder is a project,
        // which may well carry one.
        if executable.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("cmd")) {
            command.env("NoDefaultCurrentDirectoryInExePath", "1");
        }
    }
    #[cfg(target_os = "macos")]
    finder_path(&mut command, &executable);
    let input = match agent {
        Agent::Claude | Agent::Codex => {
            command.stdin(Stdio::piped());
            Some(prompt)
        }
        Agent::Gemini => {
            command.arg(format!("--prompt={prompt}")).stdin(Stdio::null());
            None
        }
    };
    let mut thinking = Thinking::default();
    let mut connected = true;
    let done = capture_progress(command, input, CHAT_TIMEOUT, MAX_CHAT_OUTPUT, Some(cancelled), |lines| {
        let before = (thinking.text.len(), thinking.reply.len());
        for line in lines.lines() { thinking.read(&agent, line); }
        if connected && before != (thinking.text.len(), thinking.reply.len()) {
            connected = progress.send(Progress { thinking: thinking.text.clone(), text: thinking.reply.clone() }).is_ok();
        }
    })?;
    if cancelled.load(Ordering::SeqCst) { return Err("cancelled".into()); }
    if !done.success {
        return Err(chat_failure(&done.stdout, &done.stderr));
    }
    answer(&agent, &done.stdout).ok_or_else(|| reason(&done.stdout).map_or("no-response".to_string(), |text| format!("cli:{text}")))
}

/// Goes on a command line, so it must not read as an option. Both CLIs use UUIDs; this allows for a change of format.
fn valid_session(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && !id.starts_with('-') && id.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
}

/// Everything but the prompt. A session is only continued on the CLIs that report one, so never on Antigravity.
/// `allow_edits`: a retry after the CLI refused an action; Claude may then change files without asking. Commands still need
/// a yes. The other CLIs already work in a sandbox that allows writing in the project.
fn chat_args(agent: &Agent, model: &str, effort: &str, session: Option<&str>, allow_edits: bool) -> Vec<String> {
    let reasoning = format!("model_reasoning_effort=\"{effort}\"");
    let args: Vec<&str> = match (agent, session) {
        (Agent::Claude, session) => {
            let mut args = vec!["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", if allow_edits { "acceptEdits" } else { "default" },
                "--permission-prompts", "none", "--model", model, "--effort", effort,
                // The user's MCP servers add tens of thousands of tokens to every turn, and a chat turn does not use them.
                "--strict-mcp-config"];
            if let Some(id) = session {
                args.extend(["--resume", id]);
            }
            args
        }
        (Agent::Codex, None) => vec!["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write",
            "--model", model, "-c", &reasoning, "-"],
        // `exec resume` has no --sandbox option; the setting is the same one under its config name.
        (Agent::Codex, Some(id)) => vec!["exec", "resume", "--json", "--skip-git-repo-check", "--model", model,
            "-c", &reasoning, "-c", "sandbox_mode=\"workspace-write\"", id, "-"],
        // The user's own settings.json may pick another provider (a "gemini" one asks for an API key, or a local proxy). A turn here
        // wants the default backend with the models Crest lists, so that key is cleared for this run only; nothing is saved.
        (Agent::Gemini, _) => vec!["--output-format", "json", "--model", model, "--effort", effort, "--sandbox",
            "--settings", "{\"modelProvider\":\"\"}"],
    };
    args.into_iter().map(str::to_owned).collect()
}

/// A CLI that exited with an error: a session it no longer has is for the page to start over, the rest is for the user.
fn chat_failure(stdout: &str, stderr: &str) -> String {
    let lowered = stderr.to_ascii_lowercase();
    if lowered.contains("no conversation found") || lowered.contains("no rollout found") {
        return "session-lost".into();
    }
    if is_too_old(stderr) {
        return "too-old".into();
    }
    reason(stdout).or_else(|| first_line(stderr)).map_or("failed".to_string(), |text| format!("cli:{text}"))
}

/// The reason in a turn's structured output: Codex's last `turn.failed` or `error` event, Claude's error result.
fn reason(stdout: &str) -> Option<String> {
    use serde_json::Value;
    let text = stdout.lines().rev().filter_map(|line| serde_json::from_str::<Value>(line).ok()).find_map(|event| {
        match event["type"].as_str() {
            Some("turn.failed") => event["error"]["message"].as_str().map(str::to_owned),
            Some("error") => event["message"].as_str().map(str::to_owned),
            _ if event["is_error"] == true => event["result"].as_str().map(str::to_owned),
            _ => None,
        }
    })?;
    first_line(&text)
}

fn first_line(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(line.chars().take(MAX_REASON).collect())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReply {
    text: String,
    thinking: String,
    tokens: Option<u64>,
    permission_denied: bool,
    session: Option<String>,
}

fn answer(agent: &Agent, output: &str) -> Option<AgentReply> {
    use serde_json::Value;
    let (text, usage, permission_denied, session) = match agent {
        Agent::Codex => {
            let mut text = None;
            let mut usage = Value::Null;
            let mut session = None;
            for event in output.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()) {
                match event["type"].as_str() {
                    Some("thread.started") => session = event["thread_id"].as_str().map(str::to_owned),
                    Some("item.completed") if event["item"]["type"] == "agent_message" => {
                        text = event["item"]["text"].as_str().map(str::to_owned);
                    }
                    Some("turn.completed") => usage = event["usage"].clone(),
                    _ => {}
                }
            }
            (text?, usage, false, session)
        }
        Agent::Claude | Agent::Gemini => {
            let result: Value = serde_json::from_str(output).ok().or_else(|| output.lines().rev()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .find(|event| event["type"] == "result"))?;
            if result["is_error"] == true || result["status"] == "ERROR" {
                return None;
            }
            let field = if matches!(agent, Agent::Claude) { "result" } else { "response" };
            let denied = result["permission_denials"].as_array().is_some_and(|entries| !entries.is_empty());
            let session = if matches!(agent, Agent::Claude) { result["session_id"].as_str().map(str::to_owned) } else { None };
            (result[field].as_str()?.to_owned(), result["usage"].clone(), denied, session)
        }
    };
    let tokens = usage["total_tokens"].as_u64().or_else(|| {
        let count = usage["input_tokens"].as_u64()?.saturating_add(usage["output_tokens"].as_u64()?);
        Some(count.saturating_add(usage["cache_read_input_tokens"].as_u64().unwrap_or(0))
            .saturating_add(usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)))
    });
    let session = session.filter(|id| valid_session(id));
    let mut thinking = Thinking::default();
    if matches!(agent, Agent::Gemini) { thinking.read(agent, output); }
    else { for line in output.lines() { thinking.read(agent, line); } }
    (!text.trim().is_empty()).then_some(AgentReply { text, thinking: thinking.text, tokens, permission_denied, session })
}

/// Only explicitly published thinking/reasoning text, never tool output, signatures or encrypted blocks.
#[derive(Default)]
struct Thinking {
    text: String,
    /// The answer as far as it has come (the current message of the turn), to show it while it is written.
    reply: String,
    streamed_message: bool,
}

impl Thinking {
    fn append(&mut self, text: &str, separate: bool) {
        const CAP: usize = 24_000;
        let room = CAP.saturating_sub(self.text.len());
        if room == 0 || text.is_empty() { return; }
        let text = if separate && !self.text.is_empty() { format!("\n\n{text}") } else { text.to_owned() };
        let mut end = text.len().min(room);
        while !text.is_char_boundary(end) { end -= 1; }
        self.text.push_str(&text[..end]);
    }

    fn append_reply(&mut self, text: &str) {
        const CAP: usize = 60_000;
        let room = CAP.saturating_sub(self.reply.len());
        let mut end = text.len().min(room);
        while !text.is_char_boundary(end) { end -= 1; }
        self.reply.push_str(&text[..end]);
    }

    fn read(&mut self, agent: &Agent, line: &str) {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { return; };
        match agent {
            Agent::Codex if event["type"] == "item.completed" && event["item"]["type"] == "reasoning" => {
                if let Some(text) = event["item"]["text"].as_str() { self.append(text, true); }
            }
            Agent::Codex if event["type"] == "item.completed" && event["item"]["type"] == "agent_message" => {
                self.reply.clear();
                if let Some(text) = event["item"]["text"].as_str() { self.append_reply(text); }
            }
            Agent::Claude if event["parent_tool_use_id"].is_null() => {
                let part = &event["event"];
                if part["type"] == "message_start" { self.streamed_message = false; self.reply.clear(); }
                if part["type"] == "content_block_delta" && part["delta"]["type"] == "text_delta" {
                    self.append_reply(part["delta"]["text"].as_str().unwrap_or(""));
                }
                if part["type"] == "content_block_start" && part["content_block"]["type"] == "thinking" {
                    self.streamed_message = true;
                    if !self.text.is_empty() { self.append("\n\n", false); }
                    self.append(part["content_block"]["thinking"].as_str().unwrap_or(""), false);
                }
                if part["type"] == "content_block_delta" && part["delta"]["type"] == "thinking_delta" {
                    self.streamed_message = true;
                    self.append(part["delta"]["thinking"].as_str().unwrap_or(""), false);
                }
                if event["type"] == "assistant" && !self.streamed_message {
                    if let Some(blocks) = event["message"]["content"].as_array() {
                        for block in blocks.iter().filter(|b| b["type"] == "thinking") {
                            self.append(block["thinking"].as_str().unwrap_or(""), true);
                        }
                    }
                }
            }
            Agent::Gemini => {
                if let Some(text) = event["thinking"].as_str().or_else(|| event["reasoning"].as_str()) { self.append(text, true); }
            }
            _ => {}
        }
    }
}

fn chat_executable(agent: &Agent) -> Option<PathBuf> {
    let stem = match agent { Agent::Claude => "claude", Agent::Codex => "codex", Agent::Gemini => "agy" };
    let names = chat_names(agent, stem);
    let path = std::env::var_os("PATH");
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let mut dirs = search_dirs(path.as_deref(), home().as_deref(), appdata.as_deref());
    dirs.extend(match agent {
        Agent::Claude => appdata.map(|p| p.join("npm/node_modules/@anthropic-ai/claude-code/bin")),
        Agent::Codex => local.map(|p| p.join("Microsoft/WindowsApps")),
        Agent::Gemini => local.map(|p| p.join("agy/bin")),
    });
    dirs.iter().flat_map(|dir| names.iter().map(move |name| dir.join(name))).find(|p| p.is_absolute() && p.is_file())
        .or_else(|| match agent {
            #[cfg(windows)]
            Agent::Codex => store_codex_cli(),
            _ => None,
        })
}

/// An npm install leaves only a `.cmd` shim, and cmd.exe would read a prompt on the command line as commands: a shim is
/// fine for the CLIs that get the prompt on stdin, never for the one that gets it as an argument.
fn chat_names(agent: &Agent, stem: &str) -> Vec<String> {
    if !cfg!(windows) {
        return vec![stem.to_owned()];
    }
    let mut names = vec![format!("{stem}.exe")];
    if !matches!(agent, Agent::Gemini) {
        names.push(format!("{stem}.cmd"));
    }
    names
}

/// The Store app bundles the CLI in its resources without putting it on PATH. Windows hides the listing of that folder,
/// but the registry names the installed packages for any user, whether or not the app is running.
#[cfg(windows)]
fn store_codex_cli() -> Option<PathBuf> {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ};

    const PACKAGES: &str = r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
    let windows_apps = PathBuf::from(std::env::var_os("ProgramFiles")?).join("WindowsApps");
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(PACKAGES), Some(0), KEY_READ, &mut key) } != ERROR_SUCCESS {
        return None;
    }
    let mut found = Vec::new();
    for index in 0.. {
        let mut buffer = [0u16; 520];
        let mut length = buffer.len() as u32;
        match unsafe { RegEnumKeyExW(key, index, Some(PWSTR(buffer.as_mut_ptr())), &mut length, None, None, None, None) } {
            ERROR_SUCCESS => {}
            ERROR_MORE_DATA => continue,
            _ => break,
        }
        let name = String::from_utf16_lossy(&buffer[..length as usize]);
        if name.starts_with("OpenAI.Codex_") {
            found.push(name);
        }
    }
    let _ = unsafe { RegCloseKey(key) };
    found.iter().rev().map(|package| windows_apps.join(package).join("app/resources/codex.exe")).find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn progress_waits_for_complete_lines_and_keeps_split_utf8() {
        let pipe = Pipe { bytes: Mutex::new(Vec::new()), over: AtomicBool::new(false) };
        let mut offset = 0;
        let line = "{\"thinking\":\"ação\"}\n".as_bytes();
        let split = line.iter().position(|b| *b == 0xc3).unwrap() + 1;
        pipe.bytes.lock().unwrap().extend_from_slice(&line[..split]);
        assert_eq!(new_lines(&pipe, &mut offset, false), "");
        assert_eq!(offset, 0);
        pipe.bytes.lock().unwrap().extend_from_slice(&line[split..]);
        assert_eq!(new_lines(&pipe, &mut offset, false), String::from_utf8_lossy(line));
        assert_eq!(new_lines(&pipe, &mut offset, false), "");
        pipe.bytes.lock().unwrap().extend_from_slice(b"final");
        assert_eq!(new_lines(&pipe, &mut offset, false), "");
        assert_eq!(new_lines(&pipe, &mut offset, true), "final");
        assert_eq!(new_lines(&pipe, &mut offset, true), "");
    }

    #[test]
    fn claude_stream_keeps_result_and_thinking_without_snapshot_duplicates() {
        let output = r#"{"type":"stream_event","event":{"type":"message_start"}}
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking","thinking":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Checking "}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"the files"}}}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Checking the files"},{"type":"text","text":"private tool output"}]}}
{"type":"result","result":"Done","session_id":"session-1","usage":{"input_tokens":10,"output_tokens":2}}"#;
        let reply = answer(&Agent::Claude, output).unwrap();
        assert_eq!(reply.text, "Done");
        assert_eq!(reply.thinking, "Checking the files");
        assert_eq!(reply.session.as_deref(), Some("session-1"));
        assert_eq!(reply.tokens, Some(12));
        let snapshot = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Published thought"},{"type":"redacted_thinking","data":"secret"}]}}
{"type":"result","result":"Done"}"#;
        assert_eq!(answer(&Agent::Claude, snapshot).unwrap().thinking, "Published thought");
    }

    #[test]
    fn codex_thinking_does_not_include_tools_or_duplicate_updates() {
        let output = r#"{"type":"item.started","item":{"type":"reasoning","text":"Working"}}
{"type":"item.updated","item":{"type":"reasoning","text":"Working on it"}}
{"type":"item.completed","item":{"type":"reasoning","text":"Working on it"}}
{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"secret"}}
{"type":"item.completed","item":{"type":"reasoning","text":"Checked"}}
{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}"#;
        assert_eq!(answer(&Agent::Codex, output).unwrap().thinking, "Working on it\n\nChecked");
        let mut thinking = Thinking::default();
        thinking.append(&"🦀".repeat(10_000), false);
        assert!(thinking.text.len() <= 24_000);
        thinking.append("ignored", true);
        assert_eq!(thinking.text.len(), 24_000);
    }

    #[cfg(windows)]
    #[test]
    fn progress_receives_lines_before_the_process_exits_and_flushes_the_last_line() {
        let exe = shim("progress", "echo first\r\nping -n 3 127.0.0.1 >nul\r\n<nul set /p =last");
        let mut command = Command::new(exe);
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::convert::hide_console(&mut command);
        let start = Instant::now();
        let mut events = Vec::new();
        let result = capture_progress(command, None, Duration::from_secs(10), 1000, None, |line| events.push((start.elapsed(), line.to_owned()))).unwrap();
        assert_eq!(events.first().unwrap().1.trim(), "first");
        assert!(events.first().unwrap().0 < Duration::from_secs(1));
        assert_eq!(events.last().unwrap().1, "last");
        assert!(result.stdout.contains("first"));
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_ends_a_waiting_cli_and_allows_the_next_capture() {
        let exe = shim("cancel", "echo ready\r\nping -n 30 127.0.0.1 >nul");
        let mut command = Command::new(exe);
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        crate::convert::hide_console(&mut command);
        let cancelled = AtomicBool::new(false);
        let start = Instant::now();
        let result = capture_progress(command, None, Duration::from_secs(10), 1000, Some(&cancelled),
            |_| cancelled.store(true, Ordering::SeqCst));
        assert!(matches!(result, Err("cancelled")));
        assert!(start.elapsed() < Duration::from_secs(4));
        let next = shim("after-cancel", "echo next");
        assert!(run(&next, &ARGS, Duration::from_secs(5), MAX_OUTPUT).unwrap().contains("next"));
    }

    #[test]
    fn cancellation_targets_only_the_registered_turn() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let other = Arc::new(AtomicBool::new(false));
        *ACTIVE_TURNS.lock().unwrap() = vec![("current-turn".into(), "c:/a".into(), cancelled.clone()), ("other-turn".into(), "c:/b".into(), other.clone())];
        let turn = Turn("current-turn".into());
        assert!(!agents_cancel("old-turn".into()));
        assert!(!cancelled.load(Ordering::SeqCst));
        assert!(agents_cancel("current-turn".into()));
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(!other.load(Ordering::SeqCst));
        drop(turn);
        assert_eq!(ACTIVE_TURNS.lock().unwrap().len(), 1);
        ACTIVE_TURNS.lock().unwrap().clear();
        assert_eq!(folder_key("C:\\Dev\\App\\"), folder_key("c:/dev/app"));
    }

    #[test]
    fn extracts_structured_chat_replies_and_token_counts() {
        let codex = r#"{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}
{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":5}}"#;
        assert_eq!(answer(&Agent::Codex, codex).unwrap().tokens, Some(15));
        let claude = r#"{"result":"Done","usage":{"input_tokens":10,"cache_read_input_tokens":4,"output_tokens":5},"permission_denials":[{}]}"#;
        let reply = answer(&Agent::Claude, claude).unwrap();
        assert_eq!(reply.tokens, Some(19));
        assert!(reply.permission_denied);
        let gemini = r#"{"status":"SUCCESS","response":"Done","usage":{"total_tokens":20}}"#;
        let reply = answer(&Agent::Gemini, gemini).unwrap();
        assert_eq!(reply.text, "Done");
        assert_eq!(reply.tokens, Some(20));
        assert!(answer(&Agent::Gemini, r#"{"status":"ERROR","response":"Partial"}"#).is_none());
    }

    #[test]
    fn a_reply_carries_the_session_that_continues_it() {
        let id = "019a-b2_c";
        let codex = format!(r#"{{"type":"thread.started","thread_id":"{id}"}}
{{"type":"item.completed","item":{{"type":"agent_message","text":"Done"}}}}"#);
        assert_eq!(answer(&Agent::Codex, &codex).unwrap().session.as_deref(), Some(id));
        let claude = format!(r#"{{"result":"Done","session_id":"{id}"}}"#);
        assert_eq!(answer(&Agent::Claude, &claude).unwrap().session.as_deref(), Some(id));
        let unusable = r#"{"result":"Done","session_id":"--dangerous"}"#;
        assert_eq!(answer(&Agent::Claude, unusable).unwrap().session, None);
        let gemini = r#"{"response":"Done","session_id":"abc"}"#;
        assert_eq!(answer(&Agent::Gemini, gemini).unwrap().session, None);
    }

    #[test]
    fn a_session_id_cannot_become_an_option() {
        assert!(valid_session("8f3c1d2e-aaaa-4bbb-8ccc-0123456789ab"));
        for bad in ["", "-x", "--model", "a b", "a;b", "a\\b", &"x".repeat(101)] {
            assert!(!valid_session(bad), "{bad}");
        }
    }

    #[test]
    fn a_resumed_turn_keeps_the_sandbox_and_the_options_of_a_new_one() {
        let new = chat_args(&Agent::Codex, "m", "low", None, false);
        assert!(new.windows(2).any(|pair| pair == ["--sandbox", "workspace-write"]));
        let resumed = chat_args(&Agent::Codex, "m", "low", Some("id"), false);
        assert_eq!(&resumed[..2], ["exec", "resume"]);
        assert!(resumed.windows(2).any(|pair| pair == ["-c", "sandbox_mode=\"workspace-write\""]));
        assert_eq!(&resumed[resumed.len() - 2..], ["id", "-"]);

        let claude = chat_args(&Agent::Claude, "m", "low", Some("id"), false);
        assert!(claude.windows(2).any(|pair| pair == ["--resume", "id"]));
        assert!(claude.windows(2).any(|pair| pair == ["--permission-mode", "default"]));
        assert!(claude.contains(&"--strict-mcp-config".to_string()));
        assert!(!chat_args(&Agent::Claude, "m", "low", None, false).contains(&"--resume".to_string()));
        assert!(chat_args(&Agent::Claude, "m", "low", None, true).windows(2).any(|pair| pair == ["--permission-mode", "acceptEdits"]));
        assert!(!chat_args(&Agent::Gemini, "m", "low", Some("id"), false).contains(&"id".to_string()));
    }

    #[test]
    fn antigravity_ignores_the_provider_the_users_settings_pick() {
        let args = chat_args(&Agent::Gemini, "m", "low", None, false);
        assert!(args.windows(2).any(|pair| pair == ["--settings", "{\"modelProvider\":\"\"}"]));
    }

    #[test]
    fn a_failed_turn_says_why() {
        assert_eq!(chat_failure("", "No conversation found with session ID: x\n"), "session-lost");
        assert_eq!(chat_failure("", "Error: no rollout found for thread id x\n"), "session-lost");
        assert_eq!(chat_failure("", "error: unknown option '--effort'"), "too-old");
        let codex = r#"{"type":"thread.started","thread_id":"t"}
{"type":"turn.failed","error":{"message":"The 'm' model is not supported"}}"#;
        assert_eq!(chat_failure(codex, "noise"), "cli:The 'm' model is not supported");
        assert_eq!(chat_failure(r#"{"is_error":true,"result":"Not logged in"}"#, ""), "cli:Not logged in");
        assert_eq!(chat_failure("", "\n  Quota reached\nstack"), "cli:Quota reached");
        assert_eq!(chat_failure("", ""), "failed");
        assert_eq!(first_line(&"x".repeat(MAX_REASON + 5)).unwrap().len(), MAX_REASON);
    }

    #[test]
    fn only_a_prompt_on_stdin_may_pass_through_a_shim() {
        assert!(!chat_names(&Agent::Gemini, "agy").iter().any(|name| name.ends_with(".cmd")));
        if cfg!(windows) {
            assert_eq!(chat_names(&Agent::Codex, "codex"), ["codex.exe", "codex.cmd"]);
        }
    }

    #[test]
    fn candidates_follow_the_path_then_the_install_folders() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let (a, b, rel) = if cfg!(windows) { (r"C:\tools", r"D:\more", "bin") } else { ("/opt/tools", "/srv/more", "bin") };
        let path = OsString::from([a, rel, b, a, ""].join(sep));
        let home = if cfg!(windows) { PathBuf::from(r"C:\Users\me") } else { PathBuf::from("/Users/me") };
        let list = candidates(Some(&path), Some(&home), Some(Path::new(r"C:\Users\me\AppData\Roaming")));

        // Relative and empty entries are left out, a repeated folder counts once, the PATH keeps its order.
        assert!(list.iter().all(|p| p.is_absolute()));
        assert_eq!(list[0].parent().unwrap(), Path::new(a));
        let first_b = list.iter().position(|p| p.parent() == Some(Path::new(b))).unwrap();
        let first_home = list.iter().position(|p| p.starts_with(&home)).unwrap();
        assert!(first_b > 0 && first_b < first_home);
        assert_eq!(list.iter().filter(|p| p.parent() == Some(Path::new(a))).count(), if cfg!(windows) { 2 } else { 1 });
        assert!(list.iter().any(|p| p.starts_with(home.join(".local").join("bin"))));
        if cfg!(windows) {
            // .exe before .cmd in the same folder; the npm folder is only looked at on Windows.
            assert!(list[0].ends_with("claude.exe") && list[1].ends_with("claude.cmd"));
            assert!(list.iter().any(|p| p.ends_with(Path::new("npm").join("claude.cmd"))));
        } else {
            assert!(list.iter().any(|p| p.starts_with("/opt/homebrew/bin")));
            assert!(!list.iter().any(|p| p.ends_with(Path::new("npm").join("claude"))));
        }
        assert!(candidates(None, None, None).is_empty());
    }

    #[test]
    fn an_old_cli_is_told_from_a_failing_one() {
        assert!(is_too_old("error: unknown option '--json'\n"));
        assert!(is_too_old("Error: Unknown command 'agents'"));
        assert!(!is_too_old("Error: not logged in"));
        assert!(!is_too_old(""));
    }

    #[test]
    fn a_pipe_keeps_the_cap_and_says_when_it_was_passed() {
        let (pipe, reader) = drain(std::io::Cursor::new(vec![b'x'; 100]), 40, false);
        reader.join().unwrap();
        assert_eq!(pipe.text().len(), 40);
        assert!(pipe.over.load(Ordering::SeqCst));
        let (pipe, reader) = drain(std::io::Cursor::new(vec![b'x'; 40]), 40, true);
        reader.join().unwrap();
        assert_eq!(pipe.text().len(), 40);
        assert!(!pipe.over.load(Ordering::SeqCst));
    }

    /// Live, needs Claude Code on this PC: `cargo test --lib agents_live -- --ignored`
    #[test]
    #[ignore]
    fn agents_live() {
        let text = list().expect("claude agents --json");
        assert!(text.trim_start().starts_with('['), "not a JSON array");
    }

    /// A small .cmd shim in a folder of its own, the way npm installs the CLI.
    #[cfg(windows)]
    fn shim(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crest-agents-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("claude.cmd");
        std::fs::write(&file, format!("@echo off\r\n{body}\r\n")).unwrap();
        file
    }

    #[cfg(windows)]
    #[test]
    fn a_cmd_shim_answers_without_a_console_window() {
        let exe = shim("ok", r#"echo [{"cwd":"C:\\work","kind":"interactive","startedAt":1}]"#);
        let text = run(&exe, &ARGS, Duration::from_secs(5), MAX_OUTPUT).unwrap();
        assert!(text.trim().starts_with("[{") && text.contains("interactive"), "{text}");
    }

    #[cfg(windows)]
    #[test]
    fn a_failing_or_old_cli_gets_its_code() {
        let old = shim("old", "echo error: unknown option '--json' 1>&2\r\nexit /b 1");
        assert_eq!(run(&old, &ARGS, Duration::from_secs(5), MAX_OUTPUT), Err("too-old"));
        let broken = shim("broken", "echo not logged in 1>&2\r\nexit /b 3");
        assert_eq!(run(&broken, &ARGS, Duration::from_secs(5), MAX_OUTPUT), Err("failed"));
        assert_eq!(run(Path::new(r"C:\no\such\claude.exe"), &ARGS, Duration::from_secs(5), MAX_OUTPUT), Err("not-started"));
    }

    #[cfg(windows)]
    #[test]
    fn too_much_output_ends_the_process() {
        let exe = shim("big", "for /l %%i in (1,1,5000) do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        let started = Instant::now();
        assert_eq!(run(&exe, &ARGS, Duration::from_secs(5), 1000), Err("too-big"));
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    /// The shim's child (ping, holding the output pipe) must end with it, or the call would hang past the timeout.
    #[cfg(windows)]
    #[test]
    fn a_hung_cli_is_ended_with_what_it_started() {
        let exe = shim("hung", "ping -n 30 127.0.0.1");
        let started = Instant::now();
        assert_eq!(run(&exe, &ARGS, Duration::from_millis(800), MAX_OUTPUT), Err("timeout"));
        assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());
    }
}
