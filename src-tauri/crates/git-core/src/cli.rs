//! Runs the system `git` with argv, never through a shell.
//!
//! Used by the operations libgit2 does not cover (path history, the merge preview, the
//! worktree writes, the status) and by the tests that compare the engine with the CLI on
//! fixture repositories. The executable is `git` on PATH until the settings name another
//! ([`set_git_executable`]); [`detect_git`] finds one for them.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::GitDetection;

/// The executable every CLI call runs; `None` is `git` on PATH.
static GIT_EXECUTABLE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Ticket of the latest [`set_git_executable`] call: a slower, earlier probe must not
/// overwrite the executable a later call installed.
static SET_TICKET: AtomicU64 = AtomicU64::new(0);

/// How long a candidate has to answer `--version`: a program that is not git may never exit.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// The git executable the CLI runs now.
pub fn git_executable() -> PathBuf {
    GIT_EXECUTABLE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| PathBuf::from("git"))
}

/// Makes every later CLI call run `path`, once `<path> --version` has answered within
/// [`PROBE_TIMEOUT`]; a program that does not is refused ([`GitError::GitNotStarted`] when
/// it cannot start or answer, [`GitError::Cli`] when it is not git) and the executable in
/// use stays. A path with a folder in it is made absolute first (a relative one would
/// resolve against the process's working directory, which differs between a terminal and
/// the installed app); a bare name keeps PATH's meaning. `None` returns to `git` on PATH at
/// once and then reports its version. When two calls overlap, the later one wins whatever
/// order their probes finish in.
pub fn set_git_executable(path: Option<&Path>, cancel: &Cancel) -> GitResult<GitDetection> {
    let ticket = SET_TICKET.fetch_add(1, Ordering::SeqCst) + 1;
    let chosen = path.map(absolute_if_pathlike);
    let candidate = chosen.clone().unwrap_or_else(|| PathBuf::from("git"));
    if chosen.is_none() {
        install_executable(None);
    }
    let version = probe_git(&candidate, cancel)?;
    if chosen.is_some() && SET_TICKET.load(Ordering::SeqCst) == ticket {
        install_executable(chosen);
    }
    Ok(GitDetection {
        path: candidate,
        version,
    })
}

fn install_executable(path: Option<PathBuf>) {
    *GIT_EXECUTABLE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = path;
}

/// `C:\Git\cmd\git.exe` and `.\tools\git.exe` are paths (made absolute); `git` is a name.
fn absolute_if_pathlike(path: &Path) -> PathBuf {
    if path.components().count() > 1 {
        std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
    } else {
        path.to_path_buf()
    }
}

/// Runs `<candidate> --version` and returns its first line: [`GitError::GitNotStarted`] when
/// the program cannot be started or has not answered within [`PROBE_TIMEOUT`],
/// [`GitError::Cli`] when it fails or does not answer like git, [`GitError::Cancelled`] when
/// `cancel` flips meanwhile.
pub fn probe_git(candidate: &Path, cancel: &Cancel) -> GitResult<String> {
    probe_git_within(candidate, cancel, PROBE_TIMEOUT)
}

