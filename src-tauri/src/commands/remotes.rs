//! Remotes and the network: list, add and remove, and fetch, pull and push
//! streamed. The network commands are the writes of the app that can be cancelled: git's
//! progress lines reach the frontend as pages of the stream envelope while git
//! runs, the result (the ref lines git printed, or the outcome of a pull) is the last page,
//! and a cancel kills git's process tree, which ends the transport too (a pull honours it
//! until its fetch is done; the merge or rebase that follows runs whole). git's own
//! credential prompt fails at once (`GIT_TERMINAL_PROMPT=0`, set by the engine); a helper
//! with a window of its own still opens it, and the timeout bounds that.

use std::path::PathBuf;
use std::time::Duration;

use git_core::engine::GitEngine;
use git_core::types::{NetworkResult, Outcome, Prompts, PullRequest, PushRequest, Remote};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::channels::StreamMessage;
use crate::error::AppError;
use crate::ops::{run_blocking, run_stream, run_unregistered, DEFAULT_TIMEOUT};
use crate::state::AppState;

use super::branches::validate_name;

/// Longest remote URL accepted.
const MAX_URL_CHARS: usize = 2_048;

/// A clone-sized fetch or push over a slow link: ten minutes, as the other long writes.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);

/// One message of a streamed network command: git's progress lines as they arrive, then
/// what the command reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum NetworkEvent {
    /// A line of git's progress (`Receiving objects:  45% (90/200)`), `\r` updates included.
    Progress {
        /// The line as git printed it, trimmed.
        line: String,
    },
    /// A fetch or a push ended: the ref lines git printed.
    Result {
        /// git's summary lines.
        summary: Vec<String>,
    },
    /// A pull ended: how the merge or the rebase went.
    Outcome {
        /// The outcome, conflicts included.
        outcome: Outcome,
    },
}

/// A remote URL or path: non-empty, bounded, never option-shaped, no control characters.
/// git validates the rest (a scheme it knows, a path that exists) and says so.
fn validate_url(field: &str, value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::invalid_argument(field, "empty"));
    }
    if value.chars().count() > MAX_URL_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("longer than {MAX_URL_CHARS} characters"),
        ));
    }
    if value.starts_with('-') {
        return Err(AppError::invalid_argument(field, "starts with a dash"));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::invalid_argument(field, "a control character"));
    }
    Ok(())
}

fn validate_optional_name(field: &str, value: Option<&str>) -> Result<(), AppError> {
    match value {
        Some(name) => validate_name(field, name),
        None => Ok(()),
    }
}

/// The remotes with their URLs.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn remotes(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<Vec<Remote>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.remotes(&cancel)
    })
    .await
}

/// Adds a remote.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, url))]
pub async fn remote_add(
    state: State<'_, AppState>,
    repo: PathBuf,
    name: String,
    url: String,
    op_id: String,
) -> Result<(), AppError> {
    validate_name("name", &name)?;
    validate_url("url", &url)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.remote_add(&name, &url, &cancel)
    })
    .await
}

/// Removes a remote and its tracking branches.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn remote_remove(
    state: State<'_, AppState>,
    repo: PathBuf,
    name: String,
    op_id: String,
) -> Result<(), AppError> {
    validate_name("name", &name)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.remote_remove(&name, &cancel)
    })
    .await
}

/// Fetches from a remote (every remote, `--all`, when `null`), streaming git's progress;
/// `prune` drops the tracking branches gone on the remote.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, on_page))]
pub async fn fetch(
    state: State<'_, AppState>,
    repo: PathBuf,
    remote: Option<String>,
    prune: bool,
    op_id: String,
    on_page: Channel<StreamMessage<NetworkEvent>>,
) -> Result<(), AppError> {
    validate_optional_name("remote", remote.as_deref())?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_stream(
        app.ops(),
        &op_id,
        NETWORK_TIMEOUT,
        on_page,
        move |cancel, stream| {
            let engine = worker.open(&repo)?;
            let mut on_line = |line: &str| {
                stream.page(NetworkEvent::Progress {
                    line: line.to_owned(),
                });
            };
            let result: NetworkResult = engine.fetch(
                remote.as_deref(),
                prune,
                Prompts::Allowed,
                &mut on_line,
                &cancel,
            )?;
            stream.page(NetworkEvent::Result {
                summary: result.summary,
            });
            Ok::<(), AppError>(())
        },
    )
    .await
}

