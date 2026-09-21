//! Commands that do not touch a repository: `ping`, the app's own facts, cancellation and
//! the debug event emitter.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::events::{emit_repo_changed, RepoChanged};
use crate::state::AppState;

/// Reply of [`ping`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pong {
    /// The message that was sent.
    pub message: String,
    /// Name of the git backend in use.
    pub backend: String,
    /// Application version.
    pub version: String,
}

/// Builds the reply for `message`.
pub fn pong(message: String) -> Pong {
    Pong {
        message,
        backend: "git2".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// Round-trips a message, for the IPC smoke test.
#[tauri::command]
#[tracing::instrument(level = "debug")]
pub fn ping(message: String) -> Pong {
    pong(message)
}

/// What the About section shows: the version and where the log is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Application version.
    pub version: String,
    /// The day file the log goes to; `None` while the log stays on the console.
    pub log_file: Option<PathBuf>,
    /// Its folder, for "Open logs folder".
    pub log_dir: Option<PathBuf>,
}

/// Builds the reply from the log file, when one was attached.
pub fn app_info_from(log_file: Option<PathBuf>) -> AppInfo {
    let log_dir = log_file
        .as_ref()
        .and_then(|file| file.parent().map(Path::to_path_buf));
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        log_file,
        log_dir,
    }
}

/// The version and the log file's location.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    app_info_from(state.log_file())
}

/// Requests cancellation of an operation in flight; returns whether it was known.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub fn cancel_operation(state: State<'_, AppState>, op_id: String) -> bool {
    state.ops().cancel(&op_id)
}

/// Emits a `repo:changed` event with the given payload, so the frontend listener can be
/// exercised before the filesystem watcher exists. Debug builds only: a release build refuses
/// it, so nothing in the webview can forge the event.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(app))]
pub fn debug_emit_repo_changed(app: AppHandle, payload: RepoChanged) -> Result<(), AppError> {
    if !cfg!(debug_assertions) {
        return Err(AppError::internal(
            "debug_emit_repo_changed is only available in debug builds",
        ));
    }
    emit_repo_changed(&app, &payload)
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_info_names_the_folder_of_the_file_and_stays_bare_without_one() {
        let info = app_info_from(Some(PathBuf::from("/logs/begira-2026-09-22.log")));
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.log_dir, Some(PathBuf::from("/logs")));
        let bare = app_info_from(None);
        assert_eq!(bare.log_file, None);
        assert_eq!(bare.log_dir, None);
    }

    use super::*;

    #[test]
    fn pong_echoes_the_message() {
        let reply = pong("hi".to_owned());
        assert_eq!(reply.message, "hi");
        assert_eq!(reply.backend, "git2");
        assert!(!reply.version.is_empty());
    }
}
