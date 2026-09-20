//! The comparison's commands: `compare` (the endpoints resolved, the merge base, the counts
//! of commits only on each side and the relation) and `merge_preview` (what merging `b` into
//! `a` would do, through `git merge-tree` for a diverged pair). The side lists and the file
//! summary go through `walk_commits` and `diff`.

use std::path::PathBuf;

use git_core::engine::GitEngine;
use git_core::types::{Comparison, MergePreview};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Longest revision accepted as an endpoint.
const MAX_ENDPOINT_CHARS: usize = 200;

/// Checks an endpoint: not empty, not longer than [`MAX_ENDPOINT_CHARS`] and not shaped like
/// an option, since one of them reaches `git merge-tree` as an argument.
fn validate_endpoint(field: &str, rev: &str) -> Result<(), AppError> {
    if rev.trim().is_empty() {
        return Err(AppError::invalid_argument(field, "empty"));
    }
    if rev.chars().count() > MAX_ENDPOINT_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("longer than {MAX_ENDPOINT_CHARS} characters"),
        ));
    }
    if rev.starts_with('-') {
        return Err(AppError::invalid_argument(field, "starts with a dash"));
    }
    Ok(())
}

/// Compares `a` with `b` in the repository at `repo`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn compare(
    state: State<'_, AppState>,
    repo: PathBuf,
    a: String,
    b: String,
    op_id: String,
) -> Result<Comparison, AppError> {
    validate_endpoint("a", &a)?;
    validate_endpoint("b", &b)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.compare(&a, &b, &cancel)
    })
    .await
}

/// Previews the merge of `b` into `a` in the repository at `repo`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn merge_preview(
    state: State<'_, AppState>,
    repo: PathBuf,
    a: String,
    b: String,
    op_id: String,
) -> Result<MergePreview, AppError> {
    validate_endpoint("a", &a)?;
    validate_endpoint("b", &b)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.merge_preview(&a, &b, &cancel)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_are_validated() {
        assert!(validate_endpoint("a", "main").is_ok());
        assert!(validate_endpoint("a", "v2.3.1").is_ok());
        assert!(validate_endpoint("a", "a".repeat(200).as_str()).is_ok());
        for bad in ["", "  ", "--output=x", "-b"] {
            let error = validate_endpoint("a", bad).expect_err(bad);
            assert_eq!(error.code, "ipc.invalid_argument", "{bad}");
        }
        assert!(validate_endpoint("b", "a".repeat(201).as_str()).is_err());
    }
}