fn probe_git_within(candidate: &Path, cancel: &Cancel, deadline: Duration) -> GitResult<String> {
    let text = candidate.to_string_lossy().into_owned();
    let joined = format!("{text} --version");
    let mut command = Command::new(candidate);
    command.arg("--version");
    let exit = run_polled(command, joined.clone(), cancel, Some(deadline), None)?;
    if exit.status != Some(0) {
        return Err(GitError::Cli {
            command: joined,
            status: exit.status,
            stderr: exit.stderr,
        });
    }
    let first = String::from_utf8_lossy(&exit.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !first.starts_with("git version ") {
        return Err(GitError::Cli {
            command: joined,
            status: exit.status,
            stderr: format!("{text} is not git: it printed {first:?}"),
        });
    }
    Ok(first)
}

/// Looks for git: the configured executable, then `git` on PATH, then the platform's common
/// locations; the first one whose `--version` answers wins, each probe bounded by
/// [`PROBE_TIMEOUT`].
pub fn detect_git(cancel: &Cancel) -> GitResult<GitDetection> {
    let mut candidates = vec![git_executable(), PathBuf::from("git")];
    candidates.extend(common_locations());
    let mut seen: Vec<PathBuf> = Vec::with_capacity(candidates.len());
    let mut last = None;
    for candidate in candidates {
        if seen.contains(&candidate) {
            continue;
        }
        match probe_git(&candidate, cancel) {
            Ok(version) => {
                return Ok(GitDetection {
                    path: candidate,
                    version,
                })
            }
            Err(GitError::Cancelled) => return Err(GitError::Cancelled),
            Err(error) => last = Some(error),
        }
        seen.push(candidate);
    }
    Err(last.unwrap_or_else(|| GitError::GitNotStarted {
        command: "git --version".to_owned(),
        reason: "no git found".to_owned(),
    }))
}

/// Where installers put git when it is not on PATH.
fn common_locations() -> Vec<PathBuf> {
    let mut found = Vec::new();
    if cfg!(windows) {
        // Git for Windows: machine-wide under Program Files, per-user under
        // `%LOCALAPPDATA%\Programs`; scoop's shim under the profile. Always the `cmd`
        // launcher, never `bin\git.exe` or `mingw64\bin\git.exe` (hooks and aliases need
        // the launcher's environment).
        let launcher = |base: PathBuf| base.join("Git").join("cmd").join("git.exe");
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                found.push(launcher(PathBuf::from(base)));
            }
        }
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            found.push(launcher(PathBuf::from(base).join("Programs")));
        }
        if let Some(base) = std::env::var_os("USERPROFILE") {
            found.push(
                PathBuf::from(base)
                    .join("scoop")
                    .join("shims")
                    .join("git.exe"),
            );
        }
    } else if cfg!(target_os = "macos") {
        found.extend(
            [
                "/opt/homebrew/bin/git",
                "/usr/local/bin/git",
                "/usr/bin/git",
            ]
            .iter()
            .map(PathBuf::from),
        );
    } else {
        found.extend(
            ["/usr/bin/git", "/usr/local/bin/git"]
                .iter()
                .map(PathBuf::from),
        );
    }
    found
}

/// How often a cancellable run polls the flag while git works; also the latency between
/// git exiting and the caller learning it.
const CANCEL_POLL: Duration = Duration::from_millis(10);

/// `CREATE_NO_WINDOW`: a child process without a console of its own.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Captured output of a `git` invocation that exited successfully.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliOutput {
    /// Standard output, decoded as UTF-8 with replacement characters.
    pub stdout: String,
    /// Standard error, decoded the same way.
    pub stderr: String,
}

/// Environment variables that would redirect git away from `cwd`. They are set when the
/// process runs inside a git hook or a `git` alias, so they are always removed: the repository
/// a call targets is the `cwd` the caller chose, never an inherited one.
const REDIRECTING_VARS: [&str; 9] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_CEILING_DIRECTORIES",
];

/// The command `git <args>` in `cwd`, with the redirecting variables removed and stdin closed.
/// On Windows the process gets no console, so a GUI caller never flashes a black window.
pub fn command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(git_executable());
    command.args(args).current_dir(cwd);
    isolate(&mut command);
    command
}

