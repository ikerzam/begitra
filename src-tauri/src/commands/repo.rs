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
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |_cancel| {
        worker.open(&path).map(|engine| engine.repo().clone())
    })
    .await
}

/// Closes the engine rooted at `root` and drops its walks; returns whether it was open.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub fn close_repository(state: State<'_, AppState>, root: PathBuf) -> bool {
    state.close(&root)
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
