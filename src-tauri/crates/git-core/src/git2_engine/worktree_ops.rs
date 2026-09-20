//! The four worktree writes: add, remove, prune and lock, through the git
//! CLI with argv, the same commands the user would type. Each runs under the operation's
//! cancel flag (the child is killed) and maps git's failure to [`GitError::Cli`] with the
//! stderr, except the refusal of a dirty removal, which is [`GitError::WorktreeDirty`].
//! Nothing else in the engine writes to a repository.

use std::path::{Path, PathBuf};

use super::{normalize, worktrees, Git2Engine};
use crate::cli::{run_git_cancellable, CliExit};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{Worktree, WorktreeAdd, WorktreeBranch};

/// Runs `git <args>` in the repository's working tree and turns a non-zero status into
/// [`GitError::Cli`].
fn git(engine: &Git2Engine, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    let exit = run_git_cancellable(&GitEngine::repo(engine).root, args, cancel)?;
    if exit.status == Some(0) {
        Ok(exit)
    } else {
        Err(GitError::Cli {
            command: args.join(" "),
            status: exit.status,
            stderr: exit.stderr,
        })
    }
}

/// Adds a worktree; see [`crate::engine::GitEngine::worktree_add`].
#[tracing::instrument(level = "debug", skip_all, fields(path = %request.path.display()))]
pub(super) fn add(
    engine: &Git2Engine,
    request: &WorktreeAdd,
    cancel: &Cancel,
) -> GitResult<Worktree> {
    let path = request.path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    match &request.branch {
        WorktreeBranch::New { name, start } => {
            args.extend(["-b", name.as_str(), path.as_str(), start.as_str()]);
        }
        WorktreeBranch::Existing { name } => args.extend([path.as_str(), name.as_str()]),
        WorktreeBranch::Detached { rev } => args.extend(["--detach", path.as_str(), rev.as_str()]),
    }
    git(engine, &args, cancel)?;
    let wanted = normalize(&request.path);
    let listed = engine.worktrees(cancel)?;
    listed
        .into_iter()
        .find(|worktree| normalize(&worktree.path) == wanted)
        .ok_or_else(|| {
            GitError::Git(format!(
                "git added no worktree at {}",
                request.path.display()
            ))
        })
}

/// Removes a worktree; see [`crate::engine::GitEngine::worktree_remove`].
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display(), force))]
pub(super) fn remove(
    engine: &Git2Engine,
    path: &Path,
    force: bool,
    cancel: &Cancel,
) -> GitResult<()> {
    let path_text = path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path_text.as_str());
    match git(engine, &args, cancel) {
        Ok(_) => Ok(()),
        Err(GitError::Cli { stderr, .. }) if !force && refuses_dirty(&stderr) => {
            Err(GitError::WorktreeDirty(path.to_path_buf()))
        }
        Err(error) => Err(error),
    }
}

/// Whether git refused because the working tree has changes ("contains modified or
/// untracked files, use --force to delete it").
fn refuses_dirty(stderr: &str) -> bool {
    stderr.contains("use --force")
}

/// Prunes the worktrees whose folders are missing; see
/// [`crate::engine::GitEngine::worktree_prune`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn prune(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<PathBuf>> {
    let before: Vec<PathBuf> = engine
        .with_repo(|repo| worktrees::collect(repo, cancel))?
        .into_iter()
        .filter(|worktree| worktree.prunable)
        .map(|worktree| worktree.path)
        .collect();
    git(engine, &["worktree", "prune"], cancel)?;
    let after: Vec<PathBuf> = engine
        .with_repo(|repo| worktrees::collect(repo, cancel))?
        .into_iter()
        .map(|worktree| worktree.path)
        .collect();
    Ok(before
        .into_iter()
        .filter(|path| !after.iter().any(|kept| kept == path))
        .collect())
}

/// Locks a worktree; see [`crate::engine::GitEngine::worktree_lock`].
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
pub(super) fn lock(
    engine: &Git2Engine,
    path: &Path,
    reason: Option<&str>,
    cancel: &Cancel,
) -> GitResult<()> {
    let path_text = path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "lock"];
    if let Some(reason) = reason.filter(|reason| !reason.trim().is_empty()) {
        args.extend(["--reason", reason]);
    }
    args.push(path_text.as_str());
    git(engine, &args, cancel).map(|_| ())
}

/// Unlocks a worktree; see [`crate::engine::GitEngine::worktree_unlock`].
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
pub(super) fn unlock(engine: &Git2Engine, path: &Path, cancel: &Cancel) -> GitResult<()> {
    let path_text = path.to_string_lossy().into_owned();
    git(engine, &["worktree", "unlock", path_text.as_str()], cancel).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dirty_refusal_is_recognised_by_gits_wording() {
        assert!(refuses_dirty(
            "fatal: '/wt/x' contains modified or untracked files, use --force to delete it\n"
        ));
        assert!(!refuses_dirty("fatal: '/wt/x' is not a working tree\n"));
    }
}
