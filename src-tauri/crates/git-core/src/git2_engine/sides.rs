//! The two sides of the operation in progress by their names, a conflicted path taken whole
//! from one of them, and the way back. The names come from the state files of the worktree's
//! own git directory (a linked worktree has its own); the writes run the git CLI in the
//! repository's root with the paths as NUL-separated input, as the other path writes do
//! (`staging`), except `git update-index --unresolve`, which reads its paths from argv only.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use git2::{BranchType, Oid, Repository};

use super::sequencer::operation_of;
use super::staging::{argv_chunks, judged, nul_list, root, FROM_STDIN, LITERAL};
use super::walk::split_message;
use super::Git2Engine;
use crate::cli::{
    run_git_cancellable, run_git_env_within, run_git_with_input, run_git_with_input_within,
};
use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::{OperationSides, OperationState, Side, SideName};

/// See [`crate::engine::GitEngine::operation_sides`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn operation_sides(engine: &Git2Engine) -> GitResult<Option<OperationSides>> {
    engine.with_repo(|repo| match operation_of(repo.state()) {
        OperationState::None => Ok(None),
        OperationState::Merge => merge_sides(repo),
        OperationState::Rebase => rebase_sides(repo),
        OperationState::CherryPick => picked_sides(repo, "CHERRY_PICK_HEAD", false),
        OperationState::Revert => picked_sides(repo, "REVERT_HEAD", true),
    })
}

/// A merge: ours is HEAD; theirs is the commit it brings in (see [`merged_side`]).
fn merge_sides(repo: &Repository) -> GitResult<Option<OperationSides>> {
    let Some(theirs) = merged_side(repo)? else {
        return Ok(None);
    };
    Ok(Some(OperationSides {
        ours: head_side(repo)?,
        theirs,
    }))
}

/// The commit a merge in progress brings in, by the name `MERGE_MSG` gives it while that name
/// still points at it, else as a commit. An octopus names none: git's ours is then HEAD with
/// the heads merged before the one that stopped, and its theirs that head, which no name says.
fn merged_side(repo: &Repository) -> GitResult<Option<SideName>> {
    let heads = state_oids(&repo.path().join("MERGE_HEAD"));
    let [merge_head] = heads.as_slice() else {
        return Ok(None);
    };
    // A merged annotated tag stands there as the tag object.
    let merged = repo
        .find_object(*merge_head, None)
        .and_then(|object| object.peel_to_commit())
        .map_or(*merge_head, |commit| commit.id());
    let subject = first_line(&repo.path().join("MERGE_MSG")).unwrap_or_default();
    Ok(Some(match merged_name(repo, &subject, merged)? {
        Some(name) => SideName::Ref { name },
        None => commit_side(repo, merged, false),
    }))
}

/// A rebase: ours is the commit rebased onto (git's `--ours` is that commit with the commits
/// replayed so far), by name (see [`onto_name`]); theirs is the branch being rebased (git's
/// `--theirs` is the commit of it being replayed), or, started detached, that commit. A merge
/// being recreated (`rebase -r`) has the merge's own sides: HEAD, the rebased first parent,
/// and the commit `MERGE_HEAD` names.
fn rebase_sides(repo: &Repository) -> GitResult<Option<OperationSides>> {
    let git_dir = repo.path();
    let Some(dir) = ["rebase-merge", "rebase-apply"]
        .iter()
        .map(|name| git_dir.join(name))
        .find(|dir| dir.is_dir())
    else {
        return Ok(None);
    };
    if git_dir.join("MERGE_HEAD").is_file() {
        return merge_sides(repo);
    }
    let Some(onto) = state_oid(&dir.join("onto")) else {
        return Ok(None);
    };
    let head_name = first_line(&dir.join("head-name")).unwrap_or_default();
    let ours = match onto_name(repo, onto, &head_name)? {
        Some(name) => SideName::Ref { name },
        None => commit_side(repo, onto, false),
    };
    let theirs = match head_name.strip_prefix("refs/heads/") {
        Some(name) if !name.is_empty() => SideName::Ref {
            name: name.to_owned(),
        },
        // "detached HEAD": the commit a stop is applying, else the one the rebase started at.
        _ => {
            let applied = state_oid(&git_dir.join("REBASE_HEAD"))
                .or_else(|| state_oid(&dir.join("orig-head")));
            let Some(applied) = applied else {
                return Ok(None);
            };
            commit_side(repo, applied, false)
        }
    };
    Ok(Some(OperationSides { ours, theirs }))
}

