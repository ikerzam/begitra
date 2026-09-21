//! The operation in progress: what the repository is in the middle of, the
//! conflicted paths with their kinds, and continue, skip or abort through the git CLI.

use git2::RepositoryState;

use super::Git2Engine;
use crate::cli::{run_git_cancellable, run_git_env, CliExit, WRITE_ENV};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{Conflict, ConflictKind, OperationState, Outcome, OutcomeKind, SequencerAction};

/// See [`GitEngine::operation_state`].
pub(super) fn operation_state(engine: &Git2Engine) -> GitResult<OperationState> {
    engine.with_repo(|repo| {
        Ok(match repo.state() {
            RepositoryState::Merge => OperationState::Merge,
            RepositoryState::Revert | RepositoryState::RevertSequence => OperationState::Revert,
            RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
                OperationState::CherryPick
            }
            RepositoryState::Rebase
            | RepositoryState::RebaseInteractive
            | RepositoryState::RebaseMerge => OperationState::Rebase,
            _ => OperationState::None,
        })
    })
}

/// The `XY` of a `u` record of `git status --porcelain=v2`.
fn conflict_kind(xy: &[u8]) -> Option<ConflictKind> {
    Some(match xy {
        b"UU" => ConflictKind::BothModified,
        b"AA" => ConflictKind::BothAdded,
        b"DD" => ConflictKind::BothDeleted,
        b"DU" => ConflictKind::DeletedByUs,
        b"UD" => ConflictKind::DeletedByThem,
        b"AU" => ConflictKind::AddedByUs,
        b"UA" => ConflictKind::AddedByThem,
        _ => return None,
    })
}

/// The `u` records of a NUL-separated porcelain v2 listing, sorted by path.
pub(super) fn parse_conflicts(output: &[u8]) -> Vec<Conflict> {
    let mut conflicts = Vec::new();
    for record in output.split(|&byte| byte == 0) {
        let Some(rest) = record.strip_prefix(b"u ") else {
            continue;
        };
        // XY sub m1 m2 m3 mW h1 h2 h3 path
        let mut fields = rest.splitn(10, |&byte| byte == b' ');
        let Some(xy) = fields.next() else { continue };
        let Some(path) = fields.nth(8) else { continue };
        if path.is_empty() {
            continue;
        }
        let Some(kind) = conflict_kind(xy) else {
            continue;
        };
        conflicts.push(Conflict {
            path: String::from_utf8_lossy(path).into_owned(),
            kind,
        });
    }
    conflicts.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    conflicts
}

/// See [`GitEngine::conflicts`]: `git status --porcelain=v2 -z`'s `u` records, read without
/// taking the index lock.
pub(super) fn conflicts(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<Conflict>> {
    let root = &GitEngine::repo(engine).root;
    let args = [
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=no",
    ];
    let exit = run_git_cancellable(root, &args, cancel)?;
    if exit.status != Some(0) {
        return Err(exit.into_failure(&args));
    }
    Ok(parse_conflicts(&exit.stdout))
}

/// HEAD's hash, or `None` on an unborn branch.
pub(super) fn head_hash(engine: &Git2Engine) -> GitResult<Option<String>> {
    engine.with_repo(|repo| match repo.head() {
        Ok(head) => Ok(head.target().map(|oid| oid.to_string())),
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(error) => Err(GitError::from(error)),
    })
}

/// What a stop changes: HEAD and the conflicted paths, taken before a command so that a
/// refusal that changed nothing is told from a stop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Marks {
    head: Option<String>,
    conflicts: Vec<Conflict>,
}

