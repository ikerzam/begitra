//! The [`GitEngine`] trait, the [`CommitWalk`] handle and the cancellation flag passed to long
//! operations.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{GitError, GitResult};
use crate::types::{
    ChangeSet, DiffOptions, DiffTarget, Page, Ref, Repo, StatusEntry, StatusOptions, WalkOptions,
    WalkScope, Worktree,
};

/// Cooperative cancellation flag checked by long operations between units of work.
///
/// The Tauri layer bridges its runtime cancellation token to this flag so the engine stays
/// free of any async runtime dependency.
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    /// A fresh handle that is not cancelled.
    pub fn new() -> Self {
        Self::default()
    }

    /// A handle that is never cancelled.
    pub fn never() -> Self {
        Self::default()
    }

    /// Requests cancellation; operations observing this handle stop at their next check.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    /// Whether cancellation was requested.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    /// Returns [`GitError::Cancelled`] when cancellation was requested.
    pub fn check(&self) -> GitResult<()> {
        if self.is_cancelled() {
            Err(GitError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// A paged commit walk in progress.
///
/// The handle keeps the frontier of the walk and the lane layout state between pages, so
/// edges drawn across a page boundary connect. Dropping the handle releases everything.
pub trait CommitWalk: Send {
    /// Produces the next page.
    ///
    /// The last page has `done == true`; calling again after it returns an empty done page.
    /// When an object turns out to be corrupt, the page in progress is returned with the commits
    /// read so far and `done == true`, and the following call returns
    /// [`GitError::CorruptObject`]. Cancellation through `cancel` returns
    /// [`GitError::Cancelled`] within 100 ms.
    fn next_page(&mut self, cancel: &Cancel) -> GitResult<Page>;
}

/// Read-only Git operations, implemented once per backend (libgit2 first).
///
/// Every operation returns plain data from [`crate::types`], never panics on repository
/// content, and maps failures to [`GitError`] with a stable code. Long operations take a
/// [`Cancel`] handle and check it between commits, files and hunks.
pub trait GitEngine: Send + Sync {
    /// Human-readable backend name, for diagnostics.
    fn backend_name(&self) -> &'static str;

    /// The repository this engine was opened on.
    fn repo(&self) -> &Repo;

    /// Lists local branches, remote branches, tags, stashes and HEAD, with ahead and behind
    /// counts for tracking branches and the worktree where each branch is checked out.
    fn refs(&self, cancel: &Cancel) -> GitResult<Vec<Ref>>;

    /// Starts a paged walk over `scope` in the requested order; see [`CommitWalk`].
    fn walk(
        &self,
        scope: &WalkScope,
        options: &WalkOptions,
        cancel: &Cancel,
    ) -> GitResult<Box<dyn CommitWalk>>;

    /// Reports the state of every changed, untracked (and, on request, ignored) path of the
    /// working tree, respecting `.gitignore`.
    fn status(&self, options: &StatusOptions, cancel: &Cancel) -> GitResult<Vec<StatusEntry>>;

    /// Computes the diff described by `target` with hunks, intra-line spans and flags.
    fn diff(
        &self,
        target: &DiffTarget,
        options: &DiffOptions,
        cancel: &Cancel,
    ) -> GitResult<ChangeSet>;

    /// Merge base of two revisions; [`GitError::UnrelatedHistories`] when there is none.
    fn merge_base(&self, a: &str, b: &str) -> GitResult<String>;

    /// Lists the main worktree and every linked worktree.
    fn worktrees(&self, cancel: &Cancel) -> GitResult<Vec<Worktree>>;
}
