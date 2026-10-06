//! Worktree listing.
//!
//! The main worktree comes first, then the linked worktrees sorted by name. libgit2 locates
//! each linked worktree; its `HEAD` and `locked` files are read from
//! `<common dir>/worktrees/<name>/` the way `git worktree list` does, so a worktree whose
//! folder was deleted still reports its branch and is marked prunable instead of failing the
//! whole listing.

use std::fs;
use std::path::{Path, PathBuf};

use git2::{ErrorCode, Oid, Repository};

use super::{normalize, Git2Engine};
use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::Worktree;

/// Lists the worktrees; see [`crate::engine::GitEngine::worktrees`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn list(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<Worktree>> {
    engine.with_repo(|repo| collect(repo, cancel))
}

/// The main worktree followed by the linked worktrees sorted by name.
///
/// Shared with the refs listing, which marks each local branch with the worktree it is
/// checked out in. A linked worktree that libgit2 cannot locate is skipped with a warning;
/// one whose `HEAD` cannot be read is listed without head and branch.
pub(super) fn collect(repo: &Repository, cancel: &Cancel) -> GitResult<Vec<Worktree>> {
    cancel.check()?;
    let common_dir = repo.commondir().to_path_buf();
    let mut worktrees = vec![main_worktree(repo, &common_dir)?];
    let names = repo.worktrees()?;
    let mut names: Vec<&str> = names
        .iter()
        .filter_map(|name| name.ok().flatten())
        .collect();
    names.sort_unstable();
    for name in names {
        cancel.check()?;
        match linked_worktree(repo, &common_dir, name) {
            Ok(worktree) => worktrees.push(worktree),
            Err(error) => {
                tracing::warn!(name = name, error = %error, "skipping a worktree that cannot be located");
            }
        }
    }
    Ok(worktrees)
}

/// The main working tree. Its path comes from the opened repository, or from the common
/// directory when a linked worktree was opened (see [`main_path`]).
fn main_worktree(repo: &Repository, common_dir: &Path) -> GitResult<Worktree> {
    let path = if repo.is_worktree() {
        main_path(common_dir)
    } else {
        repo.workdir()
            .map_or_else(|| normalize(common_dir), normalize)
    };
    let head = read_head(repo, &common_dir.join("HEAD"))?;
    Ok(Worktree {
        path,
        name: None,
        head: head.commit,
        branch: head.branch,
        detached: head.detached,
        is_main: true,
        locked: false,
        lock_reason: None,
        prunable: false,
        // A bare repository's HEAD names a branch no working tree holds (`bare`).
        bare: repo.is_worktree() && bare_common_dir(common_dir),
    })
}

/// Whether the repository whose common directory is `common_dir` is bare (`core.bare`), as
/// git reads it for its main worktree.
fn bare_common_dir(common_dir: &Path) -> bool {
    git2::Config::open(&common_dir.join("config"))
        .ok()
        .and_then(|config| config.get_bool("core.bare").ok())
        .unwrap_or(false)
}

/// Where the main working tree of the repository whose common directory is `common_dir`
/// is, seen from a linked worktree: the folder `core.worktree` names, else the parent of a
/// `.git` directory. A bare repository and a git directory that lives elsewhere
/// (`--separate-git-dir`), which record nowhere where their working tree is, report the
/// common directory, where `git worktree list` names it too. Not libgit2's guess, the
/// directory's parent, which for a separate directory is some other folder, whose owner
/// libgit2 would check besides.
pub(crate) fn main_path(common_dir: &Path) -> PathBuf {
    let config = git2::Config::open(&common_dir.join("config")).ok();
    // An entry, not the value: git2 panics on a path setting that is not UTF-8 on Windows.
    let named = config
        .as_ref()
        .is_some_and(|config| config.get_entry("core.worktree").is_ok());
    if named {
        // libgit2 resolves the setting against the directory, relative or not.
        if let Some(workdir) = Repository::open(common_dir)
            .ok()
            .and_then(|main| main.workdir().map(normalize))
        {
            return workdir;
        }
    }
    let bare = config
        .as_ref()
        .is_some_and(|config| config.get_bool("core.bare").unwrap_or(false));
    match common_dir.parent() {
        Some(parent) if !bare && common_dir.file_name() == Some(std::ffi::OsStr::new(".git")) => {
            normalize(parent)
        }
        _ => normalize(common_dir),
    }
}

