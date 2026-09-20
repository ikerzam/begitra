//! Begira desktop application: the Tauri layer that exposes `git-core` to the Vue frontend
//! through typed commands, streamed Channels, cancellable operations and one `AppError`.

pub mod channels;
pub mod commands;
pub mod error;
pub mod events;
pub mod external;
#[cfg(test)]
mod fixtures;
pub mod ops;
pub mod state;
pub mod watcher;

use tauri::Manager;

use state::AppState;

/// Installs the tracing subscriber: `RUST_LOG` when set, otherwise info for the app and the
/// engine. Safe to call more than once.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("begira_lib=info,git_core=info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .try_init();
}

/// Drops walk handles idle for longer than [`state::WALK_IDLE_LIMIT`] once a minute, off the
/// async runtime, so an abandoned walk on a large repository does not keep its maps for the
/// whole session.
fn spawn_walk_eviction(state: AppState) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            let sweeper = state.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let evicted = sweeper.evict_idle_walks(state::WALK_IDLE_LIMIT);
                if !evicted.is_empty() {
                    tracing::debug!(count = evicted.len(), "evicted idle walks");
                }
            })
            .await;
        }
    });
}

/// Opens the index database under the app data folder; when that fails the in-memory index
/// serves the session and the failure is logged (the app stays usable).
fn open_index(app: &tauri::App, state: &AppState) {
    // The local (non-roaming) data folder: the write-ahead log must not be synced apart
    // from its database.
    let path = match app.path().app_local_data_dir() {
        Ok(dir) => dir.join("index.sqlite"),
        Err(error) => {
            tracing::warn!(error = %error, "no app data folder: the index lives in memory");
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            tracing::warn!(error = %error, "the app data folder could not be created");
            return;
        }
    }
    if let Err(error) = state.open_index(&path) {
        tracing::warn!(error = %error, path = %path.display(), "the index could not be opened");
    }
}

/// Builds and runs the Tauri application.
///
/// Exits the process with status 1 if the runtime fails to start; there is no UI to report to
/// at that point.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            let state = app.state::<AppState>().inner().clone();
            open_index(app, &state);
            spawn_walk_eviction(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::ping,
            commands::system::cancel_operation,
            commands::system::debug_emit_repo_changed,
            commands::external::open_external,
            commands::repo::open_repository,
            commands::repo::close_repository,
            commands::repo::watch_repository,
            commands::index::list_repositories,
            commands::index::pin_repository,
            commands::index::forget_repository,
            commands::index::record_repository_open,
            commands::index::refresh_repository,
            commands::index::remove_scan_root,
            commands::scan::scan_folders,
            commands::repo::list_refs,
            commands::repo::status,
            commands::repo::merge_base,
            commands::repo::count_commits,
            commands::repo::list_worktrees,
            commands::walk::walk_commits,
            commands::walk::walk_continue,
            commands::walk::close_walk,
            commands::diff::diff,
            commands::review::read_blob,
            commands::review::highlight_file,
            commands::review::file_symbols,
            commands::review::list_annotations,
            commands::review::set_annotation,
            commands::review::delete_annotation,
            commands::compare::compare,
            commands::compare::merge_preview,
            commands::worktrees::worktree_add,
            commands::worktrees::worktree_remove,
            commands::worktrees::worktree_prune,
            commands::worktrees::worktree_lock,
            commands::worktrees::worktree_unlock,
            commands::worktrees::path_exists,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("begira: failed to start the application runtime: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    /// The engine crates must stay usable from a CLI or an agent, so they never depend on Tauri.
    #[test]
    fn engine_crates_do_not_depend_on_tauri() {
        let manifests = [
            ("git-core", include_str!("../crates/git-core/Cargo.toml")),
            (
                "repo-index",
                include_str!("../crates/repo-index/Cargo.toml"),
            ),
        ];
        for (name, manifest) in manifests {
            let offending: Vec<&str> = manifest
                .lines()
                .map(str::trim)
                .filter(|line| line.starts_with("tauri"))
                .collect();
            assert!(
                offending.is_empty(),
                "{name} depends on tauri: {offending:?}"
            );
        }
    }
}
