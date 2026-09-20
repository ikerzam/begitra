//! Path history as a paged walk over `git rev-list <scope> -- <paths>`.
//!
//! libgit2 has no history simplification for paths, and a tree diff per commit over a large
//! history is far slower than git's own walker, so the hashes come from the git CLI (argv,
//! never a shell) as a child process the handle owns. git's default order is the lazy order
//! of the engine and streams as it walks; `--date-order` is passed only for
//! [`WalkOrder::DateTopo`], since git sorts the whole list before the first line then. A
//! reader thread feeds the lines through a bounded channel, so a page can be returned early:
//! history simplification costs a tree diff per commit and a rarely changed path yields its
//! 500th line seconds after the first, while the graph should show the first rows at once. A
//! page therefore closes when it is full, or after [`PAGE_BUDGET`] once it holds a row;
//! cancellation is polled while waiting rather than between blocking reads. The process is
//! killed on drop and on cancel, and each hash is hydrated with libgit2 from the engine's own
//! second handle. The layout is flat (lane 0, no edges) like every filtered walk, and the
//! metadata filters apply after hydration so every filter composes.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read};
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use git2::{Oid, Repository};

use super::walk::{decorations_for, MAX_PAGE_SIZE};
use super::Git2Engine;
use crate::cli;
use crate::engine::{Cancel, CommitWalk, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{CommitNode, Page, WalkFilter, WalkOptions, WalkOrder, WalkScope};

/// Longest a page waits for more lines once it holds a row; a partial page is sent then.
const PAGE_BUDGET: Duration = Duration::from_millis(200);
/// How often cancellation is checked while waiting for a line.
const CANCEL_POLL: Duration = Duration::from_millis(50);
/// Lines the reader thread may run ahead of the pages; git is paused beyond it.
const LINE_BUFFER: usize = 4_096;

/// Starts a path-history walk; see the module docs.
#[tracing::instrument(level = "debug", skip_all, fields(paths = ?options.filter.as_ref().map(|f| &f.paths)))]
pub(super) fn start(
    engine: &Git2Engine,
    scope: &WalkScope,
    options: &WalkOptions,
    cancel: &Cancel,
) -> GitResult<Box<dyn CommitWalk>> {
    let filter = options.filter.clone().unwrap_or_default();
    let repo = engine.with_repo(super::reopen)?;
    let decorations = decorations_for(&repo, cancel)?;
    let mut args: Vec<String> = vec!["rev-list".to_owned()];
    if options.order == WalkOrder::DateTopo {
        args.push("--date-order".to_owned());
    }
    match scope {
        WalkScope::All => args.push("--all".to_owned()),
        WalkScope::Ref { name } => {
            // Resolved first so an unknown ref is `refs.not_found` rather than git's stderr.
            super::resolve_commit(&repo, name)?;
            args.push(name.clone());
        }
        WalkScope::Range { exclude, include } => {
            super::resolve_commit(&repo, include)?;
            super::resolve_commit(&repo, exclude)?;
            args.push(format!("{exclude}..{include}"));
        }
    }
    args.push("--".to_owned());
    args.extend(filter.paths.iter().cloned());
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let command_text = args.join(" ");
    let mut child = cli::command(&engine.repo().root, &argv)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| GitError::Cli {
            command: command_text.clone(),
            status: None,
            stderr: format!("could not start git: {error}"),
        })?;
    let stdout = child.stdout.take().ok_or_else(|| GitError::Cli {
        command: command_text.clone(),
        status: None,
        stderr: "git gave no output pipe".to_owned(),
    })?;
    let (sender, lines) = mpsc::sync_channel::<io::Result<String>>(LINE_BUFFER);
    let reader = std::thread::Builder::new()
        .name("begira-rev-list".to_owned())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if sender.send(line).is_err() {
                    // The walk was dropped: the child is being killed, stop reading.
                    break;
                }
            }
        })
        .map_err(|error| GitError::Cli {
            command: command_text.clone(),
            status: None,
            stderr: format!("could not start the reader thread: {error}"),
        })?;
    Ok(Box::new(CliWalk {
        repo,
        child: Some(child),
        lines,
        reader: Some(reader),
        command: command_text,
        page_size: usize::try_from(options.page_size)
            .unwrap_or(MAX_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE),
        filter,
        decorations,
        finished: false,
        pending_error: None,
    }))
}

