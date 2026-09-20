//! libgit2 implementation of [`GitEngine`].
//!
//! One submodule per operation family (`refs`, `walk`, `status`, `diff`, `worktrees`); this
//! module owns the repository handle and the `open` logic.

mod blob;
mod cli_walk;
mod compare;
mod count;
mod diff;
mod diff_pages;
mod filter;
mod refs;
mod status;
mod walk;
mod worktrees;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use git2::{ErrorClass, ErrorCode, Oid, Repository};

use crate::engine::{Cancel, CommitWalk, DiffWalk, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{
    BlobAt, BlobContent, CommitCount, Comparison, DiffOptions, DiffTarget, MergePreview, Ref, Repo,
    StatusEntry, StatusOptions, WalkOptions, WalkScope, Worktree,
};

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
            generated_attributes: Mutex::new(None),
            diff_workers: diff_pages::new_pool(),
            counts: Mutex::new(None),
        })
    }

    /// Runs `f` on the comparison handle, opened from `gitdir` on first use.
    pub(crate) fn with_counts_repo<T>(
        &self,
        gitdir: &Path,
        f: impl FnOnce(&Repository) -> GitResult<T>,
    ) -> GitResult<T> {
        let mut slot = self
            .counts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(reopen_gitdir(gitdir)?);
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
/// hold the engine's mutex (walks, parallel counts). The gitdir is what libgit2 opened, so
/// linked worktrees and repositories whose working tree lives elsewhere (`core.worktree`)
/// reopen as themselves.
pub(crate) fn reopen(repo: &Repository) -> GitResult<Repository> {
    reopen_gitdir(repo.path())
}

/// [`reopen`] from a gitdir path, for threads that cannot borrow the handle.
pub(crate) fn reopen_gitdir(gitdir: &Path) -> GitResult<Repository> {
    Repository::open(gitdir).map_err(|error| match error.code() {
        ErrorCode::NotFound => GitError::NotFound(gitdir.to_path_buf()),
        _ => GitError::Invalid {
            path: gitdir.to_path_buf(),
            reason: error.message().to_owned(),
        },
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
        let by_path = options
            .filter
            .as_ref()
            .is_some_and(|filter| filter.paths.iter().any(|path| !path.is_empty()));
        if by_path {
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

    fn merge_base(&self, a: &str, b: &str) -> GitResult<String> {
        refs::merge_base(self, a, b)
    }

    fn read_blob(&self, at: &BlobAt, path: &str) -> GitResult<BlobContent> {
        blob::read(self, at, path)
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

/// Whether the stage-0 index entry of `path` carries `flag` (`skip-worktree` of a sparse
/// checkout, `intent-to-add` of `git add -N`): the flags git honours and libgit2's diff and
/// status do not.
pub(super) fn index_flag(
    index: &git2::Index,
    path: &str,
    flag: git2::IndexEntryExtendedFlag,
) -> bool {
    index
        .get_path(std::path::Path::new(path), 0)
        .is_some_and(|entry| {
            git2::IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended).contains(flag)
        })
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

/// A `revparse_single` failure is corruption when the revision names a ref, a hash or an
/// ancestor (`~N`, `^N`) whose object cannot be read; otherwise the revision itself is at
/// fault. When the damaged object cannot be named but libgit2 reports an object store
/// failure (a short hash of a truncated object), the revision stands in for the hash.
fn classify_revision_error(repo: &Repository, revision: &str, error: git2::Error) -> GitError {
    let unreadable = ref_target(repo, revision)
        .or_else(|| Oid::from_str(revision).ok())
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
        Err(_) => ref_target(repo, base).or_else(|| Oid::from_str(base).ok())?,
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
