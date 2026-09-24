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
//!
//! Two waits cannot be interrupted, because libgit2 exposes no progress callback for them:
//! the preparation (the delta list and the rename detection of the whole change set) and
//! the patch of one file, which for a huge single file is the bulk of a page. A working file
//! the patch does not read is hashed for its id only up to 64 MiB (a tenth of a second).
//! A cancelled or timed-out operation returns when the current one of these ends; the worker
//! is not in the pool meanwhile, so the next diff starts on a fresh one rather than queueing
//! behind it.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use super::{diff, reopen_gitdir, Git2Engine};
use crate::engine::{Cancel, DiffWalk, RESTRICTED_FILES};
use crate::error::{GitError, GitResult};
use crate::types::{ChangeSet, ChangeSetPage, DiffOptions, DiffTarget, FileChange};

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
    /// The paths a working-tree diff reads, or `None` for the whole tree.
    paths: Option<Vec<Vec<u8>>>,
    /// A restriction: the files these paths cover, or `None` for the whole change set.
    only: Option<Vec<Vec<u8>>>,
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
    Ok(Box::new(open(
        engine, target, options, page_size, None, cancel,
    )?))
}

/// The diff restricted to `paths`, whole; see [`crate::engine::GitEngine::diff_paths`].
#[tracing::instrument(level = "debug", skip_all, fields(paths = paths.len()))]
pub(super) fn restricted(
    engine: &Git2Engine,
    target: &DiffTarget,
    options: &DiffOptions,
    paths: &[String],
    cancel: &Cancel,
) -> GitResult<Option<ChangeSet>> {
    let mut pages = open(engine, target, options, usize::MAX, Some(paths), cancel)?;
    // The count is known once the list is prepared, before any patch is read.
    if pages.total > RESTRICTED_FILES {
        return Ok(None);
    }
    let page = pages.next_page(cancel)?;
    Ok(Some(ChangeSet {
        files: page.files,
        additions: page.additions,
        deletions: page.deletions,
    }))
}

/// Prepares a paged diff, restricted to `only` when given (with the repositories above those
/// paths, see [`diff::with_repositories_above`]).
fn open(
    engine: &Git2Engine,
    target: &DiffTarget,
    options: &DiffOptions,
    page_size: usize,
    only: Option<&[String]>,
    cancel: &Cancel,
) -> GitResult<Pages> {
    cancel.check()?;
    let only = match only {
        Some(only) => Some(diff::with_repositories_above(engine, only)?),
        None => None,
    };
    // Revisions and the merge base resolve on the engine's warm handle; the worker only
    // diffs trees.
    let (gitdir, target): (PathBuf, DiffTarget) = engine.with_repo(|repo| {
        Ok((
            repo.path().to_path_buf(),
            diff::resolve_target(engine, repo, target)?,
        ))
    })?;
    // git's status names the working tree's changed paths on this thread, where a cancel
    // reaches the git it runs; the worker then reads only those.
    let paths = diff::working_tree_paths(engine, &target, only.as_deref(), cancel)?;
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
        paths,
        only: only.map(|only| only.into_iter().map(String::into_bytes).collect()),
        generated_attributes,
        ready: ready_tx,
        requests: worker_requests,
        replies: worker_replies,
    };
    // A pooled worker whose thread is gone (it panicked) costs one retry on a fresh one.
    let worker = match worker.send(job) {
        Ok(()) => worker,
        Err(mpsc::SendError(job)) => {
            let fresh = start_worker(&gitdir)?;
            fresh
                .send(job)
                .map_err(|_| GitError::Git("the diff thread ended early".to_owned()))?;
            fresh
        }
    };
    let total = match ready_rx.recv() {
        Ok(result) => result?,
        Err(_) => return Err(GitError::Git("the diff thread ended early".to_owned())),
    };
    Ok(Pages {
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
    })
}

/// An idle worker of the pool, or a new one on its own repository handle.
fn take_worker(pool: &WorkerPool, gitdir: &std::path::Path) -> GitResult<Sender<Job>> {
    let idle = pool
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .pop();
    match idle {
        Some(worker) => Ok(worker),
        None => start_worker(gitdir),
    }
}

