//! Scanning the folder projects' folders as a stream: entries are reported as soon as the
//! scanner finds them and again once their summary is known, while counts and folder states
//! flow in between. A found entry becomes one of its folder project's own members; a folder
//! whose walk completes lets go of the members it did not find and whose `.git` is gone.

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use git_core::engine::Cancel as GitCancel;
use git_core::summary::describe;
use repo_index::{scanner, Cancel as ScanCancel, IndexEntry, ScanEvent, ScanOptions, Upserted};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::channels::{Sink, Stream, StreamMessage};
use crate::commands::index::{canonical, index_summary, normalise, now};
use crate::commands::projects::validate_path;
use crate::error::AppError;
use crate::ops::run_stream;
use crate::state::AppState;

/// Summaries computed at once; each one opens the repository on its own thread.
const SUMMARY_WORKERS: usize = 4;

/// Most folders one scan walks: the index's own scale.
const MAX_FOLDERS: usize = 500;

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
        /// Repositories and worktrees found under it, stored or not (a folder whose project
        /// went while the scan ran stores none).
        found: u64,
        /// The folder's own members that were not found again and whose `.git` is gone: they
        /// left the folder project (and the index when no other project holds them), or stay
        /// flagged missing when none of the folder's members was found (an unmounted drive).
        /// Projects and entries can change either way: the frontend reads both again.
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

