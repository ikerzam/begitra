//! "Open in terminal", "Open in editor", "Open on <forge>" and "Reveal in Explorer" commands.
//!
//! The last two use the opener crate as a library, after their own checks: its plugin is not
//! registered, so the webview has none of its commands.

use std::path::PathBuf;

use tauri::State;

use crate::error::{codes, AppError};
use crate::external::open_with;
use crate::links::checked_link;
use crate::ops::DEFAULT_TIMEOUT;
use crate::reveal;
use crate::state::AppState;

/// The highest line a command may name: more than any file the viewer shows.
const MAX_LINE: u32 = 10_000_000;

/// A line to open at, from 1 to [`MAX_LINE`], or none.
fn valid_line(line: Option<u32>) -> Result<Option<u32>, AppError> {
    match line {
        Some(0) => Err(AppError::invalid_argument("line", "lines start at 1")),
        Some(line) if line > MAX_LINE => Err(AppError::invalid_argument(
            "line",
            format!("at most {MAX_LINE}"),
        )),
        line => Ok(line),
    }
}

/// Opens `path` (a folder, or a file at `line`) with the first template that spawns; returns
/// the argv that ran.
///
/// The frontend passes the configured template first and the platform fallbacks after it.
/// Spawning happens off the async runtime: process creation is not instant on Windows.
#[tauri::command]
#[tracing::instrument(level = "debug")]
pub async fn open_external(
    templates: Vec<String>,
    path: PathBuf,
    line: Option<u32>,
) -> Result<Vec<String>, AppError> {
    let line = valid_line(line)?;
    // Every caller passes an absolute path (a root, an index entry, a root and a file in it);
    // a relative one would start the command in whatever folder the app runs from.
    if !path.is_absolute() {
        return Err(AppError::invalid_argument("path", "must be absolute"));
    }
    tokio::task::spawn_blocking(move || open_with(&templates, &path, line))
        .await
        .map_err(|join| AppError::internal(format!("spawn task failed: {join}")))?
}

/// Opens `url`, a forge's page, in the default browser; any other link is refused
/// (`external.refused`) and opens nothing.
///
/// The platform answers at once, but a handler that waits on a dialog would hold the command:
/// it answers `op.timeout` after the default timeout, the call left to finish on its own.
#[tauri::command]
#[tracing::instrument(level = "debug")]
pub async fn open_link(url: String) -> Result<(), AppError> {
    let link = checked_link(&url)?;
    let task = tokio::task::spawn_blocking(move || {
        tauri_plugin_opener::open_url(link.as_str(), None::<&str>).map_err(|error| {
            AppError::new(
                codes::EXTERNAL_SPAWN_FAILED,
                "The browser could not be opened",
            )
            .with_detail(error.to_string())
        })
    });
    tokio::time::timeout(DEFAULT_TIMEOUT, task)
        .await
        .map_err(|_| AppError::timeout("open_link", DEFAULT_TIMEOUT))?
        .map_err(|join| AppError::internal(format!("open task failed: {join}")))?
}

/// Reveals `path`, a file or folder of the working tree at `root` or one of `root`'s
/// worktrees, in the platform's file manager, selected where the platform can. The checks are
/// [`reveal::check`]'s; the platform's own call runs off the async runtime, and a share that
/// does not answer makes it `op.timeout` after the default timeout.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn reveal_path(
    state: State<'_, AppState>,
    root: PathBuf,
    path: PathBuf,
) -> Result<(), AppError> {
    let app = state.inner().clone();
    let task = tokio::task::spawn_blocking(move || {
        reveal::check(&app, &root, &path)?;
        tauri_plugin_opener::reveal_item_in_dir(&path)
            .map_err(|error| reveal::failure(&path, error))
    });
    tokio::time::timeout(DEFAULT_TIMEOUT, task)
        .await
        .map_err(|_| AppError::timeout("reveal_path", DEFAULT_TIMEOUT))?
        .map_err(|join| AppError::internal(format!("reveal task failed: {join}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_start_at_one_and_stay_bounded() {
        assert_eq!(valid_line(None).expect("none"), None);
        assert_eq!(valid_line(Some(1)).expect("one"), Some(1));
        assert_eq!(valid_line(Some(MAX_LINE)).expect("max"), Some(MAX_LINE));
        for line in [0, MAX_LINE + 1] {
            let error = valid_line(Some(line)).expect_err("out of range");
            assert_eq!(error.code, codes::IPC_INVALID_ARGUMENT);
        }
    }
}
