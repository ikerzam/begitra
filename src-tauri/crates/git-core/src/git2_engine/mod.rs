//! libgit2 implementation of [`GitEngine`].
//!
//! One submodule per operation family (`refs`, `walk`, `count`, `status`, `diff`, `blob`,
//! `compare`, `worktrees`, `worktree_ops`, `staging` with `patch`); this module owns the
//! repository handle and the `open` logic.

mod blob;
mod branches;
mod cleanup;
mod cli_walk;
mod compare;
mod contains;
mod count;
mod diff;
mod diff_pages;
mod filter;
mod ignore;
pub mod index_snapshot;
pub mod patch;
mod recent;
mod refs;
mod remotes;
mod sequencer;
mod sides;
mod staging;
mod stash;
mod status;
mod status_porcelain;
mod walk;
mod worktree_ops;
mod worktrees;

pub(crate) use refs::upstream_short_name;
pub(crate) use sequencer::operation_of;
pub(crate) use worktrees::main_path;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use git2::{ErrorClass, ErrorCode, Oid, Repository, RepositoryOpenFlags};

use crate::engine::{Cancel, CommitWalk, DiffWalk, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{
    BlobAt, BlobContent, ChangeSet, CommitContext, CommitCount, CommitRequest, Comparison,
    Conflict, DiffOptions, DiffTarget, MergeMode, MergePreview, NetworkResult, OperationSides,
    OperationState, Outcome, PatchSelection, Prompts, PullRequest, PushRequest, Ref, Remote, Repo,
    ResetMode, SelectionTarget, SequencerAction, Side, StashPush, StatusEntry, StatusOptions,
    SwitchTarget, WalkOptions, WalkScope, Worktree, WorktreeAdd,
};
use crate::types::{BranchToDelete, CleanupCandidates, DeleteOutcome};
use crate::types::{IgnoreOutcome, IgnorePlace, IgnoreRule};

/// A repository opened with libgit2.
///
/// libgit2 handles are not thread-safe, so the repository sits behind a mutex and every
/// operation runs while holding it; walks open their own handle (see [`CommitWalk`]).
pub struct Git2Engine {
    info: Repo,
    repo: Mutex<Repository>,
    /// Whether some attributes file names `linguist-generated`, keyed by the index file's
    /// modification time: reading the index of a large repository costs a hundred
    /// milliseconds, and the verdict rarely changes.
    generated_attributes: Mutex<Option<(Vec<Option<std::time::SystemTime>>, bool)>>,
    /// Idle diff workers, each with a repository handle of its own (see `diff_pages`).
    diff_workers: diff_pages::WorkerPool,
    /// The handle the comparison counts walk on, opened on the first comparison and kept
    /// so its object cache stays warm (see `compare`).
    counts: Mutex<Option<Repository>>,
    /// The merge base of the last pair of commits asked for (see [`Self::merge_base_of`]).
    merge_base: Mutex<Option<((Oid, Oid), Oid)>>,
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
    /// with [`GitError::Invalid`] when one is found but cannot be opened: a bare repository,
    /// which has no working tree to show, and a git directory opened by its own path whose
    /// working tree lives elsewhere.
    #[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
    pub fn open(path: &Path) -> GitResult<Self> {
        // Not `Repository::discover`, which opens the git directory it finds by that
        // directory's own path: libgit2 then takes the directory's parent as the working tree,
        // a folder that holds none of it when the directory lives elsewhere
        // (`--separate-git-dir`), where a `.git` file names it from the working tree.
        let repo = Repository::open_ext(
            path,
            RepositoryOpenFlags::CROSS_FS,
            std::iter::empty::<&std::ffi::OsStr>(),
        )
        .map_err(|error| match error.code() {
            git2::ErrorCode::NotFound => GitError::NotFound(path.to_path_buf()),
            _ => GitError::Invalid {
                path: path.to_path_buf(),
                reason: error.message().to_owned(),
            },
        })?;
        check_working_tree(&repo, path)?;
        let info = describe(&repo, path)?;
        Ok(Self {
            info,
            repo: Mutex::new(repo),
            generated_attributes: Mutex::new(None),
            diff_workers: diff_pages::new_pool(),
            counts: Mutex::new(None),
            merge_base: Mutex::new(None),
        })
    }

    /// The working tree status through libgit2, the fallback of [`GitEngine::status`] when git
    /// cannot be started; public so the benchmarks and the tests can compare both paths.
    pub fn status_through_libgit2(
        &self,
        options: &StatusOptions,
        cancel: &Cancel,
    ) -> GitResult<Vec<StatusEntry>> {
        status::list_libgit2(self, options, cancel)
    }

    /// Runs `f` on the comparison handle, opened at `location` on first use.
    pub(crate) fn with_counts_repo<T>(
        &self,
        location: &Location,
        f: impl FnOnce(&Repository) -> GitResult<T>,
    ) -> GitResult<T> {
        let mut slot = self
            .counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(location.reopen()?);
        }
        match slot.as_ref() {
            Some(repo) => f(repo),
            None => Err(GitError::Git("no comparison handle".to_owned())),
        }
    }

    /// The pool of idle diff workers.
    fn diff_workers(&self) -> diff_pages::WorkerPool {
        std::sync::Arc::clone(&self.diff_workers)
    }

    /// Whether any attributes file git would consult names `linguist-generated`, cached
    /// until one of its sources changes: the index (the tracked `.gitattributes` files),
    /// `$GIT_DIR/info/attributes` and the `core.attributesfile` of the configuration.
    pub(crate) fn generated_attributes_present(&self) -> bool {
        let stamp = self
            .with_repo(|repo| Ok(diff::attribute_sources(repo)))
            .map(|files| {
                files
                    .iter()
                    .map(|file| {
                        std::fs::metadata(file)
                            .ok()
                            .and_then(|metadata| metadata.modified().ok())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut cache = self
            .generated_attributes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((known, present)) = cache.as_ref() {
            if *known == stamp && stamp.iter().any(Option::is_some) {
                return *present;
            }
        }
        let present = self
            .with_repo(|repo| Ok(diff::generated_attributes_present(repo)))
            .unwrap_or(false);
        *cache = Some((stamp, present));
        present
    }

    /// Runs `f` with the underlying libgit2 repository, serialised by the mutex.
    ///
    /// Operation modules and benchmarks use this; the handle must not escape the closure. A
    /// panic in an earlier closure poisons the mutex, but the repository handle itself is
    /// still usable, so the lock is recovered rather than failing every later operation.
    pub fn with_repo<T>(&self, f: impl FnOnce(&Repository) -> GitResult<T>) -> GitResult<T> {
        let repo = self
            .repo
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&repo)
    }

    /// Forgets the remembered merge base, so the next one is computed again: for a
    /// benchmark that repeats one pair and must time the walk rather than the lookup.
    pub fn forget_merge_base(&self) {
        *self
            .merge_base
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// The merge base of two commits through `repo`, remembered for the last pair: the
    /// comparison, its three-dot diff and every file of it read at its merge base ask for
    /// the same one, and the walk costs seconds between distant commits of a large history.
    /// Commits never change, so the entry cannot go stale; a branch name is resolved to its
    /// commit before this. The pair is kept in order: when two merge bases tie, libgit2's
    /// pick depends on it, and a swapped comparison must get its own.
    fn merge_base_of(&self, repo: &Repository, one: Oid, two: Oid) -> Result<Oid, git2::Error> {
        let key = (one, two);
        let remembered = |cache: &Option<((Oid, Oid), Oid)>| {
            cache.and_then(|(pair, base)| (pair == key).then_some(base))
        };
        let lock = || {
            self.merge_base
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        };
        if let Some(base) = remembered(&lock()) {
            return Ok(base);
        }
        let base = repo.merge_base(one, two)?;
        *lock() = Some((key, base));
        Ok(base)
    }

    /// The repository's own git directory and the shared one (equal for a main repository;
    /// `<owner>/.git/worktrees/<name>` and `<owner>/.git` for a linked worktree), for
    /// watchers and other callers that need the metadata paths.
    pub fn git_dirs(&self) -> (PathBuf, PathBuf) {
        self.with_repo(|repo| Ok((normalize(repo.path()), normalize(repo.commondir()))))
            .unwrap_or_else(|_| {
                let gitdir = self.info.root.join(".git");
                (gitdir.clone(), gitdir)
            })
    }

    /// Which of the top-level `names` hold a tracked path in the index, in the order given: a
    /// tracked file of that name (a `build` script), or tracked files under a folder of that
    /// name. The watcher ignores build and cache folders except those whose files are
    /// committed (the `dist/` of an action, a vendored `node_modules/`).
    pub fn tracked_names(&self, names: &[&str]) -> GitResult<Vec<String>> {
        self.with_repo(|repo| {
            let mut index = repo.index()?;
            // The handle keeps the index it loaded first; `read` reloads it when the file
            // changed since (a `dist/` committed after the repository was opened).
            index.read(false)?;
            // Entries sort by path bytes, so the first one that starts with a name is the file
            // of that name when there is one (`build` sorts before `build.sh` and `build/…`).
            let file = |name: &str| {
                index
                    .find_prefix(name.as_bytes())
                    .ok()
                    .and_then(|position| index.get(position))
                    .is_some_and(|entry| entry.path == name.as_bytes())
            };
            Ok(names
                .iter()
                .filter(|name| {
                    file(name) || index.find_prefix(format!("{name}/").as_bytes()).is_ok()
                })
                .map(|name| (*name).to_owned())
                .collect())
        })
    }

    /// The repository description with the current HEAD state, read now rather than at open
    /// time, so a branch switched outside the app is reported on the next open.
    pub fn describe_now(&self) -> GitResult<Repo> {
        self.with_repo(|repo| {
            let (current_branch, detached) = head_state(repo)?;
            Ok(Repo {
                current_branch,
                detached,
                ..self.info.clone()
            })
        })
    }
}

/// Opens a second handle on the repository `repo` was opened from, for work that must not
/// hold the engine's mutex (walks, parallel counts).
pub(crate) fn reopen(repo: &Repository) -> GitResult<Repository> {
    Location::of(repo).reopen()
}

/// Where a handle was opened: the git directory libgit2 opened and the working tree, for
/// threads that cannot borrow the handle and open their own.
#[derive(Clone, Debug)]
pub(crate) struct Location {
    gitdir: PathBuf,
    workdir: Option<PathBuf>,
}

impl Location {
    pub(crate) fn of(repo: &Repository) -> Self {
        Self {
            gitdir: repo.path().to_path_buf(),
            workdir: repo.workdir().map(Path::to_path_buf),
        }
    }

    /// A new handle on the same repository, opened as the first one was: from the working
    /// tree whose `.git` names the directory, so libgit2 knows that working tree and checks
    /// its owner. A git directory opened by its own path takes its parent as the working tree,
    /// which a `--separate-git-dir` one is not, and checks that folder's owner instead. A
    /// working tree with no `.git` naming the directory (one `core.worktree` names, one
    /// deleted meanwhile) reopens from the directory, whose configuration names its working
    /// tree.
    pub(crate) fn reopen(&self) -> GitResult<Repository> {
        if let Some(workdir) = &self.workdir {
            let from_tree = Repository::open_ext(
                workdir,
                RepositoryOpenFlags::NO_SEARCH,
                std::iter::empty::<&std::ffi::OsStr>(),
            );
            if let Ok(repo) = from_tree {
                if normalize(repo.path()) == normalize(&self.gitdir) {
                    return Ok(repo);
                }
            }
        }
        Repository::open(&self.gitdir).map_err(|error| match error.code() {
            ErrorCode::NotFound => GitError::NotFound(self.gitdir.clone()),
            _ => GitError::Invalid {
                path: self.gitdir.clone(),
                reason: error.message().to_owned(),
            },
        })
    }
}

/// Refuses a git directory opened by its own path whose working tree libgit2 can only guess.
/// libgit2 takes the directory's parent, which is the working tree of a `.git` folder but not
/// of a git directory that lives elsewhere (`--separate-git-dir`): there the status would read
/// every tracked file as deleted and the directory's own files as untracked, and git refuses
/// to run ("must be run in a work tree"). A linked worktree's directory names its working
/// tree, and so does `core.worktree`.
pub(crate) fn check_working_tree(repo: &Repository, opened: &Path) -> GitResult<()> {
    let gitdir = repo.path();
    if repo.workdir().is_none()
        || repo.is_worktree()
        || gitdir.file_name() == Some(std::ffi::OsStr::new(".git"))
    {
        return Ok(());
    }
    // Whether the path opened lies in the git directory: on disk when both resolve (a link,
    // a `\\?\` prefix), as spelled otherwise.
    let inside = match (std::fs::canonicalize(gitdir), std::fs::canonicalize(opened)) {
        (Ok(gitdir), Ok(opened)) => opened.starts_with(gitdir),
        _ => normalize(opened).starts_with(normalize(gitdir)),
    };
    // An entry, not the value: git2 panics on a path setting that is not UTF-8 on Windows.
    let named = repo
        .config()
        .and_then(|config| config.get_entry("core.worktree").map(|_| ()))
        .is_ok();
    if !inside || named {
        return Ok(());
    }
    Err(GitError::Invalid {
        path: opened.to_path_buf(),
        reason: "a git directory whose working tree lives elsewhere: open the working tree"
            .to_owned(),
    })
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
        // An empty path is no path: git would take `:(literal)` alone as the whole tree.
        let by_cli = options.filter.as_ref().is_some_and(|filter| {
            filter.paths.iter().any(|path| !path.is_empty()) || filter.content_search().is_some()
        });
        if by_cli {
            cli_walk::start(self, scope, options, cancel)
        } else {
            walk::start(self, scope, options, cancel)
        }
    }

    fn count_commits(&self, scope: &WalkScope, cancel: &Cancel) -> GitResult<CommitCount> {
        count::count(self, scope, cancel)
    }

    fn status(&self, options: &StatusOptions, cancel: &Cancel) -> GitResult<Vec<StatusEntry>> {
        status::list(self, options, cancel)
    }

    fn diff_pages(
        &self,
        target: &DiffTarget,
        options: &DiffOptions,
        page_size: usize,
        cancel: &Cancel,
    ) -> GitResult<Box<dyn DiffWalk>> {
        diff_pages::start(self, target, options, page_size, cancel)
    }

    fn diff_paths(
        &self,
        target: &DiffTarget,
        options: &DiffOptions,
        paths: &[String],
        cancel: &Cancel,
    ) -> GitResult<Option<ChangeSet>> {
        diff_pages::restricted(self, target, options, paths, cancel)
    }

    fn merge_base(&self, a: &str, b: &str) -> GitResult<String> {
        refs::merge_base(self, a, b)
    }

    fn read_blob(&self, at: &BlobAt, path: &str) -> GitResult<BlobContent> {
        blob::read(self, at, path)
    }

    fn refs_containing(&self, commit: &str, cancel: &Cancel) -> GitResult<Vec<String>> {
        contains::refs_containing(self, commit, cancel)
    }

    fn recent_branches(&self, limit: usize) -> GitResult<Vec<String>> {
        recent::recent_branches(self, limit)
    }

    fn compare(&self, a: &str, b: &str, cancel: &Cancel) -> GitResult<Comparison> {
        compare::compare(self, a, b, cancel)
    }

    fn merge_preview(&self, a: &str, b: &str, cancel: &Cancel) -> GitResult<MergePreview> {
        compare::merge_preview(self, a, b, cancel)
    }

    fn worktrees(&self, cancel: &Cancel) -> GitResult<Vec<Worktree>> {
        worktrees::list(self, cancel)
    }

    fn worktree_add(&self, request: &WorktreeAdd, cancel: &Cancel) -> GitResult<Worktree> {
        worktree_ops::add(self, request, cancel)
    }

    fn worktree_remove(&self, path: &Path, force: bool, cancel: &Cancel) -> GitResult<()> {
        worktree_ops::remove(self, path, force, cancel)
    }

    fn worktree_prune(&self, cancel: &Cancel) -> GitResult<Vec<PathBuf>> {
        worktree_ops::prune(self, cancel)
    }

    fn worktree_lock(&self, path: &Path, reason: Option<&str>, cancel: &Cancel) -> GitResult<()> {
        worktree_ops::lock(self, path, reason, cancel)
    }

    fn worktree_unlock(&self, path: &Path, cancel: &Cancel) -> GitResult<()> {
        worktree_ops::unlock(self, path, cancel)
    }

    fn stage_paths(&self, paths: &[String], cancel: &Cancel) -> GitResult<()> {
        staging::stage_paths(self, paths, cancel)
    }

    fn unstage_paths(&self, paths: &[String], cancel: &Cancel) -> GitResult<()> {
        staging::unstage_paths(self, paths, cancel)
    }

    fn discard_paths(
        &self,
        tracked: &[String],
        untracked: &[String],
        cancel: &Cancel,
    ) -> GitResult<()> {
        staging::discard_paths(self, tracked, untracked, cancel)
    }

    fn ignore_path(
        &self,
        path: &str,
        rule: IgnoreRule,
        place: IgnorePlace,
        cancel: &Cancel,
    ) -> GitResult<IgnoreOutcome> {
        ignore::ignore_path(self, path, rule, place, cancel)
    }

    fn apply_selection(
        &self,
        selection: &PatchSelection,
        target: SelectionTarget,
        cancel: &Cancel,
    ) -> GitResult<()> {
        staging::apply_selection(self, selection, target, cancel)
    }

    fn commit(&self, request: &CommitRequest, cancel: &Cancel) -> GitResult<String> {
        staging::commit(self, request, cancel)
    }

    fn commit_context(&self, cancel: &Cancel) -> GitResult<CommitContext> {
        staging::commit_context(self, cancel)
    }

    fn branch_create(
        &self,
        name: &str,
        start: &str,
        checkout: bool,
        track: bool,
        cancel: &Cancel,
    ) -> GitResult<()> {
        branches::branch_create(self, name, start, checkout, track, cancel)
    }

    fn switch(&self, target: &SwitchTarget, cancel: &Cancel) -> GitResult<()> {
        branches::switch(self, target, cancel)
    }

    fn branch_rename(&self, from: &str, to: &str, cancel: &Cancel) -> GitResult<()> {
        branches::branch_rename(self, from, to, cancel)
    }

    fn branch_delete(&self, name: &str, force: bool, cancel: &Cancel) -> GitResult<()> {
        branches::branch_delete(self, name, force, cancel)
    }

    fn merge(&self, rev: &str, mode: MergeMode, cancel: &Cancel) -> GitResult<Outcome> {
        branches::merge(self, rev, mode, cancel)
    }

    fn rebase(&self, onto: &str, cancel: &Cancel) -> GitResult<Outcome> {
        branches::rebase(self, onto, cancel)
    }

    fn reset(&self, rev: &str, mode: ResetMode, cancel: &Cancel) -> GitResult<()> {
        branches::reset(self, rev, mode, cancel)
    }

    fn move_head(
        &self,
        from: &str,
        to: &str,
        branch: Option<&str>,
        cancel: &Cancel,
    ) -> GitResult<()> {
        branches::move_head(self, from, to, branch, cancel)
    }

    fn cherry_pick(&self, revs: &[String], cancel: &Cancel) -> GitResult<Outcome> {
        branches::cherry_pick(self, revs, cancel)
    }

    fn revert(&self, revs: &[String], cancel: &Cancel) -> GitResult<Outcome> {
        branches::revert(self, revs, cancel)
    }

    fn tag_create(
        &self,
        name: &str,
        rev: &str,
        message: Option<&str>,
        cancel: &Cancel,
    ) -> GitResult<()> {
        branches::tag_create(self, name, rev, message, cancel)
    }

    fn tag_delete(&self, name: &str, cancel: &Cancel) -> GitResult<Option<String>> {
        branches::tag_delete(self, name, cancel)
    }

    fn set_upstream(&self, branch: &str, upstream: Option<&str>, cancel: &Cancel) -> GitResult<()> {
        branches::set_upstream(self, branch, upstream, cancel)
    }

    fn operation_state(&self) -> GitResult<OperationState> {
        sequencer::operation_state(self)
    }

    fn conflicts(&self, cancel: &Cancel) -> GitResult<Vec<Conflict>> {
        sequencer::conflicts(self, cancel)
    }

    fn operation_sides(&self) -> GitResult<Option<OperationSides>> {
        sides::operation_sides(self)
    }

    fn take_side(&self, paths: &[String], side: Side, cancel: &Cancel) -> GitResult<()> {
        sides::take_side(self, paths, side, cancel)
    }

    fn restore_conflicts(&self, paths: &[String], cancel: &Cancel) -> GitResult<()> {
        sides::restore_conflicts(self, paths, cancel)
    }

    fn cleanup_candidates(&self, cancel: &Cancel) -> GitResult<CleanupCandidates> {
        cleanup::cleanup_candidates(self, cancel)
    }

    fn delete_branches(
        &self,
        branches: &[BranchToDelete],
        cancel: &Cancel,
    ) -> GitResult<Vec<DeleteOutcome>> {
        cleanup::delete_branches(self, branches, cancel)
    }

    fn sequencer(&self, action: SequencerAction, cancel: &Cancel) -> GitResult<Outcome> {
        sequencer::sequencer(self, action, cancel)
    }

    fn remotes(&self, cancel: &Cancel) -> GitResult<Vec<Remote>> {
        remotes::remotes(self, cancel)
    }

    fn remote_add(&self, name: &str, url: &str, cancel: &Cancel) -> GitResult<()> {
        remotes::remote_add(self, name, url, cancel)
    }

    fn remote_remove(&self, name: &str, cancel: &Cancel) -> GitResult<()> {
        remotes::remote_remove(self, name, cancel)
    }

    fn fetch(
        &self,
        remote: Option<&str>,
        prune: bool,
        prompts: Prompts,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<NetworkResult> {
        remotes::fetch(self, remote, prune, prompts, progress, cancel)
    }

    fn pull(
        &self,
        request: &PullRequest,
        prompts: Prompts,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<Outcome> {
        remotes::pull(self, request, prompts, progress, cancel)
    }

    fn push(
        &self,
        request: &PushRequest,
        prompts: Prompts,
        progress: &mut dyn FnMut(&str),
        cancel: &Cancel,
    ) -> GitResult<NetworkResult> {
        remotes::push(self, request, prompts, progress, cancel)
    }

    fn stash_push(&self, request: &StashPush, cancel: &Cancel) -> GitResult<bool> {
        stash::stash_push(self, request, cancel)
    }

    fn stash_apply(&self, stash: &str, cancel: &Cancel) -> GitResult<Outcome> {
        stash::stash_apply(self, stash, cancel)
    }

    fn stash_pop(&self, stash: &str, cancel: &Cancel) -> GitResult<Outcome> {
        stash::stash_pop(self, stash, cancel)
    }

    fn stash_drop(&self, stash: &str, cancel: &Cancel) -> GitResult<()> {
        stash::stash_drop(self, stash, cancel)
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

/// The stage bits of an index entry's `flags`.
const INDEX_STAGE_MASK: u16 = 0x3000;

/// Whether the stage-0 index entry named `path` carries `flag` (`skip-worktree` of a sparse
/// checkout, `intent-to-add` of `git add -N`): the flags git honours and libgit2's diff and
/// status do not. The entry is found by the bytes git stores, so a name that is not UTF-8 is
/// found on every platform (git2's `get_path` takes a `Path`, which cannot hold it on Windows).
pub(super) fn index_flag(
    index: &git2::Index,
    path: &[u8],
    flag: git2::IndexEntryExtendedFlag,
) -> bool {
    // Entries sort by name, then stage, so the first one the prefix finds is the name's own
    // lowest stage when the name is there.
    let Ok(position) = index.find_prefix(path) else {
        return false;
    };
    index.get(position).is_some_and(|entry| {
        entry.path == path
            && entry.flags & INDEX_STAGE_MASK == 0
            && git2::IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended).contains(flag)
    })
}

/// `path` as `git2::Index::get_path` takes it, or `None` for what that method panics on (it
/// unwraps its path conversion): an empty path, one that does not start with a plain name
/// (`.`, `..`, a root or a drive) and one holding a NUL byte.
pub(super) fn index_path(path: &str) -> Option<&Path> {
    let candidate = Path::new(path);
    let plain = matches!(
        candidate.components().next(),
        Some(std::path::Component::Normal(_))
    );
    (plain && !path.contains('\0')).then_some(candidate)
}

/// A path as git stores it (bytes with `/` separators) as a `Path`: any bytes on Unix, UTF-8
/// only on Windows, whose paths are UTF-16 (git2's own `path()` panics on the others there).
pub(super) fn os_path(bytes: &[u8]) -> Option<&Path> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Some(Path::new(std::ffi::OsStr::from_bytes(bytes)))
    }
    #[cfg(not(unix))]
    {
        std::str::from_utf8(bytes).ok().map(Path::new)
    }
}

/// Resolves `revision` as `git rev-parse` would and peels it to a commit id.
///
/// Unknown revisions and revisions that name a tree or a blob fail with
/// [`GitError::RefNotFound`]; a revision that names an existing ref whose object cannot be
/// read fails with [`GitError::CorruptObject`] naming that object.
pub(crate) fn resolve_commit(repo: &Repository, revision: &str) -> GitResult<Oid> {
    let object = match repo.revparse_single(revision) {
        Ok(object) => object,
        Err(error) => return Err(classify_revision_error(repo, revision, error)),
    };
    match object.peel_to_commit() {
        Ok(commit) => Ok(commit.id()),
        Err(error) if matches!(error.code(), ErrorCode::Peel | ErrorCode::InvalidSpec) => {
            Err(GitError::RefNotFound(revision.to_owned()))
        }
        Err(error) => Err(reference_error(repo, Some(object.id()), error)),
    }
}

/// A full hash, else none: `Oid::from_str` pads an abbreviation with zeros, naming an object
/// that does not exist (a branch named `1234` that is gone is an unknown name, not damage).
pub(super) fn full_oid(text: &str) -> Option<Oid> {
    let full = matches!(text.len(), 40 | 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit());
    if full {
        Oid::from_str(text).ok()
    } else {
        None
    }
}

/// A `revparse_single` failure is corruption when the revision names a ref, a hash or an
/// ancestor (`~N`, `^N`) whose object cannot be read; otherwise the revision itself is at
/// fault. When the damaged object cannot be named but libgit2 reports an object store
/// failure (a short hash of a truncated object), the revision stands in for the hash.
fn classify_revision_error(repo: &Repository, revision: &str, error: git2::Error) -> GitError {
    let unreadable = ref_target(repo, revision)
        .or_else(|| full_oid(revision))
        .and_then(|oid| unreadable_behind(repo, oid))
        .or_else(|| unreadable_ancestor(repo, revision));
    if let Some(oid) = unreadable {
        return GitError::CorruptObject {
            hash: oid.to_string(),
            reason: error.message().to_owned(),
        };
    }
    let store_failure = error.code() != ErrorCode::NotFound
        && matches!(
            error.class(),
            ErrorClass::Odb | ErrorClass::Object | ErrorClass::Zlib
        );
    if store_failure {
        return GitError::CorruptObject {
            hash: revision.to_owned(),
            reason: error.message().to_owned(),
        };
    }
    GitError::revision(revision, error)
}

/// Maps a failure to peel a reference or a tag whose direct target is `oid`: libgit2 reports a
/// reference peel failure as an invalid reference, hiding the object error, so the object
/// chain is read again to name the damaged one as [`GitError::CorruptObject`]; otherwise the
/// error is mapped as a failure to read `oid` itself.
pub(crate) fn reference_error(repo: &Repository, oid: Option<Oid>, error: git2::Error) -> GitError {
    match oid.and_then(|oid| unreadable_behind(repo, oid)) {
        Some(oid) => GitError::CorruptObject {
            hash: oid.to_string(),
            reason: error.message().to_owned(),
        },
        None => match oid {
            Some(oid) => GitError::object(&oid.to_string(), error),
            None => GitError::from(error),
        },
    }
}

/// Whether no object with `oid` exists in the store at all (as opposed to one that exists but
/// cannot be read): a ref pointing at such an object is broken, and git ignores it with a
/// warning rather than failing the listing.
pub(crate) fn object_missing(repo: &Repository, oid: Oid) -> bool {
    repo.odb().map(|odb| !odb.exists(oid)).unwrap_or(false)
}

/// Longest chain of tags followed when looking for an unreadable object.
const MAX_TAG_DEPTH: usize = 16;

/// The first object that cannot be read starting at `oid` and following tag targets; `None`
/// when the chain reads fine (the whole object is read: a truncated loose object still has a
/// readable header).
fn unreadable_behind(repo: &Repository, mut oid: Oid) -> Option<Oid> {
    for _ in 0..MAX_TAG_DEPTH {
        let object = match repo.find_object(oid, None) {
            Ok(object) => object,
            Err(_) => return Some(oid),
        };
        oid = object.as_tag()?.target_id();
    }
    None
}

/// Follows the `~N` and `^N` suffixes of `revision` by hand and names the first commit on
/// the way that cannot be read; `None` when the revision has another shape (`^{type}`,
/// `:path`, ...) or when everything on the way reads fine. The base may itself be a ref
/// whose tip is unreadable (`main~1` with a truncated `main`).
fn unreadable_ancestor(repo: &Repository, revision: &str) -> Option<Oid> {
    let split = revision.find(['~', '^'])?;
    let (base, suffix) = revision.split_at(split);
    let mut oid = match repo.revparse_single(base) {
        Ok(object) => object.peel_to_commit().ok()?.id(),
        Err(_) => ref_target(repo, base).or_else(|| full_oid(base))?,
    };
    let mut chars = suffix.chars().peekable();
    while let Some(op) = chars.next() {
        if chars.peek() == Some(&'{') {
            return None;
        }
        let mut digits = String::new();
        while let Some(digit) = chars.next_if(char::is_ascii_digit) {
            digits.push(digit);
        }
        let count: usize = if digits.is_empty() {
            1
        } else {
            digits.parse().ok()?
        };
        // `~N` walks N first parents; `^N` takes the Nth parent once (`^0` is the commit).
        let (steps, parent) = match op {
            '~' => (count, 0),
            '^' if count == 0 => (0, 0),
            '^' => (1, count - 1),
            _ => return None,
        };
        for _ in 0..steps {
            oid = match repo.find_commit(oid) {
                Ok(commit) => commit.parent_id(parent).ok()?,
                Err(_) => return Some(oid),
            };
        }
    }
    unreadable_behind(repo, oid)
}

/// The direct target of the ref that `revision` names, when it is a plain ref name.
fn ref_target(repo: &Repository, revision: &str) -> Option<Oid> {
    if revision == "HEAD" {
        return repo.find_reference("HEAD").ok()?.resolve().ok()?.target();
    }
    repo.resolve_reference_from_short_name(revision)
        .ok()?
        .target()
}

/// Fails with [`GitError::CorruptObject`] when HEAD points at a commit that cannot be read,
/// so operations that read HEAD through libgit2's own code paths report the damage by hash.
pub(crate) fn check_head(repo: &Repository) -> GitResult<()> {
    let Ok(head) = repo.head() else {
        return Ok(());
    };
    if let Some(oid) = head.target() {
        repo.find_commit(oid)
            .map_err(|error| GitError::object(&oid.to_string(), error))?;
    }
    Ok(())
}
