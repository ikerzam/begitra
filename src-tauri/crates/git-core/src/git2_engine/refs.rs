//! Refs listing with ahead/behind counts and worktree markers, and merge base.
//!
//! The listing follows `git for-each-ref`: local branches, remote branches and tags sorted by
//! full name in byte order, then the stash entries newest first, then `HEAD`. Every target is
//! read from the object store, so a missing or corrupt object surfaces as
//! [`GitError::CorruptObject`] naming its hash instead of a panic or a silent gap.

use std::collections::HashMap;
use std::path::PathBuf;

use git2::{ErrorCode, ObjectType, Oid, Reference, ReferenceType, Repository};

use super::{worktrees, Git2Engine};
use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::{Ref, RefKind};

const HEADS: &str = "refs/heads/";
const REMOTES: &str = "refs/remotes/";
const TAGS: &str = "refs/tags/";
const STASH: &str = "refs/stash";

/// Lists every ref; see [`crate::engine::GitEngine::refs`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn list(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<Ref>> {
    engine.with_repo(|repo| collect(repo, cancel))
}

/// Merge base of two revisions; see [`crate::engine::GitEngine::merge_base`].
#[tracing::instrument(level = "debug", skip_all, fields(a = a, b = b))]
pub(super) fn merge_base(engine: &Git2Engine, a: &str, b: &str) -> GitResult<String> {
    engine.with_repo(|repo| merge_base_in(engine, repo, a, b).map(|base| base.to_string()))
}

/// The merge base of two revisions through `repo`, the engine's last one when the pair is
/// the same; [`GitError::UnrelatedHistories`] when they share no commit.
pub(super) fn merge_base_in(
    engine: &Git2Engine,
    repo: &Repository,
    a: &str,
    b: &str,
) -> GitResult<Oid> {
    let one = commit_id(repo, a)?;
    let two = commit_id(repo, b)?;
    unrelated_as_error(engine.merge_base_of(repo, one, two), a, b)
}

/// A merge base lookup with libgit2's "not found" read as unrelated histories.
pub(super) fn unrelated_as_error(
    found: Result<Oid, git2::Error>,
    a: &str,
    b: &str,
) -> GitResult<Oid> {
    match found {
        Ok(base) => Ok(base),
        Err(error) if error.code() == ErrorCode::NotFound => Err(GitError::UnrelatedHistories {
            a: a.to_owned(),
            b: b.to_owned(),
        }),
        Err(error) => Err(error.into()),
    }
}

/// Resolves a revision to a commit id, peeling tags; [`GitError::RefNotFound`] when it does
/// not name a commit, [`GitError::CorruptObject`] when its object cannot be read.
fn commit_id(repo: &Repository, revision: &str) -> GitResult<Oid> {
    super::resolve_commit(repo, revision)
}

fn collect(repo: &Repository, cancel: &Cancel) -> GitResult<Vec<Ref>> {
    cancel.check()?;
    let current = symbolic_head(repo)?;
    let checkouts = checkouts(repo, cancel)?;
    let mut refs = Vec::new();
    // Local branches whose tracking counts are computed after the listing, possibly in
    // parallel: (index in `refs`, full name, tip).
    let mut pending: Vec<(usize, String, Oid)> = Vec::new();
    for reference in repo.references()? {
        cancel.check()?;
        let reference = reference?;
        let full_name = match reference.name() {
            Ok(name) => name,
            Err(error) => {
                tracing::debug!(error = %error, "skipping a ref whose name is not UTF-8");
                continue;
            }
        };
        if let Some(short) = full_name.strip_prefix(HEADS) {
            let Some(target) = resolve(repo, &reference)? else {
                continue;
            };
            let mut entry = plain(short, full_name, RefKind::LocalBranch, target.peeled, None);
            entry.is_current = current.as_deref() == Some(full_name);
            entry.worktree = checkouts.get(full_name).cloned();
            pending.push((refs.len(), full_name.to_owned(), target.peeled));
            refs.push(entry);
        } else if let Some(short) = full_name.strip_prefix(REMOTES) {
            // The symbolic `refs/remotes/<remote>/HEAD` is not a branch.
            if reference.kind() == Some(ReferenceType::Symbolic) {
                continue;
            }
            let Some(target) = resolve(repo, &reference)? else {
                continue;
            };
            refs.push(plain(
                short,
                full_name,
                RefKind::RemoteBranch,
                target.peeled,
                None,
            ));
        } else if let Some(short) = full_name.strip_prefix(TAGS) {
            let Some(target) = resolve(repo, &reference)? else {
                continue;
            };
            refs.push(plain(
                short,
                full_name,
                RefKind::Tag,
                target.peeled,
                target.tag_message,
            ));
        }
    }
    for ((index, _, _), tracking) in pending.iter().zip(trackings(repo, &pending, cancel)?) {
        if let Some(entry) = refs.get_mut(*index) {
            entry.upstream = tracking.upstream;
            entry.ahead = tracking.ahead;
            entry.behind = tracking.behind;
        }
    }
    // Byte order of the full names groups heads before remotes before tags, as
    // `git for-each-ref` sorts them.
    refs.sort_by(|a, b| a.full_name.as_str().cmp(b.full_name.as_str()));
    refs.extend(stashes(repo, cancel)?);
    refs.extend(head_entry(repo)?);
    Ok(refs)
}

