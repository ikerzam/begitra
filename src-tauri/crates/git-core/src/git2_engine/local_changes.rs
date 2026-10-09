//! Local changes in the way of a switch, a merge, a rebase or a pull: git's refusal under an
//! error of its own, a switch that carries the changes over or leaves them in a stash, and
//! what git's autostash leaves behind (the stash it keeps when the changes do not come back
//! cleanly, the changes an operation that stopped holds aside). git's words are read under
//! `LC_ALL=C`, which every write sets.
//!
//! A carry's steps from its stash on (the switch, the apply on the new branch or back where
//! the changes were, the drop, the undoing of a stash push that failed half way) run without
//! the caller's cancel and under [`STEP_LIMIT`]: stopped half way they would leave the changes
//! between the stash and the working tree. A stash is applied with `--index` first, so what was
//! staged stays staged, and without it when the staged part does not apply on the new commit
//! (git then touches nothing).

use std::path::Path;
use std::time::Duration;

use git2::{Oid, Repository};

use super::{os_path, refs, sequencer, stash, Git2Engine};
use crate::cli::{run_git_env_with_input_within, run_git_env_within, CliExit, WRITE_ENV};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{Conflict, LocalChanges, OperationState, Outcome, Switched};

/// The longest a step of a carry that no cancel stops may run: git is stopped past it.
pub(super) const STEP_LIMIT: Duration = Duration::from_secs(600);

/// Where an operation that stopped keeps the stash its autostash made, in the worktree's own
/// git directory: a merge's, and a rebase's for each of its two backends.
const AUTOSTASH_FILES: [&str; 3] = [
    "MERGE_AUTOSTASH",
    "rebase-merge/autostash",
    "rebase-apply/autostash",
];

/// Whether git's words refuse because local changes are in the way: a switch's or a merge's
/// "would be overwritten" or "would be removed" (tracked or untracked files), untracked files
/// a directory update would lose, or a rebase's refusal of unstaged or staged changes. Not
/// when git names an unmerged file (`<path>: needs merge`): a conflict is no change to set
/// aside, and git's stash refuses it.
fn in_the_way(stderr: &str) -> bool {
    if stderr.lines().any(|line| line.ends_with(": needs merge")) {
        return false;
    }
    stderr.lines().any(|line| {
        line.contains("would be overwritten by checkout:")
            || line.contains("would be overwritten by merge:")
            || line.contains("would be removed by checkout:")
            || line.contains("would be removed by merge:")
            || line.contains("would lose untracked files in them:")
            || line.contains("cannot rebase: You have unstaged changes")
            || line.contains("cannot rebase: Your index contains uncommitted changes")
    })
}

/// Whether git's refusal names untracked files in the way, which only a stash that takes the
/// untracked files moves.
fn untracked_in_the_way(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        line.contains("untracked working tree files would be")
            || line.contains("would lose untracked files in them:")
    })
}

/// [`GitError::LocalChanges`] for git's refusal over local changes; any other error as it is.
pub(super) fn named(error: GitError) -> GitError {
    match error {
        GitError::Cli {
            command, stderr, ..
        } if in_the_way(&stderr) => GitError::LocalChanges { command, stderr },
        other => other,
    }
}

/// [`named`] for a merge, a rebase or a pull, unless no stash would let it through: git words
/// a rebase over an unmerged file as unstaged changes (its "needs merge" goes to stdout), and
/// no stash sets a conflict aside; and a rebase that stopped part way (a replayed commit
/// writes over an untracked file) is in progress, to continue or abort. With conflicted paths
/// in the index, or an operation in progress, the refusal stays git's.
pub(super) fn named_unless_conflicted(
    engine: &Git2Engine,
    error: GitError,
    cancel: &Cancel,
) -> GitError {
    match &error {
        GitError::Cli { stderr, .. } if in_the_way(stderr) => {
            let conflicted = sequencer::conflicts(engine, cancel)
                .map(|conflicts| !conflicts.is_empty())
                .unwrap_or(false);
            let stopped = sequencer::operation_state(engine)
                .map(|state| state != OperationState::None)
                .unwrap_or(false);
            if conflicted || stopped {
                error
            } else {
                named(error)
            }
        }
        _ => error,
    }
}

