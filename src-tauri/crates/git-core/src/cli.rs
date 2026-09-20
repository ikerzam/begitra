//! Runs the system `git` with argv, never through a shell.
//!
//! Used by the operations libgit2 does not cover (network, worktree add and remove) and by
//! the tests that compare the engine with the CLI on fixture repositories.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::engine::Cancel;
use crate::error::{GitError, GitResult};

/// How often a cancellable run polls the flag while git works.
const CANCEL_POLL: Duration = Duration::from_millis(50);

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
    let mut command = Command::new("git");
    command.args(args).current_dir(cwd).stdin(Stdio::null());
    for var in REDIRECTING_VARS {
        command.env_remove(var);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
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
/// kills git and returns [`GitError::Cancelled`]. Both pipes are drained by their own threads
/// so git never blocks on a full one. The exit status is returned, not judged: callers that
/// give a meaning to a non-zero status (`merge-tree` exits 1 on conflicts) read it here.
pub fn run_git_cancellable(cwd: &Path, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    let joined = args.join(" ");
    cancel.check()?;
    let mut child = command(cwd, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| GitError::Cli {
            command: joined.clone(),
            status: None,
            stderr: format!("could not start git: {error}"),
        })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stdout {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });
    let err_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if cancel.is_cancelled() {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_reader.join();
                    let _ = err_reader.join();
                    return Err(GitError::Cancelled);
                }
                thread::sleep(CANCEL_POLL);
            }
            Err(error) => {
                let _ = child.kill();
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
