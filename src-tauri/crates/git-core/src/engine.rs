//! The [`GitEngine`] trait, the [`CommitWalk`] handle and the cancellation flag passed to long
//! operations.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{GitError, GitResult};
use crate::types::{
    BlobAt, BlobContent, ChangeSet, ChangeSetPage, CommitContext, CommitCount, CommitRequest,
    Comparison, Conflict, DiffOptions, DiffTarget, MergeMode, MergePreview, NetworkResult,
    OperationSides, OperationState, Outcome, Page, PatchSelection, Prompts, PullRequest,
    PushRequest, Ref, Remote, Repo, ResetMode, SelectionTarget, SequencerAction, Side, StashPush,
    StatusEntry, StatusOptions, SwitchTarget, WalkOptions, WalkScope, Worktree, WorktreeAdd,
};
use crate::types::{BranchToDelete, CleanupCandidates, DeleteOutcome};
use crate::types::{IgnoreOutcome, IgnorePlace, IgnoreRule};

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

/// Most files a restricted diff ([`GitEngine::diff_paths`]) returns, the size of a page of
/// the streamed diff.
pub const RESTRICTED_FILES: usize = 200;

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

    /// The diff of a working-tree target, or of the index against HEAD, restricted to
    /// `paths`: the files the full diff lists that a path covers (itself, what lies below it,
    /// and a folder entry or a submodule above it, which a change inside it moves), with the
    /// same lines and ids. git's status runs at those paths alone. `None` when that is more
    /// than [`RESTRICTED_FILES`] files: the caller computes the full diff instead.
    fn diff_paths(
        &self,
        target: &DiffTarget,
        options: &DiffOptions,
        paths: &[String],
        cancel: &Cancel,
    ) -> GitResult<Option<ChangeSet>>;

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

    /// Reads one file whole at a revision, in the index, at the merge base of two revisions
    /// or in the working tree, at most 20 MB ([`GitError::BlobTooLarge`]). An unknown path is
    /// [`GitError::RefNotFound`], and so are a path with no staged version (a conflicted one)
    /// and a submodule in the index; two revisions without a merge base are
    /// [`GitError::UnrelatedHistories`].
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

    /// Writes an ignore rule for the untracked `path` (relative to the root, as the status
    /// lists it): the path itself, its extension or its folder, as one line appended to
    /// `place` (ADR-0020), then asks git whether the path is ignored and, when it is not,
    /// which rule keeps it. A line the file already holds is not written again.
    ///
    /// # Errors
    ///
    /// [`GitError::IgnoreInvalidPath`] before anything is written for a path that is
    /// absolute, outside the working tree, missing from it or tracked, or a rule the path has
    /// nothing for; [`GitError::IgnoreWriteFailed`] when the file cannot be read or written,
    /// or would be written through a link.
    ///
    /// [`GitError::IgnoreInvalidPath`]: crate::error::GitError::IgnoreInvalidPath
    /// [`GitError::IgnoreWriteFailed`]: crate::error::GitError::IgnoreWriteFailed
    fn ignore_path(
        &self,
        path: &str,
        rule: IgnoreRule,
        place: IgnorePlace,
        cancel: &Cancel,
    ) -> GitResult<IgnoreOutcome>;

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
    /// (`git switch -c`), and taking `start` as its upstream with `track` (`--track`),
    /// whatever `branch.autoSetupMerge` says.
    fn branch_create(
        &self,
        name: &str,
        start: &str,
        checkout: bool,
        track: bool,
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

    /// Moves HEAD from `from` to `to` (full commit hashes) with the index and the working tree
    /// kept, as `git reset --soft <to>` keeps them, only while HEAD is still `from` on
    /// `branch` (a full ref name; `None` for a detached HEAD): a commit made or a branch
    /// checked out since the caller planned the move is never dropped or moved
    /// ([`GitError::HeadMoved`], and nothing moves). The branch moves by its own name, so a
    /// switch in the last moment moves nothing else; the reflogs read "reset: moving to <to>"
    /// and `ORIG_HEAD` names `from`, as after a reset. Unlike `git reset`, the messages git
    /// prepared (`MERGE_MSG`, `SQUASH_MSG`) stay. While an operation is in progress (a merge,
    /// a rebase, a cherry-pick or a revert, a paused sequence of them, a bisect, a stopped
    /// `git am`) or the index holds conflicts, it is [`GitError::HeadHeld`], where git's soft
    /// reset refuses a merge and unmerged entries only; a `to` that is not a full hash of a
    /// commit is [`GitError::RefNotFound`].
    fn move_head(
        &self,
        from: &str,
        to: &str,
        branch: Option<&str>,
        cancel: &Cancel,
    ) -> GitResult<()>;

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

    /// Deletes a tag and answers what it pointed at: the tag object of an annotated tag, which
    /// `git tag <name> <hash>` puts back whole; `None` for a symbolic tag ref.
    fn tag_delete(&self, name: &str, cancel: &Cancel) -> GitResult<Option<String>>;

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

    /// The names of the operation's two sides, from the worktree's own state files; `None`
    /// while no operation is in progress, for an octopus merge (no one name says either side),
    /// and when the state files cannot be read or name no full hash.
    fn operation_sides(&self) -> GitResult<Option<OperationSides>>;

    /// Takes each conflicted path, spelled as git lists it, whole from `side`: that side's
    /// index entry (its blob and its mode), resolved, and the file written from it; or the file
    /// deleted, resolved, where that side has none. Every path is checked before anything is
    /// written: one that is not conflicted is [`GitError::NotConflicted`], a submodule's
    /// conflict [`GitError::SubmoduleConflict`]. Once the first write went through, the others
    /// run whatever the cancel says and a failure is the error after them; a file git could not
    /// write is then resolved in the index with its old content on disk.
    ///
    /// [`GitError::NotConflicted`]: crate::error::GitError::NotConflicted
    /// [`GitError::SubmoduleConflict`]: crate::error::GitError::SubmoduleConflict
    fn take_side(&self, paths: &[String], side: Side, cancel: &Cancel) -> GitResult<()>;

    /// Puts the conflicts of `paths` (spelled as git lists them) back after a resolution, from
    /// git's resolve-undo record: the stages, and the file as git wrote it at the stop (the
    /// markers, labelled "ours" and "theirs", where both sides have it), in place of the
    /// resolution and the file there are. A path still conflicted is left as it is. Outside an
    /// operation every path is [`GitError::ConflictGone`], naming the first, before git runs;
    /// a path git holds no record of is named the same way after the others are written.
    /// Once the first run of git went through, the others run whatever the cancel says and a
    /// failure is the error after them; a run that fails leaves its paths as they were.
    ///
    /// [`GitError::ConflictGone`]: crate::error::GitError::ConflictGone
    fn restore_conflicts(&self, paths: &[String], cancel: &Cancel) -> GitResult<()>;

    /// The local branches that can go against the main branch (see [`CleanupCandidates`]): the
    /// local branch named like the one `origin/HEAD` points at, else `main`, else `master`, by
    /// the exact names git lists, and none otherwise (then no candidate: the main line is never
    /// guessed from what is checked out). A branch is listed when it is merged into the main
    /// branch or its remote-tracking upstream, or when its upstream is gone (a remote's branch
    /// or a local one), with or without its changes in the main branch, which `git merge-tree`
    /// tells with every configured merge driver made to report a conflict (a driver that keeps
    /// one side would drop the branch's changes), no lazy fetch, and its objects written to a
    /// folder of its own, not the repository's; the newest go first, and those the check has
    /// not answered within its time budget are [`CleanupReason::GoneUnchecked`]. Never
    /// listed: the current branch, the main branch, the main worktree's branch, a branch whose
    /// worktree's folder is missing, a branch git counts as in use by a rebase or a bisect in
    /// any worktree, and a symbolic ref; names compare as the disk does (`core.ignorecase`).
    /// Cancellable at any step.
    ///
    /// [`CleanupReason::GoneUnchecked`]: crate::types::CleanupReason::GoneUnchecked
    fn cleanup_candidates(&self, cancel: &Cancel) -> GitResult<CleanupCandidates>;

    /// Deletes each branch with `git branch -D`, after its worktree (`git worktree remove`, never
    /// forced: changes, untracked files or a lock keep both), only while its tip is the one given,
    /// read before the worktree goes and again before the branch does; answers each one's
    /// outcome in order, and a branch that stays never stops the others. The cancel is honoured
    /// between branches only, so a removal never stops half way: the branches not reached stay
    /// with [`KeptReason::Stopped`], and each git run is bounded by its own time limit instead.
    ///
    /// [`KeptReason::Stopped`]: crate::types::KeptReason::Stopped
    fn delete_branches(
        &self,
        branches: &[BranchToDelete],
        cancel: &Cancel,
    ) -> GitResult<Vec<DeleteOutcome>>;

    /// Continues, skips or aborts the operation in progress with its git command.
    fn sequencer(&self, action: SequencerAction, cancel: &Cancel) -> GitResult<Outcome>;

    /// The remotes with their fetch and push URLs.
    fn remotes(&self, cancel: &Cancel) -> GitResult<Vec<Remote>>;

    /// Adds a remote.
    fn remote_add(&self, name: &str, url: &str, cancel: &Cancel) -> GitResult<()>;

    /// Removes a remote.
    fn remote_remove(&self, name: &str, cancel: &Cancel) -> GitResult<()>;

    /// Fetches from a remote (every remote when `None`), git's progress lines handed to
    /// `progress` as they arrive; git's own credential prompt fails at once, and a helper's
    /// window opens only when `prompts` allows it.
    fn fetch(
        &self,
        remote: Option<&str>,
        prune: bool,
        prompts: Prompts,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<NetworkResult>;

    /// Pulls: the fetch with its progress streamed, the cancel honoured and `prompts` as in
    /// [`GitEngine::fetch`], then the merge (a fast-forward only, or the rebase, when asked)
    /// of what it brought, which no cancel interrupts; a stop on conflicts is an [`Outcome`].
    fn pull(
        &self,
        request: &PullRequest,
        prompts: Prompts,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<Outcome>;

    /// Pushes with the progress streamed and `prompts` as in [`GitEngine::fetch`]: a branch or
    /// a tag by its full ref name, or deletes one on the remote (a branch's delete with a lease
    /// on its remote-tracking ref). A rejected push, a stale lease included, is
    /// [`GitError::Cli`]; a request that names both, or a ref without a remote, is
    /// [`GitError::Git`].
    fn push(
        &self,
        request: &PushRequest,
        prompts: Prompts,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<NetworkResult>;

    /// Pushes a stash; `false` when there was nothing to save.
    fn stash_push(&self, request: &StashPush, cancel: &Cancel) -> GitResult<bool>;

    /// Applies the stash whose full commit id is `stash`, keeping it; conflicts are an
    /// [`Outcome`].
    /// The stash is named by its commit, not by its position, because a stash made or dropped
    /// elsewhere shifts the positions: one no longer in the list is
    /// [`GitError::StashNotFound`](crate::error::GitError::StashNotFound) and git does not run.
    fn stash_apply(&self, stash: &str, cancel: &Cancel) -> GitResult<Outcome>;

    /// Pops the stash whose full commit id is `stash`, wherever it is in the list now: applies
    /// it and drops it when the apply went through; on conflicts the stash is kept and the
    /// [`Outcome`] says so.
    fn stash_pop(&self, stash: &str, cancel: &Cancel) -> GitResult<Outcome>;

    /// Drops the stash whose full commit id is `stash`, wherever it is in the list now.
    fn stash_drop(&self, stash: &str, cancel: &Cancel) -> GitResult<()>;
}
