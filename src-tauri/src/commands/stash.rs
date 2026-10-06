//! The stash writes: push, apply, pop and drop through the git CLI. The listing
//! is part of `list_refs` (the `stash` kind). Apply, pop and drop name the stash by its
//! commit, which the engine finds in the list when the action starts. Not registered for
//! cancellation, like the other index writes; a pop or apply that conflicts is an outcome the
//! frontend shows with the stash kept.

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

/// A stash is named by its full commit hash, lowercase, as the refs listing gives it (SHA-1
/// or SHA-256): not a revision, so neither a position like `stash@{1}` nor anything
/// option-shaped reaches git.
fn validate_stash(stash: &str) -> Result<(), AppError> {
    super::branches::validate_hash("stash", stash)
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

/// Applies the stash whose commit is `stash`, keeping it; `stash.not_found` when it is no
/// longer in the list.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn stash_apply(
    state: State<'_, AppState>,
    repo: PathBuf,
    stash: String,
    op_id: String,
) -> Result<Outcome, AppError> {
    validate_stash(&stash)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.stash_apply(&stash, &cancel)
    })
    .await
}

/// Pops the stash whose commit is `stash`; on conflicts the stash is kept and the outcome
/// says so; `stash.not_found` when it is no longer in the list.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn stash_pop(
    state: State<'_, AppState>,
    repo: PathBuf,
    stash: String,
    op_id: String,
) -> Result<Outcome, AppError> {
    validate_stash(&stash)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.stash_pop(&stash, &cancel)
    })
    .await
}

/// Drops the stash whose commit is `stash` after the confirmation (a dropped stash is in no
/// reflog: the frontend keeps its commit hash in the toast, which `git stash apply <hash>`
/// brings back until `git gc` runs); `stash.not_found` when it is no longer in the list.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn stash_drop(
    state: State<'_, AppState>,
    repo: PathBuf,
    stash: String,
    op_id: String,
) -> Result<(), AppError> {
    validate_stash(&stash)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.stash_drop(&stash, &cancel)
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
    }

    #[test]
    fn a_stash_is_named_by_its_full_commit_hash() {
        assert!(validate_stash(&"a".repeat(40)).is_ok());
        assert!(validate_stash(&"0123456789abcdef".repeat(4)).is_ok());
        for bad in [
            "stash@{1}".to_owned(),
            "abc1234".to_owned(),
            "A".repeat(40),
            "g".repeat(40),
            format!("-{}", "a".repeat(39)),
            "a".repeat(41),
            String::new(),
        ] {
            assert_eq!(
                validate_stash(&bad).expect_err("refused").code,
                "ipc.invalid_argument",
                "{bad}"
            );
        }
    }
}
