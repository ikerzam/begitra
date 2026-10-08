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
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::GitDetection;
use crate::types::Prompts;

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
    // A candidate that gives no answer within the deadline (or whose run breaks) is one
    // that could not be started, as far as the probe is concerned.
    let exit =
        run_polled(command, joined.clone(), cancel, Some(deadline), None).map_err(|error| {
            match error {
                GitError::Cli {
                    command,
                    status: None,
                    stderr,
                } => GitError::GitNotStarted {
                    command,
                    reason: stderr,
                },
                other => other,
            }
        })?;
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
/// process runs inside a git hook or a `git` alias, so an inherited one is always removed: the
/// repository a call targets is the `cwd` the caller chose, and only a variable the caller sets
/// on the command itself (a merge check's own object folder) stays. Public for the tests
/// that run git on fixtures: a hook of a linked worktree exports `GIT_DIR`, and a fixture's
/// `git init` under it would reinitialise the checkout's own repository as bare.
pub const REDIRECTING_VARS: [&str; 9] = [
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

/// Environment variables that change how git reads every pathspec. Inherited from a hook or
/// an alias they are always removed, as the redirecting ones: each call says itself how its
/// paths are read (`--literal-pathspecs`, `./` for `check-ignore`, which refuses literal
/// magic, so an inherited `GIT_LITERAL_PATHSPECS` would fail every such call).
pub const PATHSPEC_VARS: [&str; 4] = [
    "GIT_LITERAL_PATHSPECS",
    "GIT_GLOB_PATHSPECS",
    "GIT_NOGLOB_PATHSPECS",
    "GIT_ICASE_PATHSPECS",
];

/// The command `git <args>` in `cwd`, with the redirecting variables removed and stdin closed.
/// On Windows the process gets no console, so a GUI caller never flashes a black window.
pub fn command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(git_executable());
    command.args(args).current_dir(cwd);
    isolate(&mut command);
    command
}