/// The name of the commit a rebase replays onto: the one the rebase was started with, from the
/// newest start in HEAD's reflog ("rebase (start): checkout main"), while it still names
/// `onto`; else the rebased branch's upstream when its tip is `onto` (a pull's rebase starts at
/// the fetched hash); else a branch at `onto` (see [`branch_at`]). Several branches often point
/// at one commit (a branch just made from `main`), and the one the user named is the one that
/// reads right.
fn onto_name(repo: &Repository, onto: Oid, head_name: &str) -> GitResult<Option<String>> {
    if let Some(name) = started_onto(repo, onto) {
        return Ok(Some(name));
    }
    if head_name.starts_with("refs/heads/") {
        if let Ok(upstream) = repo.branch_upstream_name(head_name) {
            if let Ok(upstream) = upstream.as_str() {
                if ref_at(repo, upstream, onto) {
                    let short = upstream
                        .strip_prefix("refs/remotes/")
                        .or_else(|| upstream.strip_prefix("refs/heads/"))
                        .unwrap_or(upstream);
                    return Ok(Some(short.to_owned()));
                }
            }
        }
    }
    branch_at(repo, onto)
}

/// The name in the newest rebase start of HEAD's reflog, when that start went to `onto` and the
/// name, a branch or a remote-tracking branch, still points there.
fn started_onto(repo: &Repository, onto: Oid) -> Option<String> {
    let reflog = repo.reflog("HEAD").ok()?;
    let (id, name) = reflog.iter().find_map(|entry| {
        let message = entry.message().ok()??;
        let (_, name) = message.split_once(" (start): checkout ")?;
        Some((entry.id_new(), name.trim().to_owned()))
    })?;
    if id != onto {
        return None;
    }
    ["refs/heads/", "refs/remotes/"]
        .iter()
        .any(|prefix| ref_at(repo, &format!("{prefix}{name}"), onto))
        .then_some(name)
}

/// A cherry-pick or a revert: ours is HEAD; theirs is the commit in `file`, or for a revert
/// the state before it.
fn picked_sides(repo: &Repository, file: &str, before: bool) -> GitResult<Option<OperationSides>> {
    let Some(picked) = state_oid(&repo.path().join(file)) else {
        return Ok(None);
    };
    Ok(Some(OperationSides {
        ours: head_side(repo)?,
        theirs: commit_side(repo, picked, before),
    }))
}

/// HEAD's branch, an unborn one included (by the name HEAD points at), or HEAD's commit when
/// it is detached.
fn head_side(repo: &Repository) -> GitResult<SideName> {
    let head = repo.find_reference("HEAD")?;
    if let Some(target) = head.symbolic_target()? {
        let name = target.strip_prefix("refs/heads/").unwrap_or(target);
        return Ok(SideName::Ref {
            name: name.to_owned(),
        });
    }
    let oid = head
        .target()
        .ok_or_else(|| GitError::Git("HEAD names no commit".to_owned()))?;
    Ok(commit_side(repo, oid, false))
}

/// A commit by its hash and subject (or the state before it); a commit the object store
/// cannot read still has its hash to show.
fn commit_side(repo: &Repository, oid: Oid, before: bool) -> SideName {
    let subject = repo
        .find_commit(oid)
        .map(|commit| split_message(commit.message_raw_bytes()).0)
        .unwrap_or_default();
    let hash = oid.to_string();
    if before {
        SideName::Before { hash, subject }
    } else {
        SideName::Commit { hash, subject }
    }
}