/// Stdin closed, the redirecting variables removed, no console window on Windows, and on
/// Unix a process group of its own so that a cancel can stop what git started.
fn isolate(command: &mut Command) {
    command.stdin(Stdio::null());
    for var in REDIRECTING_VARS {
        command.env_remove(var);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

/// Stops a running git and what it started, without waiting for it.
///
/// On Windows the `git` on PATH is normally Git for Windows' launcher (`Git\cmd\git.exe`),
/// which runs the real `git.exe` as a child; killing the launcher alone leaves that child
/// working and holding the pipes (and running the launcher's real binary directly breaks
/// the hooks and aliases that need its shell), so the whole tree goes through `taskkill /T`
/// (argv, no shell) while the launcher is still alive, which is what lets it find the
/// children. That takes a tenth of a second, so it runs on a helper thread and the caller
/// returns at once: readers of the pipes end when the tree is gone and must not be joined
/// on the cancel path. On Unix git runs in a process group of its own (see [`isolate`]) and
/// the whole group is killed through `kill`, so a hook or an alias shell it started goes too.
pub(crate) fn abort(child: Child) {
    let slot = Arc::new(Mutex::new(Some(child)));
    let worker = Arc::clone(&slot);
    let spawned = thread::Builder::new()
        .name("begira-git-abort".to_owned())
        .spawn(move || {
            if let Some(child) = take_child(&worker) {
                stop_tree(child);
            }
        });
    if spawned.is_err() {
        if let Some(child) = take_child(&slot) {
            stop_tree(child);
        }
    }
}

fn take_child(slot: &Mutex<Option<Child>>) -> Option<Child> {
    slot.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

fn stop_tree(mut child: Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        // The group's id is the child's (it is the group leader); `--` keeps the negative
        // id from being read as an option.
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs `git <args>` in `cwd` and returns its output, or [`GitError::Cli`] when the process
/// could not be started or exited with a non-zero status.
///
/// The user's global and system configuration stay in effect, as they would on the command
/// line; callers that need isolation pass `-c` overrides.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?args))]
pub fn run_git(cwd: &Path, args: &[&str]) -> GitResult<CliOutput> {
    let joined = args.join(" ");
    let output = command(cwd, args)
        .output()
        .map_err(|error| GitError::GitNotStarted {
            command: joined.clone(),
            reason: error.to_string(),
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if output.status.success() {
        Ok(CliOutput { stdout, stderr })
    } else {
        Err(GitError::Cli {
            command: joined,
            status: output.status.code(),
            stderr,
        })
    }
}

/// The output of a `git` invocation whatever its status: the caller reads the code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliExit {
    /// Exit status code, `None` when the process was killed by a signal.
    pub status: Option<i32>,
    /// Standard output, raw bytes (NUL-separated formats keep their bytes).
    pub stdout: Vec<u8>,
    /// Standard error, decoded as UTF-8 with replacement characters.
    pub stderr: String,
}

/// Runs `git <args>` in `cwd` while polling `cancel` every [`CANCEL_POLL`]; a cancelled run
/// stops git (see [`abort`]) and returns [`GitError::Cancelled`] at once, without waiting
/// for the pipes: their reader threads end at end-of-file. Both pipes are drained by their
/// own threads so git never blocks on a full one. The exit status is returned, not judged:
/// callers that give a meaning to a non-zero status (`merge-tree` exits 1 on conflicts) read
/// it here. Only a git that could not be started is [`GitError::GitNotStarted`]; any later
/// failure of the run is [`GitError::Cli`] with `status: None`.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?args))]
pub fn run_git_cancellable(cwd: &Path, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    run_polled(command(cwd, args), args.join(" "), cancel, None, None)
}

/// The environment of a write that must never wait for a terminal or an editor: a
/// credential helper that needs one fails at once with git's message, and a merge, revert
/// or `--continue` that would open an editor takes the prepared message.
pub const WRITE_ENV: [(&str, &str); 3] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_EDITOR", "true"),
    ("GIT_SEQUENCE_EDITOR", "true"),
];

/// [`run_git_cancellable`] with extra environment variables (see [`WRITE_ENV`]).
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?args))]
pub fn run_git_env(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    cancel: &Cancel,
) -> GitResult<CliExit> {
    let mut command = command(cwd, args);
    command.envs(env.iter().copied());
    run_polled(command, args.join(" "), cancel, None, None)
}

/// [`run_git_env`] with git's stderr handed to `on_line` line by line as it arrives: the
/// progress of a fetch or a push (`--progress` writes `\r`-separated updates, so `\r` ends
/// a line as `\n` does). The whole stderr is still in the exit for the error message.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?args))]
pub fn run_git_streaming(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    on_line: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<CliExit> {
    let mut command = command(cwd, args);
    command.envs(env.iter().copied());
    run_polled_streaming(command, args.join(" "), cancel, on_line)
}

/// [`run_git_cancellable`] with `input` on git's stdin (a pathspec list, a commit message,
/// a patch), written from its own thread so that neither side blocks on a full pipe.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?args, input_bytes = input.len()))]
pub fn run_git_with_input(
    cwd: &Path,
    args: &[&str],
    input: Vec<u8>,
    cancel: &Cancel,
) -> GitResult<CliExit> {
    run_polled(
        command(cwd, args),
        args.join(" "),
        cancel,
        None,
        Some(input),
    )
}

/// A pipe reader's result: the bytes, or the read error.
type Piped = thread::JoinHandle<std::io::Result<Vec<u8>>>;

/// Reads a pipe in chunks and sends every line (ended by `\r` or `\n`) as it completes,
/// then the whole content; used for git's progress on stderr.
fn read_pipe_lines<R: Read + Send + 'static>(
    name: &str,
    pipe: Option<R>,
    lines: mpsc::Sender<String>,
) -> std::io::Result<Piped> {
    thread::Builder::new()
        .name(format!("begira-git-{name}"))
        .spawn(move || {
            let mut all = Vec::new();
            let Some(mut pipe) = pipe else {
                return Ok(all);
            };
            let mut chunk = [0_u8; 4096];
            let mut pending = Vec::new();
            loop {
                let read = pipe.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                all.extend_from_slice(&chunk[..read]);
                for &byte in &chunk[..read] {
                    if byte == b'\n' || byte == b'\r' {
                        if !pending.is_empty() {
                            let line = String::from_utf8_lossy(&pending).into_owned();
                            // The receiver is gone once the caller stopped listening.
                            let _ = lines.send(line);
                            pending.clear();
                        }
                    } else {
                        pending.push(byte);
                    }
                }
            }
            if !pending.is_empty() {
                let _ = lines.send(String::from_utf8_lossy(&pending).into_owned());
            }
            Ok(all)
        })
}

/// [`run_polled`] whose stderr lines reach `on_line` as they arrive.
fn run_polled_streaming(
    mut command: Command,
    joined: String,
    cancel: &Cancel,
    on_line: &mut dyn FnMut(&str),
) -> GitResult<CliExit> {
    let run_failed = |what: String| GitError::Cli {
        command: joined.clone(),
        status: None,
        stderr: what,
    };
    cancel.check()?;
    isolate(&mut command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| GitError::GitNotStarted {
            command: joined.clone(),
            reason: error.to_string(),
        })?;
    let out_reader = match read_pipe("out", child.stdout.take()) {
        Ok(reader) => reader,
        Err(error) => {
            abort(child);
            return Err(run_failed(format!(
                "could not start the output thread: {error}"
            )));
        }
    };
    let (sender, lines) = mpsc::channel();
    let err_reader = match read_pipe_lines("err", child.stderr.take(), sender) {
        Ok(reader) => reader,
        Err(error) => {
            abort(child);
            return Err(run_failed(format!(
                "could not start the error thread: {error}"
            )));
        }
    };
    let deliver = |on_line: &mut dyn FnMut(&str)| {
        while let Ok(line) = lines.try_recv() {
            on_line(&line);
        }
    };
    let status = loop {
        deliver(on_line);
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if cancel.is_cancelled() {
                    abort(child);
                    return Err(GitError::Cancelled);
                }
                thread::sleep(CANCEL_POLL);
            }
            Err(error) => {
                abort(child);
                return Err(run_failed(format!("could not wait for git: {error}")));
            }
        }
    };
    while !(out_reader.is_finished() && err_reader.is_finished()) {
        deliver(on_line);
        if cancel.is_cancelled() {
            return Err(GitError::Cancelled);
        }
        thread::sleep(CANCEL_POLL);
    }
    deliver(on_line);
    let stdout = out_reader
        .join()
        .unwrap_or_else(|_| Ok(Vec::new()))
        .map_err(|error| run_failed(format!("could not read git's output: {error}")))?;
    let stderr = err_reader
        .join()
        .unwrap_or_else(|_| Ok(Vec::new()))
        .map_err(|error| run_failed(format!("could not read git's messages: {error}")))?;
    Ok(CliExit {
        status: status.code(),
        stdout,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

fn read_pipe<R: Read + Send + 'static>(name: &str, pipe: Option<R>) -> std::io::Result<Piped> {
    thread::Builder::new()
        .name(format!("begira-git-{name}"))
        .spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                pipe.read_to_end(&mut bytes)?;
            }
            Ok(bytes)
        })
}