struct CliWalk {
    repo: Repository,
    child: Option<Child>,
    lines: Receiver<io::Result<String>>,
    reader: Option<JoinHandle<()>>,
    command: String,
    page_size: usize,
    filter: WalkFilter,
    decorations: HashMap<Oid, Vec<String>>,
    finished: bool,
    pending_error: Option<GitError>,
}

impl CliWalk {
    /// Kills the child if it still runs and joins the reader, which ends at the closed pipe.
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        self.finished = true;
    }

    /// Reads the exit status after the last line; a failure becomes [`GitError::Cli`] with
    /// git's stderr.
    fn finish(&mut self) -> GitResult<()> {
        self.finished = true;
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        let status = child.wait().map_err(|error| GitError::Cli {
            command: self.command.clone(),
            status: None,
            stderr: error.to_string(),
        })?;
        if status.success() {
            Ok(())
        } else {
            Err(GitError::Cli {
                command: self.command.clone(),
                status: status.code(),
                stderr,
            })
        }
    }

    fn cli_error(&self, stderr: String) -> GitError {
        GitError::Cli {
            command: self.command.clone(),
            status: None,
            stderr,
        }
    }

    fn hydrate(&self, oid: Oid) -> GitResult<CommitNode> {
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|error| GitError::object(&oid.to_string(), error))?;
        Ok(super::walk::node_of(&commit, &self.decorations))
    }

    /// Keeps the error for the next call when the page already holds rows.
    fn park(&mut self, commits: Vec<CommitNode>, error: GitError) -> GitResult<Page> {
        self.stop();
        if commits.is_empty() {
            return Err(error);
        }
        self.pending_error = Some(error);
        Ok(Page {
            commits,
            done: true,
        })
    }
}

impl Drop for CliWalk {
    fn drop(&mut self) {
        self.stop();
    }
}

impl CommitWalk for CliWalk {
    fn next_page(&mut self, cancel: &Cancel) -> GitResult<Page> {
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }
        if self.finished {
            return Ok(Page {
                commits: Vec::new(),
                done: true,
            });
        }
        let mut commits = Vec::with_capacity(self.page_size);
        let mut first_row_at: Option<Instant> = None;
        while commits.len() < self.page_size {
            if cancel.is_cancelled() {
                self.stop();
                return Err(GitError::Cancelled);
            }
            let line = match self.lines.recv_timeout(CANCEL_POLL) {
                Ok(Ok(line)) => line,
                Ok(Err(error)) => {
                    let error = self.cli_error(error.to_string());
                    return self.park(commits, error);
                }
                Err(RecvTimeoutError::Timeout) => {
                    // A partial page once the budget has passed with something to show.
                    if first_row_at.is_some_and(|at| at.elapsed() >= PAGE_BUDGET) {
                        break;
                    }
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => {
                    // EOF: the process is done; its status says whether git was happy.
                    if let Err(error) = self.finish() {
                        if commits.is_empty() {
                            return Err(error);
                        }
                        self.pending_error = Some(error);
                    }
                    break;
                }
            };
            let text = line.trim();
            if text.is_empty() {
                continue;
            }
            let oid = match Oid::from_str(text) {
                Ok(oid) => oid,
                Err(error) => {
                    let error =
                        self.cli_error(format!("unexpected rev-list output {text:?}: {error}"));
                    return self.park(commits, error);
                }
            };
            let node = match self.hydrate(oid) {
                Ok(node) => node,
                // The page so far is returned; the error waits for the next call.
                Err(error) => return self.park(commits, error),
            };
            if self.filter.matches(&node) {
                first_row_at.get_or_insert_with(Instant::now);
                commits.push(node);
            }
        }
        Ok(Page {
            commits,
            done: self.finished,
        })
    }
}
