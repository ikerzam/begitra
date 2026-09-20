//! The four worktree writes: add, remove, prune and lock, through the git
//! CLI with argv, the same commands the user would type. Each runs under the operation's
//! cancel flag (the child is killed) and maps git's failure to [`GitError::Cli`] with the
//! stderr, except the refusal of a dirty removal, which is [`GitError::WorktreeDirty`].
//! git runs in the main worktree, never in the folder a removal deletes (from inside it,
//! Windows refuses the deletion halfway). An add that was cancelled mid-checkout is rolled
//! back the way git itself rolls back a failed add (its own cleanup never runs when the
//! process is killed). Nothing else in the engine writes to a repository.

use std::path::{Path, PathBuf};

use super::{normalize, worktrees, Git2Engine};
use crate::cli::{run_git, run_git_cancellable, CliExit};
use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::{Worktree, WorktreeAdd, WorktreeBranch};

/// The token of git's refusal to remove a worktree with changes ("contains modified or
/// untracked files, use --force to delete it"): the one part a translated git keeps.
const DIRTY_REFUSAL: &str = "--force";

/// The main worktree's folder, where every worktree command runs.
fn main_root(engine: &Git2Engine, cancel: &Cancel) -> GitResult<PathBuf> {
    let listed = engine.with_repo(|repo| worktrees::collect(repo, cancel))?;
    listed
        .into_iter()
        .find(|worktree| worktree.is_main)
        .map(|worktree| worktree.path)
        .ok_or_else(|| GitError::Git("the repository lists no main worktree".to_owned()))
}

/// Runs `git <args>` in the main worktree and turns a non-zero status into [`GitError::Cli`].
fn git(engine: &Git2Engine, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    let cwd = main_root(engine, cancel)?;
    git_in(&cwd, args, cancel)
}

/// [`git`] in a known folder.
fn git_in(cwd: &Path, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    let exit = run_git_cancellable(cwd, args, cancel)?;
    if exit.status == Some(0) {
        Ok(exit)
    } else {
        Err(GitError::Cli {
            command: args.join(" "),
            status: exit.status,
            stderr: exit.stderr,
        })
    }
}

/// Whether two spellings name the same folder: equal once normalised, or the same on disk
/// (git records the real path: the on-disk case, `..` and junctions resolved).
pub(super) fn same_folder(a: &Path, b: &Path) -> bool {
    if normalize(a) == normalize(b) {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Adds a worktree; see [`crate::engine::GitEngine::worktree_add`].
#[tracing::instrument(level = "debug", skip_all, fields(path = %request.path.display()))]
pub(super) fn add(
    engine: &Git2Engine,
    request: &WorktreeAdd,
    cancel: &Cancel,
) -> GitResult<Worktree> {
    let path = request.path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    match &request.branch {
        WorktreeBranch::New { name, start } => {
            // `--` protects the positionals; the value of `-b` it cannot, and an
            // option-shaped one would reach `git branch` as an option.
            if name.starts_with('-') {
                return Err(GitError::Cli {
                    command: format!("worktree add -b {name}"),
                    status: None,
                    stderr: format!("fatal: '{name}' is not a valid branch name"),
                });
            }
            args.extend(["-b", name.as_str(), "--", path.as_str(), start.as_str()]);
        }
        WorktreeBranch::Existing { name } => args.extend(["--", path.as_str(), name.as_str()]),
        WorktreeBranch::Detached { rev } => {
            args.extend(["--detach", "--", path.as_str(), rev.as_str()]);
        }
    }
    let cwd = main_root(engine, cancel)?;
    let common_dir = engine.with_repo(|repo| Ok(repo.commondir().to_path_buf()))?;
    // Only what this add creates is ever rolled back: a folder that existed before is the
    // user's, and a cancel that lands before git registered the entry created nothing.
    let existed = request.path.exists();
    if let Err(error) = git_in(&cwd, &args, cancel) {
        if matches!(error, GitError::Cancelled) && !existed {
            roll_back_add(&cwd, &common_dir, &request.path);
        }
        return Err(error);
    }
    let listed = engine.with_repo(|repo| worktrees::collect(repo, cancel))?;
    listed
        .into_iter()
        .find(|worktree| same_folder(&worktree.path, &request.path))
        .ok_or_else(|| {
            GitError::Git(format!(
                "git added no worktree at {}",
                request.path.display()
            ))
        })
}

/// Undoes an add that was cancelled mid-checkout: git was killed before its own cleanup, so
/// the entry (locked "initializing") and the partial folder go; the branch stays, as after
/// git's own failure. Not cancellable: it is the rollback of the cancelled action. The kill
/// lands on its own thread a moment later, and git's removal races the dying checkout
/// (it unregisters the entry but leaves the files still being written), so the folder is
/// deleted directly once git no longer claims it, and the attempts are repeated until it
/// is gone. Nothing is deleted unless git had registered an entry for the folder: that is
/// the proof the folder is the add's own (git registers before it creates the folder).
fn roll_back_add(cwd: &Path, common_dir: &Path, path: &Path) {
    if !registered_at(common_dir, path) {
        return;
    }
    let path_text = path.to_string_lossy().into_owned();
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let _ = run_git(
            cwd,
            &["worktree", "remove", "--force", "--force", "--", &path_text],
        );
        if path.exists() {
            let _ = std::fs::remove_dir_all(path);
        }
        if !path.exists() {
            break;
        }
    }
    let _ = run_git(cwd, &["worktree", "prune"]);
    if path.exists() {
        tracing::warn!(path = %path.display(), "a cancelled worktree add could not be rolled back");
    }
}

/// Whether some entry under `<common dir>/worktrees` records `path` as its folder (each
/// `gitdir` file holds `<folder>/.git`).
fn registered_at(common_dir: &Path, path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(common_dir.join("worktrees")) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        std::fs::read_to_string(entry.path().join("gitdir")).is_ok_and(|gitdir| {
            Path::new(gitdir.trim())
                .parent()
                .is_some_and(|folder| same_folder(folder, path))
        })
    })
}

