//! The staging and commit writes through the git CLI. Every argument is checked
//! here before git runs: paths relative to the repository without `..` segments and never
//! option-shaped, a bounded count, a selection with at least one selected line, a message
//! with a subject. The commit is the one operation the frontend cannot cancel: a hook killed
//! half way can leave the repository for the user to repair, so only the timeout bounds it.

use std::path::PathBuf;
use std::time::Duration;

use git_core::engine::GitEngine;
use git_core::types::{CommitContext, CommitRequest, LineKind, PatchSelection, SelectionTarget};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, run_unregistered, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Most paths one call takes.
const MAX_PATHS: usize = 10_000;

/// Longest path accepted.
const MAX_PATH_CHARS: usize = 4096;

/// Longest commit message accepted.
const MAX_MESSAGE_CHARS: usize = 100_000;

/// Hooks take minutes here (the full Rust and Vitest suites on this repository), and a
/// `git add` of ten thousand files hashes them all, so the writes get ten minutes.
const WRITE_TIMEOUT: Duration = Duration::from_secs(600);

/// The result of a commit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    /// Full hash of the new HEAD.
    pub hash: String,
}

/// A selection with what it is applied to, as the frontend sends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionRequest {
    /// Stage, unstage or discard.
    pub target: SelectionTarget,
    /// The file and its hunks with the selected lines.
    #[serde(flatten)]
    pub selection: PatchSelection,
}

fn validate_paths(field: &str, paths: &[String]) -> Result<(), AppError> {
    if paths.is_empty() {
        return Err(AppError::invalid_argument(field, "empty"));
    }
    if paths.len() > MAX_PATHS {
        return Err(AppError::invalid_argument(
            field,
            format!("more than {MAX_PATHS} paths"),
        ));
    }
    for path in paths {
        validate_path(field, path)?;
    }
    Ok(())
}

/// A path as the status reports it: relative, inside the repository, never option-shaped.
fn validate_path(field: &str, path: &str) -> Result<(), AppError> {
    if path.is_empty() {
        return Err(AppError::invalid_argument(field, "an empty path"));
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("a path longer than {MAX_PATH_CHARS} characters"),
        ));
    }
    if path.starts_with('-') {
        return Err(AppError::invalid_argument(
            field,
            "a path that starts with a dash",
        ));
    }
    if PathBuf::from(path).is_absolute() || path.starts_with('/') || path.starts_with('\\') {
        return Err(AppError::invalid_argument(field, "an absolute path"));
    }
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(AppError::invalid_argument(field, "a path with `..`"));
    }
    if path.contains('\0') {
        return Err(AppError::invalid_argument(field, "a path with a NUL"));
    }
    Ok(())
}

fn validate_selection(request: &SelectionRequest) -> Result<(), AppError> {
    validate_path("path", &request.selection.path)?;
    if request.selection.hunks.is_empty() {
        return Err(AppError::invalid_argument("hunks", "empty"));
    }
    let selected = request.selection.hunks.iter().any(|hunk| {
        hunk.lines
            .iter()
            .any(|line| line.selected && line.kind != LineKind::Context)
    });
    if !selected {
        return Err(AppError::invalid_argument("hunks", "no selected line"));
    }
    Ok(())
}

fn validate_message(message: &str) -> Result<(), AppError> {
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(AppError::invalid_argument(
            "message",
            format!("longer than {MAX_MESSAGE_CHARS} characters"),
        ));
    }
    let subject = message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'));
    if subject.is_none() {
        return Err(AppError::invalid_argument("message", "no subject"));
    }
    Ok(())
}

/// Stages paths (`git add -A` on literal pathspecs).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(paths = paths.len()))]
pub async fn stage_paths(
    state: State<'_, AppState>,
    repo: PathBuf,
    paths: Vec<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_paths("paths", &paths)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, WRITE_TIMEOUT, move |cancel| {
        worker.open(&repo)?.stage_paths(&paths, &cancel)
    })
    .await
}

/// Unstages paths (`git reset -q` on literal pathspecs).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(paths = paths.len()))]
pub async fn unstage_paths(
    state: State<'_, AppState>,
    repo: PathBuf,
    paths: Vec<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_paths("paths", &paths)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, WRITE_TIMEOUT, move |cancel| {
        worker.open(&repo)?.unstage_paths(&paths, &cancel)
    })
    .await
}

/// Discards the unstaged changes of tracked paths and removes untracked ones; the
/// confirmation happened in the frontend, the consequence stated.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, tracked, untracked), fields(tracked = tracked.len(), untracked = untracked.len()))]
pub async fn discard_paths(
    state: State<'_, AppState>,
    repo: PathBuf,
    tracked: Vec<String>,
    untracked: Vec<String>,
    op_id: String,
) -> Result<(), AppError> {
    if tracked.is_empty() && untracked.is_empty() {
        return Err(AppError::invalid_argument("tracked", "empty"));
    }
    if !tracked.is_empty() {
        validate_paths("tracked", &tracked)?;
    }
    if !untracked.is_empty() {
        validate_paths("untracked", &untracked)?;
    }
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, WRITE_TIMEOUT, move |cancel| {
        worker
            .open(&repo)?
            .discard_paths(&tracked, &untracked, &cancel)
    })
    .await
}