/// A ref entry without tracking data or worktree marker.
fn plain(name: &str, full_name: &str, kind: RefKind, target: Oid, message: Option<String>) -> Ref {
    Ref {
        name: name.to_owned(),
        full_name: full_name.to_owned(),
        kind,
        target: target.to_string(),
        is_current: false,
        upstream: None,
        ahead: None,
        behind: None,
        worktree: None,
        message,
    }
}

/// A ref's target read from the object store: after peeling annotated tags, the commit (or
/// whatever non-tag object a tag wraps), plus the tag message when there is one.
struct Target {
    peeled: Oid,
    tag_message: Option<String>,
}

/// Resolves `reference` to its target; `None` for a symbolic ref whose target does not exist
/// and for a broken ref whose object is missing from the store (an interrupted fetch, an
/// aggressive prune), which git ignores with a warning. An object that exists but cannot be
/// read is [`GitError::CorruptObject`].
fn resolve(repo: &Repository, reference: &Reference<'_>) -> GitResult<Option<Target>> {
    let direct = match reference.resolve() {
        Ok(direct) => direct,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let Some(oid) = direct.target() else {
        return Ok(None);
    };
    let object = match repo.find_object(oid, None) {
        Ok(object) => object,
        Err(error) if error.code() == ErrorCode::NotFound && super::object_missing(repo, oid) => {
            tracing::warn!(
                reference = %String::from_utf8_lossy(reference.name_bytes()),
                object = %oid,
                "ignoring a broken ref: its object is missing"
            );
            return Ok(None);
        }
        Err(error) => return Err(GitError::object(&oid.to_string(), error)),
    };
    let Some(tag) = object.as_tag() else {
        return Ok(Some(Target {
            peeled: oid,
            tag_message: None,
        }));
    };
    let tag_message = tag
        .message()
        .ok()
        .flatten()
        .map(str::trim_end)
        .filter(|message| !message.is_empty())
        .map(str::to_owned);
    let peeled = object
        .peel(ObjectType::Any)
        .map_err(|error| GitError::object(&tag.target_id().to_string(), error))?;
    Ok(Some(Target {
        peeled: peeled.id(),
        tag_message,
    }))
}

/// Upstream of a local branch and the ahead/behind counts against it.
struct Tracking {
    upstream: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
}

/// Tracking branches from which their upstreams and counts are resolved on several threads,
/// each with its own repository handle; below it the handles cost more than they save.
const PARALLEL_TRACKING_FROM: usize = 16;

/// Most threads used for the tracking counts.
const TRACKING_THREADS: usize = 8;

/// The tracking information of every branch in `pending`, in order.
///
/// Which branches track anything is read from one configuration snapshot (libgit2 stats the
/// configuration files on every live read, which adds up over hundreds of branches); only
/// those go through the upstream lookup and the ahead/behind walk (about 2 ms each on a long
/// history), on [`TRACKING_THREADS`] threads with one `Repository` each when there are many
/// (libgit2 objects are not shared between threads). Errors and cancellation propagate.
fn trackings(
    repo: &Repository,
    pending: &[(usize, String, Oid)],
    cancel: &Cancel,
) -> GitResult<Vec<Tracking>> {
    let config = repo.config()?.snapshot()?;
    let candidates: Vec<usize> = pending
        .iter()
        .enumerate()
        .filter(|(_, (_, full_name, _))| {
            let short = full_name.strip_prefix(HEADS).unwrap_or(full_name);
            config.get_entry(&format!("branch.{short}.merge")).is_ok()
        })
        .map(|(index, _)| index)
        .collect();
    let mut trackings: Vec<Tracking> = pending
        .iter()
        .map(|_| Tracking {
            upstream: None,
            ahead: None,
            behind: None,
        })
        .collect();
    let resolved = if candidates.len() < PARALLEL_TRACKING_FROM {
        candidates
            .iter()
            .map(|&index| {
                cancel.check()?;
                let (_, full_name, local) = &pending[index];
                tracking(repo, full_name, *local)
            })
            .collect::<GitResult<Vec<_>>>()?
    } else {
        let work: Vec<(String, Oid)> = candidates
            .iter()
            .map(|&index| (pending[index].1.clone(), pending[index].2))
            .collect();
        parallel_trackings(repo, &work, cancel)?
    };
    for (index, tracking) in candidates.into_iter().zip(resolved) {
        if let Some(slot) = trackings.get_mut(index) {
            *slot = tracking;
        }
    }
    Ok(trackings)
}

/// The upstream short name and the counts of `git rev-list --left-right --count`. The counts
/// are `None` when the upstream ref is gone (deleted on the remote), like the `[gone]` marker
/// of `git branch -vv`.
fn tracking(repo: &Repository, full_name: &str, local: Oid) -> GitResult<Tracking> {
    let (mut tracking, tip) = upstream_of(repo, full_name)?;
    if let Some(tip) = tip {
        let (ahead, behind) = ahead_behind(repo, local, tip)?;
        tracking.ahead = Some(ahead);
        tracking.behind = Some(behind);
    }
    Ok(tracking)
}

/// The upstream short name of `full_name` and, when the upstream ref exists and points at a
/// commit, its tip. No upstream gives `(none, None)`; a gone upstream (deleted on the remote,
/// the `[gone]` marker of `git branch -vv`) keeps its name without a tip.
fn upstream_of(repo: &Repository, full_name: &str) -> GitResult<(Tracking, Option<Oid>)> {
    let none = Tracking {
        upstream: None,
        ahead: None,
        behind: None,
    };
    let upstream = match repo.branch_upstream_name(full_name) {
        Ok(buf) => match buf.as_str() {
            Ok(name) => name.to_owned(),
            Err(_) => return Ok((none, None)),
        },
        Err(error) if error.code() == ErrorCode::NotFound => return Ok((none, None)),
        Err(error) => return Err(error.into()),
    };
    let short = upstream
        .strip_prefix(REMOTES)
        .or_else(|| upstream.strip_prefix(HEADS))
        .unwrap_or(&upstream)
        .to_owned();
    let gone = Tracking {
        upstream: Some(short),
        ahead: None,
        behind: None,
    };
    let upstream_ref = match repo.find_reference(&upstream) {
        Ok(reference) => reference,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok((gone, None)),
        Err(error) => return Err(error.into()),
    };
    let tip = resolve(repo, &upstream_ref)?.map(|target| target.peeled);
    Ok((gone, tip))
}

/// The counts of `git rev-list --left-right --count local...upstream`.
fn ahead_behind(repo: &Repository, local: Oid, upstream: Oid) -> GitResult<(u32, u32)> {
    let (ahead, behind) = repo.graph_ahead_behind(local, upstream)?;
    Ok((count(ahead), count(behind)))
}

/// [`tracking`] for every `(full name, tip)` in `work`, in order, on up to
/// [`TRACKING_THREADS`] threads with one repository handle each; the first error wins.
fn parallel_trackings(
    repo: &Repository,
    work: &[(String, Oid)],
    cancel: &Cancel,
) -> GitResult<Vec<Tracking>> {
    let threads = std::thread::available_parallelism()
        .map_or(1, std::num::NonZero::get)
        .clamp(1, TRACKING_THREADS);
    let chunk = work.len().div_ceil(threads).max(1);
    // Repository handles do not cross threads: each worker reopens the gitdir.
    let gitdir = repo.path().to_path_buf();
    let results: Vec<GitResult<Vec<Tracking>>> = std::thread::scope(|scope| {
        let workers: Vec<_> = work
            .chunks(chunk)
            .map(|part| {
                let gitdir = gitdir.clone();
                scope.spawn(move || -> GitResult<Vec<Tracking>> {
                    let repo = super::reopen_gitdir(&gitdir)?;
                    let mut out = Vec::with_capacity(part.len());
                    for (full_name, local) in part {
                        cancel.check()?;
                        out.push(tracking(&repo, full_name, *local)?);
                    }
                    Ok(out)
                })
            })
            .collect();
        workers
            .into_iter()
            .map(|worker| {
                worker
                    .join()
                    .unwrap_or_else(|_| Err(GitError::Git("a tracking thread panicked".to_owned())))
            })
            .collect()
    });
    let mut all = Vec::with_capacity(work.len());
    for result in results {
        all.extend(result?);
    }
    Ok(all)
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The stash list as `git stash list` reads it, the reflog of `refs/stash` newest first, or
/// `None` without stashes: `refs/stash` missing, or without its reflog. Both are checked first
/// because libgit2 creates an empty reflog file when asked for a missing one, and reading the
/// list must not write.
pub(super) fn stash_reflog(repo: &Repository) -> GitResult<Option<git2::Reflog>> {
    match repo.find_reference(STASH) {
        Ok(_) => {}
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    if !repo.reference_has_log(STASH)? {
        return Ok(None);
    }
    Ok(Some(repo.reflog(STASH)?))
}

/// The entries of the stash list with the position git gives them (the `n` of `stash@{n}`),
/// newest first. git skips a reflog line whose time is 0 as corrupt (`show_one_reflog_ent`),
/// in `git stash list` and in resolving `stash@{n}` alike, while libgit2 reads it: counting
/// it would move every older stash by one, and a drop by position would take the next one.
pub(super) fn stash_entries(
    reflog: &git2::Reflog,
) -> impl Iterator<Item = (usize, git2::ReflogEntry<'_>)> + '_ {
    reflog
        .iter()
        .filter(|entry| entry.committer().when().seconds() != 0)
        .enumerate()
}

/// Stash entries newest first, from the reflog of `refs/stash` like `git stash list` (which is
/// what `git_stash_foreach` reads too). A stash whose commit is missing is left out with a
/// warning and keeps its position, as `git stash list` does; one that cannot be read fails
/// the listing with its hash.
fn stashes(repo: &Repository, cancel: &Cancel) -> GitResult<Vec<Ref>> {
    let Some(reflog) = stash_reflog(repo)? else {
        return Ok(Vec::new());
    };
    let mut refs = Vec::with_capacity(reflog.len());
    for (index, entry) in stash_entries(&reflog) {
        cancel.check()?;
        let oid = entry.id_new();
        match repo.find_object(oid, Some(ObjectType::Commit)) {
            Ok(_) => {}
            Err(error)
                if error.code() == ErrorCode::NotFound && super::object_missing(repo, oid) =>
            {
                tracing::warn!(object = %oid, "ignoring a stash whose commit is missing");
                continue;
            }
            Err(error) => return Err(GitError::object(&oid.to_string(), error)),
        }
        let message = entry.message().ok().flatten().map(str::to_owned);
        refs.push(plain(
            &format!("stash@{{{index}}}"),
            STASH,
            RefKind::Stash,
            oid,
            message,
        ));
    }
    Ok(refs)
}

/// The `HEAD` entry, or `None` when HEAD is unborn.
fn head_entry(repo: &Repository) -> GitResult<Option<Ref>> {
    let head = repo.find_reference("HEAD")?;
    let Some(target) = resolve(repo, &head)? else {
        return Ok(None);
    };
    let mut entry = plain("HEAD", "HEAD", RefKind::Head, target.peeled, None);
    entry.is_current = true;
    Ok(Some(entry))
}

/// Full name of the branch HEAD points at (`refs/heads/main`), also when it is unborn;
/// `None` when HEAD is detached.
fn symbolic_head(repo: &Repository) -> GitResult<Option<String>> {
    Ok(repo
        .find_reference("HEAD")?
        .symbolic_target()?
        .map(str::to_owned))
}

/// The worktree (main or linked, present or missing) where each local branch is checked out,
/// by full ref name. A worktree's `branch` is a short name unless HEAD points outside
/// `refs/heads/`, in which case it is already a full name.
fn checkouts(repo: &Repository, cancel: &Cancel) -> GitResult<HashMap<String, PathBuf>> {
    let mut map = HashMap::new();
    for worktree in worktrees::collect(repo, cancel)? {
        let Some(branch) = worktree.branch else {
            continue;
        };
        let full_name = if branch.starts_with("refs/") {
            branch
        } else {
            format!("{HEADS}{branch}")
        };
        map.entry(full_name).or_insert(worktree.path);
    }
    Ok(map)
}
