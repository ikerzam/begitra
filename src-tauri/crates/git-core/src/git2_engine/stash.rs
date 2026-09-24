//! The stash: push, apply, pop and drop through the git CLI. A stash is named by its
//! commit, found in the stash's reflog when the action starts, because positions shift when a
//! stash is made or dropped elsewhere. A pop or apply that conflicts is an [`Outcome`] with the
//! paths (git keeps the stash then), like the sequencer's stops; the listing is part of `refs`.

use super::{sequencer, Git2Engine};
use crate::cli::{run_git_env, run_git_with_input, CliExit, WRITE_ENV};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{Outcome, OutcomeKind, StashPush};

fn failed(args: &[&str], exit: CliExit) -> GitError {
    exit.into_failure(args)
}

/// `stash@{n}`.
fn stash_ref(index: usize) -> String {
    format!("stash@{{{index}}}")
}

/// The position of the stash whose commit is `stash` in the stash list now (the `n` of
/// `stash@{n}`): the stash's reflog lists the entries newest first, as `git stash list` does.
/// The first match wins when `git stash store` put a commit in twice.
fn position_of(engine: &Git2Engine, stash: &str) -> GitResult<usize> {
    let gone = || GitError::StashNotFound(stash.to_owned());
    let oid = git2::Oid::from_str(stash).map_err(|_| gone())?;
    engine.with_repo(|repo| {
        let reflog = match repo.reflog("refs/stash") {
            Ok(reflog) => reflog,
            Err(error) if error.code() == git2::ErrorCode::NotFound => return Err(gone()),
            Err(error) => return Err(GitError::from(error)),
        };
        reflog
            .iter()
            .position(|entry| entry.id_new() == oid)
            .ok_or_else(gone)
    })
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
    let before = stash_tip(engine)?;
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
    // A stash moves `refs/stash`; "nothing to save" leaves it (git says so and exits 0).
    Ok(stash_tip(engine)? != before)
}

/// The newest stash's hash (`refs/stash`), or `None` without a stash; read through libgit2.
fn stash_tip(engine: &Git2Engine) -> GitResult<Option<String>> {
    engine.with_repo(|repo| match repo.find_reference("refs/stash") {
        Ok(reference) => Ok(reference.target().map(|oid| oid.to_string())),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(GitError::from(error)),
    })
}

/// `git stash apply|pop <stash>` on `reference` (the commit for apply, `stash@{n}` for pop):
/// done, or conflicts with the paths (the stash stays). git exits 1 both for a conflicting
/// apply and for a refusal over paths conflicted before it ran (`needs merge`), so a stop is
/// one that added conflicted paths.
fn apply_or_pop(
    engine: &Git2Engine,
    verb: &str,
    reference: &str,
    cancel: &Cancel,
) -> GitResult<Outcome> {
    let args = ["stash", verb, "-q", reference];
    let before = sequencer::conflicts(engine, cancel)?;
    let exit = run_git_env(&GitEngine::repo(engine).root, &args, &WRITE_ENV, cancel)?;
    if exit.status == Some(0) {
        return Ok(Outcome {
            kind: OutcomeKind::Done,
            hash: sequencer::head_hash(engine)?,
            conflicts: Vec::new(),
        });
    }
    let conflicts = sequencer::conflicts(engine, cancel)?;
    let added = conflicts.iter().any(|conflict| !before.contains(conflict));
    if exit.status == Some(1) && added {
        return Ok(Outcome {
            kind: OutcomeKind::Conflicts,
            hash: sequencer::head_hash(engine)?,
            conflicts,
        });
    }
    Err(failed(&args, exit))
}

/// See [`GitEngine::stash_apply`]: on the commit itself, which `git stash apply` takes, so
/// nothing can shift under it; the stash must still be in the list.
#[tracing::instrument(level = "debug", skip_all, fields(stash))]
pub(super) fn stash_apply(engine: &Git2Engine, stash: &str, cancel: &Cancel) -> GitResult<Outcome> {
    position_of(engine, stash)?;
    apply_or_pop(engine, "apply", stash, cancel)
}

/// See [`GitEngine::stash_pop`]: on its position now, since `git stash pop` refuses a commit.
#[tracing::instrument(level = "debug", skip_all, fields(stash))]
pub(super) fn stash_pop(engine: &Git2Engine, stash: &str, cancel: &Cancel) -> GitResult<Outcome> {
    let reference = stash_ref(position_of(engine, stash)?);
    apply_or_pop(engine, "pop", &reference, cancel)
}

/// See [`GitEngine::stash_drop`]: on its position now, since `git stash drop` refuses a
/// commit.
#[tracing::instrument(level = "debug", skip_all, fields(stash))]
pub(super) fn stash_drop(engine: &Git2Engine, stash: &str, cancel: &Cancel) -> GitResult<()> {
    let reference = stash_ref(position_of(engine, stash)?);
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
