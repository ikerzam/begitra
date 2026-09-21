//! Remotes and the network: list, add and remove remotes; fetch, pull and push
//! through the git CLI with `--progress`, git's progress lines handed to the caller as they
//! arrive, and `GIT_TERMINAL_PROMPT=0` so that a credential prompt fails at once instead of
//! waiting for a terminal that is not there.

use super::{sequencer, Git2Engine};
use crate::cli::{run_git_env, run_git_streaming, CliExit, WRITE_ENV};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{NetworkResult, Outcome, OutcomeKind, PullRequest, PushRequest, Remote};

fn failed(args: &[&str], exit: CliExit) -> GitError {
    GitError::Cli {
        command: args.join(" "),
        status: exit.status,
        stderr: exit.stderr,
    }
}

/// See [`GitEngine::remotes`]: `git remote -v`, one line per URL and direction.
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn remotes(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<Remote>> {
    let args = ["remote", "-v"];
    let exit = run_git_env(&GitEngine::repo(engine).root, &args, &WRITE_ENV, cancel)?;
    if exit.status != Some(0) {
        return Err(failed(&args, exit));
    }
    Ok(parse_remotes(&String::from_utf8_lossy(&exit.stdout)))
}

/// `name<TAB>url (fetch|push)` lines into remotes, in the order git lists them.
pub(super) fn parse_remotes(output: &str) -> Vec<Remote> {
    let mut remotes: Vec<Remote> = Vec::new();
    for line in output.lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        let (url, direction) = match rest.rsplit_once(' ') {
            Some((url, direction)) => (url, direction),
            None => (rest, "(fetch)"),
        };
        let index = match remotes.iter().position(|r| r.name == name) {
            Some(index) => index,
            None => {
                remotes.push(Remote {
                    name: name.to_owned(),
                    fetch_url: String::new(),
                    push_url: String::new(),
                });
                remotes.len() - 1
            }
        };
        if let Some(remote) = remotes.get_mut(index) {
            match direction {
                "(push)" => remote.push_url = url.to_owned(),
                _ => remote.fetch_url = url.to_owned(),
            }
        }
    }
    for remote in &mut remotes {
        if remote.push_url.is_empty() {
            remote.push_url = remote.fetch_url.clone();
        }
    }
    remotes
}

/// See [`GitEngine::remote_add`].
#[tracing::instrument(level = "debug", skip_all, fields(name))]
pub(super) fn remote_add(
    engine: &Git2Engine,
    name: &str,
    url: &str,
    cancel: &Cancel,
) -> GitResult<()> {
    let args = ["remote", "add", "--", name, url];
    let exit = run_git_env(&GitEngine::repo(engine).root, &args, &WRITE_ENV, cancel)?;
    if exit.status == Some(0) {
        Ok(())
    } else {
        Err(failed(&args, exit))
    }
}

/// See [`GitEngine::remote_remove`].
#[tracing::instrument(level = "debug", skip_all, fields(name))]
pub(super) fn remote_remove(engine: &Git2Engine, name: &str, cancel: &Cancel) -> GitResult<()> {
    let args = ["remote", "remove", "--", name];
    let exit = run_git_env(&GitEngine::repo(engine).root, &args, &WRITE_ENV, cancel)?;
    if exit.status == Some(0) {
        Ok(())
    } else {
        Err(failed(&args, exit))
    }
}

/// Whether a stderr line is git's progress meter rather than its summary.
fn is_progress(line: &str) -> bool {
    const METERS: [&str; 8] = [
        "Enumerating objects",
        "Counting objects",
        "Compressing objects",
        "Writing objects",
        "Receiving objects",
        "Resolving deltas",
        "Unpacking objects",
        "Total ",
    ];
    let trimmed = line.trim_start();
    let body = trimmed.strip_prefix("remote: ").unwrap_or(trimmed);
    METERS.iter().any(|meter| body.starts_with(meter))
}

