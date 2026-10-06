//! Branch, tag and upstream operations, merge, rebase, reset, cherry-pick and revert, through
//! the git CLI in the repository's root with argv. A name that could look like an
//! option goes after `--` where git reads one, and so do the revisions of a merge and a
//! rebase; a reset resolves its revision first and passes the hash before `--`, so a path or
//! an option never reaches git as one (the bridge refuses option-shaped revisions before any
//! command runs). A merge, rebase, pick or revert that stops on conflicts is an [`Outcome`],
//! not an error (see [`super::sequencer`]).

use git2::RepositoryState;

use super::{sequencer, Git2Engine};
use crate::cli::{run_git_env, CliExit, WRITE_ENV};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{MergeMode, Outcome, OutcomeKind, ResetMode, SwitchTarget};

/// Runs `git <args>` in the root with the write environment.
fn git(engine: &Git2Engine, args: &[&str], cancel: &Cancel) -> GitResult<CliExit> {
    run_git_env(&GitEngine::repo(engine).root, args, &WRITE_ENV, cancel)
}

/// Runs `git <args>` and turns a non-zero status into [`GitError::Cli`].
fn git_ok(engine: &Git2Engine, args: &[&str], cancel: &Cancel) -> GitResult<()> {
    let exit = git(engine, args, cancel)?;
    if exit.status == Some(0) {
        Ok(())
    } else {
        Err(exit.into_failure(args))
    }
}

/// See [`GitEngine::branch_create`]. A tracking branch from a remote-tracking ref needs the one
/// remote that fetches it: git checks that only after `switch -c` rewrote the index and the
/// working tree (two remotes that claim the ref, or none), and leaves them half switched, so
/// the remote is asked of libgit2 first.
#[tracing::instrument(level = "debug", skip_all, fields(name, start, checkout, track))]
pub(super) fn branch_create(
    engine: &Git2Engine,
    name: &str,
    start: &str,
    checkout: bool,
    track: bool,
    cancel: &Cancel,
) -> GitResult<()> {
    if track && start.starts_with("refs/remotes/") {
        engine.with_repo(|repo| match repo.branch_remote_name(start) {
            Ok(_) => Ok(()),
            Err(error) => Err(GitError::Git(format!(
                "{start} cannot be tracked: no remote, or more than one, fetches it ({})",
                error.message()
            ))),
        })?;
    }
    let mut args = if checkout {
        vec!["switch", "-c", name]
    } else {
        vec!["branch"]
    };
    if track {
        args.push("--track");
    }
    args.push("--");
    if !checkout {
        args.push(name);
    }
    args.push(start);
    git_ok(engine, &args, cancel)
}

/// See [`GitEngine::switch`].
#[tracing::instrument(level = "debug", skip_all, fields(target = ?target))]
pub(super) fn switch(engine: &Git2Engine, target: &SwitchTarget, cancel: &Cancel) -> GitResult<()> {
    match target {
        SwitchTarget::Branch { name } => git_ok(engine, &["switch", "--", name], cancel),
        SwitchTarget::Detached { rev } => {
            git_ok(engine, &["switch", "--detach", "--", rev], cancel)
        }
    }
}

/// See [`GitEngine::branch_rename`].
#[tracing::instrument(level = "debug", skip_all, fields(from, to))]
pub(super) fn branch_rename(
    engine: &Git2Engine,
    from: &str,
    to: &str,
    cancel: &Cancel,
) -> GitResult<()> {
    git_ok(engine, &["branch", "-m", "--", from, to], cancel)
}

/// See [`GitEngine::branch_delete`].
#[tracing::instrument(level = "debug", skip_all, fields(name, force))]
pub(super) fn branch_delete(
    engine: &Git2Engine,
    name: &str,
    force: bool,
    cancel: &Cancel,
) -> GitResult<()> {
    let flag = if force { "-D" } else { "-d" };
    git_ok(engine, &["branch", flag, "--", name], cancel)
}

/// See [`GitEngine::tag_create`].
#[tracing::instrument(level = "debug", skip_all, fields(name, rev, annotated = message.is_some()))]
pub(super) fn tag_create(
    engine: &Git2Engine,
    name: &str,
    rev: &str,
    message: Option<&str>,
    cancel: &Cancel,
) -> GitResult<()> {
    match message {
        Some(message) => git_ok(
            engine,
            &["tag", "-a", "-m", message, "--", name, rev],
            cancel,
        ),
        None => git_ok(engine, &["tag", "--", name, rev], cancel),
    }
}