/// The name in the first line of the message `git merge` prepared, when it still points at
/// `merged`: "Merge branch 'x'", "Merge branch 'x' of <url>" (a pull: the remote-tracking
/// branch of a configured remote that holds the commit), "Merge remote-tracking branch
/// 'origin/x'", "Merge tag 'v1'", each perhaps followed by " into <branch>". A ref name may hold
/// a quote but no space, so the name ends at the first quote followed by a space or by the end
/// of the line; a name that does not resolve to `merged` (a message of the user's, a branch
/// moved since) is none.
fn merged_name(repo: &Repository, subject: &str, merged: Oid) -> GitResult<Option<String>> {
    let quoted = |prefix: &str| -> Option<(&str, &str)> {
        let rest = subject.strip_prefix(prefix)?;
        let end = rest
            .match_indices('\'')
            .map(|(index, _)| index)
            .find(|&index| rest[index + 1..].is_empty() || rest[index + 1..].starts_with(' '))?;
        Some((&rest[..end], &rest[end + 1..]))
    };
    if let Some((name, tail)) = quoted("Merge branch '") {
        if let Some(source) = tail.strip_prefix(" of ") {
            return remote_branch_at(repo, name, source, merged);
        }
        return Ok(ref_at(repo, &format!("refs/heads/{name}"), merged).then(|| name.to_owned()));
    }
    if let Some((name, _)) = quoted("Merge remote-tracking branch '") {
        return Ok(ref_at(repo, &format!("refs/remotes/{name}"), merged).then(|| name.to_owned()));
    }
    if let Some((name, _)) = quoted("Merge tag '") {
        return Ok(ref_at(repo, &format!("refs/tags/{name}"), merged).then(|| name.to_owned()));
    }
    Ok(None)
}

/// Whether `refname` resolves to the commit `oid` (a tag through its peel).
fn ref_at(repo: &Repository, refname: &str, oid: Oid) -> bool {
    repo.find_reference(refname)
        .and_then(|reference| reference.peel_to_commit())
        .is_ok_and(|commit| commit.id() == oid)
}

/// `<remote>/<branch>` for a configured remote whose remote-tracking branch of that name holds
/// `oid`: the one whose URL the message names (`source` is "<url>" or "<url> into <branch>"),
/// else the first by name.
fn remote_branch_at(
    repo: &Repository,
    branch: &str,
    source: &str,
    oid: Oid,
) -> GitResult<Option<String>> {
    let remotes = repo.remotes()?;
    let mut best: Option<(bool, String)> = None;
    // A name libgit2 cannot read as UTF-8 names no branch here.
    for remote in remotes.iter().flatten().flatten() {
        let name = format!("{remote}/{branch}");
        if !ref_at(repo, &format!("refs/remotes/{name}"), oid) {
            continue;
        }
        let named = repo
            .find_remote(remote)
            .ok()
            .and_then(|found| found.url().ok().map(message_url))
            .is_some_and(|url| source == url || source.starts_with(&format!("{url} into ")));
        // The remote the message names sorts first.
        let key = (!named, name);
        if best.as_ref().is_none_or(|current| key < *current) {
            best = Some(key);
        }
    }
    Ok(best.map(|(_, name)| name))
}

/// A remote's URL as `git fetch` writes it into the merge message: without the user part
/// (`scheme://user@host/…`, `user@host:path`; an `@` after the first slash, or in a local
/// path, stays), the trailing slashes and ".git".
fn message_url(url: &str) -> String {
    let anonymized = match (url.find('@'), url.find("://")) {
        (Some(at), Some(scheme)) => {
            let host = scheme + 3;
            let slash = url[host..].find('/').map(|index| host + index);
            if at < scheme || slash.is_some_and(|slash| slash < at) {
                url.to_owned()
            } else {
                format!("{}{}", &url[..host], &url[at + 1..])
            }
        }
        (Some(at), None) if url[at + 1..].contains(':') => url[at + 1..].to_owned(),
        _ => url.to_owned(),
    };
    let trimmed = anonymized.trim_end_matches('/');
    trimmed.strip_suffix(".git").unwrap_or(trimmed).to_owned()
}

/// A branch whose tip is `oid`, in one pass over the branches: a local one, else a
/// remote-tracking one, the first by name.
fn branch_at(repo: &Repository, oid: Oid) -> GitResult<Option<String>> {
    let mut local: Option<String> = None;
    let mut remote: Option<String> = None;
    for item in repo.branches(None)? {
        let Ok((branch, kind)) = item else { continue };
        if branch.get().target() != Some(oid) {
            continue;
        }
        let Ok(Some(name)) = branch.name() else {
            continue;
        };
        let best = match kind {
            BranchType::Local => &mut local,
            BranchType::Remote => &mut remote,
        };
        if best.as_deref().is_none_or(|current| name < current) {
            *best = Some(name.to_owned());
        }
    }
    Ok(local.or(remote))
}

