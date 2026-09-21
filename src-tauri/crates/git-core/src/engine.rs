//! The [`GitEngine`] trait, the [`CommitWalk`] handle and the cancellation flag passed to long
//! operations.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{GitError, GitResult};
use crate::types::{
    BlobAt, BlobContent, ChangeSet, ChangeSetPage, CommitContext, CommitCount, CommitRequest,
    Comparison, Conflict, DiffOptions, DiffTarget, MergeMode, MergePreview, NetworkResult,
    OperationState, Outcome, Page, PatchSelection, PullRequest, PushRequest, Ref, Remote, Repo,
    ResetMode, SelectionTarget, SequencerAction, StashPush, StatusEntry, StatusOptions,
    SwitchTarget, WalkOptions, WalkScope, Worktree, WorktreeAdd,
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

/// A change set computed page by page.
///
/// The handle keeps the delta list (renames found once) between pages and computes the
/// hunks of each page's files when asked, so the first files of a large change set reach the
/// caller before the rest are read. Dropping the handle releases everything.
pub trait DiffWalk: Send {
    /// Produces the next page; the last one has `done == true`, and calling again after it
    /// returns an empty done page. Cancellation through `cancel` returns
    /// [`GitError::Cancelled`] within one file's work.
    fn next_page(&mut self, cancel: &Cancel) -> GitResult<ChangeSetPage>;
}

/// The Git operations, implemented once per backend (libgit2 for the reads, the git CLI for
/// every write, so hooks, templates, filters and signing behave as in the user's terminal).
///
/// Every operation returns plain data from [`crate::types`], never panics on repository
/// content, and maps failures to [`GitError`] with a stable code. Long operations take a
/// [`Cancel`] handle and check it between commits, files and hunks; a write is an explicit
/// user action and runs through argv, never a shell.
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

    /// Counts the commits of `scope` up to [`crate::types::COUNT_CAP`], reporting whether the
    /// cap was hit; cancellable.
    fn count_commits(&self, scope: &WalkScope, cancel: &Cancel) -> GitResult<CommitCount>;

    /// Reports the state of every changed, untracked (and, on request, ignored) path of the
    /// working tree, respecting `.gitignore`.
    fn status(&self, options: &StatusOptions, cancel: &Cancel) -> GitResult<Vec<StatusEntry>>;

    /// Starts the diff described by `target` as pages of `page_size` files; see [`DiffWalk`].
    /// Resolving the target and listing its files happens here, so an unknown revision fails
    /// before any page.
    fn diff_pages(
        &self,
        target: &DiffTarget,
        options: &DiffOptions,
        page_size: usize,
        cancel: &Cancel,
    ) -> GitResult<Box<dyn DiffWalk>>;

    /// Computes the diff described by `target` whole, with hunks, intra-line spans and flags.
    fn diff(
        &self,
        target: &DiffTarget,
        options: &DiffOptions,
        cancel: &Cancel,
    ) -> GitResult<ChangeSet> {
        let mut walk = self.diff_pages(target, options, usize::MAX, cancel)?;
        let mut files: Vec<crate::types::FileChange> = Vec::new();
        loop {
            let page = walk.next_page(cancel)?;
            if files.is_empty() {
                files = page.files;
            } else {
                files.extend(page.files);
            }
            if page.done {
                return Ok(ChangeSet {
                    files,
                    additions: page.additions,
                    deletions: page.deletions,
                });
            }
        }
    }

    /// Merge base of two revisions; [`GitError::UnrelatedHistories`] when there is none.
    fn merge_base(&self, a: &str, b: &str) -> GitResult<String>;

    /// Both endpoints resolved, their merge base, the commits only on each side and how they
    /// relate; [`GitError::UnrelatedHistories`] without a base, [`GitError::RefNotFound`]
    /// for an endpoint that does not name a commit.
    fn compare(&self, a: &str, b: &str, cancel: &Cancel) -> GitResult<Comparison>;

    /// What merging `b` into `a` would do, through `git merge-tree` for the diverged case:
    /// nothing the user can see changes (git may store the merged result as unreferenced
    /// objects). Cancellation stops the child process and what it started.
    fn merge_preview(&self, a: &str, b: &str, cancel: &Cancel) -> GitResult<MergePreview>;

    /// Reads one file whole at a revision or in the working tree, at most 20 MB
    /// ([`GitError::BlobTooLarge`]); an unknown path is [`GitError::RefNotFound`].
    fn read_blob(&self, at: &BlobAt, path: &str) -> GitResult<BlobContent>;

    /// Lists the main worktree and every linked worktree.
    fn worktrees(&self, cancel: &Cancel) -> GitResult<Vec<Worktree>>;

    /// Adds a worktree through `git worktree add` and returns its entry; git's refusal (a
    /// branch checked out elsewhere, an existing folder, an unknown start point) is
    /// [`GitError::Cli`] with its message.
    fn worktree_add(&self, request: &WorktreeAdd, cancel: &Cancel) -> GitResult<Worktree>;

    /// Removes a worktree through `git worktree remove`; without `force`, a worktree with
    /// uncommitted changes is refused as [`GitError::WorktreeDirty`].
    fn worktree_remove(&self, path: &Path, force: bool, cancel: &Cancel) -> GitResult<()>;

    /// Unregisters the worktrees whose folders are missing (`git worktree prune`) and returns
    /// the paths that went.
    fn worktree_prune(&self, cancel: &Cancel) -> GitResult<Vec<PathBuf>>;

    /// Locks a worktree (`git worktree lock`), with a reason when given.
    fn worktree_lock(&self, path: &Path, reason: Option<&str>, cancel: &Cancel) -> GitResult<()>;

    /// Unlocks a worktree (`git worktree unlock`).
    fn worktree_unlock(&self, path: &Path, cancel: &Cancel) -> GitResult<()>;

    /// Stages paths (`git add -A` on literal pathspecs): a modification, a deletion or an
    /// untracked file alike. Paths are relative to the root, as the status reports them.
    fn stage_paths(&self, paths: &[String], cancel: &Cancel) -> GitResult<()>;

    /// Unstages paths (`git reset -q` on literal pathspecs; the empty tree on an unborn
    /// branch), leaving the working tree as it is.
    fn unstage_paths(&self, paths: &[String], cancel: &Cancel) -> GitResult<()>;

    /// Discards the unstaged changes of tracked paths (`git restore --worktree`: the index's
    /// content returns) and removes untracked ones (`git clean -f`, never an ignored file);
    /// nothing runs for an empty list.
    fn discard_paths(
        &self,
        tracked: &[String],
        untracked: &[String],
        cancel: &Cancel,
    ) -> GitResult<()>;

    /// Applies a selection of hunks and lines with `git apply`: to the index, reversed to
    /// the index, or reversed to the working tree. git checks the context, so a file that
    /// changed since the diff was taken is refused as [`GitError::Cli`] with nothing applied;
    /// a selection with no changed line selected does nothing; a selection that cannot be
    /// written (the end of the file changed without a newline and only half of that change
    /// is selected; see `git2_engine::patch::problem`) is [`GitError::Git`] and the bridge
    /// refuses it first.
    fn apply_selection(
        &self,
        selection: &PatchSelection,
        target: SelectionTarget,
        cancel: &Cancel,
    ) -> GitResult<()>;

    /// Commits the index (`git commit -F -`, the message on stdin, `--amend` and `--signoff`
    /// as asked) and returns the new HEAD's hash; hooks run and their failure is
    /// [`GitError::Cli`] with their output.
    fn commit(&self, request: &CommitRequest, cancel: &Cancel) -> GitResult<String>;

    /// The author ident, the commit template, HEAD's message and whether HEAD is unborn.
    fn commit_context(&self, cancel: &Cancel) -> GitResult<CommitContext>;

    /// Creates a branch at `start` (`git branch`), checking it out at once when asked
    /// (`git switch -c`).
    fn branch_create(
        &self,
        name: &str,
        start: &str,
        checkout: bool,
        cancel: &Cancel,
    ) -> GitResult<()>;

    /// Switches to a branch or a detached revision (`git switch`); git's refusal when local
    /// changes would be overwritten is [`GitError::Cli`] with its message and nothing changes.
    fn switch(&self, target: &SwitchTarget, cancel: &Cancel) -> GitResult<()>;

    /// Renames a branch (`git branch -m`).
    fn branch_rename(&self, from: &str, to: &str, cancel: &Cancel) -> GitResult<()>;

    /// Deletes a branch (`git branch -d`, `-D` when forced); git's refusal of an unmerged
    /// branch is [`GitError::Cli`].
    fn branch_delete(&self, name: &str, force: bool, cancel: &Cancel) -> GitResult<()>;

    /// Merges a revision into HEAD; a stop on conflicts is an [`Outcome`], not an error.
    fn merge(&self, rev: &str, mode: MergeMode, cancel: &Cancel) -> GitResult<Outcome>;

    /// Rebases HEAD onto a revision, never interactively.
    fn rebase(&self, onto: &str, cancel: &Cancel) -> GitResult<Outcome>;

    /// Resets HEAD (`--soft`, `--mixed`, `--hard`); the reflog keeps the previous HEAD.
    fn reset(&self, rev: &str, mode: ResetMode, cancel: &Cancel) -> GitResult<()>;

    /// Cherry-picks revisions onto HEAD.
    fn cherry_pick(&self, revs: &[String], cancel: &Cancel) -> GitResult<Outcome>;

    /// Reverts revisions (`--no-edit`).
    fn revert(&self, revs: &[String], cancel: &Cancel) -> GitResult<Outcome>;

    /// Creates a tag at a revision, annotated when a message is given.
    fn tag_create(
        &self,
        name: &str,
        rev: &str,
        message: Option<&str>,
        cancel: &Cancel,
    ) -> GitResult<()>;

    /// Deletes a tag.
    fn tag_delete(&self, name: &str, cancel: &Cancel) -> GitResult<()>;

    /// Sets a branch's upstream, or unsets it with `None`.
    fn set_upstream(&self, branch: &str, upstream: Option<&str>, cancel: &Cancel) -> GitResult<()>;

    /// What the repository is in the middle of, from its state files.
    fn operation_state(&self) -> GitResult<OperationState>;

    /// The conflicted paths with their kinds, from `git status --porcelain=v2`.
    fn conflicts(&self, cancel: &Cancel) -> GitResult<Vec<Conflict>>;

    /// Marks conflicted paths resolved: `git add`, as git itself asks for.
    fn mark_resolved(&self, paths: &[String], cancel: &Cancel) -> GitResult<()> {
        self.stage_paths(paths, cancel)
    }

    /// Continues, skips or aborts the operation in progress with its git command.
    fn sequencer(&self, action: SequencerAction, cancel: &Cancel) -> GitResult<Outcome>;

    /// The remotes with their fetch and push URLs.
    fn remotes(&self, cancel: &Cancel) -> GitResult<Vec<Remote>>;

    /// Adds a remote.
    fn remote_add(&self, name: &str, url: &str, cancel: &Cancel) -> GitResult<()>;

    /// Removes a remote.
    fn remote_remove(&self, name: &str, cancel: &Cancel) -> GitResult<()>;

    /// Fetches from a remote (every remote when `None`), git's progress lines handed to
    /// `progress` as they arrive; git's own credential prompt fails at once.
    fn fetch(
        &self,
        remote: Option<&str>,
        prune: bool,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<NetworkResult>;

    /// Pulls: the fetch with its progress streamed and the cancel honoured, then the merge
    /// (or the rebase, when asked) of what it brought, which no cancel interrupts; a stop
    /// on conflicts is an [`Outcome`].
    fn pull(
        &self,
        request: &PullRequest,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<Outcome>;

    /// Pushes with the progress streamed; a rejected push is [`GitError::Cli`].
    fn push(
        &self,
        request: &PushRequest,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<NetworkResult>;

    /// Pushes a stash; `false` when there was nothing to save.
    fn stash_push(&self, request: &StashPush, cancel: &Cancel) -> GitResult<bool>;

    /// Applies `stash@{index}`, keeping it; conflicts are an [`Outcome`].
    fn stash_apply(&self, index: u32, cancel: &Cancel) -> GitResult<Outcome>;

    /// Pops `stash@{index}`; on conflicts the stash is kept and the [`Outcome`] says so.
    fn stash_pop(&self, index: u32, cancel: &Cancel) -> GitResult<Outcome>;

    /// Drops `stash@{index}`.
    fn stash_drop(&self, index: u32, cancel: &Cancel) -> GitResult<()>;
}