/// `error` with a sentence of what became of the changes after it, its code kept.
fn noted(error: GitError, note: &str) -> GitError {
    match error {
        GitError::Cli {
            command,
            status,
            stderr,
        } => GitError::Cli {
            command,
            status,
            stderr: format!("{stderr}\n{note}"),
        },
        GitError::LocalChanges { command, stderr } => GitError::LocalChanges {
            command,
            stderr: format!("{stderr}\n{note}"),
        },
        GitError::GitNotStarted { command, reason } => GitError::GitNotStarted {
            command,
            reason: format!("{reason}\n{note}"),
        },
        other => GitError::Git(format!("{other}\n{note}")),
    }
}

/// git's words of an exit: stderr, or stdout when git said it there.
fn words(exit: &CliExit) -> String {
    if exit.stderr.trim().is_empty() {
        String::from_utf8_lossy(&exit.stdout).trim_end().to_owned()
    } else {
        exit.stderr.trim_end().to_owned()
    }
}

/// git's words of an error, for the answer of a switch that happened.
fn words_of(error: &GitError) -> String {
    error
        .detail()
        .map_or_else(|| error.to_string(), str::to_owned)
}

/// `text` with each run of whitespace as one space, as git writes a stash's message into the
/// stash list.
fn squashed(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The line git prints after `prefix` on stdout or stderr, trimmed.
fn printed(exit: &CliExit, prefix: &str) -> Option<String> {
    let stdout = String::from_utf8_lossy(&exit.stdout);
    stdout
        .lines()
        .chain(exit.stderr.lines())
        .find_map(|line| line.trim().strip_prefix(prefix).map(str::to_owned))
}

/// The abbreviated commit git printed for the autostash it made ("Created autostash: 14ebb0d").
pub(super) fn created_autostash(exit: &CliExit) -> Option<String> {
    printed(exit, "Created autostash: ")
        .filter(|hex| hex.len() >= 4 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// HEAD as a switch moves it: the ref it names (none when detached) and its commit (none on
/// an unborn branch).
type Head = (Option<Vec<u8>>, Option<Oid>);

fn head_of(engine: &Git2Engine) -> GitResult<Head> {
    engine.with_repo(|repo| {
        let head = repo.find_reference("HEAD")?;
        let name = head.symbolic_target_bytes().map(<[u8]>::to_vec);
        let commit = head.resolve().ok().and_then(|resolved| resolved.target());
        Ok((name, commit))
    })
}

/// The stash list's entry that `wanted` picks, newest first and newer than `older` (the newest
/// stash before the step that made it): a stash made meanwhile in another worktree of the
/// repository, which shares `refs/stash`, is older than ours or fails `wanted`.
fn newest(
    engine: &Git2Engine,
    older: Option<&str>,
    wanted: impl Fn(&Repository, Oid, &str) -> bool,
) -> GitResult<Option<String>> {
    let older = older.and_then(|older| Oid::from_str(older).ok());
    engine.with_repo(|repo| {
        let Some(reflog) = refs::stash_reflog(repo)? else {
            return Ok(None);
        };
        for (_, entry) in refs::stash_entries(&reflog) {
            let id = entry.id_new();
            if Some(id) == older {
                break;
            }
            let message = entry.message().ok().flatten().unwrap_or_default();
            if wanted(repo, id, message) {
                return Ok(Some(id.to_string()));
            }
        }
        Ok(None)
    })
}

/// Whether the stash commit `id` was made over the commit `head` (its first parent).
fn made_over(repo: &Repository, id: Oid, head: Option<Oid>) -> bool {
    let parent = repo
        .find_commit(id)
        .ok()
        .and_then(|commit| commit.parent_id(0).ok());
    parent.is_some() && parent == head
}

/// How a stash came back.
enum Applied {
    /// Whole, and dropped; `unstaged` when the staged part did not apply on the commit and
    /// came back unstaged.
    Clean { unstaged: bool },
    /// With conflicts in the paths listed, git's words with them; the stash is kept.
    Conflicts(Vec<Conflict>, String),
    /// Not whole, or not at all (a file the branch tracks where an untracked one comes back, a
    /// file git could not write), or the drop after a clean apply failed; the stash is kept.
    Kept(String),
}

/// Applies the stash `commit` (its index first), dropping it when it came back whole.
fn pop(engine: &Git2Engine, commit: &str) -> GitResult<Applied> {
    let root = &GitEngine::repo(engine).root;
    let never = Cancel::never();
    let before = sequencer::conflicts_within(engine, STEP_LIMIT)?;
    let indexed = ["stash", "apply", "--index", "-q", commit];
    let mut exit = run_git_env_within(root, &indexed, &WRITE_ENV, &never, STEP_LIMIT)?;
    let unstaged = exit.status != Some(0) && words(&exit).contains("Try without --index");
    if unstaged {
        // The staged part does not apply on this commit, and git touched nothing: the changes
        // come back unstaged.
        let plain = ["stash", "apply", "-q", commit];
        exit = run_git_env_within(root, &plain, &WRITE_ENV, &never, STEP_LIMIT)?;
    }
    if exit.status == Some(0) {
        return Ok(match stash::stash_drop_within(engine, commit, STEP_LIMIT) {
            // Dropped elsewhere meanwhile: the pop's end state holds.
            Ok(()) | Err(GitError::StashNotFound(_)) => Applied::Clean { unstaged },
            Err(error) => Applied::Kept(words_of(&error)),
        });
    }
    let said = words(&exit);
    let conflicts = sequencer::conflicts_within(engine, STEP_LIMIT)?;
    if exit.status == Some(1) && conflicts.iter().any(|conflict| !before.contains(conflict)) {
        return Ok(Applied::Conflicts(conflicts, said));
    }
    Ok(Applied::Kept(said))
}

/// Runs `switch` (which answers git's `error:` lines of a switch it completed, such as a file
/// it could not rewrite) and tells a switch git reports a failure after from one that did not
/// happen: with HEAD moved (a post-checkout hook failed, such as Git LFS's without `git-lfs` on
/// the path), the switch happened. git's words either way are the answer's notice.
fn attempt(
    engine: &Git2Engine,
    switch: &impl Fn(&Cancel) -> GitResult<Option<String>>,
    cancel: &Cancel,
) -> GitResult<Option<String>> {
    let head = head_of(engine)?;
    match switch(cancel) {
        Ok(errors) => Ok(errors),
        Err(error) if head_of(engine).is_ok_and(|now| now != head) => Ok(Some(words_of(&error))),
        Err(error) => Err(error),
    }
}

/// The answer of a switch that took no stash, with git's notice when it gave one.
fn plain(notice: Option<String>) -> Switched {
    Switched {
        notice,
        ..Switched::default()
    }
}

/// Runs `switch` (a `git switch` to `target`, which git may refuse over local changes, run
/// with the cancel it is given) as `mode` asks: as it is; or, when git refuses, with the
/// changes stashed (the untracked files too when git names them, always for
/// [`LocalChanges::Leave`]) and, for [`LocalChanges::Carry`], applied back on the new branch.
/// A switch that does not happen puts them back where they were; one that git reports a
/// failure after (a post-checkout hook) goes on, git's words in the answer's notice. Changes
/// that do not come back whole stay in their stash, named.
pub(super) fn switch_with(
    engine: &Git2Engine,
    target: &str,
    mode: LocalChanges,
    cancel: &Cancel,
    switch: impl Fn(&Cancel) -> GitResult<Option<String>>,
) -> GitResult<Switched> {
    let (message, untracked) = match mode {
        LocalChanges::Refuse => return attempt(engine, &switch, cancel).map(plain).map_err(named),
        // Only what is in the way moves: a switch that git lets through needs no stash.
        LocalChanges::Carry => match attempt(engine, &switch, cancel).map_err(named) {
            Ok(notice) => return Ok(plain(notice)),
            Err(GitError::LocalChanges { stderr, .. }) => (
                format!("Begitra: carried to {target}"),
                untracked_in_the_way(&stderr),
            ),
            Err(other) => return Err(other),
        },
        LocalChanges::Leave => (format!("Begitra: left before switching to {target}"), true),
    };
    cancel.check()?;
    match carry(engine, mode, &message, untracked, &switch)? {
        Carried::Done(switched) => Ok(switched),
        // git names the untracked files in the way only once the tracked ones are out of it (a
        // folder the branch turns into a file): once more, with them.
        Carried::Untracked(_) if !untracked => {
            match carry(engine, mode, &message, true, &switch)? {
                Carried::Done(switched) => Ok(switched),
                Carried::Untracked(error) => Err(error),
            }
        }
        Carried::Untracked(error) => Err(error),
    }
}

/// What a stash and a switch came to.
enum Carried {
    Done(Switched),
    /// git refused the switch after the stash over untracked files the stash did not take; the
    /// changes are back where they were.
    Untracked(GitError),
}

/// The stash (`untracked` with the untracked files), the switch and, for
/// [`LocalChanges::Carry`], the apply back, every step with no cancel; see [`switch_with`].
fn carry(
    engine: &Git2Engine,
    mode: LocalChanges,
    message: &str,
    untracked: bool,
    switch: &impl Fn(&Cancel) -> GitResult<Option<String>>,
) -> GitResult<Carried> {
    let root = &GitEngine::repo(engine).root;
    let never = Cancel::never();
    let head = head_of(engine)?;
    let older = stash::stash_tip(engine)?;
    // Not `-q`: git says why it cannot stash (an unborn branch), and the message it stored.
    let mut args = vec!["stash", "push"];
    if untracked {
        args.push("--include-untracked");
    }
    args.extend(["-m", message]);
    let pushed = run_git_env_within(root, &args, &WRITE_ENV, &never, STEP_LIMIT);
    // The message as git stored it ("On main: …") tells this worktree's stash from one another
    // worktree made meanwhile with the same words; without it, the words alone.
    let stored = pushed
        .as_ref()
        .ok()
        .and_then(|exit| printed(exit, "Saved working directory and index state "))
        .map(|stored| squashed(&stored));
    let ours = squashed(message);
    let made = newest(engine, older.as_deref(), |repo, id, said| {
        let said = squashed(said);
        let named = match &stored {
            Some(stored) => said == *stored,
            None => said.ends_with(&ours),
        };
        named && made_over(repo, id, head.1)
    })?;
    let exit = match pushed {
        Ok(exit) if exit.status == Some(0) => exit,
        failed => {
            let error = match failed {
                Ok(exit) => exit.into_failure(&args),
                Err(error) => error,
            };
            let Some(commit) = made else {
                return Err(error);
            };
            // git stored the stash and failed cleaning the tree after it (a file another
            // program holds open): what it took comes back, and the stash goes once all of it
            // did.
            return Err(match undo_push(engine, &commit) {
                Ok(true) => error,
                Ok(false) => noted(error, &format!("The changes are in the stash {commit}.")),
                Err(undo) => noted(
                    error,
                    &format!("The changes are in the stash {commit}: {}", words_of(&undo)),
                ),
            });
        }
    };
    let Some(stash) = made else {
        if !String::from_utf8_lossy(&exit.stdout).contains("No local changes to save") {
            let tip = stash::stash_tip(engine)?.unwrap_or_default();
            return Err(GitError::Git(format!(
                "git stashed the changes in a stash this switch cannot tell from the others; the newest is {tip}"
            )));
        }
        // Nothing to save (a change only a submodule holds): git decides as for any switch.
        return attempt(engine, switch, &never).map(|notice| Carried::Done(plain(notice)));
    };
    let notice = match attempt(engine, switch, &never) {
        Ok(notice) => notice,
        Err(error) => {
            // The switch did not happen: the changes go back where they were. A refusal now is
            // git's own, the stash having cleared what it took.
            let note = match pop(engine, &stash) {
                Ok(Applied::Clean { .. }) => {
                    let missed = !untracked && error.detail().is_some_and(untracked_in_the_way);
                    return if missed {
                        Ok(Carried::Untracked(error))
                    } else {
                        Err(error)
                    };
                }
                Ok(Applied::Conflicts(..)) => {
                    format!("The changes came back with conflicts; the stash {stash} keeps them.")
                }
                Ok(Applied::Kept(said)) => {
                    format!("The changes stayed in the stash {stash}: {said}")
                }
                Err(back) => format!(
                    "The changes stayed in the stash {stash}: {}",
                    words_of(&back)
                ),
            };
            return Err(noted(error, &note));
        }
    };
    if mode == LocalChanges::Leave {
        return Ok(Carried::Done(Switched {
            stash: Some(stash),
            notice,
            ..Switched::default()
        }));
    }
    let applied = pop(engine, &stash).unwrap_or_else(|error| Applied::Kept(words_of(&error)));
    Ok(Carried::Done(match applied {
        Applied::Clean { unstaged } => Switched {
            unstaged,
            ..plain(notice)
        },
        Applied::Conflicts(conflicts, said) => {
            // git puts the untracked files back after the merge of the tracked ones, and
            // refuses one the branch tracks: then the stash holds something no file does.
            let partial = said.contains("could not restore untracked files");
            Switched {
                stash: Some(stash),
                conflicts,
                kept: partial.then_some(said),
                notice,
                unstaged: false,
            }
        }
        Applied::Kept(said) => Switched {
            stash: Some(stash),
            kept: Some(said),
            notice,
            ..Switched::default()
        },
    }))
}

/// Puts back what a `git stash push` that stored `commit` and then failed took from the
/// working tree. git stores the stash, removes the untracked files it took, then resets the
/// tracked ones, and a file another program holds open stops either step: the untracked files
/// it removed come back from the stash's third parent (those still there stay), the tracked
/// files as the stash holds them, and a file the changes deleted that the reset put back goes
/// again. The stash is dropped once the working tree holds every file of the stash as the
/// stash does, the index is as the stash's and nothing the changes deleted is on disk; true
/// when it was.
fn undo_push(engine: &Git2Engine, commit: &str) -> GitResult<bool> {
    let root = &GitEngine::repo(engine).root;
    let never = Cancel::never();
    let (untracked, dir) = engine.with_repo(|repo| {
        let stash = repo.find_commit(Oid::from_str(commit)?)?;
        Ok((stash.parent_id(2).ok(), repo.path().to_path_buf()))
    })?;
    let mut whole = true;
    if let Some(untracked) = untracked {
        let untracked = untracked.to_string();
        whole &= scratch(&dir, "untracked", |index| {
            same_as(root, index, &untracked, true)
        })?;
    }
    let changed = [
        "diff",
        "--no-ext-diff",
        "--ignore-submodules=dirty",
        "--name-only",
        "-z",
        "--no-renames",
        commit,
        "--",
    ];
    let exit = run_git_env_within(root, &changed, &WRITE_ENV, &never, STEP_LIMIT)?;
    if exit.status != Some(0) {
        return Ok(false);
    }
    let differing: Vec<&[u8]> = exit
        .stdout
        .split(|&byte| byte == 0)
        .filter(|path| !path.is_empty())
        .collect();
    if !differing.is_empty() {
        let restore = [
            "restore",
            "--source",
            commit,
            "--worktree",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ];
        let exit = run_git_env_with_input_within(
            root,
            &restore,
            &WRITE_ENV,
            pathspecs(&differing),
            &never,
            STEP_LIMIT,
        )?;
        whole &= exit.status == Some(0);
    }
    whole &= deleted_again(engine, root, &dir, commit)?;
    whole &= scratch(&dir, "stash", |index| same_as(root, index, commit, false))?;
    let index = format!("{commit}^2");
    let staged = [
        "diff",
        "--no-ext-diff",
        "--ignore-submodules=dirty",
        "--quiet",
        "--cached",
        index.as_str(),
    ];
    whole &= run_git_env_within(root, &staged, &WRITE_ENV, &never, STEP_LIMIT)?.status == Some(0);
    if !whole {
        return Ok(false);
    }
    Ok(match stash::stash_drop_within(engine, commit, STEP_LIMIT) {
        Ok(()) | Err(GitError::StashNotFound(_)) => true,
        Err(error) => {
            tracing::warn!(%error, "the stash a failed push left could not be dropped");
            false
        }
    })
}

/// `paths` as a NUL-separated list of literal pathspecs, for `--pathspec-from-file=-`.
fn pathspecs(paths: &[&[u8]]) -> Vec<u8> {
    let mut list = Vec::new();
    for path in paths {
        list.extend_from_slice(b":(literal)");
        list.extend_from_slice(path);
        list.push(0);
    }
    list
}

/// Runs `check` with a scratch index file of its own in the git directory `dir`, which is gone
/// after it; false when the directory's path is not one git can be given.
fn scratch(
    dir: &Path,
    purpose: &str,
    check: impl FnOnce(&str) -> GitResult<bool>,
) -> GitResult<bool> {
    let path = dir.join(format!("begitra-{purpose}-{}.index", std::process::id()));
    let Some(index) = path.to_str() else {
        return Ok(false);
    };
    let checked = check(index);
    if let Err(error) = std::fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::debug!(%error, "a scratch index could not be removed");
        }
    }
    checked
}

/// Whether the working tree holds every file of `tree` as `tree` does (or, with `paths`, those
/// of its files), read through the scratch index `index`; with `write`, the files missing from
/// the working tree are written first, as `git stash apply` puts a stash's untracked files back
/// (the ones there stay).
fn same_as(root: &Path, index: &str, tree: &str, write: bool) -> GitResult<bool> {
    same_as_at(root, index, tree, write, &[])
}

fn same_as_at(
    root: &Path,
    index: &str,
    tree: &str,
    write: bool,
    paths: &[&[u8]],
) -> GitResult<bool> {
    let never = Cancel::never();
    let mut env = WRITE_ENV.to_vec();
    env.push(("GIT_INDEX_FILE", index));
    let read = run_git_env_within(root, &["read-tree", tree], &env, &never, STEP_LIMIT)?;
    if read.status != Some(0) {
        return Ok(false);
    }
    if write {
        // It fails on the files still there, which it leaves as they are: the diff after it
        // says whether they hold what the stash does.
        run_git_env_within(
            root,
            &["checkout-index", "--all", "-q"],
            &env,
            &never,
            STEP_LIMIT,
        )?;
    }
    // `git diff` reads no pathspec file: the paths, few, go after `--`.
    let mut literal = Vec::with_capacity(paths.len());
    for path in paths {
        let Ok(path) = std::str::from_utf8(path) else {
            return Ok(false);
        };
        literal.push(format!(":(literal){path}"));
    }
    let mut same = vec![
        "diff",
        "--no-ext-diff",
        "--ignore-submodules=dirty",
        "--quiet",
        "--",
    ];
    same.extend(literal.iter().map(String::as_str));
    Ok(run_git_env_within(root, &same, &env, &never, STEP_LIMIT)?.status == Some(0))
}

/// Takes away again the files the stashed changes deleted that git's reset put back from HEAD
/// before it stopped: such a file is in neither the stash nor the index. Only files that hold
/// HEAD's version go, and none when one of them is an untracked file the stash took; true when
/// none of them is left on disk.
fn deleted_again(engine: &Git2Engine, root: &Path, dir: &Path, commit: &str) -> GitResult<bool> {
    let head = format!("{commit}^1");
    let args = [
        "diff",
        "--no-ext-diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--diff-filter=D",
        head.as_str(),
        commit,
        "--",
    ];
    let exit = run_git_env_within(root, &args, &WRITE_ENV, &Cancel::never(), STEP_LIMIT)?;
    if exit.status != Some(0) {
        return Ok(false);
    }
    let mut back: Vec<(&[u8], &Path)> = Vec::new();
    for path in exit
        .stdout
        .split(|&byte| byte == 0)
        .filter(|path| !path.is_empty())
    {
        let Some(relative) = os_path(path) else {
            return Ok(false);
        };
        if root.join(relative).symlink_metadata().is_ok() {
            back.push((path, relative));
        }
    }
    if back.is_empty() {
        return Ok(true);
    }
    let taken = engine.with_repo(|repo| {
        let stash = repo.find_commit(Oid::from_str(commit)?)?;
        let Ok(untracked) = stash.parent(2) else {
            return Ok(false);
        };
        let tree = untracked.tree()?;
        Ok(back
            .iter()
            .any(|(_, relative)| tree.get_path(relative).is_ok()))
    })?;
    let paths: Vec<&[u8]> = back.iter().map(|(path, _)| *path).collect();
    if taken
        || !scratch(dir, "head", |index| {
            same_as_at(root, index, &head, false, &paths)
        })?
    {
        return Ok(false);
    }
    for (_, relative) in &back {
        if std::fs::remove_file(root.join(relative)).is_err() {
            return Ok(false);
        }
        // Folders the reset made for it go with it while they are empty.
        let mut parent = relative.parent();
        while let Some(folder) = parent.filter(|folder| !folder.as_os_str().is_empty()) {
            if std::fs::remove_dir(root.join(folder)).is_err() {
                break;
            }
            parent = folder.parent();
        }
    }
    Ok(true)
}

/// What tells, after an operation that may set the changes aside, which stash git kept: HEAD
/// and the newest stash before it, and the stash an operation in progress holds aside.
pub(super) struct Before {
    head: Option<Oid>,
    older: Option<String>,
    held: Option<Oid>,
}

/// See [`Before`].
pub(super) fn stash_before(engine: &Git2Engine) -> GitResult<Before> {
    let held = engine.with_repo(|repo| Ok(autostash_held(repo)))?;
    Ok(Before {
        head: head_of(engine)?.1,
        older: stash::stash_tip(engine)?,
        held,
    })
}

/// The stash an operation that stopped holds aside: the commit its autostash file names, in
/// full.
fn autostash_held(repo: &Repository) -> Option<Oid> {
    AUTOSTASH_FILES.iter().find_map(|name| {
        let text = std::fs::read_to_string(repo.path().join(name)).ok()?;
        let text = text.trim();
        if !matches!(text.len(), 40 | 64) {
            return None;
        }
        Oid::from_str(text).ok()
    })
}

/// See [`GitEngine::held_aside`].
pub(super) fn held_aside(engine: &Git2Engine) -> GitResult<Option<String>> {
    engine.with_repo(|repo| Ok(autostash_held(repo).map(|oid| oid.to_string())))
}

/// `outcome` with the stash git kept when the changes its autostash set aside did not come
/// back cleanly: the one an operation in progress held aside, or an `autostash` entry made
/// over the HEAD before the operation (the one git said it created, when it said so); newer
/// than the stash before it, so one made meanwhile in another worktree, which shares the stash
/// list, is never taken for it. git has finished by then: a failure to read the list leaves
/// the outcome as it is.
pub(super) fn after_operation(
    engine: &Git2Engine,
    outcome: Outcome,
    before: &Before,
    created: Option<&str>,
) -> Outcome {
    let kept = newest(engine, before.older.as_deref(), |repo, id, said| {
        let ours = created.is_none_or(|abbrev| id.to_string().starts_with(abbrev));
        Some(id) == before.held || (said == "autostash" && ours && made_over(repo, id, before.head))
    });
    match kept {
        Ok(stash) => Outcome { stash, ..outcome },
        Err(error) => {
            tracing::warn!(%error, "the stash list could not be read after the operation");
            outcome
        }
    }
}

/// `error` of an operation that failed after git set the changes aside, with them listed as a
/// stash again when git neither holds them nor lists them any more (a `merge --abort` whose
/// reset fails has deleted `MERGE_AUTOSTASH` first): the stash is named in the error. Not when
/// git says it applied them back.
pub(super) fn rescued(
    engine: &Git2Engine,
    error: GitError,
    before: &Before,
    created: Option<&str>,
) -> GitError {
    if error
        .detail()
        .is_some_and(|said| said.contains("Applied autostash"))
    {
        return error;
    }
    let lost = match lost_autostash(engine, before, created) {
        Ok(Some(lost)) => lost,
        Ok(None) => return error,
        Err(read) => {
            tracing::warn!(%read, "the stash git set aside could not be looked for");
            return error;
        }
    };
    let root = &GitEngine::repo(engine).root;
    let args = ["stash", "store", "-q", "-m", "autostash", lost.as_str()];
    match run_git_env_within(root, &args, &WRITE_ENV, &Cancel::never(), STEP_LIMIT) {
        Ok(exit) if exit.status == Some(0) => noted(
            error,
            &format!("The changes git had set aside are in the stash {lost}."),
        ),
        _ => noted(
            error,
            &format!(
                "The changes git had set aside are in the commit {lost}; git stash store {lost} lists it."
            ),
        ),
    }
}

/// The commit of the changes git set aside for the operation (held before it, or created by
/// it) when git no longer holds it and the stash list does not show it.
fn lost_autostash(
    engine: &Git2Engine,
    before: &Before,
    created: Option<&str>,
) -> GitResult<Option<String>> {
    engine.with_repo(|repo| {
        let candidate = before.held.or_else(|| {
            let abbrev = created?;
            let object = repo.revparse_single(abbrev).ok()?;
            Some(object.peel_to_commit().ok()?.id())
        });
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        if autostash_held(repo) == Some(candidate) {
            return Ok(None);
        }
        let listed = match refs::stash_reflog(repo)? {
            Some(reflog) => {
                refs::stash_entries(&reflog).any(|(_, entry)| entry.id_new() == candidate)
            }
            None => false,
        };
        Ok((!listed).then(|| candidate.to_string()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_s_refusals_over_local_changes_are_told_apart() {
        for words in [
            "error: Your local changes to the following files would be overwritten by checkout:\n\tf.txt\nPlease commit your changes or stash them before you switch branches.\nAborting",
            "error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt",
            "error: The following untracked working tree files would be removed by checkout:\n\tdir/new.txt",
            "error: Your local changes to the following files would be overwritten by merge:\n\tg.txt",
            "error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt",
            "error: Updating the following directories would lose untracked files in them:\n\tdir",
            "error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.",
            "error: cannot rebase: Your index contains uncommitted changes.",
        ] {
            assert!(in_the_way(words), "{words}");
        }
        assert!(!in_the_way("fatal: invalid reference: nowhere"));
        assert!(!in_the_way(
            "f.txt: needs merge\nerror: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them."
        ));
        assert!(!in_the_way(
            "error: pathspec 'x' did not match any file(s) known to git"
        ));
        // A path that holds the words is not git saying them.
        assert!(in_the_way(
            "error: Your local changes to the following files would be overwritten by checkout:\n\tdocs/what needs merge.md"
        ));
        assert!(!in_the_way(
            "fatal: 'would be overwritten by checkout' is not a commit"
        ));
    }

    #[test]
    fn untracked_files_in_the_way_are_told_from_tracked_ones() {
        assert!(untracked_in_the_way(
            "error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt"
        ));
        assert!(untracked_in_the_way(
            "error: The following untracked working tree files would be removed by checkout:\n\tdir/new.txt"
        ));
        assert!(untracked_in_the_way(
            "error: Updating the following directories would lose untracked files in them:\n\tdir"
        ));
        assert!(!untracked_in_the_way(
            "error: Your local changes to the following files would be overwritten by checkout:\n\tf.txt"
        ));
    }

    #[test]
    fn a_message_matches_however_git_spaced_it() {
        assert_eq!(
            squashed("Begitra: carried to other^{/fix  the\tthing} "),
            "Begitra: carried to other^{/fix the thing}"
        );
    }

    #[test]
    fn the_autostash_git_says_it_created_is_read() {
        let exit = CliExit {
            status: Some(1),
            stdout: b"Created autostash: 14ebb0d\nAuto-merging f.txt\n".to_vec(),
            stderr: String::new(),
        };
        assert_eq!(created_autostash(&exit).as_deref(), Some("14ebb0d"));
        let other = CliExit {
            status: Some(0),
            stdout: b"Created autostash: not a hash\n".to_vec(),
            stderr: String::new(),
        };
        assert_eq!(created_autostash(&other), None);
    }
}
