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
    engine.with_repo(|repo| {
        let one = commit_id(repo, a)?;
        let two = commit_id(repo, b)?;
        match repo.merge_base(one, two) {
            Ok(base) => Ok(base.to_string()),
            Err(error) if error.code() == ErrorCode::NotFound => {
                Err(GitError::UnrelatedHistories {
                    a: a.to_owned(),
                    b: b.to_owned(),
                })
            }
            Err(error) => Err(error.into()),
        }
    })
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

/// Resolves `reference` to its target; `None` for a symbolic ref whose target does not exist.
fn resolve(repo: &Repository, reference: &Reference<'_>) -> GitResult<Option<Target>> {
    let direct = match reference.resolve() {
        Ok(direct) => direct,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let Some(oid) = direct.target() else {
        return Ok(None);
    };
    let object = repo
        .find_object(oid, None)
        .map_err(|error| GitError::object(&oid.to_string(), error))?;
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

/// Ahead/behind walks from which the counts run on several threads, each with its own
/// repository handle; below it the handles cost more than they save.
const PARALLEL_WALKS_FROM: usize = 16;

/// Most threads used for the ahead/behind walks.
const TRACKING_THREADS: usize = 8;

/// The tracking information of every branch in `pending`, in order.
///
/// The upstream of each branch is resolved inline (configuration and reference reads, cheap);
/// the ahead/behind counts are revision walks (about 2 ms each on a long history), so with
/// many of them they run on [`TRACKING_THREADS`] threads, each on its own `Repository`
/// (libgit2 objects are not shared between threads). Errors and cancellation propagate.
fn trackings(
    repo: &Repository,
    pending: &[(usize, String, Oid)],
    cancel: &Cancel,
) -> GitResult<Vec<Tracking>> {
    let mut trackings = Vec::with_capacity(pending.len());
    // (index in `trackings`, local tip, upstream tip) of the branches whose counts are walked.
    let mut walks: Vec<(usize, Oid, Oid)> = Vec::new();
    for (index, (_, full_name, local)) in pending.iter().enumerate() {
        cancel.check()?;
        let (tracking, upstream_tip) = upstream_of(repo, full_name)?;
        if let Some(upstream_tip) = upstream_tip {
            walks.push((index, *local, upstream_tip));
        }
        trackings.push(tracking);
    }
    let counts = if walks.len() < PARALLEL_WALKS_FROM {
        walks
            .iter()
            .map(|(_, local, upstream)| {
                cancel.check()?;
                ahead_behind(repo, *local, *upstream)
            })
            .collect::<GitResult<Vec<_>>>()?
    } else {
        parallel_ahead_behind(repo, &walks, cancel)?
    };
    for ((index, _, _), (ahead, behind)) in walks.iter().zip(counts) {
        if let Some(tracking) = trackings.get_mut(*index) {
            tracking.ahead = Some(ahead);
            tracking.behind = Some(behind);
        }
    }
    Ok(trackings)
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

/// [`ahead_behind`] for every pair in `walks`, in order, on up to [`TRACKING_THREADS`]
/// threads with one repository handle each; the first error wins.
fn parallel_ahead_behind(
    repo: &Repository,
    walks: &[(usize, Oid, Oid)],
    cancel: &Cancel,
) -> GitResult<Vec<(u32, u32)>> {
    let threads = std::thread::available_parallelism()
        .map_or(1, std::num::NonZero::get)
        .clamp(1, TRACKING_THREADS);
    let chunk = walks.len().div_ceil(threads).max(1);
    // Repository handles do not cross threads: each worker reopens the gitdir.
    let gitdir = repo.path().to_path_buf();
    let results: Vec<GitResult<Vec<(u32, u32)>>> = std::thread::scope(|scope| {
        let workers: Vec<_> = walks
            .chunks(chunk)
            .map(|part| {
                let gitdir = gitdir.clone();
                scope.spawn(move || -> GitResult<Vec<(u32, u32)>> {
                    let repo = super::reopen_gitdir(&gitdir)?;
                    let mut out = Vec::with_capacity(part.len());
                    for (_, local, upstream) in part {
                        cancel.check()?;
                        out.push(ahead_behind(&repo, *local, *upstream)?);
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
    let mut all = Vec::with_capacity(walks.len());
    for result in results {
        all.extend(result?);
    }
    Ok(all)
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Stash entries newest first, from the reflog of `refs/stash` like `git stash list` (which is
/// what `git_stash_foreach` reads too). Each stash commit is checked to exist.
fn stashes(repo: &Repository, cancel: &Cancel) -> GitResult<Vec<Ref>> {
    match repo.find_reference(STASH) {
        Ok(_) => {}
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    }
    if !repo.reference_has_log(STASH)? {
        return Ok(Vec::new());
    }
    let reflog = repo.reflog(STASH)?;
    let mut refs = Vec::with_capacity(reflog.len());
    for (index, entry) in reflog.iter().enumerate() {
        cancel.check()?;
        let oid = entry.id_new();
        repo.find_object(oid, Some(ObjectType::Commit))
            .map_err(|error| GitError::object(&oid.to_string(), error))?;
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