/// See [`GitEngine::tag_delete`]: the ref's own target is read before git deletes it, unpeeled,
/// so an annotated tag answers its tag object rather than the commit.
#[tracing::instrument(level = "debug", skip_all, fields(name))]
pub(super) fn tag_delete(
    engine: &Git2Engine,
    name: &str,
    cancel: &Cancel,
) -> GitResult<Option<String>> {
    let full = format!("refs/tags/{name}");
    // A missing tag is left to git, whose refusal names it.
    let was = engine.with_repo(|repo| match repo.find_reference(&full) {
        Ok(reference) => Ok(reference.target().map(|oid| oid.to_string())),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(GitError::from(error)),
    })?;
    git_ok(engine, &["tag", "-d", "--", name], cancel)?;
    Ok(was)
}

/// See [`GitEngine::set_upstream`].
#[tracing::instrument(level = "debug", skip_all, fields(branch, upstream))]
pub(super) fn set_upstream(
    engine: &Git2Engine,
    branch: &str,
    upstream: Option<&str>,
    cancel: &Cancel,
) -> GitResult<()> {
    match upstream {
        Some(upstream) => {
            let option = format!("--set-upstream-to={upstream}");
            git_ok(engine, &["branch", option.as_str(), "--", branch], cancel)
        }
        None => git_ok(
            engine,
            &["branch", "--unset-upstream", "--", branch],
            cancel,
        ),
    }
}

/// See [`GitEngine::merge`]: the kind is read from where HEAD went, not from git's words
/// (which follow the user's language).
#[tracing::instrument(level = "debug", skip_all, fields(rev, mode = ?mode))]
pub(super) fn merge(
    engine: &Git2Engine,
    rev: &str,
    mode: MergeMode,
    cancel: &Cancel,
) -> GitResult<Outcome> {
    let before = sequencer::head_hash(engine)?;
    let target = engine.with_repo(|repo| Ok(super::resolve_commit(repo, rev)?.to_string()))?;
    let mut args = vec!["merge"];
    match mode {
        MergeMode::Default => {}
        MergeMode::FfOnly => args.push("--ff-only"),
        MergeMode::NoFf => args.push("--no-ff"),
    }
    args.push("--");
    args.push(rev);
    let exit = git(engine, &args, cancel)?;
    let outcome = sequencer::outcome(engine, &args, exit, OutcomeKind::Merged, None, cancel)?;
    let outcome = sequencer::after_autostash(engine, outcome, cancel)?;
    if outcome.kind != OutcomeKind::Merged {
        return Ok(outcome);
    }
    let kind = match outcome.hash.as_deref() {
        after if after == before.as_deref() => OutcomeKind::UpToDate,
        Some(after) if after == target => OutcomeKind::FastForward,
        _ => OutcomeKind::Merged,
    };
    Ok(Outcome { kind, ..outcome })
}

/// See [`GitEngine::rebase`].
#[tracing::instrument(level = "debug", skip_all, fields(onto))]
pub(super) fn rebase(engine: &Git2Engine, onto: &str, cancel: &Cancel) -> GitResult<Outcome> {
    let before = sequencer::head_hash(engine)?;
    let args = ["rebase", "--", onto];
    let exit = git(engine, &args, cancel)?;
    let outcome = sequencer::outcome(engine, &args, exit, OutcomeKind::Done, None, cancel)?;
    let outcome = sequencer::after_autostash(engine, outcome, cancel)?;
    if outcome.kind == OutcomeKind::Done && outcome.hash == before {
        return Ok(Outcome {
            kind: OutcomeKind::UpToDate,
            ..outcome
        });
    }
    Ok(outcome)
}

/// See [`GitEngine::reset`].
#[tracing::instrument(level = "debug", skip_all, fields(rev, mode = ?mode))]
pub(super) fn reset(
    engine: &Git2Engine,
    rev: &str,
    mode: ResetMode,
    cancel: &Cancel,
) -> GitResult<()> {
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        ResetMode::Hard => "--hard",
    };
    // The hash, then `--`: `git reset <path>` would unstage the path and move nothing.
    let hash = engine.with_repo(|repo| Ok(super::resolve_commit(repo, rev)?.to_string()))?;
    git_ok(engine, &["reset", "-q", flag, hash.as_str(), "--"], cancel)
}