/// Spawns `command` with both pipes captured and polls it: the cancel flag every
/// [`CANCEL_POLL`], the optional `deadline` from the spawn (past it the tree is stopped and
/// the run is [`GitError::GitNotStarted`], for the probes). After the exit the readers are
/// waited for under the same polling, so a grandchild that kept a pipe open cannot pin the
/// caller past a cancel.
fn run_polled(
    mut command: Command,
    joined: String,
    cancel: &Cancel,
    deadline: Option<Duration>,
    input: Option<Vec<u8>>,
) -> GitResult<CliExit> {
    let run_failed = |what: String| GitError::Cli {
        command: joined.clone(),
        status: None,
        stderr: what,
    };
    cancel.check()?;
    isolate(&mut command);
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let started = Instant::now();
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| GitError::GitNotStarted {
            command: joined.clone(),
            reason: error.to_string(),
        })?;
    if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
        // The writer ends when the bytes are written or the child stops reading (a broken
        // pipe is not an error of the run: git's status and stderr say what happened).
        let writer = thread::Builder::new()
            .name("begira-git-in".to_owned())
            .spawn(move || {
                use std::io::Write;
                let _ = stdin.write_all(&bytes);
            });
        if let Err(error) = writer {
            abort(child);
            return Err(run_failed(format!(
                "could not start the input thread: {error}"
            )));
        }
    }
    let out_reader = match read_pipe("out", child.stdout.take()) {
        Ok(reader) => reader,
        Err(error) => {
            abort(child);
            return Err(run_failed(format!(
                "could not start the output thread: {error}"
            )));
        }
    };
    let err_reader = match read_pipe("err", child.stderr.take()) {
        Ok(reader) => reader,
        Err(error) => {
            abort(child);
            return Err(run_failed(format!(
                "could not start the error thread: {error}"
            )));
        }
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if cancel.is_cancelled() {
                    abort(child);
                    return Err(GitError::Cancelled);
                }
                if deadline.is_some_and(|limit| started.elapsed() > limit) {
                    abort(child);
                    return Err(GitError::GitNotStarted {
                        command: joined,
                        reason: format!("no answer within {:?}", deadline.unwrap_or_default()),
                    });
                }
                thread::sleep(CANCEL_POLL);
            }
            Err(error) => {
                abort(child);
                return Err(run_failed(format!("could not wait for git: {error}")));
            }
        }
    };
    while !(out_reader.is_finished() && err_reader.is_finished()) {
        if cancel.is_cancelled() {
            return Err(GitError::Cancelled);
        }
        thread::sleep(CANCEL_POLL);
    }
    let stdout = out_reader
        .join()
        .unwrap_or_else(|_| Ok(Vec::new()))
        .map_err(|error| run_failed(format!("could not read git's output: {error}")))?;
    let stderr = err_reader
        .join()
        .unwrap_or_else(|_| Ok(Vec::new()))
        .map_err(|error| run_failed(format!("could not read git's messages: {error}")))?;
    Ok(CliExit {
        status: status.code(),
        stdout,
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellable_runs_report_the_status_and_stop_on_cancel() {
        let version = run_git_cancellable(Path::new("."), &["--version"], &Cancel::never())
            .expect("git is installed");
        assert_eq!(version.status, Some(0));
        assert!(version.stdout.starts_with(b"git version"));
        let failed = run_git_cancellable(Path::new("."), &["no-such-subcommand"], &Cancel::never())
            .expect("a failure is an exit status, not an error");
        assert_ne!(failed.status, Some(0));
        assert!(failed.stderr.contains("no-such-subcommand"));
        let cancel = Cancel::new();
        cancel.cancel();
        let cancelled = run_git_cancellable(Path::new("."), &["--version"], &cancel)
            .expect_err("cancelled before starting");
        assert_eq!(cancelled.code(), "op.cancelled");
    }

    #[test]
    fn probes_and_detects_git_and_refuses_what_is_not_git() {
        let never = Cancel::never();
        let version = probe_git(Path::new("git"), &never).expect("git is installed");
        assert!(version.starts_with("git version "));
        let detected = detect_git(&never).expect("detected");
        assert!(detected.version.starts_with("git version "));
        // A program that exists but is not git, and one that does not exist.
        let not_git = if cfg!(windows) { "cmd" } else { "sh" };
        let refused = probe_git(Path::new(not_git), &never).expect_err("not git");
        assert_eq!(refused.code(), "git.cli_failed");
        let missing =
            probe_git(Path::new("no-such-git-binary-for-tests"), &never).expect_err("missing");
        assert_eq!(missing.code(), "git.not_started");
        // Refusing keeps the executable in use.
        let before = git_executable();
        assert!(
            set_git_executable(Some(Path::new("no-such-git-binary-for-tests")), &never).is_err()
        );
        assert_eq!(git_executable(), before);
        // A cancelled probe never starts the program.
        let cancelled = Cancel::new();
        cancelled.cancel();
        assert_eq!(
            probe_git(Path::new("git"), &cancelled)
                .expect_err("cancelled")
                .code(),
            "op.cancelled"
        );
    }

    #[test]
    fn a_silent_candidate_is_refused_at_the_deadline() {
        // A script that never answers stands for a GUI program picked by mistake (Git for
        // Windows ships `git-gui.exe` next to `git.exe`).
        let dir = tempfile::tempdir().expect("temp dir");
        let script = if cfg!(windows) {
            let path = dir.path().join("silent.cmd");
            std::fs::write(&path, "@ping -n 30 127.0.0.1 >nul\r\n").expect("script");
            path
        } else {
            let path = dir.path().join("silent.sh");
            std::fs::write(&path, "#!/bin/sh\nsleep 30\n").expect("script");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    .expect("chmod");
            }
            path
        };
        let started = Instant::now();
        let error = probe_git_within(&script, &Cancel::never(), Duration::from_millis(300))
            .expect_err("no answer");
        assert_eq!(error.code(), "git.not_started", "{error:?}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_relative_executable_path_is_made_absolute_and_a_name_is_kept() {
        assert_eq!(absolute_if_pathlike(Path::new("git")), PathBuf::from("git"));
        let relative = Path::new("tools").join("git.exe");
        let absolute = absolute_if_pathlike(&relative);
        assert!(absolute.is_absolute(), "{}", absolute.display());
        assert!(absolute.ends_with(&relative));
    }

    #[test]
    fn a_cancelled_run_stops_git_and_what_it_started() {
        // A `!` alias runs through git's shell, so the tree is git, sh and sleep (behind Git
        // for Windows' launcher when that is the `git` on PATH). Killing the direct child
        // alone would leave the rest holding the pipe for the whole sleep.
        let cancel = Cancel::new();
        let flag = cancel.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            flag.cancel();
        });
        let started = std::time::Instant::now();
        let result = run_git_cancellable(Path::new("."), &["-c", "alias.w=!sleep 8", "w"], &cancel);
        assert_eq!(result.expect_err("cancelled").code(), "op.cancelled");
        let took = started.elapsed();
        assert!(took < Duration::from_secs(4), "returned after {took:?}");
    }

    #[test]
    fn input_is_written_whole_and_a_cancel_stops_a_run_with_input() {
        // 8 MB through stdin while stdout is read: neither pipe may stall the other.
        let big = vec![b'x'; 8 * 1024 * 1024];
        let hashed = run_git_with_input(
            Path::new("."),
            &["hash-object", "--stdin"],
            big.clone(),
            &Cancel::never(),
        )
        .expect("git is installed");
        assert_eq!(hashed.status, Some(0), "{}", hashed.stderr);
        let expected = run_git_with_input(
            Path::new("."),
            &["hash-object", "--stdin"],
            big.clone(),
            &Cancel::never(),
        )
        .expect("again");
        assert_eq!(hashed.stdout, expected.stdout);
        assert_eq!(hashed.stdout.len(), 41, "one hash and a newline");
        // git that never reads its input: the writer sees the broken pipe and the run ends
        // with git's own status, well before the input would have been written.
        let started = Instant::now();
        let ignored = run_git_with_input(Path::new("."), &["--version"], big, &Cancel::never())
            .expect("runs");
        assert_eq!(ignored.status, Some(0));
        assert!(ignored.stdout.starts_with(b"git version"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        let cancel = Cancel::new();
        cancel.cancel();
        let cancelled = run_git_with_input(
            Path::new("."),
            &["hash-object", "--stdin"],
            b"x".to_vec(),
            &cancel,
        )
        .expect_err("cancelled before starting");
        assert_eq!(cancelled.code(), "op.cancelled");
    }

    #[test]
    fn streaming_hands_over_stderr_lines_as_they_come_and_keeps_the_whole_output() {
        // `git -c alias.x='!...'` writes to stderr through a shell; `\r` and `\n` both end
        // a line, as git's progress meter writes them.
        let mut seen = Vec::new();
        let exit = run_git_streaming(
            Path::new("."),
            &[
                "-c",
                "alias.x=!printf 'first\\rsecond\\nthird' >&2; echo out",
                "x",
            ],
            &WRITE_ENV,
            &mut |line| seen.push(line.to_owned()),
            &Cancel::never(),
        )
        .expect("runs");
        assert_eq!(exit.status, Some(0), "{}", exit.stderr);
        assert_eq!(seen, ["first", "second", "third"]);
        assert_eq!(exit.stderr, "first\rsecond\nthird");
        assert_eq!(String::from_utf8_lossy(&exit.stdout).trim(), "out");
        let cancel = Cancel::new();
        cancel.cancel();
        let cancelled =
            run_git_streaming(Path::new("."), &["--version"], &[], &mut |_| {}, &cancel)
                .expect_err("cancelled before starting");
        assert_eq!(cancelled.code(), "op.cancelled");
    }

    #[test]
    fn reports_the_version() {
        let output = run_git(Path::new("."), &["--version"]).expect("git is installed");
        assert!(output.stdout.starts_with("git version"));
    }

    #[test]
    fn failure_carries_status_and_stderr() {
        let error = run_git(Path::new("."), &["no-such-subcommand"]).expect_err("must fail");
        match error {
            GitError::Cli {
                command,
                status,
                stderr,
            } => {
                assert_eq!(command, "no-such-subcommand");
                assert!(status.is_some());
                assert!(stderr.contains("no-such-subcommand"));
            }
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[test]
    fn removes_the_variables_a_hook_environment_sets() {
        let command = command(Path::new("."), &["status"]);
        let removed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect();
        for var in REDIRECTING_VARS {
            assert!(removed.contains(&var.to_owned()), "{var} is not removed");
        }
        assert_eq!(command.get_current_dir(), Some(Path::new(".")));
    }
}