/// Stdin closed, the inherited redirecting and pathspec variables removed (one the caller set
/// on the command, a merge check's own object folder, stays), no console window on Windows, and on
/// Unix a process group of its own so that a cancel can stop what git started.
fn isolate(command: &mut Command) {
    command.stdin(Stdio::null());
    let set: Vec<std::ffi::OsString> = command
        .get_envs()
        .filter(|(_, value)| value.is_some())
        .map(|(key, _)| key.to_owned())
        .collect();
    for var in REDIRECTING_VARS.iter().chain(PATHSPEC_VARS.iter()) {
        if !set.iter().any(|key| key == var) {
            command.env_remove(var);
        }
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
        .name("begitra-git-abort".to_owned())
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

/// Stops git and what it started, waiting for it: [`abort`] on the caller's thread.
pub(crate) fn stop_tree(mut child: Child) {
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
/// An argument with the credentials of a URL hidden (`https://user:token@host/…` becomes
/// `https://***@host/…`): what the spans record and what an error names as its command,
/// since both reach the log file and the toasts a user copies.
pub fn redact(arg: &str) -> String {
    let Some((scheme, rest)) = arg.split_once("://") else {
        return arg.to_owned();
    };
    match rest.split_once('@') {
        Some((credentials, host)) if !credentials.contains('/') && !credentials.is_empty() => {
            format!("{scheme}://***@{host}")
        }
        _ => arg.to_owned(),
    }
}

/// Arguments joined by spaces, credentials hidden.
pub fn joined(args: &[&str]) -> String {
    args.iter()
        .map(|arg| redact(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The arguments as a span records them: credentials hidden.
struct Redacted<'a>(&'a [&'a str]);

impl std::fmt::Debug for Redacted<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.0.iter().map(|arg| redact(arg)))
            .finish()
    }
}

/// The user's global and system configuration stay in effect, as they would on the command
/// line; callers that need isolation pass `-c` overrides.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args)))]
pub fn run_git(cwd: &Path, args: &[&str]) -> GitResult<CliOutput> {
    let joined = joined(args);
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

impl CliExit {
    /// The exit as [`GitError::Cli`] for `args`, with git's words: stderr, or stdout when
    /// git put its refusal there (`git rebase --continue` prints "<path>: needs merge" on
    /// stdout and nothing on stderr).
    pub fn into_failure(self, args: &[&str]) -> GitError {
        let stderr = if self.stderr.trim().is_empty() {
            String::from_utf8_lossy(&self.stdout).trim_end().to_owned()
        } else {
            self.stderr
        };
        GitError::Cli {
            command: joined(args),
            status: self.status,
            stderr,
        }
    }
}

/// Runs `git <args>` in `cwd` while polling `cancel` every [`CANCEL_POLL`]; a cancelled run
/// stops git (see [`abort`]) and returns [`GitError::Cancelled`] at once, without waiting
/// for the pipes: their reader threads end at end-of-file. Both pipes are drained by their
/// own threads so git never blocks on a full one. The exit status is returned, not judged:
/// callers that give a meaning to a non-zero status (`merge-tree` exits 1 on conflicts) read
/// it here. Only a git that could not be started is [`GitError::GitNotStarted`]; any later
/// failure of the run is [`GitError::Cli`] with `status: None`.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args)))]
pub fn run_git_cancellable(cwd: &Path, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    run_polled(command(cwd, args), joined(args), cancel, None, None)
}

/// The environment of a write that must never wait for a terminal or an editor: git's own
/// credential prompt never reads the terminal (a helper with a window of its own, such as Git
/// Credential Manager, or an askpass program the user set still opens its window, which the
/// caller's timeout bounds and [`NO_PROMPT_ENV`] closes), and a
/// merge, revert or `--continue` that would open an editor takes the prepared message. `:`
/// is the editor git knows not to launch, where `true` would spawn a shell for it. `LC_ALL=C`
/// keeps git's words in English, so a refusal the app reads ("would be overwritten", "not
/// fully merged") is the same under every locale; the app's own sentences are translated,
/// git's output is the terminal's lingua franca.
pub const WRITE_ENV: [(&str, &str); 4] = [
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_EDITOR", ":"),
    ("GIT_SEQUENCE_EDITOR", ":"),
    ("LC_ALL", "C"),
];

/// What [`Prompts::Never`] adds to [`WRITE_ENV`] for a fetch, pull or push, besides
/// OpenSSH's askpass (see [`network_env`]): Git Credential Manager fails instead of opening its
/// window, and an empty `GIT_ASKPASS` ends git's own chain for a username or a password
/// (`GIT_ASKPASS`, then `core.askPass`, then `SSH_ASKPASS`) before the terminal, which
/// `WRITE_ENV` already closes. The user's SSH command, credential helpers and configuration
/// stay as they are.
pub const NO_PROMPT_ENV: [(&str, &str); 2] = [("GCM_INTERACTIVE", "never"), ("GIT_ASKPASS", "")];

/// A program that exits non-zero at once without reading its input: OpenSSH's askpass in a
/// bulk operation, so a passphrase or a host key to confirm fails as a refused sign-in
/// instead of waiting. `where.exe` looks for a file named as the prompt, which none is, and
/// every Windows has it; `false` everywhere else.
pub fn failing_askpass() -> &'static str {
    static PROGRAM: OnceLock<String> = OnceLock::new();
    PROGRAM.get_or_init(|| {
        if cfg!(windows) {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_owned());
            format!(r"{root}\System32\where.exe")
        } else if Path::new("/usr/bin/false").exists() {
            "/usr/bin/false".to_owned()
        } else {
            "/bin/false".to_owned()
        }
    })
}

/// The environment of a fetch, pull or push: [`WRITE_ENV`], and when nothing may ask,
/// [`NO_PROMPT_ENV`] and OpenSSH's askpass forced to [`failing_askpass`]. Forced, not refused:
/// `SSH_ASKPASS_REQUIRE=never` leaves OpenSSH reading the console, and Windows' own OpenSSH
/// finds the hidden console a windowless process gets and waits on it for a passphrase or a
/// host key; with the failing askpass both it and Git for Windows' ssh fail within a second.
pub fn network_env(prompts: Prompts) -> Vec<(&'static str, &'static str)> {
    let mut env = WRITE_ENV.to_vec();
    if prompts == Prompts::Never {
        env.extend(NO_PROMPT_ENV);
        env.push(("SSH_ASKPASS_REQUIRE", "force"));
        env.push(("SSH_ASKPASS", failing_askpass()));
    }
    env
}

/// [`run_git_cancellable`] with extra environment variables (see [`WRITE_ENV`]).
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args)))]
pub fn run_git_env(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    cancel: &Cancel,
) -> GitResult<CliExit> {
    let mut command = command(cwd, args);
    command.envs(env.iter().copied());
    run_polled(command, joined(args), cancel, None, None)
}

