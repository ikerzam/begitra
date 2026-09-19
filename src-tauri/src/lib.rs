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
        .invoke_handler(tauri::generate_handler![
            commands::system::ping,
            commands::system::cancel_operation,
            commands::system::debug_emit_repo_changed,
            commands::external::open_external,
            commands::repo::open_repository,
            commands::repo::close_repository,
            commands::repo::list_refs,
            commands::repo::status,
            commands::repo::merge_base,
            commands::repo::list_worktrees,
            commands::walk::walk_commits,
            commands::walk::walk_continue,
            commands::walk::close_walk,
            commands::diff::diff,
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
