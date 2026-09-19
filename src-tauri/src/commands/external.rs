//! "Open in terminal" and "Open in editor" commands.

use std::path::PathBuf;

use crate::error::AppError;
use crate::external::open_with;

/// Opens `path` with the first template that spawns; returns the argv that ran.
///
/// The frontend passes the configured template first and the platform fallbacks after it.
/// Spawning happens off the async runtime: process creation is not instant on Windows.
#[tauri::command]
#[tracing::instrument(level = "debug")]
pub async fn open_external(templates: Vec<String>, path: PathBuf) -> Result<Vec<String>, AppError> {
    tokio::task::spawn_blocking(move || open_with(&templates, &path))
        .await
        .map_err(|join| AppError::internal(format!("spawn task failed: {join}")))?
}