/// [`run_git_env`] that also stops git past `limit` (the tree is killed and the run is
/// [`GitError::Cli`] with no status): for a write that ignores the user's cancel on purpose
/// but must not run forever.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args), limit = ?limit))]
pub fn run_git_env_within(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    cancel: &Cancel,
    limit: Duration,
) -> GitResult<CliExit> {
    let mut command = command(cwd, args);
    command.envs(env.iter().copied());
    run_polled(command, joined(args), cancel, Some(limit), None)
}

/// [`run_git_env`] with git's stderr handed to `on_line` line by line as it arrives: the
/// progress of a fetch or a push (`--progress` writes `\r`-separated updates, so `\r` ends
/// a line as `\n` does). The whole stderr is still in the exit for the error message.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args)))]
pub fn run_git_streaming(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    on_line: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<CliExit> {
    let mut command = command(cwd, args);
    command.envs(env.iter().copied());
    run_polled_streaming(command, joined(args), cancel, on_line)
}

/// Lines of output one batch carries from [`run_git_lines`]'s reader thread to its caller.
const LINE_BATCH: usize = 512;

/// Batches the reader may run ahead of the caller: past them git is paused, its pipe full.
const BATCHES_AHEAD: usize = 8;

/// Runs `git <args>` in `cwd` and hands each line of its standard output to `on_line` as it
/// arrives, without its line ending: for a listing too large to hold whole (`rev-list` over a
/// large history). A reader thread sends the lines in batches through a bounded channel, so a
/// slow caller pauses git instead of filling memory. `cancel` is polled every
/// [`CANCEL_POLL`] while waiting and after each batch; a cancelled run stops git (see
/// [`abort`]) and returns [`GitError::Cancelled`], and so does any early return or a panic of
/// `on_line`. stderr is read whole by its own thread. The exit status is returned, not judged,
/// as [`run_git_cancellable`] does; the exit's `stdout` is empty, its lines having gone to
/// `on_line`.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args)))]
pub fn run_git_lines(
    cwd: &Path,
    args: &[&str],
    cancel: &Cancel,
    on_line: &mut dyn FnMut(&[u8]),
) -> GitResult<CliExit> {
    run_lines(command(cwd, args), joined(args), None, cancel, on_line)
}

/// [`run_git_lines`] with `input` on git's stdin (the revisions `rev-list --stdin` starts
/// from), written from its own thread so that neither side blocks on a full pipe.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args), input_bytes = input.len()))]
pub fn run_git_lines_with_input(
    cwd: &Path,
    args: &[&str],
    input: Vec<u8>,
    cancel: &Cancel,
    on_line: &mut dyn FnMut(&[u8]),
) -> GitResult<CliExit> {
    run_lines(
        command(cwd, args),
        joined(args),
        Some(input),
        cancel,
        on_line,
    )
}

/// A git that runs until it exits: dropped while it still holds the child (an early return, a
/// cancel, a panic of the caller's callback), it stops git and what git started.
struct Running(Option<Child>);

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(child) = self.0.take() {
            abort(child);
        }
    }
}