/// See [`Marks`].
pub(super) fn marks(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Marks> {
    Ok(Marks {
        head: head_hash(engine)?,
        conflicts: conflicts(engine, cancel)?,
    })
}

/// The outcome of a command that may stop on conflicts: a clean exit is `done` (with HEAD);
/// an exit of 1 that left an operation in progress (merge, rebase, cherry-pick, revert:
/// git's state files say so) with conflicted paths is `conflicts`; anything else is git's
/// failure with its message. Conflicted paths alone are not a stop: they may predate the
/// command (a stash pop that conflicted earlier), and git refuses to start anything over them
/// with the same exit code. With `before`, an exit that moved neither HEAD nor the conflicted
/// paths is a refusal too (`git rebase --continue` over an unresolved file exits 1 where
/// `merge --continue` exits 128).
pub(super) fn outcome(
    engine: &Git2Engine,
    args: &[&str],
    exit: CliExit,
    done: OutcomeKind,
    before: Option<&Marks>,
    cancel: &Cancel,
) -> GitResult<Outcome> {
    if exit.status == Some(0) {
        return Ok(Outcome {
            kind: done,
            hash: head_hash(engine)?,
            conflicts: Vec::new(),
        });
    }
    if exit.status == Some(1) && operation_state(engine)? != OperationState::None {
        let conflicted = conflicts(engine, cancel)?;
        let hash = head_hash(engine)?;
        let unchanged =
            before.is_some_and(|marks| marks.head == hash && marks.conflicts == conflicted);
        if !conflicted.is_empty() && !unchanged {
            return Ok(Outcome {
                kind: OutcomeKind::Conflicts,
                hash,
                conflicts: conflicted,
            });
        }
    }
    Err(exit.into_failure(args))
}

/// A clean exit can still leave conflicted paths: `rebase.autoStash` (or `merge.autoStash`)
/// re-applies the stash after the operation and reports the conflicts only in words (git
/// exits 0, keeps the stash). They are the outcome then, with no operation in progress.
pub(super) fn after_autostash(
    engine: &Git2Engine,
    outcome: Outcome,
    cancel: &Cancel,
) -> GitResult<Outcome> {
    if outcome.kind == OutcomeKind::Conflicts {
        return Ok(outcome);
    }
    let conflicted = conflicts(engine, cancel)?;
    if conflicted.is_empty() {
        return Ok(outcome);
    }
    Ok(Outcome {
        kind: OutcomeKind::Conflicts,
        conflicts: conflicted,
        ..outcome
    })
}

/// See [`GitEngine::sequencer`]: the command of the operation in progress; a merge has no
/// skip, and nothing in progress is an error of the caller's, not git's.
pub(super) fn sequencer(
    engine: &Git2Engine,
    action: SequencerAction,
    cancel: &Cancel,
) -> GitResult<Outcome> {
    let state = operation_state(engine)?;
    let verb = match state {
        OperationState::Merge => "merge",
        OperationState::Rebase => "rebase",
        OperationState::CherryPick => "cherry-pick",
        OperationState::Revert => "revert",
        OperationState::None => {
            return Err(GitError::Git(
                "no merge, rebase, cherry-pick or revert is in progress".to_owned(),
            ));
        }
    };
    let flag = match action {
        SequencerAction::Continue => "--continue",
        SequencerAction::Skip if state == OperationState::Merge => {
            return Err(GitError::Git(
                "a merge cannot skip; continue or abort it".to_owned(),
            ));
        }
        SequencerAction::Skip => "--skip",
        SequencerAction::Abort => "--abort",
    };
    let args = [verb, flag];
    let root = &GitEngine::repo(engine).root;
    // A continue that moves nothing is a refusal (an unresolved file); a multi-commit rebase
    // or pick can stop again on the next commit, which moves HEAD or the conflicted paths.
    let before = match action {
        SequencerAction::Continue => Some(marks(engine, cancel)?),
        _ => None,
    };
    let exit = run_git_env(root, &args, &WRITE_ENV, cancel)?;
    outcome(
        engine,
        &args,
        exit,
        OutcomeKind::Done,
        before.as_ref(),
        cancel,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_records_are_parsed_and_sorted() {
        let output = b"u UU N... 100644 100644 100644 100644 h1 h2 h3 b.txt\0u DU N... 000000 100644 100644 000000 h1 h2 h3 a b.txt\0? loose.txt\x001 .M N... 100644 100644 100644 h1 h2 c.txt\0u XX N... 0 0 0 0 h h h odd.txt\0";
        let parsed = parse_conflicts(output);
        assert_eq!(
            parsed,
            vec![
                Conflict {
                    path: "a b.txt".to_owned(),
                    kind: ConflictKind::DeletedByUs
                },
                Conflict {
                    path: "b.txt".to_owned(),
                    kind: ConflictKind::BothModified
                },
            ]
        );
        assert!(parse_conflicts(b"").is_empty());
        assert!(parse_conflicts(b"u UU\0u \0").is_empty());
    }
}