/// See [`GitEngine::move_head`]: `git update-ref` on the branch's own name with the old
/// value, which git compares under the ref's lock; `HEAD` itself when detached.
#[tracing::instrument(level = "debug", skip_all, fields(from = %from, to = %to, branch))]
pub(super) fn move_head(
    engine: &Git2Engine,
    from: &str,
    to: &str,
    branch: Option<&str>,
    cancel: &Cancel,
) -> GitResult<()> {
    engine.with_repo(|repo| {
        // Full hashes, and a commit to go to: a zero new value would make `update-ref` delete
        // the branch.
        full_oid(from)?;
        let target = full_oid(to)?;
        if repo.find_commit(target).is_err() {
            return Err(GitError::RefNotFound(to.to_owned()));
        }
        if let Some(held) = held_by(repo)? {
            return Err(GitError::HeadHeld(held));
        }
        // HEAD on another branch (or detached, or unborn) is not where the move was planned.
        let head = repo.find_reference("HEAD")?;
        let on = head.symbolic_target()?.map(str::to_owned);
        if on.as_deref() != branch {
            let actual = repo
                .head()
                .ok()
                .and_then(|head| head.target())
                .map(|oid| oid.to_string());
            return Err(GitError::HeadMoved {
                expected: from.to_owned(),
                actual: actual.unwrap_or_default(),
            });
        }
        Ok(())
    })?;
    let reason = format!("reset: moving to {to}");
    let name = branch.unwrap_or("HEAD");
    let args = ["update-ref", "-m", reason.as_str(), "--", name, to, from];
    if let Err(error) = git_ok(engine, &args, cancel) {
        // Only a git that answered can have refused the old value, and its words do not say
        // which refusal it was: HEAD read again tells.
        if matches!(
            error,
            GitError::Cli {
                status: Some(_),
                ..
            }
        ) {
            if let Ok(actual) = sequencer::head_hash(engine) {
                if actual.as_deref() != Some(from) {
                    return Err(GitError::HeadMoved {
                        expected: from.to_owned(),
                        actual: actual.unwrap_or_default(),
                    });
                }
            }
        }
        return Err(error);
    }
    // As after `git reset`, with its reflog message; the move stands when ORIG_HEAD cannot be
    // written.
    let orig = [
        "update-ref",
        "-m",
        "reset: updating ORIG_HEAD",
        "--",
        "ORIG_HEAD",
        from,
    ];
    if let Err(error) = git_ok(engine, &orig, cancel) {
        tracing::warn!(%error, "ORIG_HEAD was not written");
    }
    Ok(())
}

/// A full, non-zero object id spelled in hexadecimal; anything else names no commit here.
fn full_oid(hash: &str) -> GitResult<git2::Oid> {
    let hex = hash.bytes().all(|byte| byte.is_ascii_hexdigit());
    let oid = if hex && matches!(hash.len(), 40 | 64) {
        git2::Oid::from_str(hash).ok()
    } else {
        None
    };
    oid.filter(|oid| !oid.is_zero())
        .ok_or_else(|| GitError::RefNotFound(hash.to_owned()))
}

/// What holds HEAD where it is: an operation in progress (a paused sequence of picks or
/// reverts included), or conflicts in the index (read again from disk); None when nothing
/// does.
fn held_by(repo: &git2::Repository) -> GitResult<Option<String>> {
    let operation = match repo.state() {
        RepositoryState::Clean => None,
        RepositoryState::Merge => Some("a merge"),
        RepositoryState::Revert | RepositoryState::RevertSequence => Some("a revert"),
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => Some("a cherry-pick"),
        RepositoryState::Bisect => Some("a bisect"),
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => Some("a rebase"),
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => Some("a git am"),
    };
    if let Some(operation) = operation {
        return Ok(Some(format!("{operation} is in progress")));
    }
    if super::staging::sequence_paused(repo) {
        return Ok(Some(
            "a cherry-pick or revert sequence is in progress".to_owned(),
        ));
    }
    let mut index = repo.index()?;
    index.read(false)?;
    Ok(index
        .has_conflicts()
        .then(|| "the index holds conflicts".to_owned()))
}

/// See [`GitEngine::cherry_pick`].
#[tracing::instrument(level = "debug", skip_all, fields(revs = revs.len()))]
pub(super) fn cherry_pick(
    engine: &Git2Engine,
    revs: &[String],
    cancel: &Cancel,
) -> GitResult<Outcome> {
    let mut args = vec!["cherry-pick"];
    args.extend(revs.iter().map(String::as_str));
    let exit = git(engine, &args, cancel)?;
    sequencer::outcome(engine, &args, exit, OutcomeKind::Done, None, cancel)
}

/// See [`GitEngine::revert`].
#[tracing::instrument(level = "debug", skip_all, fields(revs = revs.len()))]
pub(super) fn revert(engine: &Git2Engine, revs: &[String], cancel: &Cancel) -> GitResult<Outcome> {
    let mut args = vec!["revert", "--no-edit"];
    args.extend(revs.iter().map(String::as_str));
    let exit = git(engine, &args, cancel)?;
    sequencer::outcome(engine, &args, exit, OutcomeKind::Done, None, cancel)
}
