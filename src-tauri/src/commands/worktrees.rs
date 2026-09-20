//! The worktree writes: add, remove, prune, lock and unlock through the git
//! CLI. Every argument is checked here before git runs: the path must be absolute (and, for
//! add, not exist yet), names, revisions and reasons must be short and never option-shaped,
//! and a remove or lock must name a worktree the repository lists.

use std::path::{Path, PathBuf};
use std::time::Duration;

use git_core::engine::GitEngine;
use git_core::types::{RefKind, Worktree, WorktreeAdd, WorktreeBranch};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Longest branch name, revision or lock reason accepted.
const MAX_TEXT_CHARS: usize = 200;

/// Longest path accepted (the OS refuses far shorter ones; the bound keeps the error ours).
const MAX_PATH_CHARS: usize = 4096;

/// Adding a worktree checks out the whole tree and removing one deletes it: a minute each on
/// the benchmark repositories (96,038 files; 58,430 files in 35,604 directories), so they
/// get ten minutes instead of the default thirty seconds. A timeout kills git mid-checkout;
/// the engine then rolls the add back.
const WRITE_TIMEOUT: Duration = Duration::from_secs(600);

/// How long the add dialog's existence check waits for a path (a network share may hang).
const EXISTS_TIMEOUT: Duration = Duration::from_secs(2);

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
    let text = path.to_string_lossy();
    if text.starts_with('-') {
        return Err(AppError::invalid_argument(field, "starts with a dash"));
    }
    if text.chars().count() > MAX_PATH_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("longer than {MAX_PATH_CHARS} characters"),
        ));
    }
    Ok(())
}

/// Checks an add request: the path is absolute, the branch and revision are sane. Whether
/// the folder exists is checked on the blocking thread, with the engine.
fn validate_add(request: &WorktreeAdd) -> Result<(), AppError> {
    validate_path("path", &request.path)?;
    match &request.branch {
        WorktreeBranch::New { name, start } => {
            validate_text("name", name)?;
            validate_text("start", start)
        }
        WorktreeBranch::Existing { name } => validate_text("name", name),
        WorktreeBranch::Detached { rev } => validate_text("rev", rev),
    }
}

/// Whether two spellings name the same folder, on disk when both exist.
fn same_folder(a: &Path, b: &Path) -> bool {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    a == b || canonical(a) == canonical(b)
}

/// Whether `path` is one of the repository's worktrees (the main one excluded when asked).
fn listed_worktree(
    engine: &dyn GitEngine,
    path: &Path,
    linked_only: bool,
    cancel: &git_core::engine::Cancel,
) -> Result<(), AppError> {
    let listed = engine.worktrees(cancel)?;
    let found = listed
        .iter()
        .any(|worktree| same_folder(&worktree.path, path) && !(linked_only && worktree.is_main));
    if found {
        Ok(())
    } else {
        Err(AppError::invalid_argument(
            "path",
            "not a linked worktree of the repository",
        ))
    }
}

/// An existing branch to check out must be a local branch no worktree holds: given any
/// other commit-ish git would check it out detached, and given a name that only a remote
/// has it would create a tracking branch, neither of which the dialog offered.
fn free_local_branch(
    engine: &dyn GitEngine,
    name: &str,
    cancel: &git_core::engine::Cancel,
) -> Result<(), AppError> {
    let refs = engine.refs(cancel)?;
    let branch = refs
        .iter()
        .find(|r| r.kind == RefKind::LocalBranch && r.name == name)
        .ok_or_else(|| AppError::invalid_argument("name", "not a local branch"))?;
    if branch.worktree.is_some() {
        return Err(AppError::invalid_argument(
            "name",
            "checked out in a worktree already",
        ));
    }
    Ok(())
}

/// Whether an absolute path exists, for the add dialog's inline check of its Path field
/// before git is asked (git refuses an existing folder too). Off the main thread, since a
/// network path can hang for the share's timeout; after [`EXISTS_TIMEOUT`] it reads as free
/// and git has the last word.
#[tauri::command]
#[tracing::instrument(level = "debug")]
pub async fn path_exists(path: PathBuf) -> Result<bool, AppError> {
    validate_path("path", &path)?;
    let probe = tokio::task::spawn_blocking(move || path.exists());
    match tokio::time::timeout(EXISTS_TIMEOUT, probe).await {
        Ok(Ok(exists)) => Ok(exists),
        Ok(Err(join)) => Err(AppError::internal(format!("path probe failed: {join}"))),
        Err(_elapsed) => Ok(false),
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
    run_blocking(app.ops(), &op_id, WRITE_TIMEOUT, move |cancel| {
        if request.path.exists() {
            return Err(AppError::invalid_argument("path", "the folder exists"));
        }
        let engine = worker.open(&repo)?;
        if let WorktreeBranch::Existing { name } = &request.branch {
            free_local_branch(engine.as_ref(), name, &cancel)?;
        }
        Ok::<_, AppError>(engine.worktree_add(&request, &cancel)?)
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
    run_blocking(app.ops(), &op_id, WRITE_TIMEOUT, move |cancel| {
        let engine = worker.open(&repo)?;
        listed_worktree(engine.as_ref(), &path, true, &cancel)?;
        // The worktree the app has open cannot go: the app would be left in a deleted
        // folder. The user opens the main worktree (or another) first.
        if same_folder(&GitEngine::repo(engine.as_ref()).root, &path) {
            return Err(AppError::invalid_argument(
                "path",
                "the open repository; open another worktree first",
            ));
        }
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
        let long = temp.join("x".repeat(5_000));
        assert_eq!(
            validate_path("path", &long).expect_err("too long").code,
            "ipc.invalid_argument"
        );
    }
}