/// Longest state file read.
const MAX_STATE_BYTES: u64 = 64 * 1024;

/// The non-empty lines of a state file, without their line ends; none when it cannot be read.
fn state_lines(path: &Path) -> Vec<String> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    if file.take(MAX_STATE_BYTES).read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The first line of a state file.
fn first_line(path: &Path) -> Option<String> {
    state_lines(path).into_iter().next()
}

/// A full hash, else none (`Oid::from_str` would pad an abbreviation with zeros).
fn full_oid(text: &str) -> Option<Oid> {
    let full = matches!(text.len(), 40 | 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit());
    if full {
        Oid::from_str(text).ok()
    } else {
        None
    }
}

/// The commit a state file names on its first line, when that line is a full hash.
fn state_oid(path: &Path) -> Option<Oid> {
    first_line(path).as_deref().and_then(full_oid)
}

/// The commits a state file names, a full hash a line; none when a line is not one.
fn state_oids(path: &Path) -> Vec<Oid> {
    let lines = state_lines(path);
    let oids: Vec<Oid> = lines.iter().filter_map(|line| full_oid(line)).collect();
    if oids.len() == lines.len() {
        oids
    } else {
        Vec::new()
    }
}

/// A conflict stage of a path: its mode and blob, as `git ls-files -u` prints them.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stage {
    mode: String,
    hash: String,
}

/// A path's entries in the index's conflict stages.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Unmerged {
    /// Stages 1 (the base), 2 (ours) and 3 (theirs).
    stages: [Option<Stage>; 3],
}

impl Unmerged {
    /// The stage of `side`, when that side has the path.
    fn stage(&self, side: Side) -> Option<&Stage> {
        match side {
            Side::Ours => self.stages[1].as_ref(),
            Side::Theirs => self.stages[2].as_ref(),
        }
    }

    /// Whether one of the stages is a submodule (mode 160000).
    fn is_submodule(&self) -> bool {
        self.stages
            .iter()
            .flatten()
            .any(|stage| stage.mode == "160000")
    }
}

/// `git ls-files -u -z`: `<mode> <hash> <stage>\t<path>` per entry.
fn parse_unmerged(output: &[u8]) -> HashMap<String, Unmerged> {
    let mut paths: HashMap<String, Unmerged> = HashMap::new();
    for record in output.split(|&byte| byte == 0) {
        let Some(tab) = record.iter().position(|&byte| byte == b'\t') else {
            continue;
        };
        let (meta, path) = (&record[..tab], &record[tab + 1..]);
        if path.is_empty() {
            continue;
        }
        let mut fields = meta.split(|&byte| byte == b' ');
        let (Some(mode), Some(hash), Some(stage)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let index = match stage {
            b"1" => 0,
            b"2" => 1,
            b"3" => 2,
            _ => continue,
        };
        let entry = paths
            .entry(String::from_utf8_lossy(path).into_owned())
            .or_default();
        entry.stages[index] = Some(Stage {
            mode: String::from_utf8_lossy(mode).into_owned(),
            hash: String::from_utf8_lossy(hash).into_owned(),
        });
    }
    paths
}

/// The conflicted paths of the index with their stages.
fn unmerged(engine: &Git2Engine, cancel: &Cancel) -> GitResult<HashMap<String, Unmerged>> {
    const ARGS: [&str; 3] = ["ls-files", "-u", "-z"];
    let exit = judged(&ARGS, run_git_cancellable(root(engine), &ARGS, cancel)?)?;
    Ok(parse_unmerged(&exit.stdout))
}

/// Whether the worktree is a sparse checkout (`core.sparseCheckout`): `git rm` then refuses a
/// path outside its definition without `--sparse`, an option git before 2.35 does not know.
fn sparse_checkout(engine: &Git2Engine) -> bool {
    engine
        .with_repo(|repo| {
            Ok(repo
                .config()?
                .get_bool("core.sparseCheckout")
                .unwrap_or(false))
        })
        .unwrap_or(false)
}

/// The `--index-info -z` record that resolves `path` to `stage`: `<mode> <hash> 0\t<path>`.
fn push_index_record(records: &mut Vec<u8>, stage: &Stage, path: &str) {
    records.extend_from_slice(stage.mode.as_bytes());
    records.push(b' ');
    records.extend_from_slice(stage.hash.as_bytes());
    records.extend_from_slice(b" 0\t");
    records.extend_from_slice(path.as_bytes());
    records.push(0);
}

/// How long a write may run once an earlier one of its call changed the index: it ignores the
/// user's cancel, so this is what stops a filter or a hook that never returns; the bridge's
/// write timeout is the same ten minutes.
const FINISH_LIMIT: Duration = Duration::from_secs(600);

/// The writes of one call, in order. The first runs with the caller's cancel and, when it
/// fails, nothing was written and nothing follows. Once it went through, the others run to
/// their end whatever the cancel says, within [`FINISH_LIMIT`], since a sequence stopped
/// halfway leaves stages and files that match neither the conflict nor its resolution; a
/// failure is kept while the rest go on, and the first one is the call's error.
struct Writes<'a> {
    root: &'a Path,
    cancel: &'a Cancel,
    written: bool,
    failed: Option<GitError>,
}

