//! Repository commands with a single result: open, close, refs, status, merge base, worktrees.

use std::path::PathBuf;

use git_core::engine::GitEngine;
use git_core::types::{Ref, Repo, StatusEntry, StatusOptions, Worktree};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Opens the repository containing `path` (or reuses the open engine) and describes it.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn open_repository(
    state: State<'_, AppState>,
    path: PathBuf,
    op_id: String,
) -> Result<Repo, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        // The engine may have been opened earlier; HEAD is read now so a branch switched
        // outside the app is reported on this open.
        let engine = worker.open(&path)?;
        let repo = engine.describe_now()?;
        // The index learns about every opened repository and its recents order; a failure
        // there is logged, never a reason to refuse the open.
        if let Err(error) = crate::commands::index::refresh_entry(&worker, &repo.root, &cancel)
            .and_then(|_| {
                worker.with_index(|index| {
                    Ok(index.record_open(
                        &crate::commands::index::normalise(&repo.root),
                        crate::commands::index::now(),
                    )?)
                })
            })
        {
            tracing::warn!(error = %error, "the index could not record the open");
        }
        Ok::<_, AppError>(repo)
    })
    .await
}

/// Starts the filesystem watcher of the open repository at `root` (replacing the watcher of
/// any other repository); `watcher.unavailable` when the platform refuses, in which case the
/// repository stays open without change detection.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, app))]
pub async fn watch_repository(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    root: PathBuf,
) -> Result<(), AppError> {
    let shared = state.inner().clone();
    if shared.is_watching(&root) {
        return Ok(());
    }
    let previous = tokio::task::spawn_blocking(move || {
        let handle = app.clone();
        let watcher = crate::watcher::RepoWatcher::start(&root, move |payload| {
            if let Err(error) = crate::events::emit_repo_changed(&handle, &payload) {
                tracing::warn!(error = %error, "repo:changed could not be emitted");
            }
        })
        .map_err(|error| {
            AppError::new(
                crate::error::codes::WATCHER_UNAVAILABLE,
                "Changes in this repository will not be detected automatically",
            )
            .with_detail(error.to_string())
        })?;
        Ok::<_, AppError>(shared.set_watcher(root, watcher))
    })
    .await
    .map_err(|join| AppError::internal(format!("watcher task failed: {join}")))??;
    if let Some(previous) = previous {
        tokio::task::spawn_blocking(move || drop(previous))
            .await
            .map_err(|join| AppError::internal(format!("watcher task failed: {join}")))?;
    }
    Ok(())
}

/// Closes the engine rooted at `root` and drops its walks off the async runtime; returns
/// whether it was open.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn close_repository(state: State<'_, AppState>, root: PathBuf) -> Result<bool, AppError> {
    let Some(closed) = state.close(&root) else {
        return Ok(false);
    };
    let was_open = closed.engine.is_some();
    tokio::task::spawn_blocking(move || drop(closed))
        .await
        .map_err(|join| AppError::internal(format!("close task failed: {join}")))?;
    Ok(was_open)
}

/// Lists the refs of the repository at `repo`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn list_refs(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<Vec<Ref>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.refs(&cancel)
    })
    .await
}

/// Reports the working tree status of the repository at `repo`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn status(
    state: State<'_, AppState>,
    repo: PathBuf,
    options: StatusOptions,
    op_id: String,
) -> Result<Vec<StatusEntry>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.status(&options, &cancel)
    })
    .await
}

/// Merge base of two revisions of the repository at `repo`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn merge_base(
    state: State<'_, AppState>,
    repo: PathBuf,
    a: String,
    b: String,
    op_id: String,
) -> Result<String, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |_cancel| {
        worker.open(&repo)?.merge_base(&a, &b)
    })
    .await
}

/// Lists the worktrees of the repository at `repo`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn list_worktrees(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<Vec<Worktree>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.worktrees(&cancel)
    })
    .await
}