/// The body of [`run_git_lines`] and [`run_git_lines_with_input`].
fn run_lines(
    mut command: Command,
    joined: String,
    input: Option<Vec<u8>>,
    cancel: &Cancel,
    on_line: &mut dyn FnMut(&[u8]),
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
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| GitError::GitNotStarted {
            command: joined.clone(),
            reason: error.to_string(),
        })?;
    let mut running = Running(Some(child));
    let Some(child) = running.0.as_mut() else {
        return Err(run_failed("git stopped as it started".to_owned()));
    };
    if let Some(bytes) = input {
        feed(child, bytes)
            .map_err(|error| run_failed(format!("could not start the input thread: {error}")))?;
    }
    let (sender, batches) = mpsc::sync_channel(BATCHES_AHEAD);
    let out_reader = read_line_batches(child.stdout.take(), sender)
        .map_err(|error| run_failed(format!("could not start the output thread: {error}")))?;
    let err_reader = read_pipe("err", child.stderr.take())
        .map_err(|error| run_failed(format!("could not start the error thread: {error}")))?;
    loop {
        match batches.recv_timeout(CANCEL_POLL) {
            Ok(batch) => {
                for line in &batch {
                    on_line(line);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // The reader ends at end-of-file, or at its next send once the channel is gone.
        cancel.check()?;
    }
    let status = loop {
        let Some(child) = running.0.as_mut() else {
            return Err(run_failed(
                "git stopped before its exit was read".to_owned(),
            ));
        };
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                cancel.check()?;
                thread::sleep(CANCEL_POLL);
            }
            Err(error) => return Err(run_failed(format!("could not wait for git: {error}"))),
        }
    };
    // git exited: there is nothing to stop any more.
    running.0 = None;
    // A process git started may still hold a pipe: the readers are waited for under the cancel.
    while !(out_reader.is_finished() && err_reader.is_finished()) {
        cancel.check()?;
        thread::sleep(CANCEL_POLL);
    }
    out_reader
        .join()
        .map_err(|_| run_failed("the output thread stopped".to_owned()))?
        .map_err(|error| run_failed(format!("could not read git's output: {error}")))?;
    let stderr = err_reader
        .join()
        .map_err(|_| run_failed("the error thread stopped".to_owned()))?
        .map_err(|error| run_failed(format!("could not read git's messages: {error}")))?;
    Ok(CliExit {
        status: status.code(),
        stdout: Vec::new(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

/// Reads a pipe line by line, each without its `\n` or `\r\n`, and sends the lines in batches
/// of [`LINE_BATCH`]; the thread ends at end-of-file, or once the receiver is gone.
fn read_line_batches<R: Read + Send + 'static>(
    pipe: Option<R>,
    batches: mpsc::SyncSender<Vec<Vec<u8>>>,
) -> std::io::Result<thread::JoinHandle<std::io::Result<()>>> {
    thread::Builder::new()
        .name("begitra-git-lines".to_owned())
        .spawn(move || {
            use std::io::BufRead;
            let Some(pipe) = pipe else {
                return Ok(());
            };
            let mut reader = std::io::BufReader::new(pipe);
            let mut batch = Vec::with_capacity(LINE_BATCH);
            loop {
                let mut line = Vec::new();
                if reader.read_until(b'\n', &mut line)? == 0 {
                    break;
                }
                if line.last() == Some(&b'\n') {
                    line.pop();
                }
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                batch.push(line);
                if batch.len() == LINE_BATCH {
                    let full = std::mem::replace(&mut batch, Vec::with_capacity(LINE_BATCH));
                    if batches.send(full).is_err() {
                        return Ok(());
                    }
                }
            }
            if !batch.is_empty() {
                // The receiver may be gone: the caller stopped listening.
                let _ = batches.send(batch);
            }
            Ok(())
        })
}

/// [`run_git_cancellable`] with `input` on git's stdin (a pathspec list, a commit message,
/// a patch), written from its own thread so that neither side blocks on a full pipe.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args), input_bytes = input.len()))]
pub fn run_git_with_input(
    cwd: &Path,
    args: &[&str],
    input: Vec<u8>,
    cancel: &Cancel,
) -> GitResult<CliExit> {
    run_polled(command(cwd, args), joined(args), cancel, None, Some(input))
}

/// [`run_git_with_input`] that also stops git past `limit` (see [`run_git_env_within`]): a
/// write that goes on whatever the user's cancel says once an earlier one has changed the
/// index, but must not run forever.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args), input_bytes = input.len(), limit = ?limit))]
pub fn run_git_with_input_within(
    cwd: &Path,
    args: &[&str],
    input: Vec<u8>,
    cancel: &Cancel,
    limit: Duration,
) -> GitResult<CliExit> {
    run_polled(
        command(cwd, args),
        joined(args),
        cancel,
        Some(limit),
        Some(input),
    )
}

/// [`run_git_with_input`] with extra environment variables (see [`run_git_env`]) that answers at
/// `budget` with what git wrote so far: past it the tree is stopped and the exit holds the
/// output read until then, with no status. For a batch that writes each answer as it ends
/// (`git merge-tree --stdin`, its objects in a folder of their own), so that a slow tail costs
/// its own answers and not the ones before it.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display(), args = ?Redacted(args), input_bytes = input.len(), budget = ?budget))]
pub fn run_git_env_with_input_for(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
    input: Vec<u8>,
    cancel: &Cancel,
    budget: Duration,
) -> GitResult<CliExit> {
    let mut command = command(cwd, args);
    command.envs(env.iter().copied());
    run_polled_for(command, joined(args), cancel, budget, input)
}

/// A pipe reader's result: the bytes, or the read error.
type Piped = thread::JoinHandle<std::io::Result<Vec<u8>>>;

/// Bytes a pipe reader appends as they arrive, for a caller that may stop before the end.
type Collected = Arc<Mutex<Vec<u8>>>;

/// Writes `bytes` to the child's stdin from a thread of its own, so that neither side blocks on
/// a full pipe. The writer ends when the bytes are written or the child stops reading (a broken
/// pipe is not an error of the run: git's status and stderr say what happened).
fn feed(child: &mut Child, bytes: Vec<u8>) -> std::io::Result<()> {
    let Some(mut stdin) = child.stdin.take() else {
        return Ok(());
    };
    thread::Builder::new()
        .name("begitra-git-in".to_owned())
        .spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(&bytes);
        })
        .map(|_| ())
}

/// Reads a pipe to its end into `into`, chunk by chunk, so that what arrived is there to take
/// at any moment.
fn read_pipe_into<R: Read + Send + 'static>(
    name: &str,
    pipe: Option<R>,
    into: Collected,
) -> std::io::Result<thread::JoinHandle<std::io::Result<()>>> {
    thread::Builder::new()
        .name(format!("begitra-git-{name}"))
        .spawn(move || {
            let Some(mut pipe) = pipe else {
                return Ok(());
            };
            let mut chunk = [0_u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => return Ok(()),
                    Ok(read) => into
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .extend_from_slice(&chunk[..read]),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(error),
                }
            }
        })
}

