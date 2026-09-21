//! The stash: push, apply, pop and drop through the git CLI. A pop or apply that
//! conflicts is an [`Outcome`] with the paths (git keeps the stash then), like the
//! sequencer's stops; the listing is part of `refs`.

use super::{sequencer, Git2Engine};
use crate::cli::{run_git_env, run_git_with_input, CliExit, WRITE_ENV};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{Outcome, OutcomeKind, StashPush};

fn failed(args: &[&str], exit: CliExit) -> GitError {
    GitError::Cli {
        command: args.join(" "),
        status: exit.status,
        stderr: exit.stderr,
    }
}

/// `stash@{n}`.
fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

/// See [`GitEngine::stash_push`]: `true` when a stash was made, `false` when git found
/// nothing to save (it says so and exits 0).
#[tracing::instrument(level = "debug", skip_all, fields(untracked = request.include_untracked, paths = request.paths.len()))]
pub(super) fn stash_push(
    engine: &Git2Engine,
    request: &StashPush,
    cancel: &Cancel,
) -> GitResult<bool> {
    let root = &GitEngine::repo(engine).root;
    let before = stash_count(engine, cancel)?;
    // Not `--literal-pathspecs`: it reaches the `git clean` a stash runs for its untracked
    // files and leaves them on disk (git 2.54); the `:(literal)` magic on each path does not.
    let mut args = vec!["stash", "push", "-q"];
    if request.include_untracked {
        args.push("--include-untracked");
    }
    if let Some(message) = request.message.as_deref() {
        args.push("-m");
        args.push(message);
    }
    let exit = if request.paths.is_empty() {
        run_git_env(root, &args, &WRITE_ENV, cancel)?
    } else {
        args.push("--pathspec-from-file=-");
        args.push("--pathspec-file-nul");
        let mut list = Vec::new();
        for path in &request.paths {
            list.extend_from_slice(b":(literal)");
            list.extend_from_slice(path.as_bytes());
            list.push(0);
        }
        run_git_with_input(root, &args, list, cancel)?
    };
    if exit.status != Some(0) {
        return Err(failed(&args, exit));
    }
    Ok(stash_count(engine, cancel)? > before)
}

/// The number of stashes, from the stash reflog.
fn stash_count(engine: &Git2Engine, cancel: &Cancel) -> GitResult<usize> {
    let args = ["stash", "list", "--format=%H"];
    let exit = run_git_env(&GitEngine::repo(engine).root, &args, &WRITE_ENV, cancel)?;
    if exit.status != Some(0) {
        return Err(failed(&args, exit));
    }
    Ok(String::from_utf8_lossy(&exit.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count())
}

/// `git stash apply|pop stash@{n}`: done, or conflicts with the paths (the stash stays).
fn apply_or_pop(
    engine: &Git2Engine,
    verb: &str,
    index: u32,
    cancel: &Cancel,
) -> GitResult<Outcome> {
    let reference = stash_ref(index);
    let args = ["stash", verb, "-q", reference.as_str()];
    let exit = run_git_env(&GitEngine::repo(engine).root, &args, &WRITE_ENV, cancel)?;
    if exit.status == Some(0) {
        return Ok(Outcome {
            kind: OutcomeKind::Done,
            hash: sequencer::head_hash(engine)?,
            conflicts: Vec::new(),
        });
    }
    let conflicts = sequencer::conflicts(engine, cancel)?;
    if exit.status == Some(1) && !conflicts.is_empty() {
        return Ok(Outcome {
            kind: OutcomeKind::Conflicts,
            hash: sequencer::head_hash(engine)?,
            conflicts,
        });
    }
    Err(failed(&args, exit))
}

/// See [`GitEngine::stash_apply`].
#[tracing::instrument(level = "debug", skip_all, fields(index))]
pub(super) fn stash_apply(engine: &Git2Engine, index: u32, cancel: &Cancel) -> GitResult<Outcome> {
    apply_or_pop(engine, "apply", index, cancel)
}

/// See [`GitEngine::stash_pop`].
#[tracing::instrument(level = "debug", skip_all, fields(index))]
pub(super) fn stash_pop(engine: &Git2Engine, index: u32, cancel: &Cancel) -> GitResult<Outcome> {
    apply_or_pop(engine, "pop", index, cancel)
}

/// See [`GitEngine::stash_drop`].
#[tracing::instrument(level = "debug", skip_all, fields(index))]
pub(super) fn stash_drop(engine: &Git2Engine, index: u32, cancel: &Cancel) -> GitResult<()> {
    let reference = stash_ref(index);
    let args = ["stash", "drop", "-q", reference.as_str()];
    let exit = run_git_env(&GitEngine::repo(engine).root, &args, &WRITE_ENV, cancel)?;
    if exit.status == Some(0) {
        Ok(())
    } else {
        Err(failed(&args, exit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_references_are_indexed() {
        assert_eq!(stash_ref(0), "stash@{0}");
        assert_eq!(stash_ref(12), "stash@{12}");
    }
}
