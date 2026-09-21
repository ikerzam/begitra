//! Branch, tag and upstream operations, merge, rebase, reset, cherry-pick and revert, through
//! the git CLI in the repository's root with argv. A name that could look like an
//! option goes after `--` where git reads one; revisions are checked for a leading dash by
//! the bridge before any command runs. A merge, rebase, pick or revert that stops on
//! conflicts is an [`Outcome`], not an error (see [`super::sequencer`]).

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
        Err(GitError::Cli {
            command: args.join(" "),
            status: exit.status,
            stderr: exit.stderr,
        })
    }
}

/// See [`GitEngine::branch_create`].
#[tracing::instrument(level = "debug", skip_all, fields(name, start, checkout))]
pub(super) fn branch_create(
    engine: &Git2Engine,
    name: &str,
    start: &str,
    checkout: bool,
    cancel: &Cancel,
) -> GitResult<()> {
    if checkout {
        git_ok(engine, &["switch", "-c", name, "--", start], cancel)
    } else {
        git_ok(engine, &["branch", "--", name, start], cancel)
    }
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

/// See [`GitEngine::tag_delete`].
#[tracing::instrument(level = "debug", skip_all, fields(name))]
pub(super) fn tag_delete(engine: &Git2Engine, name: &str, cancel: &Cancel) -> GitResult<()> {
    git_ok(engine, &["tag", "-d", "--", name], cancel)
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
    let target = engine.with_repo(|repo| {
        let object = repo.revparse_single(rev)?;
        let commit = object.peel_to_commit()?;
        Ok(commit.id().to_string())
    })?;
    let mut args = vec!["merge"];
    match mode {
        MergeMode::Default => {}
        MergeMode::FfOnly => args.push("--ff-only"),
        MergeMode::NoFf => args.push("--no-ff"),
    }
    args.push(rev);
    let exit = git(engine, &args, cancel)?;
    let outcome = sequencer::outcome(engine, &args, exit, OutcomeKind::Merged, cancel)?;
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
    let args = ["rebase", onto];
    let exit = git(engine, &args, cancel)?;
    sequencer::outcome(engine, &args, exit, OutcomeKind::Done, cancel)
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
    git_ok(engine, &["reset", "-q", flag, rev], cancel)
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
    sequencer::outcome(engine, &args, exit, OutcomeKind::Done, cancel)
}

/// See [`GitEngine::revert`].
#[tracing::instrument(level = "debug", skip_all, fields(revs = revs.len()))]
pub(super) fn revert(engine: &Git2Engine, revs: &[String], cancel: &Cancel) -> GitResult<Outcome> {
    let mut args = vec!["revert", "--no-edit"];
    args.extend(revs.iter().map(String::as_str));
    let exit = git(engine, &args, cancel)?;
    sequencer::outcome(engine, &args, exit, OutcomeKind::Done, cancel)
}
