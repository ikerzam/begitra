//! The branch cleanup: the branches that can go against the main branch, and their deletion
//! with their worktrees. Both are cancellable from the status bar. The listing reads under the
//! default timeout; the deletion writes through git, one branch after another, under a limit
//! that grows with its branches (removing a worktree with a large `node_modules` takes seconds,
//! and the engine bounds each git run), and its cancel stops it between two branches only.

use std::path::PathBuf;
use std::time::Duration;

use git_core::engine::GitEngine;
use git_core::types::{BranchToDelete, CleanupCandidates, DeleteOutcome};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

use super::branches::{validate_hash, validate_name, WRITE_TIMEOUT};

/// Most branches one deletion takes.
const MAX_BRANCHES: usize = 1_000;

/// One to [`MAX_BRANCHES`] branches, each named as git names a branch, with the full hash it
/// was listed with and, when it has one, its worktree's absolute path.
fn validate_branches(branches: &[BranchToDelete]) -> Result<(), AppError> {
    if branches.is_empty() {
        return Err(AppError::invalid_argument("branches", "empty"));
    }
    if branches.len() > MAX_BRANCHES {
        return Err(AppError::invalid_argument(
            "branches",
            format!("more than {MAX_BRANCHES} branches"),
        ));
    }
    for branch in branches {
        validate_name("branches.name", &branch.name)?;
        validate_hash("branches.tip", &branch.tip)?;
        if branch
            .worktree
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        {
            return Err(AppError::invalid_argument(
                "branches.worktree",
                "not an absolute path",
            ));
        }
    }
    Ok(())
}

/// The deletion's own limit: two git runs a branch (its worktree, then the branch), each bounded
/// by the engine to the write timeout, and one more. A shorter total would answer `op.timeout`
/// and drop the outcomes of the branches already deleted, whose restore commands only the
/// toast keeps.
fn deletion_limit(branches: usize) -> Duration {
    let runs = u32::try_from(branches.saturating_mul(2).saturating_add(1)).unwrap_or(u32::MAX);
    WRITE_TIMEOUT.saturating_mul(runs)
}

/// The branches that can go against the main branch.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn cleanup_candidates(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<CleanupCandidates, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.cleanup_candidates(&cancel)
    })
    .await
}

/// Deletes each branch with its worktree while its tip is still the one listed; answers each
/// one's outcome, the branches a cancel kept among them.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, branches), fields(branches = branches.len()))]
pub async fn delete_branches(
    state: State<'_, AppState>,
    repo: PathBuf,
    branches: Vec<BranchToDelete>,
    op_id: String,
) -> Result<Vec<DeleteOutcome>, AppError> {
    validate_branches(&branches)?;
    let app = state.inner().clone();
    let worker = app.clone();
    let limit = deletion_limit(branches.len());
    run_blocking(app.ops(), &op_id, limit, move |cancel| {
        worker.open(&repo)?.delete_branches(&branches, &cancel)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branch(name: &str, tip: &str, worktree: Option<&str>) -> BranchToDelete {
        BranchToDelete {
            name: name.to_owned(),
            tip: tip.to_owned(),
            worktree: worktree.map(PathBuf::from),
        }
    }

    fn code(result: Result<(), AppError>) -> String {
        result.expect_err("refused").code
    }

    #[test]
    fn a_deletion_takes_listed_branches_only() {
        let tip = "a".repeat(40);
        let absolute = if cfg!(windows) {
            "C:\\code\\wt"
        } else {
            "/code/wt"
        };
        assert!(validate_branches(&[
            branch("claude/árbol", &tip, None),
            branch("feature/x", &tip, Some(absolute)),
        ])
        .is_ok());
        assert_eq!(code(validate_branches(&[])), "ipc.invalid_argument");
        for bad in [
            branch("-x", &tip, None),
            branch("a b", &tip, None),
            branch("x", "HEAD~1", None),
            branch("x", &"0".repeat(40), None),
            branch("x", &tip, Some("relative/wt")),
        ] {
            assert_eq!(
                code(validate_branches(std::slice::from_ref(&bad))),
                "ipc.invalid_argument",
                "{bad:?}"
            );
        }
        let many: Vec<BranchToDelete> = (0..=MAX_BRANCHES)
            .map(|i| branch(&format!("b{i}"), &tip, None))
            .collect();
        assert_eq!(code(validate_branches(&many)), "ipc.invalid_argument");
    }

    #[test]
    fn a_deletion_has_time_for_each_of_its_git_runs() {
        assert_eq!(deletion_limit(1), WRITE_TIMEOUT * 3);
        assert_eq!(deletion_limit(MAX_BRANCHES), WRITE_TIMEOUT * 2_001);
        assert!(deletion_limit(usize::MAX) >= WRITE_TIMEOUT);
    }
}
