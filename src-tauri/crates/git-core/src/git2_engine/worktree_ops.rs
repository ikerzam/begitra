//! The worktree writes: add, remove, prune and lock, through the git
//! CLI with argv, the same commands the user would type. Each runs under the operation's
//! cancel flag (the child is killed) and maps git's failure to [`GitError::Cli`] with the
//! stderr, except the refusal of a dirty removal, which is [`GitError::WorktreeDirty`].
//! git runs in the main worktree, never in the folder a removal deletes (from inside it,
//! Windows refuses the deletion halfway). An add that was cancelled mid-checkout is rolled
//! back the way git itself rolls back a failed add (its own cleanup never runs when the
//! process is killed).

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use super::{normalize, worktrees, Git2Engine};
use crate::cli::{run_git_cancellable, run_git_env_within, CliExit};
use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::{Worktree, WorktreeAdd, WorktreeBranch};

/// The token of git's refusal to remove a worktree with changes ("contains modified or
/// untracked files, use --force to delete it"): the one part a translated git keeps.
const DIRTY_REFUSAL: &str = "--force";

/// Where every worktree command runs: the main worktree's folder, with the repository named
/// outright when that folder is the common directory itself (a bare repository, or a git
/// directory that lives elsewhere seen from a linked worktree), which is no working tree and
/// which git refuses to find by itself under `safe.bareRepository=explicit`.
struct Place {
    cwd: PathBuf,
    git_dir: Option<String>,
}