fn take_collected(collected: &Collected) -> Vec<u8> {
    std::mem::take(
        &mut *collected
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    )
}

/// Longest line the streaming reader hands over; the rest of a longer one is dropped (a
/// hostile remote could otherwise grow a line without bound).
const MAX_STREAMED_LINE: usize = 4096;

/// Reads a pipe in chunks and sends every line (ended by `\r` or `\n`) as it completes;
/// used for git's progress on stderr. Nothing is kept whole: the caller decides what of the
/// stream it remembers, so a chatty remote cannot fill memory.
fn read_pipe_lines<R: Read + Send + 'static>(
    name: &str,
    pipe: Option<R>,
    lines: mpsc::Sender<String>,
) -> std::io::Result<Piped> {
    thread::Builder::new()
        .name(format!("begitra-git-{name}"))
        .spawn(move || {
            let Some(mut pipe) = pipe else {
                return Ok(Vec::new());
            };
            let mut chunk = [0_u8; 4096];
            let mut pending = Vec::new();
            loop {
                let read = pipe.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                for &byte in &chunk[..read] {
                    if byte == b'\n' || byte == b'\r' {
                        if !pending.is_empty() {
                            let line = String::from_utf8_lossy(&pending).into_owned();
                            // The receiver is gone once the caller stopped listening.
                            let _ = lines.send(line);
                            pending.clear();
                        }
                    } else if pending.len() < MAX_STREAMED_LINE {
                        pending.push(byte);
                    }
                }
            }
            if !pending.is_empty() {
                let _ = lines.send(String::from_utf8_lossy(&pending).into_owned());
            }
            Ok(Vec::new())
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
        .name(format!("begitra-git-{name}"))
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
/// the run is [`GitError::Cli`] with no status). After the exit the readers are
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
    if let Some(bytes) = input {
        if let Err(error) = feed(&mut child, bytes) {
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
                    return Err(run_failed(format!(
                        "no answer within {:?}: git was stopped",
                        deadline.unwrap_or_default()
                    )));
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

/// [`run_polled`] with `input` that, past `budget` from the spawn, stops the tree and answers
/// the output read so far with no status instead of failing.
fn run_polled_for(
    mut command: Command,
    joined: String,
    cancel: &Cancel,
    budget: Duration,
    input: Vec<u8>,
) -> GitResult<CliExit> {
    let run_failed = |what: String| GitError::Cli {
        command: joined.clone(),
        status: None,
        stderr: what,
    };
    cancel.check()?;
    isolate(&mut command);
    command.stdin(Stdio::piped());
    let started = Instant::now();
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| GitError::GitNotStarted {
            command: joined.clone(),
            reason: error.to_string(),
        })?;
    if let Err(error) = feed(&mut child, input) {
        abort(child);
        return Err(run_failed(format!(
            "could not start the input thread: {error}"
        )));
    }
    let (out, err) = (Collected::default(), Collected::default());
    let out_reader = match read_pipe_into("out", child.stdout.take(), Arc::clone(&out)) {
        Ok(reader) => reader,
        Err(error) => {
            abort(child);
            return Err(run_failed(format!(
                "could not start the output thread: {error}"
            )));
        }
    };
    let err_reader = match read_pipe_into("err", child.stderr.take(), Arc::clone(&err)) {
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
                if started.elapsed() > budget {
                    // Stopped as a cancel is, without waiting for the tree to go (a tenth of a
                    // second and more on Windows): the caller has the answers read until now,
                    // and git may hold its files a moment after this returns.
                    abort(child);
                    return Ok(CliExit {
                        status: None,
                        stdout: take_collected(&out),
                        stderr: String::from_utf8_lossy(&take_collected(&err)).into_owned(),
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
    out_reader
        .join()
        .unwrap_or(Ok(()))
        .map_err(|error| run_failed(format!("could not read git's output: {error}")))?;
    err_reader
        .join()
        .unwrap_or(Ok(()))
        .map_err(|error| run_failed(format!("could not read git's messages: {error}")))?;
    Ok(CliExit {
        status: status.code(),
        stdout: take_collected(&out),
        stderr: String::from_utf8_lossy(&take_collected(&err)).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_network_command_that_may_not_prompt_closes_every_helper_s_window() {
        assert_eq!(network_env(Prompts::Allowed), WRITE_ENV.to_vec());
        let never = network_env(Prompts::Never);
        assert_eq!(never[..WRITE_ENV.len()], WRITE_ENV[..]);
        assert_eq!(
            never[WRITE_ENV.len()..],
            [
                ("GCM_INTERACTIVE", "never"),
                ("GIT_ASKPASS", ""),
                ("SSH_ASKPASS_REQUIRE", "force"),
                ("SSH_ASKPASS", failing_askpass()),
            ]
        );
    }

    #[test]
    fn the_failing_askpass_runs_and_fails_without_reading_its_input() {
        let exit = Command::new(failing_askpass())
            .arg("Enter passphrase for key 'C:\\Users\\x/.ssh/id_ed25519': ")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .expect("the askpass program runs");
        assert!(!exit.status.success());
    }

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
    fn a_cancelled_streaming_run_stops_git_and_what_it_started() {
        // The streaming runner hands each line over as it comes, then detaches its readers and
        // returns on the cancel without waiting for the pipes; the process tree (git, sh,
        // sleep) still ends. The cancel follows the first line rather than a timer, since
        // starting git and the alias's shell can take longer than any fixed delay on Windows.
        let cancel = Cancel::new();
        let flag = cancel.clone();
        let mut cancelled_at = None;
        let mut lines = Vec::new();
        let result = run_git_streaming(
            Path::new("."),
            &["-c", "alias.w=!echo start >&2; sleep 8", "w"],
            &WRITE_ENV,
            &mut |line| {
                lines.push(line.to_owned());
                flag.cancel();
                cancelled_at.get_or_insert_with(std::time::Instant::now);
            },
            &cancel,
        );
        assert_eq!(result.expect_err("cancelled").code(), "op.cancelled");
        let took = cancelled_at.expect("the first line arrived").elapsed();
        assert!(
            took < Duration::from_secs(4),
            "returned {took:?} after the cancel"
        );
        assert_eq!(lines, ["start"]);
    }

    #[test]
    fn lines_arrive_whole_and_in_order_past_a_batch() {
        let mut lines = Vec::new();
        let exit = run_git_lines(
            Path::new("."),
            &["-c", "alias.w=!seq 1 1300", "w"],
            &Cancel::never(),
            &mut |line| lines.push(String::from_utf8_lossy(line).into_owned()),
        )
        .expect("git runs");
        assert_eq!(exit.status, Some(0), "{}", exit.stderr);
        assert!(exit.stdout.is_empty());
        let expected: Vec<String> = (1..=1300).map(|n| n.to_string()).collect();
        assert_eq!(lines, expected);
    }

    #[test]
    fn a_cancel_after_a_batch_stops_a_git_still_printing() {
        // The cancel is checked after each batch: a git that prints on, then sleeps, stops
        // after the first batch, without its output read to the end or its sleep waited for.
        let cancel = Cancel::new();
        let flag = cancel.clone();
        let mut seen = 0;
        let mut cancelled_at = None;
        let result = run_git_lines(
            Path::new("."),
            &["-c", "alias.w=!seq 1 20000; sleep 8", "w"],
            &cancel,
            &mut |_| {
                seen += 1;
                flag.cancel();
                cancelled_at.get_or_insert_with(std::time::Instant::now);
            },
        );
        assert_eq!(result.expect_err("cancelled").code(), "op.cancelled");
        assert_eq!(seen, LINE_BATCH, "one batch, then the cancel");
        let took = cancelled_at.expect("lines arrived").elapsed();
        assert!(
            took < Duration::from_secs(4),
            "returned {took:?} after the cancel"
        );
    }

    #[test]
    fn lines_with_input_read_git_s_stdin() {
        let mut lines = Vec::new();
        let exit = run_git_lines_with_input(
            Path::new("."),
            &["hash-object", "--stdin"],
            b"hello\n".to_vec(),
            &Cancel::never(),
            &mut |line| lines.push(String::from_utf8_lossy(line).into_owned()),
        )
        .expect("git runs");
        assert_eq!(exit.status, Some(0), "{}", exit.stderr);
        assert_eq!(lines, ["ce013625030ba8dba906f756967f9e9ca394464a"]);
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
    fn streaming_hands_over_stderr_lines_as_they_come_and_keeps_nothing_whole() {
        // `git -c alias.x='!...'` writes to stderr through a shell; `\r` and `\n` both end
        // a line, as git's progress meter writes them; the exit keeps no copy of the stream.
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
        assert_eq!(exit.stderr, "");
        assert_eq!(String::from_utf8_lossy(&exit.stdout).trim(), "out");
        // A line past 4 KiB is cut, not kept growing.
        let mut long = Vec::new();
        run_git_streaming(
            Path::new("."),
            &[
                "-c",
                "alias.y=!head -c 10000 /dev/zero | tr '\\0' 'x' >&2",
                "y",
            ],
            &WRITE_ENV,
            &mut |line| long.push(line.len()),
            &Cancel::never(),
        )
        .expect("runs");
        assert_eq!(long, [MAX_STREAMED_LINE]);
        let cancel = Cancel::new();
        cancel.cancel();
        let cancelled =
            run_git_streaming(Path::new("."), &["--version"], &[], &mut |_| {}, &cancel)
                .expect_err("cancelled before starting");
        assert_eq!(cancelled.code(), "op.cancelled");
    }

    #[test]
    fn credentials_are_hidden_from_spans_and_commands() {
        assert_eq!(
            redact("https://iker:ghp_secret@github.com/ikerzam/begitra.git"),
            "https://***@github.com/ikerzam/begitra.git"
        );
        assert_eq!(
            redact("https://github.com/x.git"),
            "https://github.com/x.git"
        );
        assert_eq!(redact("git@github.com:x.git"), "git@github.com:x.git");
        assert_eq!(redact("ssh://git@host/x.git"), "ssh://***@host/x.git");
        assert_eq!(redact("-m"), "-m");
        assert_eq!(
            joined(&["remote", "add", "--", "o", "https://u:p@h/r.git"]),
            "remote add -- o https://***@h/r.git"
        );
        assert_eq!(
            format!("{:?}", Redacted(&["push", "https://u:p@h/r"])),
            "[\"push\", \"https://***@h/r\"]"
        );
    }

    #[test]
    fn a_bounded_run_is_stopped_past_its_limit() {
        let started = std::time::Instant::now();
        let error = run_git_env_within(
            Path::new("."),
            &["-c", "alias.w=!sleep 8", "w"],
            &WRITE_ENV,
            &Cancel::never(),
            Duration::from_millis(400),
        )
        .expect_err("stopped");
        assert!(
            matches!(error, GitError::Cli { status: None, .. }),
            "{error:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn a_run_with_a_budget_answers_what_git_wrote_before_it() {
        // The alias writes one answer, then works past the budget: the run stops the tree and
        // answers what came, with no status. The budget leaves the alias's shell time to start.
        let started = Instant::now();
        let stopped = run_git_env_with_input_for(
            Path::new("."),
            &["-c", "alias.w=!printf 'first\\0'; sleep 30", "w"],
            &WRITE_ENV,
            b"unread\n".to_vec(),
            &Cancel::never(),
            Duration::from_secs(3),
        )
        .expect("answers");
        assert_eq!(stopped.status, None);
        assert_eq!(stopped.stdout, b"first\0");
        assert!(started.elapsed() < Duration::from_secs(10));
        // A run that ends in time answers whole, its input read.
        let whole = run_git_env_with_input_for(
            Path::new("."),
            &["hash-object", "--stdin"],
            &[],
            b"x".to_vec(),
            &Cancel::never(),
            Duration::from_secs(30),
        )
        .expect("answers");
        assert_eq!(whole.status, Some(0), "{}", whole.stderr);
        assert_eq!(whole.stdout.len(), 41, "one hash and a newline");
        let cancel = Cancel::new();
        cancel.cancel();
        let cancelled = run_git_env_with_input_for(
            Path::new("."),
            &["--version"],
            &[],
            Vec::new(),
            &cancel,
            Duration::from_secs(30),
        )
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
        for var in REDIRECTING_VARS.iter().chain(PATHSPEC_VARS.iter()) {
            assert!(removed.contains(&(*var).to_owned()), "{var} is not removed");
        }
        assert_eq!(command.get_current_dir(), Some(Path::new(".")));
    }

    #[test]
    fn keeps_a_redirecting_variable_the_caller_sets() {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo folder");
        run_git(&repo, &["init", "-q"]).expect("init");
        let objects = dir.path().join("objects");
        std::fs::create_dir_all(&objects).expect("objects");
        let objects = objects.to_string_lossy().into_owned();
        let exit = run_git_env(
            &repo,
            &["rev-parse", "--git-path", "objects"],
            &[("GIT_OBJECT_DIRECTORY", objects.as_str())],
            &Cancel::never(),
        )
        .expect("ran");
        assert_eq!(
            String::from_utf8_lossy(&exit.stdout).trim(),
            objects,
            "{}",
            exit.stderr
        );
    }
}
