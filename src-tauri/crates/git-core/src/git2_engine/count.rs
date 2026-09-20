//! A bounded commit count of a scope, for the graph's "N of M commits" line.

use git2::Sort;

use super::Git2Engine;
use crate::engine::Cancel;
use crate::error::GitResult;
use crate::types::{CommitCount, WalkScope, COUNT_CAP};

/// Commits between two cancellation checks.
const CANCEL_EVERY: u32 = 1_000;

/// Counts the commits of `scope` with a libgit2 revwalk, stopping at [`COUNT_CAP`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn count(
    engine: &Git2Engine,
    scope: &WalkScope,
    cancel: &Cancel,
) -> GitResult<CommitCount> {
    engine.with_repo(|repo| {
        let (seeds, exclude) = super::walk::scope_of(repo, scope, cancel)?;
        let mut walk = repo.revwalk()?;
        walk.set_sorting(Sort::NONE)?;
        for seed in seeds {
            walk.push(seed)?;
        }
        if let Some(exclude) = exclude {
            walk.hide(exclude)?;
        }
        let mut count: u32 = 0;
        for step in walk {
            step?;
            count += 1;
            if count >= COUNT_CAP {
                return Ok(CommitCount {
                    count,
                    capped: true,
                });
            }
            if count.is_multiple_of(CANCEL_EVERY) {
                cancel.check()?;
            }
        }
        Ok(CommitCount {
            count,
            capped: false,
        })
    })
}
