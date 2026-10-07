//! A bounded commit count of a scope, for the graph's "N of M commits" line.
//!
//! The count runs on its own repository handle (the engine's mutex stays free for the refs,
//! the status and the diffs the screen asks for meanwhile). Every scope but `Range` walks the
//! parents itself from the same seeds as the graph, so it stops at the cap and answers
//! cancellation at every [`CANCEL_EVERY`] commits. A `Range` scope counts the members of
//! libgit2's bounded revwalk up to the cap: the cost is the range's size, never the excluded
//! history, and only the timeout interrupts that pass.

use std::collections::HashSet;

use git2::{Oid, Repository};

use super::walk::range_members;
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
    if let Some(exclude) = exclude {
        cancel.check()?;
        let (members, more) = range_members(&repo, &seeds, exclude, Some(COUNT_CAP as usize))?;
        return Ok(CommitCount {
            count: u32::try_from(members.len()).unwrap_or(COUNT_CAP),
            capped: more,
        });
    }
    count_from(&repo, &seeds, COUNT_CAP, cancel)
}

/// Counts the commits reachable from `seeds`, at most `cap`.
fn count_from(
    repo: &Repository,
    seeds: &[Oid],
    cap: u32,
    cancel: &Cancel,
) -> GitResult<CommitCount> {
    let mut seen: HashSet<Oid> = HashSet::new();
    let mut stack: Vec<Oid> = Vec::new();
    for seed in seeds {
        if seen.insert(*seed) {
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
            if seen.insert(parent) {
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
        let all = count_from(&repo, &[tip], 100, &Cancel::never()).expect("count");
        assert_eq!(
            all,
            CommitCount {
                count: 10,
                capped: false
            }
        );
        let capped = count_from(&repo, &[tip], 4, &Cancel::never()).expect("count");
        assert_eq!(
            capped,
            CommitCount {
                count: 4,
                capped: true
            }
        );
        let exact = count_from(&repo, &[tip], 10, &Cancel::never()).expect("count");
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
        let (members, more) = range_members(&repo, &[tip], third, None).expect("members");
        assert_eq!(members.len(), 2);
        assert!(!more);
        // The cap cuts the members and says so; exactly the cap is not cut.
        let (one, more) = range_members(&repo, &[tip], third, Some(1)).expect("members");
        assert_eq!((one.len(), more), (1, true));
        let (two, more) = range_members(&repo, &[tip], third, Some(2)).expect("members");
        assert_eq!((two.len(), more), (2, false));
        // Excluding the tip itself leaves nothing.
        let (none, more) = range_members(&repo, &[tip], tip, None).expect("members");
        assert!(none.is_empty() && !more);
    }
}