/// Applies a selection of hunks and lines: to the index, reversed to the index, or
/// reversed to the working tree.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, request), fields(path = %request.selection.path, target = ?request.target))]
pub async fn apply_selection(
    state: State<'_, AppState>,
    repo: PathBuf,
    request: SelectionRequest,
    op_id: String,
) -> Result<(), AppError> {
    validate_selection(&request)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker
            .open(&repo)?
            .apply_selection(&request.selection, request.target, &cancel)
    })
    .await
}

/// Commits the index. Not registered for cancellation: only the timeout bounds it.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, request), fields(amend = request.amend, signoff = request.signoff))]
pub async fn commit(
    state: State<'_, AppState>,
    repo: PathBuf,
    request: CommitRequest,
    op_id: String,
) -> Result<CommitResult, AppError> {
    validate_message(&request.message)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        let hash = app.open(&repo)?.commit(&request, &cancel)?;
        Ok::<_, AppError>(CommitResult { hash })
    })
    .await
}

/// The author, the template, HEAD's message and whether HEAD is unborn.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn commit_context(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<CommitContext, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.commit_context(&cancel)
    })
    .await
}

#[cfg(test)]
mod tests {
    use git_core::types::{ChangeKind, SelectedHunk, SelectedLine};

    use super::*;

    fn code(result: Result<(), AppError>) -> String {
        result.expect_err("refused").code
    }

    #[test]
    fn paths_are_validated() {
        assert!(validate_paths("paths", &["src/lib.rs".to_owned()]).is_ok());
        assert!(validate_paths("paths", &["dir with space/ünïcödé.txt".to_owned()]).is_ok());
        assert_eq!(code(validate_paths("paths", &[])), "ipc.invalid_argument");
        for bad in [
            "../outside.txt",
            "a/../../b",
            "/etc/passwd",
            "C:\\x",
            "-flag",
            "",
            "nul\0",
        ] {
            assert_eq!(
                code(validate_paths("paths", &[bad.to_owned()])),
                "ipc.invalid_argument",
                "{bad:?}"
            );
        }
        let too_many: Vec<String> = (0..=MAX_PATHS).map(|i| format!("f{i}")).collect();
        assert_eq!(
            code(validate_paths("paths", &too_many)),
            "ipc.invalid_argument"
        );
    }

    #[test]
    fn selections_need_a_selected_line() {
        let line = |selected: bool| SelectedLine {
            kind: LineKind::Added,
            text: "x".to_owned(),
            no_newline: false,
            selected,
        };
        let request = |lines: Vec<SelectedLine>| SelectionRequest {
            target: SelectionTarget::Stage,
            selection: PatchSelection {
                path: "a.txt".to_owned(),
                status: ChangeKind::Modified,
                hunks: vec![SelectedHunk {
                    old_start: 1,
                    old_lines: 0,
                    new_start: 1,
                    new_lines: 1,
                    lines,
                }],
            },
        };
        assert!(validate_selection(&request(vec![line(true)])).is_ok());
        assert_eq!(
            code(validate_selection(&request(vec![line(false)]))),
            "ipc.invalid_argument"
        );
        let mut empty = request(vec![line(true)]);
        empty.selection.hunks.clear();
        assert_eq!(code(validate_selection(&empty)), "ipc.invalid_argument");
    }

    #[test]
    fn messages_need_a_subject() {
        assert!(validate_message("feat: x\n\nbody\n").is_ok());
        assert!(validate_message("\n\n  subject after blanks").is_ok());
        assert_eq!(code(validate_message("")), "ipc.invalid_argument");
        assert_eq!(code(validate_message("  \n\n \n")), "ipc.invalid_argument");
        assert_eq!(
            code(validate_message("# only a comment\n")),
            "ipc.invalid_argument"
        );
        assert_eq!(
            code(validate_message(&"x".repeat(MAX_MESSAGE_CHARS + 1))),
            "ipc.invalid_argument"
        );
    }

    #[test]
    fn a_selection_request_flattens_the_selection() {
        let json = serde_json::json!({
            "target": "unstage",
            "path": "a.txt",
            "status": "modified",
            "hunks": [],
        });
        let parsed: SelectionRequest = serde_json::from_value(json).expect("parses");
        assert_eq!(parsed.target, SelectionTarget::Unstage);
        assert_eq!(parsed.selection.path, "a.txt");
    }
}
