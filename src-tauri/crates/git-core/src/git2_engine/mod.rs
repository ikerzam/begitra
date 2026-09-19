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

use git2::{ErrorCode, Oid, Repository};

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

/// A `revparse_single` failure is corruption when the revision names a ref whose target
/// object cannot be read, or an ancestor (`~N`, `^N`) that cannot be read; otherwise the
/// revision itself is at fault.
fn classify_revision_error(repo: &Repository, revision: &str, error: git2::Error) -> GitError {
    let unreadable = ref_target(repo, revision)
        .and_then(|oid| unreadable_behind(repo, oid))
        .or_else(|| unreadable_ancestor(repo, revision));
    match unreadable {
        Some(oid) => GitError::CorruptObject {
            hash: oid.to_string(),
            reason: error.message().to_owned(),
        },
        None => GitError::revision(revision, error),
    }
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
/// `:path`, ...) or when everything on the way reads fine.
fn unreadable_ancestor(repo: &Repository, revision: &str) -> Option<Oid> {
    let split = revision.find(['~', '^'])?;
    let (base, suffix) = revision.split_at(split);
    let mut oid = repo.revparse_single(base).ok()?.peel_to_commit().ok()?.id();
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
        let steps = match op {
            '~' => vec![0; count],
            '^' if count == 0 => Vec::new(),
            '^' => vec![count - 1],
            _ => return None,
        };
        for parent in steps {
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
