//! libgit2 implementation of [`GitEngine`].
//!
//! One submodule per operation family (`refs`, `walk`, `status`, `diff`, `worktrees`); this
//! module owns the repository handle and the `open` logic.

mod diff;
mod refs;
mod status;
mod walk;
mod worktrees;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use git2::Repository;

use crate::engine::{Cancel, CommitWalk, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{
    ChangeSet, DiffOptions, DiffTarget, Ref, Repo, StatusEntry, StatusOptions, WalkOptions,
    WalkScope, Worktree,
};

/// A repository opened with libgit2.
///
/// libgit2 handles are not thread-safe, so the repository sits behind a mutex and every
/// operation runs while holding it; walks open their own handle (see [`CommitWalk`]).
pub struct Git2Engine {
    info: Repo,
    repo: Mutex<Repository>,
}

impl std::fmt::Debug for Git2Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Git2Engine")
            .field("info", &self.info)
            .finish_non_exhaustive()
    }
}

impl Git2Engine {
    /// Opens the repository that contains `path`: the repository root, a linked worktree, or
    /// any directory inside either.
    ///
    /// Fails with [`GitError::NotFound`] when no repository is found at or above the path and
    /// with [`GitError::Invalid`] when one is found but cannot be opened (a bare repository
    /// counts as invalid for now: there is no working tree to show).
    #[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
    pub fn open(path: &Path) -> GitResult<Self> {
        let repo = Repository::discover(path).map_err(|error| match error.code() {
            git2::ErrorCode::NotFound => GitError::NotFound(path.to_path_buf()),
            _ => GitError::Invalid {
                path: path.to_path_buf(),
                reason: error.message().to_owned(),
            },
        })?;
        let info = describe(&repo, path)?;
        Ok(Self {
            info,
            repo: Mutex::new(repo),
        })
    }

    /// Runs `f` with the underlying libgit2 repository, serialised by the mutex.
    ///
    /// Operation modules and benchmarks use this; the handle must not escape the closure.
    pub fn with_repo<T>(&self, f: impl FnOnce(&Repository) -> GitResult<T>) -> GitResult<T> {
        let repo = self
            .repo
            .lock()
            .map_err(|_| GitError::Git("repository lock poisoned".to_owned()))?;
        f(&repo)
    }
}

impl GitEngine for Git2Engine {
    fn backend_name(&self) -> &'static str {
        "git2"
    }

    fn repo(&self) -> &Repo {
        &self.info
    }

    fn refs(&self, cancel: &Cancel) -> GitResult<Vec<Ref>> {
        refs::list(self, cancel)
    }

    fn walk(
        &self,
        scope: &WalkScope,
        options: &WalkOptions,
        cancel: &Cancel,
    ) -> GitResult<Box<dyn CommitWalk>> {
        walk::start(self, scope, options, cancel)
    }

    fn status(&self, options: &StatusOptions, cancel: &Cancel) -> GitResult<Vec<StatusEntry>> {
        status::list(self, options, cancel)
    }

    fn diff(
        &self,
        target: &DiffTarget,
        options: &DiffOptions,
        cancel: &Cancel,
    ) -> GitResult<ChangeSet> {
        diff::compute(self, target, options, cancel)
    }

    fn merge_base(&self, a: &str, b: &str) -> GitResult<String> {
        refs::merge_base(self, a, b)
    }

    fn worktrees(&self, cancel: &Cancel) -> GitResult<Vec<Worktree>> {
        worktrees::list(self, cancel)
    }
}

/// Builds the [`Repo`] description of an opened repository.
fn describe(repo: &Repository, opened: &Path) -> GitResult<Repo> {
    let workdir = repo.workdir().ok_or_else(|| GitError::Invalid {
        path: opened.to_path_buf(),
        reason: "bare repositories are not supported".to_owned(),
    })?;
    let (current_branch, detached) = head_state(repo)?;
    Ok(Repo {
        root: normalize(workdir),
        common_dir: normalize(repo.commondir()),
        current_branch,
        detached,
        is_linked_worktree: repo.is_worktree(),
    })
}

/// Current branch name and whether HEAD is detached, from the `HEAD` reference itself so an
/// unborn branch still reports its name.
fn head_state(repo: &Repository) -> GitResult<(Option<String>, bool)> {
    let head = repo.find_reference("HEAD")?;
    match head.symbolic_target()? {
        Some(target) => {
            let name = target.strip_prefix("refs/heads/").unwrap_or(target);
            Ok((Some(name.to_owned()), false))
        }
        None => Ok((None, true)),
    }
}

/// Rebuilds a path from its components, dropping trailing separators and using the platform
/// separator, so paths compare equal however libgit2 spelled them.
fn normalize(path: &Path) -> PathBuf {
    path.components().collect()
}