impl Place {
    fn of(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Self> {
        let (listed, common_dir) = engine.with_repo(|repo| {
            Ok((
                worktrees::collect(repo, cancel)?,
                repo.commondir().to_path_buf(),
            ))
        })?;
        let cwd = listed
            .into_iter()
            .find(|worktree| worktree.is_main)
            .map(|worktree| worktree.path)
            .ok_or_else(|| GitError::Git("the repository lists no main worktree".to_owned()))?;
        let git_dir =
            same_folder(&cwd, &common_dir).then(|| format!("--git-dir={}", common_dir.display()));
        Ok(Self { cwd, git_dir })
    }

    /// `args` after the repository's name when it must be given.
    fn args<'a>(&'a self, args: &[&'a str]) -> Vec<&'a str> {
        self.git_dir
            .iter()
            .map(String::as_str)
            .chain(args.iter().copied())
            .collect()
    }
}

/// Runs `git <args>` in the main worktree and turns a non-zero status into [`GitError::Cli`].
fn git(engine: &Git2Engine, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    let place = Place::of(engine, cancel)?;
    git_in(&place.cwd, &place.args(args), cancel)
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
    // A branch that tracks a remote-tracking ref needs the one remote that fetches it: git
    // creates the branch first, then refuses to track it and leaves it behind (no remote, or
    // two that claim the ref), so the remote is asked of libgit2 first, as `branch_create`
    // asks it.
    if let WorktreeBranch::New {
        start,
        track: Some(true),
        ..
    } = &request.branch
    {
        if start.starts_with("refs/remotes/") {
            engine.with_repo(|repo| match repo.branch_remote_name(start) {
                Ok(_) => Ok(()),
                Err(error) => Err(GitError::Git(format!(
                    "{start} cannot be tracked: no remote, or more than one, fetches it ({})",
                    error.message()
                ))),
            })?;
        }
    }
    let path = request.path.to_string_lossy().into_owned();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    match &request.branch {
        WorktreeBranch::New { name, start, track } => {
            // `--` protects the positionals; the value of `-b` it cannot, and an
            // option-shaped one would reach `git branch` as an option.
            if name.starts_with('-') {
                return Err(GitError::Cli {
                    command: format!("worktree add -b {name}"),
                    status: None,
                    stderr: format!("fatal: '{name}' is not a valid branch name"),
                });
            }
            match track {
                Some(true) => args.push("--track"),
                Some(false) => args.push("--no-track"),
                None => {}
            }
            args.extend(["-b", name.as_str(), "--", path.as_str(), start.as_str()]);
        }
        WorktreeBranch::Existing { name } => args.extend(["--", path.as_str(), name.as_str()]),
        WorktreeBranch::Detached { rev } => {
            args.extend(["--detach", "--", path.as_str(), rev.as_str()]);
        }
    }
    let place = Place::of(engine, cancel)?;
    let common_dir = engine.with_repo(|repo| Ok(repo.commondir().to_path_buf()))?;
    // Only what this add creates is ever rolled back: a folder that existed before is the
    // user's, an entry that existed before is another add's, and a cancel that lands before
    // git registered the entry created nothing.
    let existed = request.path.exists();
    let entries_before = admin_entries(&common_dir);
    if let Err(error) = git_in(&place.cwd, &place.args(&args), cancel) {
        if matches!(error, GitError::Cancelled) && !existed {
            roll_back_add(&place, &common_dir, &request.path, &entries_before);
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
/// git's own failure. Not cancellable: it is the rollback of the cancelled action.
///
/// The kill lands on its own thread a moment after the cancel, so the dying git may still
/// register the entry or write files after the first look: the rollback looks again after
/// every pause. git's removal races the dying checkout (it unregisters the entry but leaves
/// the files still being written), so the folder is deleted directly once git no longer
/// claims it; git's removal also unregisters a locked entry whose folder is already gone,
/// which `prune` would skip. Nothing is deleted unless an entry that did not exist before
/// the add records the folder: that is the proof the folder is the add's own. git creates
/// the folder a moment before it writes the entry, so a kill between the two leaves an
/// unproven folder, which stays. When no entry appeared a second after the cancel, the kill
/// came first and there is nothing more to undo. The pauses and git's removals together
/// stop at [`ROLLBACK_LIMIT`], since a file another program holds open in the partial
/// checkout can make each removal walk it again.
fn roll_back_add(place: &Place, common_dir: &Path, path: &Path, before: &HashSet<OsString>) {
    let started = Instant::now();
    let path_text = path.to_string_lossy().into_owned();
    let mut owned = false;
    for attempt in 0..20 {
        std::thread::sleep(Duration::from_millis(250));
        let Some(left) = ROLLBACK_LIMIT.checked_sub(started.elapsed()) else {
            break;
        };
        if registered_at(common_dir, path, before) {
            owned = true;
            let _ = run_git_env_within(
                &place.cwd,
                &place.args(&["worktree", "remove", "--force", "--force", "--", &path_text]),
                &[],
                &Cancel::never(),
                left,
            );
        }
        if owned && path.exists() {
            let _ = std::fs::remove_dir_all(path);
        }
        if !owned && attempt >= 3 {
            break;
        }
        if owned && !path.exists() && !registered_at(common_dir, path, before) {
            break;
        }
    }
    if owned && (path.exists() || registered_at(common_dir, path, before)) {
        tracing::warn!(path = %path.display(), "a cancelled worktree add could not be rolled back");
    }
}

/// Longest time a rollback's pauses and git's removals take together.
const ROLLBACK_LIMIT: Duration = Duration::from_secs(30);

/// The names of the worktree entries under `<common dir>/worktrees`.
fn admin_entries(common_dir: &Path) -> HashSet<OsString> {
    std::fs::read_dir(common_dir.join("worktrees"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether an entry under `<common dir>/worktrees` that is not in `before` records `path`
/// as its folder. Each `gitdir` file holds `<folder>/.git`, absolute, or relative to the
/// entry's own folder when `worktree.useRelativePaths` is set.
fn registered_at(common_dir: &Path, path: &Path, before: &HashSet<OsString>) -> bool {
    let Ok(entries) = std::fs::read_dir(common_dir.join("worktrees")) else {
        return false;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| !before.contains(&entry.file_name()))
        .any(|entry| {
            std::fs::read_to_string(entry.path().join("gitdir")).is_ok_and(|gitdir| {
                let recorded = Path::new(gitdir.trim());
                let recorded = if recorded.is_absolute() {
                    recorded.to_path_buf()
                } else {
                    by_name(&entry.path().join(recorded))
                };
                recorded
                    .parent()
                    .is_some_and(|folder| same_folder(folder, path))
            })
        })
}

/// `path` with `.` and `..` resolved by name, for a folder that may not exist yet.
fn by_name(path: &Path) -> PathBuf {
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other.as_os_str()),
        }
    }
    resolved
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

    /// A common dir with one worktree entry `id` whose `gitdir` file holds `gitdir`.
    fn entry(common: &Path, id: &str, gitdir: &str) {
        let admin = common.join("worktrees").join(id);
        std::fs::create_dir_all(&admin).expect("admin folder");
        std::fs::write(admin.join("gitdir"), format!("{gitdir}\n")).expect("gitdir");
    }

    #[test]
    fn an_entry_is_the_adds_own_only_when_new_and_absolute_or_relative() {
        let temp = tempfile::tempdir().expect("temp");
        let common = temp.path().join("repo").join(".git");
        let folder = temp.path().join("wt-new");
        let none = HashSet::new();
        assert!(!registered_at(&common, &folder, &none), "no entries yet");

        let absolute = folder.join(".git");
        entry(&common, "wt-new", &absolute.to_string_lossy());
        assert!(registered_at(&common, &folder, &none));
        // The same entry listed before the add is another add's, never this one's.
        let before: HashSet<OsString> = [OsString::from("wt-new")].into();
        assert!(!registered_at(&common, &folder, &before));

        // `worktree.useRelativePaths`: relative to `<common>/worktrees/<id>`.
        std::fs::remove_dir_all(common.join("worktrees")).expect("clean");
        // From `repo/.git/worktrees/wt-new` up to the folder beside `repo`.
        entry(&common, "wt-new", "../../../../wt-new/.git");
        assert!(registered_at(&common, &folder, &none));
        assert!(!registered_at(
            &common,
            &temp.path().join("elsewhere"),
            &none
        ));
    }

    #[test]
    fn by_name_resolves_dots_without_the_disk() {
        assert_eq!(by_name(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
        assert_eq!(by_name(Path::new("a/../../b")), PathBuf::from("b"));
    }

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
