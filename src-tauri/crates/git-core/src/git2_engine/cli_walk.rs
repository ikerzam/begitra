//! Path history as a paged walk over `git rev-list <scope> --date-order -- <paths>`.
//!
//! libgit2 has no history simplification for paths, and a tree diff per commit over a large
//! history is far slower than git's own walker, so the hashes come from the git CLI (argv,
//! never a shell) as a child process the handle owns: lines are read one page at a time, the
//! process is killed on drop and on cancel, and each hash is hydrated with libgit2 from the
//! engine's own second handle. The layout is flat (lane 0, no edges) like every filtered walk,
//! and the metadata filters apply after hydration so every filter composes.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, ChildStdout, Stdio};

use git2::{Oid, Repository};

use super::walk::{decorations_for, MAX_PAGE_SIZE};
use super::Git2Engine;
use crate::cli;
use crate::engine::{Cancel, CommitWalk, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{CommitNode, Page, WalkFilter, WalkOptions, WalkScope};

/// Lines read between two cancellation checks.
const CANCEL_EVERY: usize = 100;

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
    let mut args: Vec<String> = vec!["rev-list".to_owned(), "--date-order".to_owned()];
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
    Ok(Box::new(CliWalk {
        repo,
        child: Some(child),
        lines: BufReader::new(stdout),
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
    lines: BufReader<ChildStdout>,
    command: String,
    page_size: usize,
    filter: WalkFilter,
    decorations: HashMap<Oid, Vec<String>>,
    finished: bool,
    pending_error: Option<GitError>,
}

impl CliWalk {
    /// Kills the child if it still runs.
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Reads the exit status after the last line; a failure becomes [`GitError::Cli`] with
    /// git's stderr.
    fn finish(&mut self) -> GitResult<()> {
        self.finished = true;
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

    fn hydrate(&self, oid: Oid) -> GitResult<CommitNode> {
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|error| GitError::object(&oid.to_string(), error))?;
        Ok(super::walk::node_of(&commit, &self.decorations))
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
        let mut line = String::new();
        let mut read: usize = 0;
        while commits.len() < self.page_size {
            if read.is_multiple_of(CANCEL_EVERY) && cancel.is_cancelled() {
                self.stop();
                self.finished = true;
                return Err(GitError::Cancelled);
            }
            read += 1;
            line.clear();
            let bytes = self
                .lines
                .read_line(&mut line)
                .map_err(|error| GitError::Cli {
                    command: self.command.clone(),
                    status: None,
                    stderr: error.to_string(),
                })?;
            if bytes == 0 {
                // EOF: the process is done; its status says whether git was happy.
                if let Err(error) = self.finish() {
                    if commits.is_empty() {
                        return Err(error);
                    }
                    self.pending_error = Some(error);
                }
                break;
            }
            let text = line.trim();
            if text.is_empty() {
                continue;
            }
            let oid = Oid::from_str(text).map_err(|error| GitError::Cli {
                command: self.command.clone(),
                status: None,
                stderr: format!("unexpected rev-list output {text:?}: {error}"),
            })?;
            let node = match self.hydrate(oid) {
                Ok(node) => node,
                Err(error) => {
                    // The page so far is returned; the error waits for the next call.
                    self.stop();
                    self.finished = true;
                    if commits.is_empty() {
                        return Err(error);
                    }
                    self.pending_error = Some(error);
                    break;
                }
            };
            if self.filter.matches(&node) {
                commits.push(node);
            }
        }
        Ok(Page {
            commits,
            done: self.finished,
        })
    }
}