impl<'a> Writes<'a> {
    fn new(engine: &'a Git2Engine, cancel: &'a Cancel) -> Self {
        Self {
            root: root(engine),
            cancel,
            written: false,
            failed: None,
        }
    }

    /// Runs `git <args>`, with `input` on stdin when there is some; `shown` names the command in
    /// an error when its arguments are too many to repeat.
    fn run(&mut self, args: &[&str], input: Option<Vec<u8>>, shown: Option<String>) {
        if !self.written && self.failed.is_some() {
            return;
        }
        let never = Cancel::never();
        let exit = match (self.written, input) {
            (false, Some(input)) => run_git_with_input(self.root, args, input, self.cancel),
            (false, None) => run_git_cancellable(self.root, args, self.cancel),
            (true, Some(input)) => {
                run_git_with_input_within(self.root, args, input, &never, FINISH_LIMIT)
            }
            (true, None) => run_git_env_within(self.root, args, &[], &never, FINISH_LIMIT),
        };
        match exit.and_then(|exit| judged(args, exit)) {
            Ok(_) => self.written = true,
            Err(error) => {
                let error = match (error, shown) {
                    (GitError::Cli { status, stderr, .. }, Some(command)) => GitError::Cli {
                        command,
                        status,
                        stderr,
                    },
                    (error, _) => error,
                };
                self.failed.get_or_insert(error);
            }
        }
    }

    /// `git --literal-pathspecs <verb> --pathspec-from-file=- --pathspec-file-nul` with `paths`
    /// on stdin; nothing for none.
    fn on_paths(&mut self, verb: &[&str], paths: &[String]) {
        if paths.is_empty() {
            return;
        }
        let mut args = Vec::with_capacity(verb.len() + 3);
        args.push(LITERAL);
        args.extend_from_slice(verb);
        args.extend_from_slice(&FROM_STDIN);
        self.run(&args, Some(nul_list(paths)), None);
    }

    fn finish(self) -> GitResult<()> {
        self.failed.map_or(Ok(()), Err)
    }
}

