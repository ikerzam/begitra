//! Commands that do not touch a repository: `ping`, cancellation and the debug event emitter.

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
    use super::*;

    #[test]
    fn pong_echoes_the_message() {
        let reply = pong("hi".to_owned());
        assert_eq!(reply.message, "hi");
        assert_eq!(reply.backend, "git2");
        assert!(!reply.version.is_empty());
    }
}
