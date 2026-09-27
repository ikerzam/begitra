//! Remotes and the network: list, add and remove remotes; fetch, pull and push
//! through the git CLI with `--progress`, git's progress lines handed to the caller as they
//! arrive, and `GIT_TERMINAL_PROMPT=0` so that git's own credential prompt fails at once
//! instead of waiting for a terminal that is not there (a helper with a window of its own
//! still opens it; the caller's timeout bounds that).

use std::path::{Path, PathBuf};

use super::{sequencer, Git2Engine};
use crate::cli::{run_git_env, run_git_env_within, run_git_streaming, CliExit, WRITE_ENV};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{NetworkResult, Outcome, OutcomeKind, PullRequest, PushRequest, Remote};

/// Most summary lines kept from a network command: a chatty server hook can print
/// thousands, and the last ones carry the refs and the refusal.
const MAX_SUMMARY_LINES: usize = 200;

fn failed(args: &[&str], exit: CliExit) -> GitError {
    exit.into_failure(args)
}

/// See [`GitEngine::remotes`]: `git remote -v`, one line per URL and direction, and the time
/// of the last fetch for the remotes `FETCH_HEAD` names (its mtime; the file holds one
/// `… of <url>` per fetched ref, so a fetch of one remote dates that remote only).
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn remotes(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<Remote>> {
    let args = ["remote", "-v"];
    let exit = run_git_env(&GitEngine::repo(engine).root, &args, &WRITE_ENV, cancel)?;
    if exit.status != Some(0) {
        return Err(failed(&args, exit));
    }
    let mut remotes = parse_remotes(&String::from_utf8_lossy(&exit.stdout));
    let fetch_head: PathBuf = engine.with_repo(|repo| Ok(repo.path().join("FETCH_HEAD")))?;
    if let Some((at, content)) = last_fetch(&fetch_head) {
        for remote in &mut remotes {
            if fetch_head_names(&content, &remote.fetch_url) {
                remote.fetched_at = Some(at);
            }
        }
    }
    Ok(remotes)
}

/// A URL as `FETCH_HEAD` writes it after ` of `: credentials dropped, trailing slashes and a
/// `.git` suffix stripped (`transport_anonymize_url` and `store_updated_refs` in git).
fn fetch_head_form(url: &str) -> String {
    let mut url = url.trim_end_matches('/');
    if let Some(stripped) = url.strip_suffix(".git") {
        url = stripped;
    }
    match url.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('@') {
            Some((credentials, host)) if !credentials.contains('/') => {
                format!("{scheme}://{host}")
            }
            _ => url.to_owned(),
        },
        None => url.to_owned(),
    }
}

/// Whether a line of `FETCH_HEAD` names `url` as what it fetched from.
pub(super) fn fetch_head_names(content: &str, url: &str) -> bool {
    let wanted = fetch_head_form(url);
    content.lines().any(|line| {
        line.rsplit_once(" of ")
            .is_some_and(|(_, named)| named.trim_end_matches('/') == wanted)
    })
}

/// `FETCH_HEAD`'s modification time (Unix seconds) and content, when the file exists.
fn last_fetch(path: &Path) -> Option<(i64, String)> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let at = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok())?;
    let content = std::fs::read_to_string(path).ok()?;
    Some((at, content))
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
                    fetched_at: None,
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

/// Whether a stderr line is git's progress meter rather than its summary. The meter's shape
/// is fixed while its title follows the language of whichever git printed it (the user's,
/// or the server's behind `remote: `): `<title>: <n>% (<a>/<b>)…`, `<title>: <n>, done.`
/// and the `Total <n> (delta <d>)…` line of a pack.
pub(super) fn is_progress(line: &str) -> bool {
    let trimmed = line.trim_start();
    let body = trimmed.strip_prefix("remote: ").unwrap_or(trimmed);
    if body.starts_with("Total ") {
        return true;
    }
    let Some((_, counter)) = body.split_once(':') else {
        return false;
    };
    let counter = counter.trim_start();
    let digits = counter.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let rest = &counter[digits..];
    rest.starts_with('%') || rest.starts_with(',') || rest.starts_with(" (")
}

