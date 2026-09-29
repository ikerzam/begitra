//! "Open in terminal" and "Open in editor" commands.

use std::path::PathBuf;

use crate::error::AppError;
use crate::external::open_with;

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
    tokio::task::spawn_blocking(move || open_with(&templates, &path, line))
        .await
        .map_err(|join| AppError::internal(format!("spawn task failed: {join}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::codes;

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