/// Pulls with the fetch's progress streamed; the last page is the outcome of the merge or
/// the rebase (a stop on conflicts included). A cancel is honoured until the fetch is done.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, on_page), fields(rebase = request.rebase))]
pub async fn pull(
    state: State<'_, AppState>,
    repo: PathBuf,
    request: PullRequest,
    op_id: String,
    on_page: Channel<StreamMessage<NetworkEvent>>,
) -> Result<(), AppError> {
    validate_optional_name("remote", request.remote.as_deref())?;
    validate_optional_name("branch", request.branch.as_deref())?;
    if request.branch.is_some() && request.remote.is_none() {
        return Err(AppError::invalid_argument(
            "remote",
            "a branch without a remote",
        ));
    }
    let app = state.inner().clone();
    let worker = app.clone();
    run_stream(
        app.ops(),
        &op_id,
        NETWORK_TIMEOUT,
        on_page,
        move |cancel, stream| {
            let engine = worker.open(&repo)?;
            let mut on_line = |line: &str| {
                stream.page(NetworkEvent::Progress {
                    line: line.to_owned(),
                });
            };
            let outcome = engine.pull(&request, Prompts::Allowed, &mut on_line, &cancel)?;
            stream.page(NetworkEvent::Outcome { outcome });
            Ok::<(), AppError>(())
        },
    )
    .await
}

/// Pushes with the progress streamed; a rejected push is git's message in the terminal
/// error.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, on_page), fields(set_upstream = request.set_upstream, force = request.force_with_lease))]
pub async fn push(
    state: State<'_, AppState>,
    repo: PathBuf,
    request: PushRequest,
    op_id: String,
    on_page: Channel<StreamMessage<NetworkEvent>>,
) -> Result<(), AppError> {
    validate_optional_name("remote", request.remote.as_deref())?;
    validate_optional_name("branch", request.branch.as_deref())?;
    if request.branch.is_some() && request.remote.is_none() {
        return Err(AppError::invalid_argument(
            "remote",
            "a branch without a remote",
        ));
    }
    let app = state.inner().clone();
    let worker = app.clone();
    run_stream(
        app.ops(),
        &op_id,
        NETWORK_TIMEOUT,
        on_page,
        move |cancel, stream| {
            let engine = worker.open(&repo)?;
            let mut on_line = |line: &str| {
                stream.page(NetworkEvent::Progress {
                    line: line.to_owned(),
                });
            };
            let result = engine.push(&request, Prompts::Allowed, &mut on_line, &cancel)?;
            stream.page(NetworkEvent::Result {
                summary: result.summary,
            });
            Ok::<(), AppError>(())
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(result: Result<(), AppError>) -> String {
        result.expect_err("refused").code
    }

    #[test]
    fn urls_are_bounded_and_never_options() {
        for good in [
            "https://github.com/ikerzam/begitra",
            "git@github.com:ikerzam/begitra.git",
            "C:\\repos\\bare.git",
            "../bare.git",
        ] {
            assert!(validate_url("url", good).is_ok(), "{good}");
        }
        for bad in ["", "--upload-pack=x", "a\nb"] {
            assert_eq!(
                code(validate_url("url", bad)),
                "ipc.invalid_argument",
                "{bad:?}"
            );
        }
        let long = "x".repeat(MAX_URL_CHARS + 1);
        assert_eq!(code(validate_url("url", &long)), "ipc.invalid_argument");
    }

    #[test]
    fn events_serialise_with_a_kind_tag() {
        let progress = serde_json::to_value(NetworkEvent::Progress {
            line: "Receiving objects: 45%".to_owned(),
        })
        .expect("json");
        assert_eq!(progress["kind"], "progress");
        assert_eq!(progress["line"], "Receiving objects: 45%");
        let result = serde_json::to_value(NetworkEvent::Result {
            summary: vec!["   a1b2c3d..e4f5a6b  main -> main".to_owned()],
        })
        .expect("json");
        assert_eq!(result["kind"], "result");
        assert_eq!(result["summary"][0], "   a1b2c3d..e4f5a6b  main -> main");
    }
}