/// A new worker thread on its own repository handle.
fn start_worker(gitdir: &std::path::Path) -> GitResult<Sender<Job>> {
    let (jobs, inbox) = mpsc::channel::<Job>();
    let gitdir = gitdir.to_path_buf();
    thread::Builder::new()
        .name("begitra-diff".to_owned())
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
        let prepared = match diff::prepare(
            &repo,
            &job.target,
            &job.options,
            job.generated_attributes,
            job.paths.as_deref(),
            job.only.as_deref(),
        ) {
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

#[cfg(test)]
mod tests {
    use git2::{Oid, Repository, Signature};

    use super::*;

    /// A repository whose second commit changes `a.txt` and adds `b.txt`, as (dir, from, to).
    fn two_commits() -> (tempfile::TempDir, Oid, Oid) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = Repository::init(dir.path()).expect("init");
        let signature = Signature::now("t", "t@x").expect("signature");
        let commit = |files: &[(&str, &str)], parent: Option<Oid>| -> Oid {
            for (name, text) in files {
                std::fs::write(dir.path().join(name), text).expect("write");
            }
            let mut index = repo.index().expect("index");
            index
                .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
                .expect("add");
            index.write().expect("write index");
            let tree_id = index.write_tree().expect("tree");
            let tree = repo.find_tree(tree_id).expect("find tree");
            let parents: Vec<git2::Commit<'_>> = parent
                .into_iter()
                .map(|oid| repo.find_commit(oid).expect("parent"))
                .collect();
            let refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
            repo.commit(Some("HEAD"), &signature, &signature, "c", &tree, &refs)
                .expect("commit")
        };
        let from = commit(&[("a.txt", "one\n")], None);
        let to = commit(&[("a.txt", "two\n"), ("b.txt", "new\n")], Some(from));
        (dir, from, to)
    }

    #[test]
    fn the_worker_polls_the_request_flag_between_files() {
        // The handle checks the flag before asking; this sends a request whose flag is
        // already raised straight to the worker, which is the poll the timeout relies on
        // while a page is being read.
        let (dir, from, to) = two_commits();
        let engine = Git2Engine::open(dir.path()).expect("open");
        let (gitdir, target) = engine
            .with_repo(|repo| {
                Ok((
                    repo.path().to_path_buf(),
                    diff::resolve_target(
                        &engine,
                        repo,
                        &DiffTarget::Commits {
                            from: from.to_string(),
                            to: to.to_string(),
                        },
                    )?,
                ))
            })
            .expect("resolve");
        let worker = start_worker(&gitdir).expect("worker");
        let (requests, worker_requests) = mpsc::channel::<Request>();
        let (worker_replies, replies) = mpsc::channel::<Reply>();
        let (ready_tx, ready_rx) = mpsc::channel::<GitResult<usize>>();
        worker
            .send(Job {
                target,
                options: DiffOptions::default(),
                paths: None,
                only: None,
                generated_attributes: false,
                ready: ready_tx,
                requests: worker_requests,
                replies: worker_replies,
            })
            .expect("send job");
        assert_eq!(ready_rx.recv().expect("ready").expect("prepared"), 2);
        let cancelled = Cancel::new();
        cancelled.cancel();
        requests
            .send(Request {
                start: 0,
                count: 2,
                cancel: cancelled,
            })
            .expect("send request");
        let reply = replies.recv().expect("reply");
        assert!(matches!(reply, Err(GitError::Cancelled)), "{reply:?}");
        // The worker is still serving the job: the same page reads fine afterwards.
        requests
            .send(Request {
                start: 0,
                count: 2,
                cancel: Cancel::never(),
            })
            .expect("send request");
        let (files, additions, deletions) = replies.recv().expect("reply").expect("page");
        assert_eq!(files.len(), 2);
        assert_eq!((additions, deletions), (2, 1));
    }
}
