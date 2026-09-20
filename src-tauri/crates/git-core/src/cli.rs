//! Runs the system `git` with argv, never through a shell.
//!
//! Used by the operations libgit2 does not cover (path history, the merge preview, the
//! worktree writes, the status) and by the tests that compare the engine with the CLI on
//! fixture repositories. The executable is `git` on PATH until the settings name another
//! ([`set_git_executable`]); [`detect_git`] finds one for them.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::Duration;

use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::GitDetection;

/// The executable every CLI call runs; `None` is `git` on PATH.
static GIT_EXECUTABLE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// The git executable the CLI runs now.
pub fn git_executable() -> PathBuf {
    GIT_EXECUTABLE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| PathBuf::from("git"))
}

/// Makes every later CLI call run `path` (or `git` on PATH again for `None`), once
/// `<path> --version` has answered; a program that does not is refused with
/// [`GitError::Cli`] and the executable in use stays.
pub fn set_git_executable(path: Option<&Path>) -> GitResult<GitDetection> {
    let candidate = path.map_or_else(|| PathBuf::from("git"), Path::to_path_buf);
    let version = probe_git(&candidate)?;
    *GIT_EXECUTABLE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = path.map(Path::to_path_buf);
    Ok(GitDetection {
        path: candidate,
        version,
    })
}

/// Runs `<candidate> --version` and returns its first line, or [`GitError::Cli`] when the
/// program cannot be started, fails, or does not answer like git.
pub fn probe_git(candidate: &Path) -> GitResult<String> {
    let text = candidate.to_string_lossy().into_owned();
    let failed = |stderr: String| GitError::Cli {
        command: format!("{text} --version"),
        status: None,
        stderr,
    };
    let mut command = Command::new(candidate);
    command.arg("--version").stdin(Stdio::null());
    for var in REDIRECTING_VARS {
        command.env_remove(var);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|error| failed(format!("could not start {text}: {error}")))?;
    if !output.status.success() {
        return Err(GitError::Cli {
            command: format!("{text} --version"),
            status: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    let first = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !first.starts_with("git version ") {
        return Err(failed(format!("{text} is not git: it printed {first:?}")));
    }
    Ok(first)
}

/// Looks for git: the configured executable, then `git` on PATH, then the platform's common
/// locations; the first one whose `--version` answers wins.
pub fn detect_git() -> GitResult<GitDetection> {
    let mut candidates = vec![git_executable(), PathBuf::from("git")];
    candidates.extend(common_locations());
    let mut last = None;
    for candidate in candidates {
        match probe_git(&candidate) {
            Ok(version) => {
                return Ok(GitDetection {
                    path: candidate,
                    version,
                })
            }
            Err(error) => last = Some(error),
        }
    }
    Err(last.unwrap_or_else(|| GitError::Cli {
        command: "git --version".to_owned(),
        status: None,
        stderr: "no git found".to_owned(),
    }))
}

/// Where installers put git when it is not on PATH.
fn common_locations() -> Vec<PathBuf> {
    let mut found = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var) {
                let base = PathBuf::from(base);
                found.push(base.join("Git").join("cmd").join("git.exe"));
                found.push(
                    base.join("Programs")
                        .join("Git")
                        .join("cmd")
                        .join("git.exe"),
                );
            }
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
    command.args(args).current_dir(cwd).stdin(Stdio::null());
    for var in REDIRECTING_VARS {
        command.env_remove(var);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
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
/// on the cancel path. Elsewhere the child is killed; a helper it spawned (a hook, an alias
/// shell) ends on its own when its parent is gone.
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
    let output = command(cwd, args).output().map_err(|error| GitError::Cli {
        command: joined.clone(),
        status: None,
        stderr: format!("could not start git: {error}"),
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
/// it here.
pub fn run_git_cancellable(cwd: &Path, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    let joined = args.join(" ");
    let start_failed = |what: &str, error: &dyn std::fmt::Display| GitError::Cli {
        command: joined.clone(),
        status: None,
        stderr: format!("could not start {what}: {error}"),
    };
    cancel.check()?;
    let mut child = command(cwd, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| start_failed("git", &error))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_reader = thread::Builder::new()
        .name("begira-git-out".to_owned())
        .spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = stdout {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        });
    let out_reader = match out_reader {
        Ok(reader) => reader,
        Err(error) => {
            abort(child);
            return Err(start_failed("the output thread", &error));
        }
    };
    let err_reader = thread::Builder::new()
        .name("begira-git-err".to_owned())
        .spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = stderr {
                let _ = pipe.read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).into_owned()
        });
    let err_reader = match err_reader {
        Ok(reader) => reader,
        Err(error) => {
            abort(child);
            return Err(start_failed("the error thread", &error));
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
                thread::sleep(CANCEL_POLL);
            }
            Err(error) => {
                abort(child);
                return Err(GitError::Cli {
                    command: joined,
                    status: None,
                    stderr: format!("could not wait for git: {error}"),
                });
            }
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(CliExit {
        status: status.code(),
        stdout,
        stderr,
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
        let version = probe_git(Path::new("git")).expect("git is installed");
        assert!(version.starts_with("git version "));
        let detected = detect_git().expect("detected");
        assert!(detected.version.starts_with("git version "));
        // A program that exists but is not git, and one that does not exist.
        let not_git = if cfg!(windows) { "cmd" } else { "sh" };
        let refused = probe_git(Path::new(not_git)).expect_err("not git");
        assert_eq!(refused.code(), "git.cli_failed");
        let missing = probe_git(Path::new("no-such-git-binary-for-tests")).expect_err("missing");
        assert!(matches!(missing, GitError::Cli { status: None, .. }));
        // Refusing keeps the executable in use.
        let before = git_executable();
        assert!(set_git_executable(Some(Path::new("no-such-git-binary-for-tests"))).is_err());
        assert_eq!(git_executable(), before);
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
