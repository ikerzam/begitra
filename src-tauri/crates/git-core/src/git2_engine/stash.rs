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

/// The position of the stash whose full commit id is `stash` in the stash list now (the `n`
/// of `stash@{n}`), read and counted as the refs listing and git do (see
/// `refs::stash_reflog` and `refs::stash_entries`). The first match wins when
/// `git stash store` put a commit in twice. An abbreviated id is not in the list: libgit2
/// would pad it with zeros.
fn position_of(engine: &Git2Engine, stash: &str) -> GitResult<usize> {
    let gone = || GitError::StashNotFound(stash.to_owned());
    if !matches!(stash.len(), 40 | 64) {
        return Err(gone());
    }
    let oid = git2::Oid::from_str(stash).map_err(|_| gone())?;
    engine.with_repo(|repo| {
        let Some(reflog) = super::refs::stash_reflog(repo)? else {
            return Err(gone());
        };
        let position = super::refs::stash_entries(&reflog)
            .find(|(_, entry)| entry.id_new() == oid)
            .map(|(position, _)| position);
        position.ok_or_else(gone)
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

/// `git stash apply <commit>`: done, or conflicts with the paths (the stash stays). git exits
/// 1 both for a conflicting apply and for a refusal over paths conflicted before it ran
/// (`needs merge`), so a stop is one that added conflicted paths.
fn apply_commit(engine: &Git2Engine, stash: &str, cancel: &Cancel) -> GitResult<Outcome> {
    let args = ["stash", "apply", "-q", stash];
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
#[tracing::instrument(level = "debug", skip_all, fields(stash = %stash))]
pub(super) fn stash_apply(engine: &Git2Engine, stash: &str, cancel: &Cancel) -> GitResult<Outcome> {
    position_of(engine, stash)?;
    apply_commit(engine, stash, cancel)
}

/// See [`GitEngine::stash_pop`]: the apply of the commit and, when it went through, the drop
/// of that stash where it sits then, which is what `git stash pop` does inside. Not
/// `git stash pop stash@{n}`: git applies what the ref names for `stash@{0}`, which is not
/// the list's newest entry once `git reflog delete stash@{0}` ran without `--updateref`, and
/// a position read before the apply's own status can be a second old when git starts.
#[tracing::instrument(level = "debug", skip_all, fields(stash = %stash))]
pub(super) fn stash_pop(engine: &Git2Engine, stash: &str, cancel: &Cancel) -> GitResult<Outcome> {
    let outcome = stash_apply(engine, stash, cancel)?;
    if outcome.kind == OutcomeKind::Done {
        match stash_drop(engine, stash, cancel) {
            // Dropped elsewhere meanwhile: the pop's end state holds.
            Ok(()) | Err(GitError::StashNotFound(_)) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(outcome)
}

/// See [`GitEngine::stash_drop`]: on its position now, looked up right before git runs, since
/// `git stash drop` refuses a commit.
#[tracing::instrument(level = "debug", skip_all, fields(stash = %stash))]
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
