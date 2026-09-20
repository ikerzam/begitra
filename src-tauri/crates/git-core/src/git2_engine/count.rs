//! A bounded commit count of a scope, for the graph's "N of M commits" line.
//!
//! The count runs on its own repository handle (the engine's mutex stays free for the refs,
//! the status and the diffs the screen asks for meanwhile) and walks the parents itself from
//! the same seeds as the graph, so it stops at the cap and answers cancellation at every
//! [`CANCEL_EVERY`] commits; libgit2's revwalk would read the whole excluded ancestry of a
//! range inside its first step. The excluded ancestry of a range is read first, cancellable.

use std::collections::HashSet;

use git2::{Oid, Repository};

use super::Git2Engine;
use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::{CommitCount, WalkScope, COUNT_CAP};

/// Commits between two cancellation checks.
const CANCEL_EVERY: u32 = 1_000;

/// Counts the commits of `scope`, stopping at [`COUNT_CAP`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn count(
    engine: &Git2Engine,
    scope: &WalkScope,
    cancel: &Cancel,
) -> GitResult<CommitCount> {
    let repo = engine.with_repo(super::reopen)?;
    let (seeds, exclude) = super::walk::scope_of(&repo, scope, cancel)?;
    let excluded = match exclude {
        Some(root) => ancestry(&repo, root, cancel)?,
        None => HashSet::new(),
    };
    count_from(&repo, &seeds, &excluded, COUNT_CAP, cancel)
}

/// Every commit reachable from `root`, `root` included.
fn ancestry(repo: &Repository, root: Oid, cancel: &Cancel) -> GitResult<HashSet<Oid>> {
    let mut set = HashSet::from([root]);
    let mut stack = vec![root];
    let mut visited: u32 = 0;
    while let Some(oid) = stack.pop() {
        visited = visited.wrapping_add(1);
        if visited.is_multiple_of(CANCEL_EVERY) {
            cancel.check()?;
        }
        let commit = repo
            .find_commit(oid)
            .map_err(|error| GitError::object(&oid.to_string(), error))?;
        for parent in commit.parent_ids() {
            if set.insert(parent) {
                stack.push(parent);
            }
        }
    }
    Ok(set)
}

/// Counts the commits reachable from `seeds` outside `excluded`, at most `cap`.
fn count_from(
    repo: &Repository,
    seeds: &[Oid],
    excluded: &HashSet<Oid>,
    cap: u32,
    cancel: &Cancel,
) -> GitResult<CommitCount> {
    let mut seen: HashSet<Oid> = HashSet::new();
    let mut stack: Vec<Oid> = Vec::new();
    for seed in seeds {
        if !excluded.contains(seed) && seen.insert(*seed) {
            stack.push(*seed);
        }
    }
    let mut count: u32 = 0;
    while let Some(oid) = stack.pop() {
        count += 1;
        if count.is_multiple_of(CANCEL_EVERY) {
            cancel.check()?;
        }
        let commit = repo
            .find_commit(oid)
            .map_err(|error| GitError::object(&oid.to_string(), error))?;
        for parent in commit.parent_ids() {
            if !excluded.contains(&parent) && seen.insert(parent) {
                stack.push(parent);
            }
        }
        // Exactly `cap` commits is not capped: the cap only cuts a longer history.
        if count >= cap && !stack.is_empty() {
            return Ok(CommitCount {
                count,
                capped: true,
            });
        }
    }
    Ok(CommitCount {
        count,
        capped: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A chain of `n` commits in a temporary repository, tip first.
    fn chain(n: usize) -> (tempfile::TempDir, Repository, Oid) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = Repository::init(dir.path()).expect("init");
        let tip = {
            let signature = git2::Signature::now("t", "t@x").expect("signature");
            let tree_id = repo
                .treebuilder(None)
                .expect("builder")
                .write()
                .expect("tree");
            let tree = repo.find_tree(tree_id).expect("tree");
            let mut parent: Option<Oid> = None;
            for i in 0..n {
                let parents: Vec<git2::Commit<'_>> = parent
                    .into_iter()
                    .map(|oid| repo.find_commit(oid).expect("parent"))
                    .collect();
                let refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
                let oid = repo
                    .commit(None, &signature, &signature, &format!("c{i}"), &tree, &refs)
                    .expect("commit");
                parent = Some(oid);
            }
            parent.expect("tip")
        };
        (dir, repo, tip)
    }

    #[test]
    fn counts_up_to_the_cap_and_reports_it() {
        let (_dir, repo, tip) = chain(10);
        let none = HashSet::new();
        let all = count_from(&repo, &[tip], &none, 100, &Cancel::never()).expect("count");
        assert_eq!(
            all,
            CommitCount {
                count: 10,
                capped: false
            }
        );
        let capped = count_from(&repo, &[tip], &none, 4, &Cancel::never()).expect("count");
        assert_eq!(
            capped,
            CommitCount {
                count: 4,
                capped: true
            }
        );
        let exact = count_from(&repo, &[tip], &none, 10, &Cancel::never()).expect("count");
        assert_eq!(
            exact,
            CommitCount {
                count: 10,
                capped: false
            }
        );
    }

    #[test]
    fn leaves_out_the_excluded_ancestry() {
        let (_dir, repo, tip) = chain(6);
        let third = repo
            .find_commit(tip)
            .and_then(|c| c.parent(0))
            .and_then(|c| c.parent(0))
            .expect("tip~2")
            .id();
        let excluded = ancestry(&repo, third, &Cancel::never()).expect("ancestry");
        assert_eq!(excluded.len(), 4);
        let counted = count_from(&repo, &[tip], &excluded, 100, &Cancel::never()).expect("count");
        assert_eq!(counted.count, 2);
        assert!(!counted.capped);
    }
}
