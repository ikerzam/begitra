//! Begitra desktop application: the Tauri layer that exposes `git-core` to the Vue frontend
//! through typed commands, streamed Channels, cancellable operations and one `AppError`.

pub mod channels;
pub mod commands;
pub mod error;
pub mod events;
pub mod external;
#[cfg(test)]
mod fixtures;
pub mod logging;
pub mod ops;
pub mod state;
pub mod watcher;

use tauri::Manager;

use state::AppState;

/// Points the log at the app's log folder (`app_log_dir`), once Tauri can resolve it; a
/// failure is logged and leaves the console output in place.
fn attach_log(app: &tauri::App, state: &AppState, slot: Option<&logging::LogSlot>) {
    let Some(slot) = slot else { return };
    let dir = match app.path().app_log_dir() {
        Ok(dir) => dir,
        Err(error) => {
            tracing::warn!(error = %error, "no log folder: the log stays on the console");
            return;
        }
    };
    match slot.attach(&dir) {
        Ok(path) => {
            tracing::info!(path = %path.display(), version = env!("CARGO_PKG_VERSION"), "log file attached");
            state.set_log_file(path);
        }
        Err(error) => {
            tracing::warn!(error = %error, dir = %dir.display(), "the log file could not be opened");
        }
    }
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
    let log_slot = logging::install();
    logging::install_panic_hook();
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .setup(move |app| {
            let state = app.state::<AppState>().inner().clone();
            attach_log(app, &state, log_slot.as_ref());
            open_index(app, &state);
            spawn_walk_eviction(state);
            // The syntax set takes a while to deserialise; loading it now keeps the first
            // diff from waiting for it.
            if let Err(error) = std::thread::Builder::new()
                .name("syntax-warm-up".to_owned())
                .spawn(syntax::warm_up)
            {
                tracing::warn!(%error, "the syntax set loads with the first file instead");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::ping,
            commands::system::app_info,
            commands::system::cancel_operation,
            commands::system::debug_emit_repo_changed,
            commands::external::open_external,
            commands::repo::open_repository,
            commands::repo::close_repository,
            commands::repo::watch_repository,
            commands::repo::watch_folder,
            commands::repo::unwatch_folder,
            commands::index::list_repositories,
            commands::index::pin_repository,
            commands::index::forget_repository,
            commands::index::record_repository_open,
            commands::index::refresh_repository,
            commands::index::remove_scan_root,
            commands::projects::projects,
            commands::projects::project_create,
            commands::projects::project_rename,
            commands::projects::project_set_members,
            commands::projects::project_delete,
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
            commands::diff::diff_paths,
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
            commands::git::detect_git,
            commands::git::set_git_executable,
            commands::staging::stage_paths,
            commands::staging::unstage_paths,
            commands::staging::discard_paths,
            commands::staging::apply_selection,
            commands::staging::commit,
            commands::staging::commit_context,
            commands::branches::branch_create,
            commands::branches::switch,
            commands::branches::branch_rename,
            commands::branches::branch_delete,
            commands::branches::merge,
            commands::branches::rebase,
            commands::branches::reset,
            commands::branches::cherry_pick,
            commands::branches::revert,
            commands::branches::tag_create,
            commands::branches::tag_delete,
            commands::branches::set_upstream,
            commands::branches::operation_state,
            commands::branches::conflicts,
            commands::branches::mark_resolved,
            commands::branches::sequencer,
            commands::remotes::remotes,
            commands::remotes::remote_add,
            commands::remotes::remote_remove,
            commands::remotes::fetch,
            commands::remotes::pull,
            commands::remotes::push,
            commands::stash::stash_push,
            commands::stash::stash_apply,
            commands::stash::stash_pop,
            commands::stash::stash_drop,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("begitra: failed to start the application runtime: {error}");
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