/// See [`crate::engine::GitEngine::take_side`]. Every path is checked before anything is
/// written: a path that is not conflicted is [`GitError::NotConflicted`], a submodule's
/// conflict [`GitError::SubmoduleConflict`]. The paths the side has get that side's entry,
/// resolved, and their file from it; the ones it has not (it deleted the file, or never added
/// it) are removed.
#[tracing::instrument(level = "debug", skip_all, fields(paths = paths.len(), side = ?side))]
pub(super) fn take_side(
    engine: &Git2Engine,
    paths: &[String],
    side: Side,
    cancel: &Cancel,
) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let unmerged = unmerged(engine, cancel)?;
    let mut records = Vec::new();
    let mut kept = Vec::with_capacity(paths.len());
    let mut removed = Vec::new();
    for path in paths {
        let Some(entry) = unmerged.get(path) else {
            return Err(GitError::NotConflicted(path.clone()));
        };
        if entry.is_submodule() {
            return Err(GitError::SubmoduleConflict(path.clone()));
        }
        match entry.stage(side) {
            Some(stage) => {
                push_index_record(&mut records, stage, path);
                kept.push(path.clone());
            }
            None => removed.push(path.clone()),
        }
    }
    let mut writes = Writes::new(engine, cancel);
    // The side's own entry, its blob and its mode, resolved; not `git add` of the file
    // `checkout --ours | --theirs` writes, which takes the mode of ours (or the base) where the
    // file system keeps no executable bit (`core.fileMode=false`, Windows' default) and runs
    // the file back through the clean filters.
    if !kept.is_empty() {
        writes.run(&["update-index", "-z", "--index-info"], Some(records), None);
    }
    // The file, from that entry.
    writes.on_paths(&["checkout"], &kept);
    if !removed.is_empty() && sparse_checkout(engine) {
        writes.on_paths(&["rm", "-f", "-q", "--sparse"], &removed);
    } else {
        writes.on_paths(&["rm", "-f", "-q"], &removed);
    }
    writes.finish()
}

