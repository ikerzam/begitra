//! The worktree writes: add, remove, prune, lock and unlock through the git
//! CLI. Every argument is checked here before git runs: the path must be absolute (and, for
//! add, not exist yet), names, revisions and reasons must be short and never option-shaped,
//! and a remove or lock must name a worktree the repository lists.

use std::path::{Path, PathBuf};

use git_core::engine::GitEngine;
use git_core::types::{Worktree, WorktreeAdd, WorktreeBranch};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Longest branch name, revision or lock reason accepted.
const MAX_TEXT_CHARS: usize = 200;

fn validate_text(field: &str, value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::invalid_argument(field, "empty"));
    }
    if value.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("longer than {MAX_TEXT_CHARS} characters"),
        ));
    }
    if value.starts_with('-') {
        return Err(AppError::invalid_argument(field, "starts with a dash"));
    }
    Ok(())
}

fn validate_path(field: &str, path: &Path) -> Result<(), AppError> {
    if !path.is_absolute() {
        return Err(AppError::invalid_argument(field, "not an absolute path"));
    }
    if path.to_string_lossy().starts_with('-') {
        return Err(AppError::invalid_argument(field, "starts with a dash"));
    }
    Ok(())
}

/// Checks an add request: the path is absolute and free, the branch and revision are sane.
fn validate_add(request: &WorktreeAdd) -> Result<(), AppError> {
    validate_path("path", &request.path)?;
    if request.path.exists() {
        return Err(AppError::invalid_argument("path", "the folder exists"));
    }
    match &request.branch {
        WorktreeBranch::New { name, start } => {
            validate_text("name", name)?;
            validate_text("start", start)
        }
        WorktreeBranch::Existing { name } => validate_text("name", name),
        WorktreeBranch::Detached { rev } => validate_text("rev", rev),
    }
}

/// Whether `path` is one of the repository's worktrees (the main one excluded when asked).
fn listed_worktree(
    engine: &dyn GitEngine,
    path: &Path,
    linked_only: bool,
    cancel: &git_core::engine::Cancel,
) -> Result<(), AppError> {
    let listed = engine.worktrees(cancel)?;
    let same = |a: &Path, b: &Path| {
        let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        a == b || canonical(a) == canonical(b)
    };
    let found = listed
        .iter()
        .any(|worktree| same(&worktree.path, path) && !(linked_only && worktree.is_main));
    if found {
        Ok(())
    } else {
        Err(AppError::invalid_argument(
            "path",
            "not a linked worktree of the repository",
        ))
    }
}

/// Adds a worktree to the repository at `repo`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn worktree_add(
    state: State<'_, AppState>,
    repo: PathBuf,
    request: WorktreeAdd,
    op_id: String,
) -> Result<Worktree, AppError> {
    validate_add(&request)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.worktree_add(&request, &cancel)
    })
    .await
}

/// Removes a linked worktree; `force` discards its uncommitted changes.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn worktree_remove(
    state: State<'_, AppState>,
    repo: PathBuf,
    path: PathBuf,
    force: bool,
    op_id: String,
) -> Result<(), AppError> {
    validate_path("path", &path)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        let engine = worker.open(&repo)?;
        listed_worktree(engine.as_ref(), &path, true, &cancel)?;
        Ok::<_, AppError>(engine.worktree_remove(&path, force, &cancel)?)
    })
    .await
}

/// Unregisters the worktrees whose folders are missing; returns the paths that went.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn worktree_prune(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<Vec<PathBuf>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.worktree_prune(&cancel)
    })
    .await
}

/// Locks a linked worktree, with a reason when given.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn worktree_lock(
    state: State<'_, AppState>,
    repo: PathBuf,
    path: PathBuf,
    reason: Option<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_path("path", &path)?;
    if let Some(reason) = reason.as_deref().filter(|r| !r.trim().is_empty()) {
        validate_text("reason", reason)?;
    }
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        let engine = worker.open(&repo)?;
        listed_worktree(engine.as_ref(), &path, true, &cancel)?;
        Ok::<_, AppError>(engine.worktree_lock(&path, reason.as_deref(), &cancel)?)
    })
    .await
}

/// Unlocks a linked worktree.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn worktree_unlock(
    state: State<'_, AppState>,
    repo: PathBuf,
    path: PathBuf,
    op_id: String,
) -> Result<(), AppError> {
    validate_path("path", &path)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        let engine = worker.open(&repo)?;
        listed_worktree(engine.as_ref(), &path, true, &cancel)?;
        Ok::<_, AppError>(engine.worktree_unlock(&path, &cancel)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_requests_are_validated() {
        let temp = std::env::temp_dir();
        let free = temp.join("begira-no-such-folder-for-tests");
        let ok = WorktreeAdd {
            path: free.clone(),
            branch: WorktreeBranch::New {
                name: "topic".to_owned(),
                start: "main".to_owned(),
            },
        };
        assert!(validate_add(&ok).is_ok());
        let relative = WorktreeAdd {
            path: PathBuf::from("relative/wt"),
            ..ok.clone()
        };
        assert_eq!(
            validate_add(&relative).expect_err("relative").code,
            "ipc.invalid_argument"
        );
        let existing = WorktreeAdd {
            path: temp.clone(),
            ..ok.clone()
        };
        assert!(validate_add(&existing).is_err());
        let dashed = WorktreeAdd {
            branch: WorktreeBranch::Existing {
                name: "--force".to_owned(),
            },
            ..ok.clone()
        };
        assert!(validate_add(&dashed).is_err());
        let empty = WorktreeAdd {
            branch: WorktreeBranch::Detached {
                rev: " ".to_owned(),
            },
            ..ok
        };
        assert!(validate_add(&empty).is_err());
        assert!(validate_text("reason", &"r".repeat(201)).is_err());
    }
}