/// A linked worktree by name. Locking and prunability follow git: a locked worktree is never
/// prunable; an unlocked one is prunable when its `.git` link is gone or libgit2 says so.
fn linked_worktree(repo: &Repository, common_dir: &Path, name: &str) -> GitResult<Worktree> {
    let worktree = repo.find_worktree(name)?;
    let private_dir = common_dir.join("worktrees").join(name);
    // git2's `path()` panics on a folder whose name is not UTF-8 on Windows; libgit2 reads it
    // from the `gitdir` file, so that file is checked first.
    if cfg!(windows)
        && std::fs::read(private_dir.join("gitdir"))
            .is_ok_and(|gitdir| std::str::from_utf8(&gitdir).is_err())
    {
        return Err(GitError::Git(format!(
            "the worktree {name} names a folder that is not UTF-8"
        )));
    }
    let path = normalize(worktree.path());
    let lock = read_lock(&private_dir.join("locked"));
    let locked = lock.is_some();
    let prunable =
        !locked && (!path.join(".git").exists() || worktree.is_prunable(None).unwrap_or(false));
    let head = match read_head(repo, &private_dir.join("HEAD")) {
        Ok(head) => head,
        Err(error) => {
            tracing::warn!(name = name, error = %error, "listing the worktree without its HEAD");
            HeadInfo::default()
        }
    };
    Ok(Worktree {
        path,
        name: Some(name.to_owned()),
        head: head.commit,
        branch: head.branch,
        detached: head.detached,
        is_main: false,
        locked,
        lock_reason: lock.flatten(),
        prunable,
        bare: false,
    })
}

/// `Some(reason)` when the `locked` file exists; the reason is `None` when the file is empty
/// or unreadable.
fn read_lock(path: &Path) -> Option<Option<String>> {
    if !path.exists() {
        return None;
    }
    let reason = fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned())
        .unwrap_or_default();
    Some((!reason.is_empty()).then_some(reason))
}

/// What a `HEAD` file says, resolved against the shared refs.
#[derive(Default)]
struct HeadInfo {
    commit: Option<String>,
    branch: Option<String>,
    detached: bool,
}

/// Reads a `HEAD` file (`ref: refs/heads/x` or a commit hash) like `git worktree list` does,
/// resolving a branch through the repository so packed refs work and an unborn branch keeps
/// its name without a commit.
fn read_head(repo: &Repository, head_file: &Path) -> GitResult<HeadInfo> {
    let content = fs::read_to_string(head_file)
        .map_err(|error| GitError::Git(format!("cannot read {}: {error}", head_file.display())))?;
    let content = content.trim();
    if let Some(target) = content.strip_prefix("ref:") {
        let target = target.trim();
        let commit = match repo.find_reference(target) {
            Ok(reference) => match reference.resolve() {
                Ok(direct) => direct.target().map(|oid| oid.to_string()),
                Err(error) if error.code() == ErrorCode::NotFound => None,
                Err(error) => return Err(error.into()),
            },
            Err(error) if error.code() == ErrorCode::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let branch = target.strip_prefix("refs/heads/").unwrap_or(target);
        return Ok(HeadInfo {
            commit,
            branch: Some(branch.to_owned()),
            detached: false,
        });
    }
    let oid: Oid = content.parse().map_err(|error| {
        GitError::Git(format!(
            "{} holds neither a ref nor a hash: {error}",
            head_file.display()
        ))
    })?;
    Ok(HeadInfo {
        commit: Some(oid.to_string()),
        branch: None,
        detached: true,
    })
}