/// See [`crate::engine::GitEngine::restore_conflicts`]. Outside a stop that holds conflicts
/// every path is [`GitError::ConflictGone`], naming the first, before git runs: git keeps the
/// resolve-undo record across its commit and across a rebase's `break` or `exec`, which run no
/// merge (the next conflict stop, a skip, an abort, a reset and the next merge drop it), and
/// stages brought back then would be a conflict of a stop that has ended. A rebase holds
/// conflicts only at a stop that applies a commit, where git writes `REBASE_HEAD`; a commit
/// made by hand within that stop is not told apart. A path still conflicted has nothing to
/// bring back and is left as it is, its
/// file perhaps half resolved by hand. The others get their stages back from the record, then
/// their file as git wrote it at the stop: the conflicted merge where both sides have it, the
/// one side's version where one does, nothing where neither does, nothing for a submodule (git
/// leaves its checkout alone). `git update-index --unresolve` exits 0 for a path it has no
/// record of, so the stages are read again and the first path still resolved is
/// [`GitError::ConflictGone`]; that error and a failure of git come after every file of the
/// paths that did come back is written (see [`Writes`]).
#[tracing::instrument(level = "debug", skip_all, fields(paths = paths.len()))]
pub(super) fn restore_conflicts(
    engine: &Git2Engine,
    paths: &[String],
    cancel: &Cancel,
) -> GitResult<()> {
    let Some(first) = paths.first() else {
        return Ok(());
    };
    let in_progress = engine.with_repo(|repo| {
        Ok(match operation_of(repo.state()) {
            OperationState::None => false,
            OperationState::Rebase => repo.path().join("REBASE_HEAD").is_file(),
            _ => true,
        })
    })?;
    if !in_progress {
        return Err(GitError::ConflictGone(first.clone()));
    }
    let before = unmerged(engine, cancel)?;
    let resolved: Vec<String> = paths
        .iter()
        .filter(|path| !before.contains_key(*path))
        .cloned()
        .collect();
    if resolved.is_empty() {
        return Ok(());
    }
    let mut writes = Writes::new(engine, cancel);
    for chunk in argv_chunks(&resolved) {
        // git reads every argument after `--unresolve` as a path, a `--` included, so none is
        // given; a leading dash is a name here.
        let mut args = Vec::with_capacity(chunk.len() + 2);
        args.push("update-index");
        args.push("--unresolve");
        args.extend(chunk.iter().map(String::as_str));
        let shown = format!("update-index --unresolve ({} paths)", chunk.len());
        writes.run(&args, None, Some(shown));
    }
    if !writes.written {
        // The first run failed: nothing came back.
        return writes.finish();
    }
    let after = unmerged(engine, &Cancel::never())?;
    let mut merged = Vec::new();
    let mut ours = Vec::new();
    let mut theirs = Vec::new();
    let mut gone = None;
    for path in &resolved {
        let Some(entry) = after.get(path) else {
            gone.get_or_insert_with(|| path.clone());
            continue;
        };
        if entry.is_submodule() {
            continue;
        }
        match (entry.stage(Side::Ours), entry.stage(Side::Theirs)) {
            (Some(_), Some(_)) => merged.push(path.clone()),
            (Some(_), None) => ours.push(path.clone()),
            (None, Some(_)) => theirs.push(path.clone()),
            (None, None) => {}
        }
    }
    writes.on_paths(&["checkout", "-m"], &merged);
    writes.on_paths(&["checkout", "--ours"], &ours);
    writes.on_paths(&["checkout", "--theirs"], &theirs);
    writes.finish()?;
    gone.map_or(Ok(()), |path| Err(GitError::ConflictGone(path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmerged_entries_are_grouped_by_path() {
        let records: [&[u8]; 11] = [
            b"100644 aaaa 1\ta b.txt",
            b"100644 bbbb 2\ta b.txt",
            b"100755 cccc 3\ta b.txt",
            b"100644 dddd 3\tonly-theirs.txt",
            b"160000 eeee 2\tsub",
            b"160000 ffff 3\tsub",
            // A submodule on one side, a file on the other.
            b"160000 gggg 2\tmixed",
            b"100644 hhhh 3\tmixed",
            b"odd",
            b"100644 x 9\tbad",
            b"",
        ];
        let parsed = parse_unmerged(&records.join(&0));
        assert_eq!(parsed.len(), 4);
        let both = &parsed["a b.txt"];
        assert!(both.stages.iter().all(Option::is_some));
        assert_eq!(
            both.stage(Side::Theirs),
            Some(&Stage {
                mode: "100755".to_owned(),
                hash: "cccc".to_owned(),
            })
        );
        let only_theirs = &parsed["only-theirs.txt"];
        assert!(
            only_theirs.stage(Side::Theirs).is_some() && only_theirs.stage(Side::Ours).is_none()
        );
        assert!(parsed["sub"].is_submodule());
        assert!(parsed["mixed"].is_submodule());
        assert!(!both.is_submodule());
        assert!(parse_unmerged(b"").is_empty());
    }

    #[test]
    fn a_side_resolves_to_its_own_entry() {
        let mut records = Vec::new();
        let stage = Stage {
            mode: "100755".to_owned(),
            hash: "cccc".to_owned(),
        };
        push_index_record(&mut records, &stage, "src/run me.sh");
        push_index_record(&mut records, &stage, "-dash");
        let expected: [&[u8]; 3] = [
            b"100755 cccc 0\tsrc/run me.sh",
            b"100755 cccc 0\t-dash",
            b"",
        ];
        assert_eq!(records, expected.join(&0));
    }

    #[test]
    fn a_state_file_names_commits_only_by_their_full_hashes() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("STATE");
        let hash = "0123456789abcdef0123456789abcdef01234567";
        let other = "89abcdef0123456789abcdef0123456789abcdef";
        std::fs::write(&file, format!("{hash}\r\nsecond line\n")).expect("write");
        assert_eq!(
            state_oid(&file).map(|oid| oid.to_string()),
            Some(hash.to_owned())
        );
        assert!(state_oids(&file).is_empty());
        std::fs::write(&file, format!("{hash}\n{other}\n")).expect("write");
        assert_eq!(state_oids(&file).len(), 2);
        std::fs::write(&file, "0123456\n").expect("write");
        assert_eq!(state_oid(&file), None);
        std::fs::write(&file, "detached HEAD\n").expect("write");
        assert_eq!(state_oid(&file), None);
        std::fs::write(&file, b"Merge branch 'caf\xe9'\n").expect("write");
        assert_eq!(
            first_line(&file).as_deref(),
            Some("Merge branch 'caf\u{fffd}'")
        );
        assert_eq!(state_oid(&dir.path().join("missing")), None);
        assert!(state_oids(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn a_remotes_url_reads_as_the_merge_message_writes_it() {
        for (configured, written) in [
            (
                "https://user:secret@host.example/team/repo.git/",
                "https://host.example/team/repo",
            ),
            (
                "https://host.example/a@b/repo",
                "https://host.example/a@b/repo",
            ),
            ("git@github.com:team/repo.git", "github.com:team/repo"),
            ("C:/repos/fork.git", "C:/repos/fork"),
            ("/srv/repo.git//", "/srv/repo"),
            ("../sibling", "../sibling"),
        ] {
            assert_eq!(message_url(configured), written, "{configured}");
        }
    }
}
