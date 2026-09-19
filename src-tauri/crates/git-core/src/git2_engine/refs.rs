//! Refs listing with ahead/behind counts and worktree markers, and merge base.
//!
//! The listing follows `git for-each-ref`: local branches, remote branches and tags sorted by
//! full name in byte order, then the stash entries newest first, then `HEAD`. Every target is
//! read from the object store, so a missing or corrupt object surfaces as
//! [`GitError::CorruptObject`] naming its hash instead of a panic or a silent gap.

use std::collections::HashMap;
use std::path::PathBuf;

use git2::{ErrorCode, ObjectType, Oid, Reference, ReferenceType, Repository};

use super::{not_implemented, worktrees, Git2Engine};
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
pub(super) fn merge_base(engine: &Git2Engine, a: &str, b: &str) -> GitResult<String> {
    let _ = (engine, a, b);
    Err(not_implemented("merge_base"))
}

fn collect(repo: &Repository, cancel: &Cancel) -> GitResult<Vec<Ref>> {
    cancel.check()?;
    let current = symbolic_head(repo)?;
    let checkouts = checkouts(repo, cancel)?;
    let mut refs = Vec::new();
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
            let tracking = tracking(repo, full_name, target.peeled)?;
            let mut entry = plain(short, full_name, RefKind::LocalBranch, target.peeled, None);
            entry.is_current = current.as_deref() == Some(full_name);
            entry.upstream = tracking.upstream;
            entry.ahead = tracking.ahead;
            entry.behind = tracking.behind;
            entry.worktree = checkouts.get(full_name).cloned();
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

/// The upstream short name and the counts of `git rev-list --left-right --count`. The counts
/// are `None` when the upstream ref is gone (deleted on the remote), like the `[gone]` marker
/// of `git branch -vv`.
fn tracking(repo: &Repository, full_name: &str, local: Oid) -> GitResult<Tracking> {
    let none = Tracking {
        upstream: None,
        ahead: None,
        behind: None,
    };
    let upstream = match repo.branch_upstream_name(full_name) {
        Ok(buf) => match buf.as_str() {
            Ok(name) => name.to_owned(),
            Err(_) => return Ok(none),
        },
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(none),
        Err(error) => return Err(error.into()),
    };
    let short = upstream
        .strip_prefix(REMOTES)
        .or_else(|| upstream.strip_prefix(HEADS))
        .unwrap_or(&upstream)
        .to_owned();
    let gone = Tracking {
        upstream: Some(short.clone()),
        ahead: None,
        behind: None,
    };
    let upstream_ref = match repo.find_reference(&upstream) {
        Ok(reference) => reference,
        Err(error) if error.code() == ErrorCode::NotFound => return Ok(gone),
        Err(error) => return Err(error.into()),
    };
    let Some(target) = resolve(repo, &upstream_ref)? else {
        return Ok(gone);
    };
    let (ahead, behind) = repo.graph_ahead_behind(local, target.peeled)?;
    Ok(Tracking {
        upstream: Some(short),
        ahead: Some(count(ahead)),
        behind: Some(count(behind)),
    })
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
