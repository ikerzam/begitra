//! Scanning the configured folders as a stream: entries are reported as soon as the scanner
//! finds them and again once their summary is known, while counts and folder states flow in
//! between.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use git_core::engine::Cancel as GitCancel;
use git_core::summary::describe;
use repo_index::{scanner, Cancel as ScanCancel, IndexEntry, ScanEvent, ScanOptions};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::channels::{Sink, Stream, StreamMessage};
use crate::commands::index::{index_summary, normalise, now};
use crate::error::AppError;
use crate::ops::run_stream;
use crate::state::AppState;

/// Summaries computed at once; each one opens the repository on its own thread.
const SUMMARY_WORKERS: usize = 4;

/// How often the drain of in-flight summaries looks at the cancel flag.
const DRAIN_POLL: Duration = Duration::from_millis(100);

/// A whole scan may run this long before it is stopped.
const SCAN_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// One streamed message of a scan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScanMessage {
    /// A scan folder started.
    FolderStarted {
        /// The folder.
        folder: PathBuf,
    },
    /// Running counts.
    Progress {
        /// The folder being walked.
        folder: PathBuf,
        /// Directories read so far.
        scanned: u64,
        /// Repositories and worktrees found so far.
        found: u64,
    },
    /// A repository or worktree, recorded in the index without a summary yet.
    Found {
        /// The entry as stored.
        entry: IndexEntry,
    },
    /// The summary of an entry reported earlier landed.
    Updated {
        /// The entry as stored.
        entry: IndexEntry,
    },
    /// A scan folder finished.
    FolderDone {
        /// The folder.
        folder: PathBuf,
        /// Repositories and worktrees found under it.
        found: u64,
        /// Entries of earlier scans of this folder that were not found again.
        missing: Vec<PathBuf>,
    },
    /// A scan folder could not be read; the scan went on with the others.
    FolderError {
        /// The folder.
        folder: PathBuf,
        /// The operating system's reason.
        reason: String,
    },
}

/// Scans `folders` and streams the results; cancellable through `op_id`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, on_page))]
pub async fn scan_folders(
    state: State<'_, AppState>,
    folders: Vec<PathBuf>,
    options: ScanOptions,
    op_id: String,
    on_page: Channel<StreamMessage<ScanMessage>>,
) -> Result<(), AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_stream(
        app.ops(),
        &op_id,
        SCAN_TIMEOUT,
        on_page,
        move |cancel, stream| run_scan(&worker, &folders, &options, &cancel, stream),
    )
    .await
}

