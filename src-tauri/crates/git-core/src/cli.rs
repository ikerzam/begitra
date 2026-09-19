//! Runs the system `git` with argv, never through a shell.
//!
//! Used by the operations libgit2 does not cover (network, worktree add and remove) and by
//! the tests that compare the engine with the CLI on fixture repositories.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{GitError, GitResult};

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

#[cfg(test)]
mod tests {
    use super::*;

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