/// Runs a network command, streaming the progress and keeping the rest of stderr as the
/// summary (`To <url>`, `   a1b2c3d..e4f5a6b  main -> main`, `From <url>`), bounded to
/// the last [`MAX_SUMMARY_LINES`]. The exit's stderr is that summary, so a failure reads
/// as git's refusal rather than as every update of the meter.
fn network(
    engine: &Git2Engine,
    args: &[&str],
    progress: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<(CliExit, NetworkResult)> {
    let mut summary = Vec::new();
    let mut exit = run_git_streaming(
        &GitEngine::repo(engine).root,
        args,
        &WRITE_ENV,
        &mut |line| {
            if is_progress(line) {
                progress(line);
            } else if !line.trim().is_empty() {
                if summary.len() == MAX_SUMMARY_LINES {
                    summary.remove(0);
                }
                summary.push(line.to_owned());
            }
        },
        cancel,
    )?;
    exit.stderr = summary.join("\n");
    Ok((exit, NetworkResult { summary }))
}

/// See [`GitEngine::fetch`]: one remote, or every remote with `--all`.
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
    match remote {
        Some(remote) => {
            args.push("--");
            args.push(remote);
        }
        None => args.push("--all"),
    }
    let (exit, result) = network(engine, &args, progress, cancel)?;
    if exit.status == Some(0) {
        Ok(result)
    } else {
        Err(failed(&args, exit))
    }
}

/// A branch name on a fetch or push line is a refspec: one that starts with `+` would force
/// the update whatever the request said, so it is refused before git sees it (the bridge
/// refuses it first; `git check-ref-format` alone would accept it as a name).
fn plain_refspec(branch: Option<&str>) -> GitResult<()> {
    match branch {
        Some(branch) if branch.starts_with('+') => Err(GitError::Git(format!(
            "a branch to fetch or push cannot start with '+' ({branch}): it would force the update"
        ))),
        _ => Ok(()),
    }
}

/// The environment of the merge or rebase half of a pull: the reflog names the pull.
const PULL_ENV: [(&str, &str); 5] = [
    WRITE_ENV[0],
    WRITE_ENV[1],
    WRITE_ENV[2],
    WRITE_ENV[3],
    ("GIT_REFLOG_ACTION", "pull"),
];

/// How long the merge or rebase half of a pull may run: it ignores the user's cancel on
/// purpose (a killed merge leaves half an operation), so this is what stops a hook or a
/// merge driver that never returns; the bridge's write timeout is the same ten minutes.
const FINISH_LIMIT: std::time::Duration = std::time::Duration::from_secs(600);

