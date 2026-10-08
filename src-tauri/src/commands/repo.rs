//! Repository commands with a single result: open, close, refs, status, merge base, worktrees.

use std::path::PathBuf;

use git_core::engine::GitEngine;
use git_core::types::{CommitCount, Ref, Repo, StatusEntry, StatusOptions, WalkScope, Worktree};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;
use crate::watcher::{RepoWatcher, WatchBasesExt};

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
    let repo = run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |_cancel| {
        // The engine may have been opened earlier; HEAD is read now so a branch switched
        // outside the app is reported on this open.
        let engine = worker.open(&path)?;
        engine.describe_now()
    })
    .await?;
    // The index learns about every opened repository and its recents order off the open's
    // critical path; a failure there is logged, never shown. The dirty flag is left as it
    // was: nothing shows it while the repository is open, and the frontend refreshes it once
    // the repository stops being the open one.
    let recorder = app.clone();
    let root = repo.root.clone();
    tokio::task::spawn_blocking(move || {
        let cancel = git_core::engine::Cancel::never();
        let outcome = crate::commands::index::refresh_entry(&recorder, &root, false, &cancel)
            .and_then(|_| {
                recorder.with_index(|index| {
                    Ok(index.record_open(
                        &crate::commands::index::normalise(&root),
                        crate::commands::index::now(),
                    )?)
                })
            });
        if let Err(error) = outcome {
            tracing::warn!(error = %error, "the index could not record the open");
        }
    });
    Ok(repo)
}

/// Starts the filesystem watcher of the open repository at `root` (replacing the watcher of
/// any other repository); `watcher.unavailable` when the platform refuses, in which case the
/// repository stays open without change detection. A start that a later one, or a close of
/// `root`, superseded while it walked the tree is dropped instead of installed. A repository of
/// the folder view keeps the view's watcher until its own start ends
/// ([`AppState::finish_watch`]), and falls back on it when the platform refuses.
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
    let ticket = shared.begin_watch(&root);
    let taken = shared.take_folder_watcher(&root);
    let (refusal, dropped) = tokio::task::spawn_blocking(move || {
        let handle = app.clone();
        let bases = match shared.engine_for(&root) {
            Some(engine) => engine.watch_bases(),
            // An engine opened for the bases alone, as the folder view's starts do, so a linked
            // worktree watches its own git directory; the main layout when it does not open.
            None => match git_core::git2_engine::Git2Engine::open(&root) {
                Ok(engine) => engine.watch_bases(),
                Err(_) => crate::watcher::WatchBases::main(&root),
            },
        };
        let started = RepoWatcher::start(bases, move |payload| {
            if let Err(error) = crate::events::emit_repo_changed(&handle, &payload) {
                tracing::warn!(error = %error, "repo:changed could not be emitted");
            }
        });
        shared.finish_watch(ticket, &root, started, taken)
    })
    .await
    .map_err(|join| AppError::internal(format!("watcher task failed: {join}")))?;
    if !dropped.is_empty() {
        tokio::task::spawn_blocking(move || drop(dropped))
            .await
            .map_err(|join| AppError::internal(format!("watcher task failed: {join}")))?;
    }
    match refusal {
        None => Ok(()),
        Some(error) => {
            // notify names the inotify limit as its own kind (ENOSPC included).
            let detail = match error.kind {
                notify::ErrorKind::MaxFilesWatch => {
                    "too many watched folders for this system (inotify limit)".to_owned()
                }
                _ => error.to_string(),
            };
            Err(AppError::new(
                crate::error::codes::WATCHER_UNAVAILABLE,
                "Changes in this repository will not be detected automatically",
            )
            .with_detail(detail))
        }
    }
}

/// Makes the folder view's watchers follow `roots`: the first
/// [`crate::state::FOLDER_WATCH_LIMIT`] of them get a watcher, but the open repository, which
/// keeps its own, and the watchers of roots no longer listed stop. The roots are claimed before
/// the command waits, so an `unwatch_folder` or a sync sent after it comes after it; the starts
/// run in the background, one after another. Answers the roots the folder watchers watch when
/// this call's starts ended; a root whose repository or watcher cannot start is logged and left
/// out, and the view reads it again on the window's focus.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, app, roots), fields(roots = roots.len()))]
pub async fn watch_folder(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    roots: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, AppError> {
    let shared = state.inner().clone();
    let sync = shared.begin_folder_sync(&roots);
    tokio::task::spawn_blocking(move || {
        drop(sync.dropped);
        shared.run_folder_starts(sync.start, |bases| {
            let handle = app.clone();
            RepoWatcher::start_without_snapshot(bases, move |payload| {
                if let Err(error) = crate::events::emit_repo_changed(&handle, &payload) {
                    tracing::warn!(error = %error, "repo:changed could not be emitted");
                }
            })
        });
        shared.folder_watched()
    })
    .await
    .map_err(|join| AppError::internal(format!("folder watcher task failed: {join}")))
}

/// Stops the folder view's watchers, leaving the view.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn unwatch_folder(state: State<'_, AppState>) -> Result<(), AppError> {
    let dropped = state.stop_folder_watchers();
    tokio::task::spawn_blocking(move || drop(dropped))
        .await
        .map_err(|join| AppError::internal(format!("folder watcher task failed: {join}")))
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

/// How many commits `scope` holds, at most `COUNT_CAP`.
#[tauri::command]
#[tracing::instrument(
    level = "debug",
    skip(state, scope),
    fields(scope = scope.kind(), names = scope.name_count())
)]
pub async fn count_commits(
    state: State<'_, AppState>,
    repo: PathBuf,
    scope: WalkScope,
    op_id: String,
) -> Result<CommitCount, AppError> {
    super::walk::validate_scope(&scope)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.count_commits(&scope, &cancel)
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

/// The longest a "Contained in" read runs: about eight times the parents-first walk of the
/// kernel's 1.48 million commits without a commit-graph.
const CONTAINS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// The full names of the branches, remote branches and tags whose history holds `commit` (a
/// full hash) in the repository at `repo`; git's walk stops with the operation.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn refs_containing(
    state: State<'_, AppState>,
    repo: PathBuf,
    commit: String,
    op_id: String,
) -> Result<Vec<String>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, CONTAINS_TIMEOUT, move |cancel| {
        worker.open(&repo)?.refs_containing(&commit, &cancel)
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
