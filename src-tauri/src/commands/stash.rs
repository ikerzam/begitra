//! The stash writes: push, apply, pop and drop through the git CLI. The listing
//! is part of `list_refs` (the `stash` kind). Not registered for cancellation,
//! like the other index writes; a pop or apply that conflicts is an outcome the frontend
//! shows with the stash kept.

use std::path::PathBuf;

use git_core::engine::GitEngine;
use git_core::types::{Outcome, StashPush};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_unregistered, DEFAULT_TIMEOUT};
use crate::state::AppState;

use super::branches::WRITE_TIMEOUT;
use super::staging::validate_paths;

/// Longest stash message accepted.
const MAX_MESSAGE_CHARS: usize = 10_000;

/// Highest stash index addressed (`stash@{n}`); git lists far fewer in practice.
const MAX_STASH_INDEX: u32 = 999;

fn validate_push(request: &StashPush) -> Result<(), AppError> {
    if let Some(message) = request.message.as_deref() {
        if message.trim().is_empty() {
            return Err(AppError::invalid_argument("message", "blank"));
        }
        if message.chars().count() > MAX_MESSAGE_CHARS {
            return Err(AppError::invalid_argument(
                "message",
                format!("longer than {MAX_MESSAGE_CHARS} characters"),
            ));
        }
        if message.starts_with('-') {
            return Err(AppError::invalid_argument("message", "starts with a dash"));
        }
        if message.chars().any(|c| c.is_control() && c != '\n') {
            return Err(AppError::invalid_argument("message", "a control character"));
        }
    }
    if !request.paths.is_empty() {
        validate_paths("paths", &request.paths)?;
    }
    Ok(())
}

fn validate_index(index: u32) -> Result<(), AppError> {
    if index > MAX_STASH_INDEX {
        return Err(AppError::invalid_argument(
            "index",
            format!("over {MAX_STASH_INDEX}"),
        ));
    }
    Ok(())
}

/// Stashes the working tree (or the given paths); `false` when there was nothing to save.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, request), fields(untracked = request.include_untracked, paths = request.paths.len()))]
pub async fn stash_push(
    state: State<'_, AppState>,
    repo: PathBuf,
    request: StashPush,
    op_id: String,
) -> Result<bool, AppError> {
    validate_push(&request)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.stash_push(&request, &cancel)
    })
    .await
}

/// Applies `stash@{index}`, keeping it.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn stash_apply(
    state: State<'_, AppState>,
    repo: PathBuf,
    index: u32,
    op_id: String,
) -> Result<Outcome, AppError> {
    validate_index(index)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.stash_apply(index, &cancel)
    })
    .await
}

/// Pops `stash@{index}`; on conflicts the stash is kept and the outcome says so.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn stash_pop(
    state: State<'_, AppState>,
    repo: PathBuf,
    index: u32,
    op_id: String,
) -> Result<Outcome, AppError> {
    validate_index(index)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.stash_pop(index, &cancel)
    })
    .await
}

/// Drops `stash@{index}` after the confirmation (a dropped stash is only in the reflog of
/// nothing: git prints its hash, which the frontend shows once).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn stash_drop(
    state: State<'_, AppState>,
    repo: PathBuf,
    index: u32,
    op_id: String,
) -> Result<(), AppError> {
    validate_index(index)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.stash_drop(index, &cancel)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_requests_are_validated() {
        let request = |message: Option<&str>, paths: Vec<&str>| StashPush {
            message: message.map(str::to_owned),
            include_untracked: false,
            paths: paths.into_iter().map(str::to_owned).collect(),
        };
        assert!(validate_push(&request(None, vec![])).is_ok());
        assert!(validate_push(&request(Some("wip: tiles"), vec!["src/a.ts"])).is_ok());
        for bad in [
            request(Some(""), vec![]),
            request(Some("-m"), vec![]),
            request(Some("a\0b"), vec![]),
            request(None, vec!["../x"]),
        ] {
            assert_eq!(
                validate_push(&bad).expect_err("refused").code,
                "ipc.invalid_argument"
            );
        }
        assert!(validate_index(0).is_ok());
        assert_eq!(
            validate_index(MAX_STASH_INDEX + 1)
                .expect_err("refused")
                .code,
            "ipc.invalid_argument"
        );
    }
}
