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

/// What the About and Agents sections show: the version, where the log is written and where
/// the agent server is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Application version.
    pub version: String,
    /// The day file the log goes to; `None` while the log stays on the console.
    pub log_file: Option<PathBuf>,
    /// Its folder, for "Open logs folder".
    pub log_dir: Option<PathBuf>,
    /// The agent server beside the app's executable (the installers put it there); `None`
    /// when it is not there, as in a development build that did not build it.
    pub agent_server: Option<PathBuf>,
}

/// The agent server's file name.
const AGENT_SERVER: &str = if cfg!(windows) {
    "begitra-mcp.exe"
} else {
    "begitra-mcp"
};

/// Builds the reply from the log file, when one was attached, and the agent server found.
pub fn app_info_from(log_file: Option<PathBuf>, agent_server: Option<PathBuf>) -> AppInfo {
    let log_dir = log_file
        .as_ref()
        .and_then(|file| file.parent().map(Path::to_path_buf));
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        log_file,
        log_dir,
        agent_server,
    }
}

/// The agent server beside the executable `exe`, when it is there.
pub fn agent_server_beside(exe: &Path) -> Option<PathBuf> {
    let server = exe.parent()?.join(AGENT_SERVER);
    server.is_file().then_some(server)
}

/// The version, the log file's location and the agent server's.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    let agent_server = std::env::current_exe()
        .ok()
        .and_then(|exe| agent_server_beside(&exe));
    app_info_from(state.log_file(), agent_server)
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
        let info = app_info_from(Some(PathBuf::from("/logs/begitra-2026-09-22.log")), None);
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.log_dir, Some(PathBuf::from("/logs")));
        let bare = app_info_from(None, None);
        assert_eq!(bare.log_file, None);
        assert_eq!(bare.log_dir, None);
    }

    #[test]
    fn the_agent_server_is_found_beside_the_executable_only() {
        let dir = tempfile::tempdir().expect("temporary folder");
        let exe = dir.path().join(if cfg!(windows) {
            "begitra.exe"
        } else {
            "begitra"
        });
        std::fs::write(&exe, b"app").expect("app");
        assert_eq!(agent_server_beside(&exe), None);
        let server = dir.path().join(AGENT_SERVER);
        std::fs::write(&server, b"server").expect("server");
        assert_eq!(agent_server_beside(&exe), Some(server));
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
