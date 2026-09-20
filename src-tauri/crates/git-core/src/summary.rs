//! One cheap read of a repository for the index: HEAD, upstream counts, the tip's time and
//! a bounded dirty flag.

use std::path::{Path, PathBuf};

use git2::{ErrorCode, Repository, StatusOptions, StatusShow};
use serde::{Deserialize, Serialize};

use crate::engine::Cancel;
use crate::error::{GitError, GitResult};

/// The state of a repository as the index shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    /// Working tree root as libgit2 reports it.
    pub root: PathBuf,
    /// Folder name of the root.
    pub name: String,
    /// Whether this is a linked worktree; `main_root` then names its repository.
    pub is_linked_worktree: bool,
    /// The working tree of the repository that owns this worktree.
    pub main_root: Option<PathBuf>,
    /// Current branch, `None` when HEAD is detached or unborn.
    pub current_branch: Option<String>,
    /// Whether HEAD is detached.
    pub detached: bool,
    /// Commits ahead of the upstream, `None` without one.
    pub ahead: Option<u32>,
    /// Commits behind the upstream, `None` without one.
    pub behind: Option<u32>,
    /// Committer time of the tip, unix seconds; `None` when unborn.
    pub last_commit_at: Option<i64>,
    /// Whether the working tree has changes (untracked files count); `None` when the status
    /// was cancelled before it finished.
    pub dirty: Option<bool>,
}

/// Describes the repository at `path` for the index. Cheap parts first (HEAD, upstream, tip,
/// counts capped at [`COUNT_CAP`]); the dirty flag runs a status with untracked files and no
/// rename detection. libgit2 offers no cancel hook inside a status, so a huge working tree
/// costs its status once; `cancel` is honoured before it and makes the flag unknown after
/// it.
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
pub fn describe(path: &Path, cancel: &Cancel) -> GitResult<RepoSummary> {
    let repo = Repository::open(path).map_err(|error| match error.code() {
        ErrorCode::NotFound => GitError::NotFound(path.to_path_buf()),
        _ => GitError::Invalid {
            path: path.to_path_buf(),
            reason: error.message().to_owned(),
        },
    })?;
    let workdir = repo.workdir().ok_or_else(|| GitError::Invalid {
        path: path.to_path_buf(),
        reason: "bare repositories are not supported".to_owned(),
    })?;
    let root: PathBuf = workdir.components().collect();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned());
    let is_linked_worktree = repo.is_worktree();
    let main_root = if is_linked_worktree {
        let common: PathBuf = repo.commondir().components().collect();
        common.parent().map(Path::to_path_buf)
    } else {
        None
    };

    let head = repo.find_reference("HEAD")?;
    let (current_branch, detached) = match head.symbolic_target()? {
        Some(target) => (
            Some(
                target
                    .strip_prefix("refs/heads/")
                    .unwrap_or(target)
                    .to_owned(),
            ),
            false,
        ),
        None => (None, true),
    };
    let tip = head.resolve().ok().and_then(|direct| direct.target());
    let last_commit_at = tip
        .and_then(|oid| repo.find_commit(oid).ok())
        .map(|commit| commit.time().seconds());

    let (ahead, behind) = match (current_branch.as_deref(), tip) {
        (Some(branch), Some(local)) => upstream_counts(&repo, branch, local, cancel)?,
        _ => (None, None),
    };
    cancel.check()?;
    let dirty = dirty_flag(&repo, cancel);
    Ok(RepoSummary {
        root,
        name,
        is_linked_worktree,
        main_root,
        current_branch,
        detached,
        ahead,
        behind,
        last_commit_at,
        dirty,
    })
}

/// `(ahead, behind)` of `branch` against its upstream; `None`s without an upstream or when
/// the upstream ref is gone.
fn upstream_counts(
    repo: &Repository,
    branch: &str,
    local: git2::Oid,
    cancel: &Cancel,
) -> GitResult<(Option<u32>, Option<u32>)> {
    let full_name = format!("refs/heads/{branch}");
    let upstream = match repo.branch_upstream_name(&full_name) {
        Ok(buf) => match buf.as_str() {
            Ok(name) => name.to_owned(),
            Err(_) => return Ok((None, None)),
        },
        Err(error) if error.code() == ErrorCode::NotFound => return Ok((None, None)),
        Err(error) => return Err(error.into()),
    };
    let target = match repo.find_reference(&upstream) {
        Ok(reference) => reference.resolve().ok().and_then(|r| r.target()),
        Err(error) if error.code() == ErrorCode::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let Some(target) = target else {
        return Ok((None, None));
    };
    let ahead = bounded_count(repo, local, target, cancel)?;
    let behind = bounded_count(repo, target, local, cancel)?;
    Ok((Some(ahead), Some(behind)))
}

/// Commits reachable from `from` and not from `hide`, counted at most up to
/// [`COUNT_CAP`] (a stale fork diverged by a million commits is not worth walking for a
/// list), checking the cancel flag every thousand commits.
fn bounded_count(
    repo: &Repository,
    from: git2::Oid,
    hide: git2::Oid,
    cancel: &Cancel,
) -> GitResult<u32> {
    let mut walk = repo.revwalk()?;
    walk.push(from)?;
    walk.hide(hide)?;
    let mut count: u32 = 0;
    for step in walk {
        step?;
        count += 1;
        if count >= COUNT_CAP {
            break;
        }
        if count.is_multiple_of(1_000) {
            cancel.check()?;
        }
    }
    Ok(count)
}

/// Most commits counted on either side of an upstream comparison.
pub const COUNT_CAP: u32 = 100_000;

/// Whether the working tree has any change; `None` when the status was cancelled or failed.
fn dirty_flag(repo: &Repository, cancel: &Cancel) -> Option<bool> {
    let mut options = StatusOptions::new();
    options
        .show(StatusShow::IndexAndWorkdir)
        .include_untracked(true)
        .recurse_untracked_dirs(false)
        .exclude_submodules(true)
        .renames_head_to_index(false)
        .renames_index_to_workdir(false)
        .no_refresh(false);
    if cancel.is_cancelled() {
        return None;
    }
    let statuses = repo.statuses(Some(&mut options)).ok()?;
    if cancel.is_cancelled() {
        return None;
    }
    Some(!statuses.is_empty())
}
