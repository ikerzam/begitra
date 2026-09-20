//! A change set read page by page: the delta list is built once, renames found
//! once, and the hunks of each page's files are read when the page is asked for, so the first
//! files of a large diff reach the caller while the rest are still to be read.
//!
//! libgit2's diff borrows its repository, so a handle cannot own both without unsafe code.
//! Instead a worker thread owns a repository handle of its own (reopened like a walk's) and
//! the diff, and serves page requests over a channel; dropping the handle closes the channel
//! and the thread ends with everything it owns. The worker polls the request's cancel flag
//! between files, so a cancelled page comes back within one file's work.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use super::{diff, reopen_gitdir, Git2Engine};
use crate::engine::{Cancel, DiffWalk};
use crate::error::{GitError, GitResult};
use crate::types::{ChangeSetPage, DiffOptions, DiffTarget, FileChange};

/// A page request: the files at positions `start..start + count` of the listing order.
struct Request {
    start: usize,
    count: usize,
    cancel: Cancel,
}

/// The worker's answer: the files of the page with their line counts.
type Reply = GitResult<(Vec<FileChange>, u32, u32)>;

/// The handle the engine returns.
struct Pages {
    requests: Sender<Request>,
    replies: Receiver<Reply>,
    page_size: usize,
    total: usize,
    next: usize,
    additions: u32,
    deletions: u32,
    finished: bool,
}

/// Starts a paged diff; see [`crate::engine::GitEngine::diff_pages`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn start(
    engine: &Git2Engine,
    target: &DiffTarget,
    options: &DiffOptions,
    page_size: usize,
    cancel: &Cancel,
) -> GitResult<Box<dyn DiffWalk>> {
    cancel.check()?;
    // Revisions and the merge base resolve on the engine's warm handle; the worker only
    // diffs trees.
    let (gitdir, target): (PathBuf, DiffTarget) = engine.with_repo(|repo| {
        Ok((
            repo.path().to_path_buf(),
            diff::resolve_target(repo, target)?,
        ))
    })?;
    let generated_attributes = engine.generated_attributes_present();
    let (requests, worker_requests) = mpsc::channel::<Request>();
    let (worker_replies, replies) = mpsc::channel::<Reply>();
    // The first reply carries the file count, or the error that stopped the preparation.
    let (ready_tx, ready_rx) = mpsc::channel::<GitResult<usize>>();
    let options = options.clone();
    let spawned = thread::Builder::new()
        .name("begira-diff".to_owned())
        .spawn(move || {
            serve(
                &gitdir,
                &target,
                &options,
                generated_attributes,
                &ready_tx,
                &worker_requests,
                &worker_replies,
            )
        });
    if let Err(error) = spawned {
        return Err(GitError::Git(format!(
            "could not start the diff thread: {error}"
        )));
    }
    let total = match ready_rx.recv() {
        Ok(result) => result?,
        Err(_) => return Err(GitError::Git("the diff thread ended early".to_owned())),
    };
    Ok(Box::new(Pages {
        requests,
        replies,
        page_size: page_size.max(1),
        total,
        next: 0,
        additions: 0,
        deletions: 0,
        finished: false,
    }))
}

/// The worker: prepares the diff, reports the count, then answers page requests until the
/// handle goes away.
fn serve(
    gitdir: &std::path::Path,
    target: &DiffTarget,
    options: &DiffOptions,
    generated_attributes: bool,
    ready: &Sender<GitResult<usize>>,
    requests: &Receiver<Request>,
    replies: &Sender<Reply>,
) {
    let repo = match reopen_gitdir(gitdir) {
        Ok(repo) => repo,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let prepared = match diff::prepare(&repo, target, options, generated_attributes) {
        Ok(prepared) => prepared,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    if ready.send(Ok(prepared.total_files())).is_err() {
        return;
    }
    while let Ok(request) = requests.recv() {
        let range = request.start..request.start.saturating_add(request.count);
        let reply = diff::collect_range(&repo, &prepared, options, range, &request.cancel);
        if replies.send(reply).is_err() {
            break;
        }
    }
}

impl DiffWalk for Pages {
    fn next_page(&mut self, cancel: &Cancel) -> GitResult<ChangeSetPage> {
        let total_files = u32::try_from(self.total).unwrap_or(u32::MAX);
        if self.finished {
            return Ok(ChangeSetPage {
                files: Vec::new(),
                additions: self.additions,
                deletions: self.deletions,
                total_files,
                done: true,
            });
        }
        cancel.check()?;
        let count = self.page_size.min(self.total.saturating_sub(self.next));
        let request = Request {
            start: self.next,
            count,
            cancel: cancel.clone(),
        };
        if self.requests.send(request).is_err() {
            self.finished = true;
            return Err(GitError::Git("the diff thread ended early".to_owned()));
        }
        let (files, additions, deletions) = match self.replies.recv() {
            Ok(Ok(reply)) => reply,
            Ok(Err(error)) => {
                self.finished = true;
                return Err(error);
            }
            Err(_) => {
                self.finished = true;
                return Err(GitError::Git("the diff thread ended early".to_owned()));
            }
        };
        self.next += count;
        self.additions = self.additions.saturating_add(additions);
        self.deletions = self.deletions.saturating_add(deletions);
        self.finished = self.next >= self.total;
        Ok(ChangeSetPage {
            files,
            additions: self.additions,
            deletions: self.deletions,
            total_files,
            done: self.finished,
        })
    }
}
