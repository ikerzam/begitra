//! A change set read page by page: the delta list is built once, renames found
//! once, and the hunks of each page's files are read when the page is asked for, so the first
//! files of a large diff reach the caller while the rest are still to be read.
//!
//! libgit2's diff borrows its repository, so a handle cannot own both without unsafe code.
//! Instead a worker thread owns a repository handle of its own (reopened like a walk's) and
//! the diff, and serves page requests over a channel; dropping the handle closes the channel
//! and the worker moves on to its next job. The worker polls the request's cancel flag
//! between files, so a cancelled page comes back within one file's work.
//!
//! Workers are pooled per engine: a handle takes an idle worker or starts one, and gives it
//! back when dropped (up to [`IDLE_WORKERS`] kept). A fresh handle would load the index
//! again on its first attribute lookup, forty milliseconds on a repository of fifty thousand
//! files, which is more than a typical diff costs.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use super::{diff, reopen_gitdir, Git2Engine};
use crate::engine::{Cancel, DiffWalk};
use crate::error::{GitError, GitResult};
use crate::types::{ChangeSetPage, DiffOptions, DiffTarget, FileChange};

/// Idle workers kept per engine, each holding a repository handle and its loaded index.
const IDLE_WORKERS: usize = 2;

/// A page request: the files at positions `start..start + count` of the listing order.
struct Request {
    start: usize,
    count: usize,
    cancel: Cancel,
}

/// The worker's answer: the files of the page with their line counts.
type Reply = GitResult<(Vec<FileChange>, u32, u32)>;

/// One diff for a worker: what to prepare, where to report, where the requests come from.
pub(super) struct Job {
    target: DiffTarget,
    options: DiffOptions,
    generated_attributes: bool,
    ready: Sender<GitResult<usize>>,
    requests: Receiver<Request>,
    replies: Sender<Reply>,
}

/// The idle workers of an engine, as the senders their threads wait on.
pub(super) type WorkerPool = Arc<Mutex<Vec<Sender<Job>>>>;

pub(super) fn new_pool() -> WorkerPool {
    Arc::new(Mutex::new(Vec::new()))
}

/// The handle the engine returns.
struct Pages {
    requests: Option<Sender<Request>>,
    replies: Receiver<Reply>,
    worker: Option<Sender<Job>>,
    pool: WorkerPool,
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
    let pool = engine.diff_workers();
    let worker = take_worker(&pool, &gitdir)?;
    let (requests, worker_requests) = mpsc::channel::<Request>();
    let (worker_replies, replies) = mpsc::channel::<Reply>();
    // The first reply carries the file count, or the error that stopped the preparation.
    let (ready_tx, ready_rx) = mpsc::channel::<GitResult<usize>>();
    let job = Job {
        target,
        options: options.clone(),
        generated_attributes,
        ready: ready_tx,
        requests: worker_requests,
        replies: worker_replies,
    };
    if worker.send(job).is_err() {
        return Err(GitError::Git("the diff thread ended early".to_owned()));
    }
    let total = match ready_rx.recv() {
        Ok(result) => result?,
        Err(_) => return Err(GitError::Git("the diff thread ended early".to_owned())),
    };
    Ok(Box::new(Pages {
        requests: Some(requests),
        replies,
        worker: Some(worker),
        pool,
        page_size: page_size.max(1),
        total,
        next: 0,
        additions: 0,
        deletions: 0,
        finished: false,
    }))
}

/// An idle worker of the pool, or a new one on its own repository handle.
fn take_worker(pool: &WorkerPool, gitdir: &std::path::Path) -> GitResult<Sender<Job>> {
    let idle = pool
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .pop();
    if let Some(worker) = idle {
        return Ok(worker);
    }
    let (jobs, inbox) = mpsc::channel::<Job>();
    let gitdir = gitdir.to_path_buf();
    thread::Builder::new()
        .name("begira-diff".to_owned())
        .spawn(move || serve(&gitdir, &inbox))
        .map_err(|error| GitError::Git(format!("could not start the diff thread: {error}")))?;
    Ok(jobs)
}

/// The worker: one repository handle for every job it gets; each job prepares its diff,
/// reports the count, then answers page requests until the handle goes away.
fn serve(gitdir: &std::path::Path, inbox: &Receiver<Job>) {
    let repo = match reopen_gitdir(gitdir) {
        Ok(repo) => repo,
        Err(error) => {
            // The first job learns why; the pool never sees this worker again.
            if let Ok(job) = inbox.recv() {
                let _ = job.ready.send(Err(error));
            }
            return;
        }
    };
    while let Ok(job) = inbox.recv() {
        let prepared =
            match diff::prepare(&repo, &job.target, &job.options, job.generated_attributes) {
                Ok(prepared) => prepared,
                Err(error) => {
                    let _ = job.ready.send(Err(error));
                    continue;
                }
            };
        if job.ready.send(Ok(prepared.total_files())).is_err() {
            continue;
        }
        while let Ok(request) = job.requests.recv() {
            let range = request.start..request.start.saturating_add(request.count);
            let reply = diff::collect_range(&repo, &prepared, &job.options, range, &request.cancel);
            if job.replies.send(reply).is_err() {
                break;
            }
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
        let sent = self
            .requests
            .as_ref()
            .is_some_and(|requests| requests.send(request).is_ok());
        if !sent {
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

impl Drop for Pages {
    /// Ends the job (the worker drops the diff) and returns the worker to the pool.
    fn drop(&mut self) {
        self.requests = None;
        if let Some(worker) = self.worker.take() {
            let mut idle = self
                .pool
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if idle.len() < IDLE_WORKERS {
                idle.push(worker);
            }
        }
    }
}
