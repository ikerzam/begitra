//! The git executable (the settings' Git section): `detect_git` finds one, and
//! `set_git_executable` makes the engine's CLI use the one the user chose, after a probe.

use std::path::{Path, PathBuf};

use git_core::cli;
use git_core::types::GitDetection;
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Longest executable path accepted.
const MAX_PATH_CHARS: usize = 4096;

/// Checks the executable the user typed: at most [`MAX_PATH_CHARS`] characters and never
/// option-shaped; a bare program name (`git`) is allowed, PATH resolves it.
fn validate_executable(path: &Path) -> Result<(), AppError> {
    let text = path.to_string_lossy();
    if text.chars().count() > MAX_PATH_CHARS {
        return Err(AppError::invalid_argument(
            "path",
            format!("longer than {MAX_PATH_CHARS} characters"),
        ));
    }
    if text.trim_start().starts_with('-') {
        return Err(AppError::invalid_argument("path", "starts with a dash"));
    }
    Ok(())
}

/// Looks for git at the configured executable, on PATH and in the platform's common
/// locations; `git.cli_failed` when none runs.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn detect_git(
    state: State<'_, AppState>,
    op_id: String,
) -> Result<GitDetection, AppError> {
    let app = state.inner().clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |_cancel| {
        cli::detect_git().map_err(AppError::from)
    })
    .await
}

/// Makes the engine's CLI run `path` (an empty path returns to `git` on PATH) once
/// `<path> --version` has answered; a program that is not git is refused and the previous
/// executable stays in use.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn set_git_executable(
    state: State<'_, AppState>,
    path: String,
    op_id: String,
) -> Result<GitDetection, AppError> {
    let trimmed = path.trim();
    let chosen = if trimmed.is_empty() {
        None
    } else {
        let candidate = PathBuf::from(trimmed);
        validate_executable(&candidate)?;
        Some(candidate)
    };
    let app = state.inner().clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |_cancel| {
        cli::set_git_executable(chosen.as_deref()).map_err(AppError::from)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executables_are_validated() {
        assert!(validate_executable(Path::new("git")).is_ok());
        assert!(validate_executable(Path::new("C:/Program Files/Git/cmd/git.exe")).is_ok());
        assert_eq!(
            validate_executable(Path::new("--version"))
                .expect_err("dash")
                .code,
            "ipc.invalid_argument"
        );
        assert!(validate_executable(Path::new(&"x".repeat(5_000))).is_err());
    }
}
