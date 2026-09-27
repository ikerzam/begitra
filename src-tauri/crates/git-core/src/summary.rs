//! One cheap read of a repository for the index: HEAD, the upstream and its counts, the
//! operation in progress, the last fetch, the tip's time and a bounded dirty flag.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use git2::{Buf, ErrorCode, Repository, StatusOptions, StatusShow};
use serde::{Deserialize, Serialize};

use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::git2_engine::{operation_of, upstream_short_name};
use crate::types::OperationState;

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
    /// The current branch's upstream, read from the branch's configuration, so a gone
    /// upstream keeps it; `None` when detached, unset, or a remote git names no upstream for
    /// (a URL in `branch.<name>.remote`).
    pub upstream: Option<Upstream>,
    /// Commits ahead of the upstream, `None` without one or when it is gone.
    pub ahead: Option<u32>,
    /// Commits behind the upstream, `None` without one or when it is gone.
    pub behind: Option<u32>,
    /// The operation the working tree is in the middle of.
    pub operation: OperationState,
    /// When this working tree last fetched, unix seconds: the modification time of
    /// `FETCH_HEAD` in its own git directory (a linked worktree has its own); `None` before
    /// any fetch.
    pub fetched_at: Option<i64>,
    /// Committer time of the tip, unix seconds; `None` when unborn.
    pub last_commit_at: Option<i64>,
    /// The tip's subject as `git log --format=%s` prints it, at most [`SUBJECT_CAP`]
    /// characters; `None` when unborn.
    pub last_commit_subject: Option<String>,
    /// Whether the working tree has changes (untracked files count); `None` when the status
    /// was cancelled before it finished.
    pub dirty: Option<bool>,
}

/// A branch's upstream as its configuration names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    /// The tracking ref's short name as `git branch -vv` shows it (`origin/main`; `main` for
    /// a local upstream).
    pub name: String,
    /// The remote a pull fetches from and a push sends to (`branch.<name>.remote`, `.` for a
    /// local upstream): the remote's own name, which the tracking ref's name does not give
    /// when the remote's name holds a slash or its fetch refspec maps elsewhere.
    pub remote: String,
    /// The upstream's branch on that remote (`branch.<name>.merge` without `refs/heads/`).
    pub branch: String,
}

/// Describes the repository at `path` for the index. Cheap parts first (HEAD, upstream, tip,
/// counts capped at [`COUNT_CAP`], the operation in progress, `FETCH_HEAD`'s time); the dirty
/// flag runs a status with untracked files and no
/// rename detection. libgit2 offers no cancel hook inside a status, so a huge working tree
/// costs its status once; `cancel` is honoured before it and makes the flag unknown after
/// it.
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
pub fn describe(path: &Path, cancel: &Cancel) -> GitResult<RepoSummary> {
    read(path, true, cancel)
}

/// [`describe`] without the dirty flag (`None`): HEAD, the upstream counts and the tip, with
/// no status of the working tree. For the open repository, whose flag nothing shows until it
/// is no longer open.
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
pub fn describe_head(path: &Path, cancel: &Cancel) -> GitResult<RepoSummary> {
    read(path, false, cancel)
}

fn read(path: &Path, with_dirty: bool, cancel: &Cancel) -> GitResult<RepoSummary> {
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
    let main_root = is_linked_worktree.then(|| crate::git2_engine::main_path(repo.commondir()));

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
    let tip_commit = tip.and_then(|oid| repo.find_commit(oid).ok());
    let last_commit_at = tip_commit.as_ref().map(|commit| commit.time().seconds());
    let last_commit_subject = tip_commit.as_ref().and_then(|commit| {
        let subject = String::from_utf8_lossy(commit.summary_bytes()?);
        Some(subject.chars().take(SUBJECT_CAP).collect())
    });

    let upstream = match current_branch.as_deref() {
        Some(branch) => upstream_of(&repo, branch)?,
        None => None,
    };
    let (ahead, behind) = match (upstream.as_ref(), tip) {
        (Some((_, tracking)), Some(local)) => upstream_counts(&repo, tracking, local, cancel)?,
        _ => (None, None),
    };
    let upstream = upstream.map(|(upstream, _)| upstream);
    let operation = operation_of(repo.state());
    let fetched_at = fetched_at(&repo);
    cancel.check()?;
    let dirty = if with_dirty {
        dirty_flag(&repo, cancel)
    } else {
        None
    };
    Ok(RepoSummary {
        root,
        name,
        is_linked_worktree,
        main_root,
        current_branch,
        detached,
        upstream,
        ahead,
        behind,
        operation,
        fetched_at,
        last_commit_at,
        last_commit_subject,
        dirty,
    })
}

/// `branch`'s upstream and the full name of its tracking ref (`refs/remotes/origin/main`)
/// from the branch's configuration, whether or not the ref exists; `None` when unset.
fn upstream_of(repo: &Repository, branch: &str) -> GitResult<Option<(Upstream, String)>> {
    let full = format!("refs/heads/{branch}");
    let Some(tracking) = setting(repo.branch_upstream_name(&full))? else {
        return Ok(None);
    };
    let Some(remote) = setting(repo.branch_upstream_remote(&full))? else {
        return Ok(None);
    };
    let Some(merge) = setting(repo.branch_upstream_merge(&full))? else {
        return Ok(None);
    };
    let upstream = Upstream {
        name: upstream_short_name(&tracking).to_owned(),
        remote,
        branch: merge
            .strip_prefix("refs/heads/")
            .unwrap_or(&merge)
            .to_owned(),
    };
    Ok(Some((upstream, tracking)))
}

/// A branch's upstream setting as text; `None` when it is unset, not UTF-8, or names no
/// remote libgit2 can look up: a URL in `branch.<name>.remote` (`gh pr checkout` of a fork
/// writes one) is `InvalidSpec`, and git shows no upstream for it either.
fn setting(read: Result<Buf, git2::Error>) -> GitResult<Option<String>> {
    match read {
        Ok(buf) => Ok(buf.as_str().ok().map(str::to_owned)),
        Err(error) if matches!(error.code(), ErrorCode::NotFound | ErrorCode::InvalidSpec) => {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

/// `(ahead, behind)` of `local` against the `upstream` ref; `None`s when the ref is gone.
fn upstream_counts(
    repo: &Repository,
    upstream: &str,
    local: git2::Oid,
    cancel: &Cancel,
) -> GitResult<(Option<u32>, Option<u32>)> {
    let target = match repo.find_reference(upstream) {
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

/// Longest subject kept for a list row, in characters: a first paragraph can run to pages.
pub const SUBJECT_CAP: usize = 200;

/// The modification time of `FETCH_HEAD` in the repository's own git directory (a linked
/// worktree's `.git/worktrees/<name>`), unix seconds; `None` when there is none.
fn fetched_at(repo: &Repository) -> Option<i64> {
    let modified = std::fs::metadata(repo.path().join("FETCH_HEAD"))
        .and_then(|meta| meta.modified())
        .ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since.as_secs()).ok()
}

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