/// Removes a worktree; see [`crate::engine::GitEngine::worktree_remove`].
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display(), force))]
pub(super) fn remove(
    engine: &Git2Engine,
    path: &Path,
    force: bool,
    cancel: &Cancel,
) -> GitResult<()> {
    let path_text = path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--", path_text.as_str()]);
    match git(engine, &args, cancel) {
        Ok(_) => Ok(()),
        Err(GitError::Cli {
            command,
            status,
            stderr,
        }) if !force && refuses_dirty(&stderr) => {
            // A locked worktree's refusal quotes its reason, which is free text and may
            // say "--force" too: the listing, not the wording, tells the cases apart.
            if is_locked(engine, path, cancel)? {
                Err(GitError::Cli {
                    command,
                    status,
                    stderr,
                })
            } else {
                Err(GitError::WorktreeDirty(path.to_path_buf()))
            }
        }
        Err(error) => Err(error),
    }
}

/// Whether git's refusal names `--force`: the dirty refusal does ("contains modified or
/// untracked files, use --force to delete it", the token untranslated); a locked worktree's
/// ("use 'remove -f -f' to override or unlock first") and one with submodules ("working
/// trees containing submodules cannot be moved or removed") do not.
fn refuses_dirty(stderr: &str) -> bool {
    stderr.contains(DIRTY_REFUSAL)
}

fn is_locked(engine: &Git2Engine, path: &Path, cancel: &Cancel) -> GitResult<bool> {
    let listed = engine.with_repo(|repo| worktrees::collect(repo, cancel))?;
    Ok(listed
        .iter()
        .any(|worktree| worktree.locked && same_folder(&worktree.path, path)))
}

/// Prunes the worktrees whose folders are missing; see
/// [`crate::engine::GitEngine::worktree_prune`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn prune(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<PathBuf>> {
    // Counted by admin directory (`.git/worktrees/<name>`), so an entry libgit2 cannot open
    // (its `gitdir` file gone) is reported when git prunes it, under its name.
    let (names_before, listed) =
        engine.with_repo(|repo| Ok((admin_names(repo)?, worktrees::collect(repo, cancel)?)))?;
    git(engine, &["worktree", "prune"], cancel)?;
    let names_after = engine.with_repo(admin_names)?;
    Ok(names_before
        .into_iter()
        .filter(|name| !names_after.contains(name))
        .map(|name| {
            listed
                .iter()
                .find(|worktree| worktree.name.as_deref() == Some(name.as_str()))
                .map_or_else(|| PathBuf::from(&name), |worktree| worktree.path.clone())
        })
        .collect())
}

/// The names under `.git/worktrees`, whether or not libgit2 can open them (it lists only
/// the entries with a `gitdir`, a `commondir` and a `HEAD`; git prunes the others too).
fn admin_names(repo: &git2::Repository) -> GitResult<Vec<String>> {
    let dir = repo.commondir().join("worktrees");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(GitError::Git(format!(
                "cannot read {}: {error}",
                dir.display()
            )))
        }
    };
    Ok(entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect())
}

/// Locks a worktree; see [`crate::engine::GitEngine::worktree_lock`].
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
pub(super) fn lock(
    engine: &Git2Engine,
    path: &Path,
    reason: Option<&str>,
    cancel: &Cancel,
) -> GitResult<()> {
    let path_text = path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "lock"];
    if let Some(reason) = reason.filter(|reason| !reason.trim().is_empty()) {
        args.extend(["--reason", reason]);
    }
    args.extend(["--", path_text.as_str()]);
    git(engine, &args, cancel).map(|_| ())
}

/// Unlocks a worktree; see [`crate::engine::GitEngine::worktree_unlock`].
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display()))]
pub(super) fn unlock(engine: &Git2Engine, path: &Path, cancel: &Cancel) -> GitResult<()> {
    let path_text = path.to_string_lossy().into_owned();
    git(
        engine,
        &["worktree", "unlock", "--", path_text.as_str()],
        cancel,
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dirty_refusal_is_recognised_by_its_untranslated_token() {
        assert!(refuses_dirty(
            "fatal: '/wt/x' contains modified or untracked files, use --force to delete it\n"
        ));
        assert!(refuses_dirty(
            "fatal: '/wt/x' contiene archivos modificados o no rastreados, usa --force para borrarlo\n"
        ));
        assert!(!refuses_dirty("fatal: '/wt/x' is not a working tree\n"));
        assert!(!refuses_dirty(
            "fatal: cannot remove a locked working tree, lock reason: review\nuse 'remove -f -f' to override or unlock first\n"
        ));
        assert!(!refuses_dirty(
            "fatal: working trees containing submodules cannot be moved or removed\n"
        ));
    }
}
