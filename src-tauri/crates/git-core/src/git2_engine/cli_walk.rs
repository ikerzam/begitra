//! Path history as a paged walk over `git rev-list --stdin -- <paths>`.
//!
//! libgit2 has no history simplification for paths, and a tree diff per commit over a large
//! history is far slower than git's own walker, so the hashes come from the git CLI (argv,
//! never a shell) as a child process the handle owns. The scope is the same as the graph's:
//! the seeds and the excluded revision come from [`super::walk::scope_of`] (refs with a
//! missing object skipped, unknown revisions as `refs.not_found`) and are fed to git as
//! object ids on stdin, so no ref name or revision reaches git as an argument and the list
//! never exceeds the command line. Paths are passed with the `:(literal)` magic, so a name
//! with `*`, `?`, `[` or a leading `:` is a path, never a pattern. git's default order is the
//! lazy order of the engine and streams as it walks; `--date-order` is passed only for
//! [`WalkOrder::DateTopo`], since git sorts the whole list before the first line then. A
//! reader thread feeds the lines through a bounded channel, so a page can be returned early:
//! history simplification costs a tree diff per commit and a rarely changed path yields its
//! 500th line seconds after the first, while the graph should show the first rows at once. A
//! page therefore closes when it is full, or after [`PAGE_BUDGET`] once it holds a row;
//! cancellation is polled while waiting rather than between blocking reads. stderr is drained
//! by its own thread (capped), so git never blocks on a full pipe. The process is killed on
//! drop and on cancel, and each hash is read with libgit2 from the engine's own second handle;
//! the metadata predicate runs on that commit before the row is built, so every filter
//! composes. The layout is flat (lane 0, no edges) like every filtered walk.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use git2::{Oid, Repository};

