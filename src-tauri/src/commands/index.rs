//! The repository index: listing, pinning, forgetting, recents and one-off refreshes.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use git_core::engine::Cancel;
use git_core::summary::{describe, RepoSummary};
use repo_index::{Found, IndexEntry, RepoKind};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Unix seconds now.
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Rebuilds a path from its components so spellings compare equal.
pub fn normalise(path: &Path) -> PathBuf {
    path.components().collect()
}

/// The index entry a summary describes, with no scan folder (opened by path).
pub fn found_from_summary(summary: &RepoSummary) -> Found {
    Found {
        path: normalise(&summary.root),
        name: summary.name.clone(),
        kind: if summary.is_linked_worktree {
            RepoKind::Worktree
        } else {
            RepoKind::Main
        },
        parent_path: summary.main_root.as_deref().map(normalise),
        scan_root: PathBuf::new(),
    }
}

/// The index's own summary shape from the engine's.
pub fn index_summary(summary: &RepoSummary) -> repo_index::RepoSummary {
    repo_index::RepoSummary {
        current_branch: summary.current_branch.clone(),
        detached: summary.detached,
        ahead: summary.ahead,
        behind: summary.behind,
        last_commit_at: summary.last_commit_at,
        dirty: summary.dirty,
    }
}

/// Describes `path` and stores the result: the entry (created when unknown) and its summary.
/// Returns the stored entry.
pub fn refresh_entry(
    state: &AppState,
    path: &Path,
    cancel: &Cancel,
) -> Result<IndexEntry, AppError> {
    let summary = match describe(path, cancel) {
        Ok(summary) => summary,
        Err(error) => {
            let code = error.code();
            if code == crate::error::codes::REPO_NOT_FOUND {
                state.with_index(|index| Ok(index.mark_missing(&normalise(path), true)?))?;
            }
            return Err(AppError::from(error));
        }
    };
    let found = found_from_summary(&summary);
    let stamp = now();
    state.with_index(|index| {
        if index.get(&found.path)?.is_none() {
            index.upsert_found(&found, stamp)?;
        }
        index.update_summary(&found.path, &index_summary(&summary), stamp)?;
        index
            .get(&found.path)?
            .ok_or_else(|| AppError::internal("the refreshed entry vanished"))
    })
}

/// Every indexed repository and worktree.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn list_repositories(state: State<'_, AppState>) -> Result<Vec<IndexEntry>, AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || app.with_index(|index| Ok(index.list()?)))
        .await
        .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Pins or unpins an entry.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn pin_repository(
    state: State<'_, AppState>,
    path: PathBuf,
    pinned: bool,
) -> Result<(), AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        app.with_index(|index| Ok(index.set_pinned(&normalise(&path), pinned)?))
    })
    .await
    .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Forgets an entry (and a repository's worktrees) until a scan finds it again.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn forget_repository(state: State<'_, AppState>, path: PathBuf) -> Result<(), AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        app.with_index(|index| Ok(index.forget(&normalise(&path))?))
    })
    .await
    .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Records that `path` was opened now (the recents order).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn record_repository_open(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<(), AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        app.with_index(|index| Ok(index.record_open(&normalise(&path), now())?))
    })
    .await
    .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Describes one repository again and returns its updated entry.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn refresh_repository(
    state: State<'_, AppState>,
    path: PathBuf,
    op_id: String,
) -> Result<IndexEntry, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        refresh_entry(&worker, &path, &cancel)
    })
    .await
}

/// Drops entries under a removed scan folder (pinned and opened ones stay without a folder).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn remove_scan_root(state: State<'_, AppState>, root: PathBuf) -> Result<(), AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        app.with_index(|index| Ok(index.remove_root(&normalise(&root))?))
    })
    .await
    .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}