/// See [`GitEngine::pull`]: the fetch, streamed and cancellable, then the merge or the
/// rebase of what it brought, which no cancel interrupts (a killed merge or rebase leaves
/// half an operation behind, the reason every other write is not cancellable) but
/// [`FINISH_LIMIT`] does stop. `git pull` does both in one process that a cancel would kill
/// at any point, so the two halves run here as `git-pull.sh` ran them: `git merge
/// FETCH_HEAD` with `pull.ff`, or `git rebase --onto FETCH_HEAD <fork point>` with the fork
/// point `git pull --rebase` computes from the tracking branch's reflog. A fetch that
/// brought nothing to merge (no upstream) is refused, as `git pull` refuses it. A
/// fast-forward-only pull runs `git merge --ff-only FETCH_HEAD` whatever `pull.ff` says.
#[tracing::instrument(level = "debug", skip_all, fields(remote = ?request.remote, branch = ?request.branch, rebase = request.rebase, ff_only = request.ff_only))]
pub(super) fn pull(
    engine: &Git2Engine,
    request: &PullRequest,
    progress: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<Outcome> {
    plain_refspec(request.branch.as_deref())?;
    if request.rebase && request.ff_only {
        return Err(GitError::Git(
            "a pull is either a rebase or a fast-forward only, not both".to_owned(),
        ));
    }
    let before = sequencer::head_hash(engine)?;
    let mut args = vec!["fetch", "--progress"];
    if let Some(remote) = request.remote.as_deref() {
        args.push("--");
        args.push(remote);
        if let Some(branch) = request.branch.as_deref() {
            args.push(branch);
        }
    }
    let (exit, _) = network(engine, &args, progress, cancel)?;
    if exit.status != Some(0) {
        return Err(failed(&args, exit));
    }
    // The last moment a cancel is honoured: the fetch is done and nothing else has changed.
    cancel.check()?;
    let fetched = fetch_head(engine)?;
    if fetched.is_empty() {
        // `git pull` refuses before fetching; here the fetch happened and nothing else did.
        return Err(GitError::Git(
            "the fetch brought nothing to merge: the branch has no upstream".to_owned(),
        ));
    }
    let root = &GitEngine::repo(engine).root;
    let never = Cancel::never();
    if request.rebase {
        let Some(onto) = fetched.first() else {
            return Err(GitError::Git(
                "the fetch brought nothing to rebase onto: the branch has no upstream".to_owned(),
            ));
        };
        if fetched.len() > 1 {
            return Err(GitError::Git(
                "the fetch brought more than one branch; a rebase takes one".to_owned(),
            ));
        }
        let fork = fork_point(engine, request, &never)?;
        let upstream = fork.as_deref().unwrap_or(onto);
        let args = ["rebase", "--onto", onto, upstream];
        let exit = run_git_env_within(root, &args, &PULL_ENV, &never, FINISH_LIMIT)?;
        let outcome = sequencer::outcome(engine, &args, exit, OutcomeKind::Done, None, &never)?;
        let outcome = sequencer::after_autostash(engine, outcome, &never)?;
        if outcome.kind == OutcomeKind::Done && outcome.hash == before {
            return Ok(Outcome {
                kind: OutcomeKind::UpToDate,
                ..outcome
            });
        }
        return Ok(outcome);
    }
    let mut args = vec!["merge"];
    if request.ff_only {
        args.push("--ff-only");
    } else {
        match pull_ff(engine)?.as_deref() {
            Some("only") => args.push("--ff-only"),
            Some("false") => args.push("--no-ff"),
            Some(_) => args.push("--ff"),
            None => {}
        }
    }
    args.push("FETCH_HEAD");
    let exit = run_git_env_within(root, &args, &PULL_ENV, &never, FINISH_LIMIT)?;
    let outcome = sequencer::outcome(engine, &args, exit, OutcomeKind::Merged, None, &never)?;
    let outcome = sequencer::after_autostash(engine, outcome, &never)?;
    if outcome.kind != OutcomeKind::Merged {
        return Ok(outcome);
    }
    // `git merge` says nothing structured about a fast-forward; where HEAD went tells.
    let kind = match outcome.hash.as_deref() {
        after if after == before.as_deref() => OutcomeKind::UpToDate,
        Some(after) if fetched.iter().any(|hash| hash == after) => OutcomeKind::FastForward,
        _ => OutcomeKind::Merged,
    };
    Ok(Outcome { kind, ..outcome })
}

/// The hashes `FETCH_HEAD` marks for merging (the lines without `not-for-merge`), in the
/// file's order: the branch that was named, or the upstream when none was.
fn fetch_head(engine: &Git2Engine) -> GitResult<Vec<String>> {
    let path: PathBuf = engine.with_repo(|repo| Ok(repo.path().join("FETCH_HEAD")))?;
    let content = std::fs::read_to_string(&path)
        .map_err(|error| GitError::Git(format!("could not read {}: {error}", path.display())))?;
    Ok(content
        .lines()
        .filter(|line| !line.contains("\tnot-for-merge\t"))
        .filter_map(|line| line.split('\t').next())
        .filter(|hash| hash.len() >= 40 && hash.chars().all(|c| c.is_ascii_hexdigit()))
        .map(str::to_owned)
        .collect())
}

/// The `pull.ff` setting (`only`, `false` or `true`), when set.
fn pull_ff(engine: &Git2Engine) -> GitResult<Option<String>> {
    engine.with_repo(|repo| match repo.config()?.get_string("pull.ff") {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(error) => Err(GitError::from(error)),
    })
}

/// What `git pull --rebase` rebases from: `git merge-base --fork-point <tracking> HEAD`,
/// with the tracking branch of the branch that was fetched (`refs/remotes/<remote>/<branch>`)
/// or the upstream of HEAD; `None` when there is no such ref or no fork point (the rebase
/// then takes what was fetched as the upstream, as `git pull` does).
fn fork_point(
    engine: &Git2Engine,
    request: &PullRequest,
    cancel: &Cancel,
) -> GitResult<Option<String>> {
    let tracking: Option<String> = engine.with_repo(|repo| {
        let name = match (request.remote.as_deref(), request.branch.as_deref()) {
            (Some(remote), Some(branch)) => format!("refs/remotes/{remote}/{branch}"),
            (_, _) => {
                let head = match repo.head() {
                    Ok(head) => head,
                    Err(_) => return Ok(None),
                };
                let Ok(name) = head.name() else {
                    return Ok(None);
                };
                match repo.branch_upstream_name(name) {
                    Ok(buf) => match buf.as_str() {
                        Ok(upstream) => upstream.to_owned(),
                        Err(_) => return Ok(None),
                    },
                    Err(_) => return Ok(None),
                }
            }
        };
        Ok(repo.find_reference(&name).ok().map(|_| name))
    })?;
    let Some(tracking) = tracking else {
        return Ok(None);
    };
    let args = ["merge-base", "--fork-point", tracking.as_str(), "HEAD"];
    let exit = run_git_env_within(
        &GitEngine::repo(engine).root,
        &args,
        &WRITE_ENV,
        cancel,
        FINISH_LIMIT,
    )?;
    if exit.status != Some(0) {
        return Ok(None);
    }
    let hash = String::from_utf8_lossy(&exit.stdout).trim().to_owned();
    Ok((!hash.is_empty()).then_some(hash))
}

/// See [`GitEngine::push`].
#[tracing::instrument(level = "debug", skip_all, fields(remote = ?request.remote, branch = ?request.branch, set_upstream = request.set_upstream, lease = request.force_with_lease))]
pub(super) fn push(
    engine: &Git2Engine,
    request: &PushRequest,
    progress: &mut dyn FnMut(&str),
    cancel: &Cancel,
) -> GitResult<NetworkResult> {
    plain_refspec(request.branch.as_deref())?;
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
    fn fetch_head_lines_name_the_remote_without_its_suffix_or_credentials() {
        let content = "abc\t\tbranch 'main' of https://github.com/ikerzam/begitra\ndef\tnot-for-merge\tbranch 'x' of C:\\Users\\iker\\origin\n";
        assert!(fetch_head_names(
            content,
            "https://github.com/ikerzam/begitra.git"
        ));
        assert!(fetch_head_names(
            content,
            "https://iker:secret@github.com/ikerzam/begitra.git/"
        ));
        assert!(fetch_head_names(content, r"C:\Users\iker\origin.git"));
        assert!(!fetch_head_names(
            content,
            "https://github.com/ikerzam/other.git"
        ));
        assert!(!fetch_head_names(
            "",
            "https://github.com/ikerzam/begitra.git"
        ));
    }

    #[test]
    fn progress_lines_are_told_from_summaries_in_any_language() {
        for line in [
            "Writing objects:  50% (1/2)",
            "remote: Resolving deltas: 100% (3/3), done.",
            "remote: Enumerating objects: 5, done.",
            "Receiving objects: 100% (1000/1000), 5.00 MiB | 2.00 MiB/s, done.",
            "Total 3 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)",
            "remote: Total 3 (delta 0), reused 0 (delta 0)",
            "Empfange Objekte:  45% (450/1000), 1.20 MiB | 2.40 MiB/s",
            "Objetos: 100% (12/12), listo.",
            "Comprimiendo objetos: 100% (12/12), listo.",
        ] {
            assert!(is_progress(line), "{line}");
        }
        for line in [
            "To /tmp/origin.git",
            "   1a2b3c4..5d6e7f8  main -> main",
            " ! [rejected]        main -> main (fetch first)",
            "error: failed to push some refs to '/tmp/origin.git'",
            "remote: error: GH006: Protected branch update failed for refs/heads/main.",
            "hint: Updates were rejected because the remote contains work that you do not",
            "From /tmp/origin.git",
            " * branch            main       -> FETCH_HEAD",
            "fatal: 'nowhere' does not appear to be a git repository",
            "",
        ] {
            assert!(!is_progress(line), "{line}");
        }
    }
}