use super::filter::Matcher;
use super::walk::{decorations_for, scope_of, MAX_PAGE_SIZE};
use super::Git2Engine;
use crate::cli;
use crate::engine::{Cancel, CommitWalk, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{CommitNode, Page, WalkOptions, WalkOrder, WalkScope};

/// Longest a page waits for more lines once it holds a row; a partial page is sent then.
const PAGE_BUDGET: Duration = Duration::from_millis(200);
/// How often cancellation is checked while waiting for a line.
const CANCEL_POLL: Duration = Duration::from_millis(50);
/// Lines the reader thread may run ahead of the pages; git is paused beyond it (the pipe
/// fills and it blocks on its write), so a walk nobody pages costs nothing.
const LINE_BUFFER: usize = 256;
/// Most bytes of stderr kept for the error report.
const STDERR_CAP: usize = 64 * 1024;

/// Starts a path-history walk; see the module docs.
#[tracing::instrument(level = "debug", skip_all, fields(paths = ?options.filter.as_ref().map(|f| &f.paths)))]
pub(super) fn start(
    engine: &Git2Engine,
    scope: &WalkScope,
    options: &WalkOptions,
    cancel: &Cancel,
) -> GitResult<Box<dyn CommitWalk>> {
    let filter = options.filter.clone().unwrap_or_default();
    let matcher = Matcher::new(&filter);
    let repo = engine.with_repo(super::reopen)?;
    let decorations = decorations_for(&repo, cancel)?;
    let (seeds, exclude) = scope_of(&repo, scope, cancel)?;
    let mut args: Vec<String> = vec!["rev-list".to_owned(), "--stdin".to_owned()];
    if options.order == WalkOrder::DateTopo {
        args.push("--date-order".to_owned());
    }
    args.push("--".to_owned());
    args.extend(
        filter
            .paths
            .iter()
            .filter(|path| !path.is_empty())
            .map(|path| format!(":(literal){path}")),
    );
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let command_text = args.join(" ");
    let cli_error = |stderr: String| GitError::Cli {
        command: command_text.clone(),
        status: None,
        stderr,
    };
    if seeds.is_empty() {
        // Nothing to list (an unborn repository): git would list HEAD instead.
        return Ok(Box::new(CliWalk::empty(repo, command_text)));
    }
    let mut child = cli::command(&engine.repo().root, &argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| cli_error(format!("could not start git: {error}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| cli_error("git gave no input pipe".to_owned()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| cli_error("git gave no output pipe".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| cli_error("git gave no error pipe".to_owned()))?;
    // The revisions go in on their own thread: a repository with thousands of refs exceeds
    // the pipe buffer, and git reads them all before it writes anything.
    let mut revisions = String::with_capacity(seeds.len() * 41 + 42);
    for seed in &seeds {
        revisions.push_str(&seed.to_string());
        revisions.push('\n');
    }
    if let Some(exclude) = exclude {
        revisions.push('^');
        revisions.push_str(&exclude.to_string());
        revisions.push('\n');
    }
    let writer = std::thread::Builder::new()
        .name("begira-rev-list-in".to_owned())
        .spawn(move || {
            let mut stdin = stdin;
            // A closed pipe (git exited early) is reported through the exit status.
            let _ = stdin.write_all(revisions.as_bytes());
        })
        .map_err(|error| cli_error(format!("could not start the writer thread: {error}")))?;
    let drain = std::thread::Builder::new()
        .name("begira-rev-list-err".to_owned())
        .spawn(move || {
            let mut text = Vec::new();
            let _ = stderr.take(STDERR_CAP as u64).read_to_end(&mut text);
            String::from_utf8_lossy(&text).into_owned()
        })
        .map_err(|error| cli_error(format!("could not start the stderr thread: {error}")))?;
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
        .map_err(|error| cli_error(format!("could not start the reader thread: {error}")))?;
    Ok(Box::new(CliWalk {
        repo,
        child: Some(child),
        lines: Some(lines),
        reader: Some(reader),
        writer: Some(writer),
        drain: Some(drain),
        command: command_text,
        page_size: usize::try_from(options.page_size)
            .unwrap_or(MAX_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE),
        matcher,
        decorations,
        finished: false,
        pending_error: None,
    }))
}

struct CliWalk {
    repo: Repository,
    child: Option<Child>,
    /// Taken on stop, so a reader blocked on a full channel sees the receiver gone and ends.
    lines: Option<Receiver<io::Result<String>>>,
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
    drain: Option<JoinHandle<String>>,
    command: String,
    page_size: usize,
    matcher: Matcher,
    decorations: HashMap<Oid, Vec<String>>,
    finished: bool,
    pending_error: Option<GitError>,
}

impl CliWalk {
    /// A walk with nothing to list, already done.
    fn empty(repo: Repository, command: String) -> Self {
        CliWalk {
            repo,
            child: None,
            lines: None,
            reader: None,
            writer: None,
            drain: None,
            command,
            page_size: 1,
            matcher: Matcher::new(&Default::default()),
            decorations: HashMap::new(),
            finished: true,
            pending_error: None,
        }
    }

    /// Joins the helper threads; they end once the child's pipes close and, for the reader,
    /// once the receiver is gone (it may be blocked on a full channel).
    fn join_helpers(&mut self) -> String {
        drop(self.lines.take());
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        self.drain
            .take()
            .and_then(|drain| drain.join().ok())
            .unwrap_or_default()
    }

    /// Stops the child (and what it started) if it still runs. The helpers are left to end
    /// at the closed pipes rather than joined: the tree dies on `abort`'s thread, a tenth
    /// of a second later on Windows, and a cancelled page must not wait for it.
    fn stop(&mut self) {
        if let Some(child) = self.child.take() {
            cli::abort(child);
        }
        drop(self.lines.take());
        drop(self.reader.take());
        drop(self.writer.take());
        drop(self.drain.take());
        self.finished = true;
    }

    /// Reads the exit status after the last line; a failure becomes [`GitError::Cli`] with
    /// git's stderr.
    fn finish(&mut self) -> GitResult<()> {
        self.finished = true;
        let Some(mut child) = self.child.take() else {
            self.join_helpers();
            return Ok(());
        };
        let status = child.wait().map_err(|error| GitError::Cli {
            command: self.command.clone(),
            status: None,
            stderr: error.to_string(),
        })?;
        let stderr = self.join_helpers();
        if status.success() {
            Ok(())
        } else if let Some(hash) = corrupt_object(&stderr) {
            // git stops at an unreadable object the way the libgit2 walk does.
            Err(GitError::CorruptObject {
                hash,
                reason: stderr.trim().to_owned(),
            })
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

    /// Reads the commit and builds its row when the metadata filter keeps it.
    fn hydrate(&self, oid: Oid) -> GitResult<Option<CommitNode>> {
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|error| GitError::object(&oid.to_string(), error))?;
        if !self.matcher.matches(&commit) {
            return Ok(None);
        }
        Ok(Some(super::walk::node_of(&commit, &self.decorations)))
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

/// The hash git names when it dies on a missing or corrupt object (`fatal: bad object
/// <hash>`, `error: object file ... is empty`, `fatal: loose object <hash> ... is corrupt`).
fn corrupt_object(stderr: &str) -> Option<String> {
    let lower = stderr.to_ascii_lowercase();
    if !(lower.contains("corrupt") || lower.contains("bad object") || lower.contains("missing")) {
        return None;
    }
    let hash = stderr
        .split(|c: char| !c.is_ascii_hexdigit())
        .find(|token| token.len() >= 7 && token.len() <= 40)
        .unwrap_or("unknown");
    Some(hash.to_owned())
}

impl CommitWalk for CliWalk {
    #[tracing::instrument(level = "trace", skip_all)]
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
            let Some(lines) = self.lines.as_ref() else {
                break;
            };
            let line = match lines.recv_timeout(CANCEL_POLL) {
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
            match self.hydrate(oid) {
                Ok(Some(node)) => {
                    first_row_at.get_or_insert_with(Instant::now);
                    commits.push(node);
                }
                Ok(None) => {}
                // The page so far is returned; the error waits for the next call.
                Err(error) => return self.park(commits, error),
            }
        }
        Ok(Page {
            commits,
            done: self.finished,
        })
    }
}