/// Scans `folders`, the folder projects' folders, and streams the results; cancellable
/// through `op_id`. An entry found under a folder that has no project is not stored.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, on_page))]
pub async fn scan_folders(
    state: State<'_, AppState>,
    folders: Vec<PathBuf>,
    options: ScanOptions,
    op_id: String,
    on_page: Channel<StreamMessage<ScanMessage>>,
) -> Result<(), AppError> {
    if folders.len() > MAX_FOLDERS {
        return Err(AppError::invalid_argument(
            "folders",
            format!("more than {MAX_FOLDERS} folders"),
        ));
    }
    let folders = folders
        .iter()
        .map(|folder| validate_path("folders", folder))
        .collect::<Result<Vec<_>, _>>()?;
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
            .name(format!("begitra-summary-{n}"))
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
    let mut seen_by_root: HashMap<PathBuf, HashSet<PathBuf>> = HashMap::new();
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
                        .insert(found.path.clone());
                    let stored = state.with_index(|index| {
                        match index.upsert_found(&found, stamp)? {
                            Upserted::Stored => Ok(index.get(&found.path)?),
                            // The folder's project went while the scan ran.
                            Upserted::NoFolderProject => Ok(None),
                        }
                    });
                    match stored {
                        Ok(Some(entry)) => {
                            let _ = work_tx.send(found.path.clone());
                            stream.page(ScanMessage::Found { entry })
                        }
                        Ok(None) => true,
                        Err(error) => {
                            failure = Some(error);
                            return std::ops::ControlFlow::Break(());
                        }
                    }
                }
                ScanEvent::FolderDone { folder, found } => {
                    let folder = normalise(&folder);
                    let seen = seen_by_root.remove(&folder).unwrap_or_default();
                    let missing = match complete_folder(state, &folder, &seen, stamp) {
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

/// Ends the complete walk of `folder`: of its folder project's own members the scan did not
/// find, those whose `.git` is gone leave the project (and the index when no other project
/// holds them), while those whose `.git` is still on disk stay (an unreadable subfolder, a
/// lowered depth or a new skip name hid them). The disk is read outside the index's lock.
/// Answers the members not found and gone, sorted.
fn complete_folder(
    state: &AppState,
    folder: &Path,
    seen: &HashSet<PathBuf>,
    stamp: i64,
) -> Result<Vec<PathBuf>, AppError> {
    // A folder lost during its walk (a share or a drive gone: its subfolders then read as
    // missing) is no complete walk, and its members stay.
    if std::fs::metadata(folder).is_err() {
        return Ok(Vec::new());
    }
    let members = state.with_index(|index| Ok(index.folder_members(folder)?))?;
    let (mut gone, mut present) = (Vec::new(), Vec::new());
    for path in members.into_iter().filter(|path| !seen.contains(path)) {
        match std::fs::symlink_metadata(path.join(".git")) {
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                gone.push(path);
            }
            // The same folder found under another spelling (a rename of its case on a disk
            // that ignores case, a link): the found spelling replaced it.
            Ok(_) if seen.contains(&canonical(&path)) => gone.push(path),
            // On disk, or unreadable, which is not gone.
            _ => present.push(path),
        }
    }
    let end = state
        .with_index(|index| Ok(index.complete_folder_scan(folder, &gone, &present, stamp)?))?;
    let mut missing: Vec<PathBuf> = end.left.into_iter().chain(end.held).collect();
    missing.sort();
    Ok(missing)
}

/// Stores a landed summary and streams the updated entry; a repository that vanished or
/// cannot be read is flagged missing and reported as updated too.
fn deliver_summary<S: Sink<ScanMessage>>(
    state: &AppState,
    stream: &mut Stream<ScanMessage, S>,
    path: &Path,
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

    /// The folder project of `folder`, as `project_create_folder` makes it.
    fn folder_project(state: &AppState, folder: &Path) -> repo_index::Project {
        crate::commands::projects::create_folder_project(state, folder).expect("folder project")
    }

    /// The folder a folder project's scan walks.
    fn folder_of(project: &repo_index::Project) -> PathBuf {
        project.folder.clone().expect("a folder project")
    }

    /// A link at `link` to the folder `target`: a junction on Windows (no privilege needed), a
    /// symbolic link elsewhere.
    fn link_folder(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .status()
                .expect("mklink runs");
            assert!(status.success(), "mklink /J");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).expect("symlink");
    }

    /// Scans `folders` to the end and answers the stream's messages.
    async fn scan(state: &AppState, folders: Vec<PathBuf>) -> Vec<StreamMessage<ScanMessage>> {
        let ops = Operations::default();
        let collector = Collector::<ScanMessage>::default();
        let worker = state.clone();
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
        collector.messages()
    }

    /// The paths of a folder project's members.
    fn members(state: &AppState, id: i64) -> Vec<PathBuf> {
        let projects = state
            .with_index(|index| Ok(index.projects()?))
            .expect("projects");
        projects
            .into_iter()
            .find(|project| project.id == id)
            .expect("the project")
            .members
            .into_iter()
            .map(|member| member.path)
            .collect()
    }

    #[tokio::test]
    async fn streams_found_entries_then_their_summaries_and_stores_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("code");
        init_repo(&root.join("alpha"));
        init_repo(&root.join("beta"));
        std::fs::write(root.join("beta").join("dirty.txt"), b"x").expect("write");
        let state = AppState::default();
        let project = folder_project(&state, &root);
        let ops = Operations::default();
        let collector = Collector::<ScanMessage>::default();
        let worker = state.clone();
        let folders = vec![folder_of(&project)];
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
        // Both are the folder project's own members.
        assert_eq!(members(&state, project.id).len(), 2);
    }

    #[tokio::test]
    async fn a_folder_without_a_project_stores_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("code");
        init_repo(&root.join("alpha"));
        let state = AppState::default();
        let messages = scan(&state, vec![root]).await;
        assert!(!messages.iter().any(|m| matches!(
            m,
            StreamMessage::Page {
                data: ScanMessage::Found { .. },
                ..
            }
        )));
        let stored = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert!(stored.is_empty());
    }

    #[tokio::test]
    async fn a_complete_scan_lets_go_of_what_left_the_disk_and_a_stopped_one_changes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("code");
        init_repo(&root.join("alpha"));
        init_repo(&root.join("beta"));
        init_repo(&root.join("gamma"));
        let state = AppState::default();
        let project = folder_project(&state, &root);
        let folder = folder_of(&project);
        scan(&state, vec![folder.clone()]).await;
        assert_eq!(members(&state, project.id).len(), 3);

        // Gamma's folder goes: a stopped scan changes no membership.
        std::fs::remove_dir_all(root.join("gamma")).expect("remove gamma");
        let collector = Collector::<ScanMessage>::default();
        let cancel = GitCancel::new();
        let sink = CancellingSink {
            inner: collector.clone(),
            cancel: cancel.clone(),
        };
        let mut stream = Stream::new(sink);
        let error = run_scan(
            &state,
            std::slice::from_ref(&folder),
            &ScanOptions::default(),
            &cancel,
            &mut stream,
        )
        .expect_err("stopped after the first entry");
        assert_eq!(error.code, "op.cancelled");
        assert_eq!(members(&state, project.id).len(), 3);

        // A complete scan lets gamma go, from the project and the index, and says so.
        let messages = scan(&state, vec![folder.clone()]).await;
        let missing: Vec<PathBuf> = messages
            .iter()
            .find_map(|m| match m {
                StreamMessage::Page {
                    data: ScanMessage::FolderDone { missing, .. },
                    ..
                } => Some(missing.clone()),
                _ => None,
            })
            .expect("the folder ended");
        assert_eq!(missing.len(), 1);
        assert!(missing[0].ends_with("gamma"), "{missing:?}");
        let left = members(&state, project.id);
        assert_eq!(left.len(), 2);
        assert!(!left.iter().any(|path| path.ends_with("gamma")));
        let stored = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert_eq!(stored.len(), 2);
    }

    #[tokio::test]
    async fn a_folder_that_went_or_a_member_the_walk_skipped_changes_no_membership() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("code");
        init_repo(&root.join("alpha"));
        init_repo(&root.join("vendor"));
        let state = AppState::default();
        let project = folder_project(&state, &root);
        let folder = folder_of(&project);
        scan(&state, vec![folder.clone()]).await;
        assert_eq!(members(&state, project.id).len(), 2);
        // A new skip name hides vendor, whose .git is still on disk: it stays.
        let skipping = ScanOptions {
            skip: vec!["vendor".to_owned()],
            ..ScanOptions::default()
        };
        let ops = Operations::default();
        let collector = Collector::<ScanMessage>::default();
        let worker = state.clone();
        let folders = vec![folder.clone()];
        run_stream(
            &ops,
            "scan",
            SCAN_TIMEOUT,
            collector.clone(),
            move |cancel, stream| run_scan(&worker, &folders, &skipping, &cancel, stream),
        )
        .await
        .expect("scan ok");
        assert_eq!(members(&state, project.id).len(), 2);
        // The folder renamed away reads as an error, not as an empty folder: nothing leaves.
        std::fs::rename(&root, dir.path().join("renamed")).expect("rename");
        let messages = scan(&state, vec![folder.clone()]).await;
        assert!(messages.iter().any(|m| matches!(
            m,
            StreamMessage::Page {
                data: ScanMessage::FolderError { .. },
                ..
            }
        )));
        assert_eq!(members(&state, project.id).len(), 2);
        let stored = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert_eq!(stored.len(), 2);
    }

    #[tokio::test]
    async fn a_repository_reached_through_a_link_is_one_entry_in_its_folder_project() {
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real");
        init_repo(&real.join("geo"));
        init_repo(&dir.path().join("elsewhere").join("tiles"));
        let link = dir.path().join("link");
        link_folder(&real, &link);
        let state = AppState::default();
        // The folder picked through the link is stored as the disk spells it.
        let project = folder_project(&state, &link);
        assert_eq!(folder_of(&project), canonical(&real));
        scan(&state, vec![folder_of(&project)]).await;
        // Opened through the link, the scanned repository opens in its folder project.
        let opened =
            crate::commands::projects::open_path(&state, &link.join("geo"), &GitCancel::never())
                .expect("open");
        assert_eq!(opened.project.id, project.id);
        assert_eq!(opened.repository, canonical(&real.join("geo")));
        // A refresh through the link finds the same entry.
        crate::commands::index::refresh_entry(
            &state,
            &link.join("geo"),
            false,
            &GitCancel::never(),
        )
        .expect("refresh");
        let stored = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert_eq!(stored.len(), 1);
        let projects = state
            .with_index(|index| Ok(index.projects()?))
            .expect("projects");
        assert_eq!(projects.len(), 1);
        // A repository no project names is described under the disk's spelling too.
        let other = dir.path().join("other");
        link_folder(&dir.path().join("elsewhere"), &other);
        let probe = crate::commands::index::refresh_entry(
            &state,
            &other.join("tiles"),
            false,
            &GitCancel::never(),
        )
        .expect("probe");
        assert_eq!(
            probe.path,
            canonical(&dir.path().join("elsewhere").join("tiles"))
        );
        let stored = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert_eq!(stored.len(), 1);
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
        let project = folder_project(&state, &root);
        let collector = Collector::<ScanMessage>::default();
        let cancel = GitCancel::new();
        let sink = CancellingSink {
            inner: collector.clone(),
            cancel: cancel.clone(),
        };
        let mut stream = Stream::new(sink);
        let error = run_scan(
            &state,
            &[folder_of(&project)],
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