/// The scan proper: the scanner on this thread, summaries on [`SUMMARY_WORKERS`] threads,
/// every result stored in the index and streamed as it lands.
pub fn run_scan<S: Sink<ScanMessage>>(
    state: &AppState,
    folders: &[PathBuf],
    options: &ScanOptions,
    cancel: &GitCancel,
    stream: &mut Stream<ScanMessage, S>,
) -> Result<(), AppError> {
    let scan_cancel = ScanCancel::new();
    let (work_tx, work_rx) = mpsc::channel::<PathBuf>();
    let work_rx = Arc::new(Mutex::new(work_rx));
    let (result_tx, result_rx) = mpsc::channel::<(
        PathBuf,
        Result<git_core::summary::RepoSummary, git_core::error::GitError>,
    )>();
    let mut workers = Vec::with_capacity(SUMMARY_WORKERS);
    for n in 0..SUMMARY_WORKERS {
        let work_rx = Arc::clone(&work_rx);
        let result_tx = result_tx.clone();
        let cancel = cancel.clone();
        let worker = thread::Builder::new()
            .name(format!("begira-summary-{n}"))
            .spawn(move || loop {
                let next = work_rx.lock().ok().and_then(|rx| rx.recv().ok());
                let Some(path) = next else { break };
                if cancel.is_cancelled() {
                    break;
                }
                // libgit2 has no cancel hook inside a status: the flag is honoured between
                // repositories, and a huge working tree costs its status once.
                let result = describe(&path, &cancel);
                if result_tx.send((path, result)).is_err() {
                    break;
                }
            })
            .map_err(|error| AppError::internal(format!("summary thread: {error}")))?;
        workers.push(worker);
    }
    drop(result_tx);

    let stamp = now();
    let mut seen_by_root: std::collections::HashMap<PathBuf, Vec<PathBuf>> =
        std::collections::HashMap::new();
    let mut failure: Option<AppError> = None;
    let mut stopped = false;
    {
        let mut on_event = |event: ScanEvent| -> std::ops::ControlFlow<()> {
            if cancel.is_cancelled() {
                scan_cancel.cancel();
                return std::ops::ControlFlow::Break(());
            }
            // Summaries that landed meanwhile go out in order with the scan events.
            while let Ok((path, result)) = result_rx.try_recv() {
                if let Err(error) = deliver_summary(state, stream, &path, result) {
                    failure = Some(error);
                    return std::ops::ControlFlow::Break(());
                }
            }
            let delivered = match event {
                ScanEvent::FolderStarted { folder } => {
                    stream.page(ScanMessage::FolderStarted { folder })
                }
                ScanEvent::Progress {
                    folder,
                    scanned,
                    found,
                } => stream.page(ScanMessage::Progress {
                    folder,
                    scanned,
                    found,
                }),
                ScanEvent::Found(mut found) => {
                    found.path = normalise(&found.path);
                    found.scan_root = normalise(&found.scan_root);
                    found.parent_path = found.parent_path.as_deref().map(normalise);
                    seen_by_root
                        .entry(found.scan_root.clone())
                        .or_default()
                        .push(found.path.clone());
                    let stored = state.with_index(|index| {
                        index.upsert_found(&found, stamp)?;
                        index
                            .get(&found.path)?
                            .ok_or_else(|| AppError::internal("the found entry vanished"))
                    });
                    match stored {
                        Ok(entry) => {
                            let _ = work_tx.send(found.path.clone());
                            stream.page(ScanMessage::Found { entry })
                        }
                        Err(error) => {
                            failure = Some(error);
                            return std::ops::ControlFlow::Break(());
                        }
                    }
                }
                ScanEvent::FolderDone { folder, found } => {
                    let folder = normalise(&folder);
                    let seen = seen_by_root.remove(&folder).unwrap_or_default();
                    let missing = match mark_missing(state, &folder, &seen, stamp) {
                        Ok(missing) => missing,
                        Err(error) => {
                            failure = Some(error);
                            return std::ops::ControlFlow::Break(());
                        }
                    };
                    stream.page(ScanMessage::FolderDone {
                        folder,
                        found,
                        missing,
                    })
                }
                ScanEvent::FolderError { folder, reason } => {
                    stream.page(ScanMessage::FolderError { folder, reason })
                }
            };
            if delivered {
                std::ops::ControlFlow::Continue(())
            } else {
                stopped = true;
                std::ops::ControlFlow::Break(())
            }
        };
        scanner::scan(folders, options, &scan_cancel, &mut on_event);
    }
    drop(work_tx);
    if let Some(error) = failure {
        return Err(error);
    }
    if stopped {
        return Ok(());
    }
    // The scanner is done: drain the summaries still in flight, looking at the cancel flag
    // while waiting. A cancelled drain leaves the workers to finish their current status on
    // their own (they exit once the receiver is gone).
    loop {
        if cancel.is_cancelled() {
            return Err(AppError::cancelled());
        }
        match result_rx.recv_timeout(DRAIN_POLL) {
            Ok((path, result)) => deliver_summary(state, stream, &path, result)?,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

/// Flags the entries of `folder` the scan did not report again, unless their `.git` is still
/// on disk (an unreadable subfolder, a lowered depth or a new skip name hid them, the
/// repository itself is fine).
fn mark_missing(
    state: &AppState,
    folder: &std::path::Path,
    seen: &[PathBuf],
    stamp: i64,
) -> Result<Vec<PathBuf>, AppError> {
    let candidates =
        state.with_index(|index| Ok(index.mark_missing_under_root(folder, seen, stamp)?))?;
    let mut missing = Vec::new();
    for path in candidates {
        if std::fs::symlink_metadata(path.join(".git")).is_ok() {
            state.with_index(|index| Ok(index.mark_missing(&path, false)?))?;
        } else {
            missing.push(path);
        }
    }
    Ok(missing)
}

/// Stores a landed summary and streams the updated entry; a repository that vanished or
/// cannot be read is flagged missing and reported as updated too.
fn deliver_summary<S: Sink<ScanMessage>>(
    state: &AppState,
    stream: &mut Stream<ScanMessage, S>,
    path: &std::path::Path,
    result: Result<git_core::summary::RepoSummary, git_core::error::GitError>,
) -> Result<(), AppError> {
    let entry = state.with_index(|index| {
        match &result {
            Ok(summary) => index.update_summary(path, &index_summary(summary), now())?,
            Err(error) => {
                tracing::debug!(path = %path.display(), error = %error, "summary failed");
                index.mark_missing(path, error.code() == crate::error::codes::REPO_NOT_FOUND)?;
            }
        }
        Ok(index.get(path)?)
    })?;
    if let Some(entry) = entry {
        stream.page(ScanMessage::Updated { entry });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::testing::Collector;
    use crate::ops::Operations;

    fn init_repo(path: &std::path::Path) {
        std::fs::create_dir_all(path).expect("mkdir");
        let git = |args: &[&str]| {
            let output = git_core::cli::command(path, args)
                .output()
                .expect("git runs");
            assert!(output.status.success(), "git {args:?} failed");
        };
        git(&["init", "-q", "-b", "master"]);
        git(&["config", "user.email", "t@x"]);
        git(&["config", "user.name", "t"]);
        git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    }

    #[tokio::test]
    async fn streams_found_entries_then_their_summaries_and_stores_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("code");
        init_repo(&root.join("alpha"));
        init_repo(&root.join("beta"));
        std::fs::write(root.join("beta").join("dirty.txt"), b"x").expect("write");
        let state = AppState::default();
        let ops = Operations::default();
        let collector = Collector::<ScanMessage>::default();
        let worker = state.clone();
        let folders = vec![root.clone()];
        let options = ScanOptions::default();
        run_stream(
            &ops,
            "scan",
            SCAN_TIMEOUT,
            collector.clone(),
            move |cancel, stream| run_scan(&worker, &folders, &options, &cancel, stream),
        )
        .await
        .expect("scan ok");
        let messages = collector.messages();
        let found: Vec<String> = messages
            .iter()
            .filter_map(|m| match m {
                StreamMessage::Page {
                    data: ScanMessage::Found { entry },
                    ..
                } => Some(entry.name.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(found, ["alpha", "beta"]);
        let updated: Vec<(String, Option<bool>)> = messages
            .iter()
            .filter_map(|m| match m {
                StreamMessage::Page {
                    data: ScanMessage::Updated { entry },
                    ..
                } => Some((entry.name.clone(), entry.summary.dirty)),
                _ => None,
            })
            .collect();
        assert_eq!(updated.len(), 2);
        assert!(updated.contains(&("alpha".to_owned(), Some(false))));
        assert!(updated.contains(&("beta".to_owned(), Some(true))));
        assert!(matches!(messages.last(), Some(StreamMessage::Done)));
        let stored = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[1].summary.current_branch.as_deref(), Some("master"));
        assert!(messages.iter().any(|m| matches!(
            m,
            StreamMessage::Page {
                data: ScanMessage::FolderDone { found: 2, .. },
                ..
            }
        )));
    }

    #[tokio::test]
    async fn a_missing_folder_is_reported_and_a_cancel_ends_with_cancelled() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("gone");
        let state = AppState::default();
        let ops = Operations::default();
        let collector = Collector::<ScanMessage>::default();
        let worker = state.clone();
        let folders = vec![missing.clone()];
        let options = ScanOptions::default();
        run_stream(
            &ops,
            "scan",
            SCAN_TIMEOUT,
            collector.clone(),
            move |cancel, stream| run_scan(&worker, &folders, &options, &cancel, stream),
        )
        .await
        .expect("a missing folder is not an error");
        assert!(collector.messages().iter().any(|m| matches!(
            m,
            StreamMessage::Page {
                data: ScanMessage::FolderError { folder, .. },
                ..
            } if *folder == missing
        )));

        let root = dir.path().join("code");
        for i in 0..30 {
            init_repo(&root.join(format!("r{i}")));
        }
        let collector = Collector::<ScanMessage>::default();
        let cancel = GitCancel::new();
        let sink = CancellingSink {
            inner: collector.clone(),
            cancel: cancel.clone(),
        };
        let mut stream = Stream::new(sink);
        let error = run_scan(
            &state,
            &[root],
            &ScanOptions::default(),
            &cancel,
            &mut stream,
        )
        .expect_err("cancelled after the first entry");
        assert_eq!(error.code, "op.cancelled");
        stream.error(error);
        let found = collector
            .messages()
            .iter()
            .filter(|m| {
                matches!(
                    m,
                    StreamMessage::Page {
                        data: ScanMessage::Found { .. },
                        ..
                    }
                )
            })
            .count();
        assert_eq!(found, 1);
    }

    /// A sink that cancels the operation once the first entry is found.
    struct CancellingSink<S> {
        inner: S,
        cancel: GitCancel,
    }

    impl<S: Sink<ScanMessage>> Sink<ScanMessage> for CancellingSink<S> {
        fn send(&self, message: StreamMessage<ScanMessage>) -> Result<(), String> {
            if matches!(
                message,
                StreamMessage::Page {
                    data: ScanMessage::Found { .. },
                    ..
                }
            ) {
                self.cancel.cancel();
            }
            self.inner.send(message)
        }
    }
}