/// Runs a network command, streaming the progress and keeping the rest of stderr as the
/// summary (`To <url>`, `   a1b2c3d..e4f5a6b  main -> main`, `From <url>`).
fn network(
    engine: &Git2Engine,
    args: &[&str],
    progress: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<(CliExit, NetworkResult)> {
    let mut summary = Vec::new();
    let exit = run_git_streaming(
        &GitEngine::repo(engine).root,
        args,
        &WRITE_ENV,
        &mut |line| {
            if is_progress(line) {
                progress(line);
            } else if !line.trim().is_empty() {
                summary.push(line.to_owned());
            }
        },
        cancel,
    )?;
    Ok((exit, NetworkResult { summary }))
}

/// See [`GitEngine::fetch`].
#[tracing::instrument(level = "debug", skip_all, fields(remote, prune))]
pub(super) fn fetch(
    engine: &Git2Engine,
    remote: Option<&str>,
    prune: bool,
    progress: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<NetworkResult> {
    let mut args = vec!["fetch", "--progress"];
    if prune {
        args.push("--prune");
    }
    if let Some(remote) = remote {
        args.push("--");
        args.push(remote);
    }
    let (exit, result) = network(engine, &args, progress, cancel)?;
    if exit.status == Some(0) {
        Ok(result)
    } else {
        Err(failed(&args, exit))
    }
}

/// See [`GitEngine::pull`]: a merge or a rebase after the fetch, with their outcomes.
#[tracing::instrument(level = "debug", skip_all, fields(remote = ?request.remote, branch = ?request.branch, rebase = request.rebase))]
pub(super) fn pull(
    engine: &Git2Engine,
    request: &PullRequest,
    progress: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<Outcome> {
    let before = sequencer::head_hash(engine)?;
    let mut args = vec!["pull", "--progress"];
    args.push(if request.rebase {
        "--rebase"
    } else {
        "--no-rebase"
    });
    if let Some(remote) = request.remote.as_deref() {
        args.push("--");
        args.push(remote);
        if let Some(branch) = request.branch.as_deref() {
            args.push(branch);
        }
    }
    let (exit, _) = network(engine, &args, progress, cancel)?;
    let done = if request.rebase {
        OutcomeKind::Done
    } else {
        OutcomeKind::Merged
    };
    let outcome = sequencer::outcome(engine, &args, exit, done, cancel)?;
    if outcome.kind == OutcomeKind::Merged {
        // `git pull` says nothing structured about a fast-forward; HEAD tells.
        let kind = match (&before, &outcome.hash) {
            (Some(before), Some(after)) if before == after => OutcomeKind::UpToDate,
            (_, Some(after)) if !is_merge_commit(engine, after) => OutcomeKind::FastForward,
            _ => OutcomeKind::Merged,
        };
        return Ok(Outcome { kind, ..outcome });
    }
    Ok(outcome)
}

/// Whether a commit has more than one parent.
fn is_merge_commit(engine: &Git2Engine, hash: &str) -> bool {
    engine
        .with_repo(|repo| {
            let oid = git2::Oid::from_str(hash)?;
            Ok(repo.find_commit(oid)?.parent_count() > 1)
        })
        .unwrap_or(false)
}

/// See [`GitEngine::push`].
#[tracing::instrument(level = "debug", skip_all, fields(remote = ?request.remote, branch = ?request.branch, set_upstream = request.set_upstream, lease = request.force_with_lease))]
pub(super) fn push(
    engine: &Git2Engine,
    request: &PushRequest,
    progress: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<NetworkResult> {
    let mut args = vec!["push", "--progress"];
    if request.set_upstream {
        args.push("--set-upstream");
    }
    if request.force_with_lease {
        args.push("--force-with-lease");
    }
    if let Some(remote) = request.remote.as_deref() {
        args.push("--");
        args.push(remote);
        if let Some(branch) = request.branch.as_deref() {
            args.push(branch);
        }
    }
    let (exit, result) = network(engine, &args, progress, cancel)?;
    if exit.status == Some(0) {
        Ok(result)
    } else {
        Err(failed(&args, exit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_lines_are_paired_by_name() {
        let parsed = parse_remotes(
            "origin\thttps://example.com/a.git (fetch)\norigin\tgit@example.com:a.git (push)\nmirror\t/tmp/m.git (fetch)\nmirror\t/tmp/m.git (push)\n",
        );
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "origin");
        assert_eq!(parsed[0].fetch_url, "https://example.com/a.git");
        assert_eq!(parsed[0].push_url, "git@example.com:a.git");
        assert_eq!(parsed[1].push_url, "/tmp/m.git");
        assert!(parse_remotes("").is_empty());
    }

    #[test]
    fn progress_lines_are_told_from_summaries() {
        assert!(is_progress("Writing objects:  50% (1/2)"));
        assert!(is_progress("remote: Resolving deltas: 100% (3/3), done."));
        assert!(!is_progress("To /tmp/origin.git"));
        assert!(!is_progress("   1a2b3c4..5d6e7f8  main -> main"));
    }
}
