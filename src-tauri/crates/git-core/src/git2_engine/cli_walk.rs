//! Path and content history as a paged walk over git's own listing: `git rev-list --stdin --
//! <paths>` for a path filter, `git log --stdin --format=%H -S<text>` (or `-G`) for a content
//! search, within the paths when there are some.
//!
//! libgit2 has no history simplification for paths and no pickaxe, and a tree diff per commit
//! over a large history is far slower than git's own walker, so the hashes come from the git
//! CLI (argv, never a shell) as a child process the handle owns. The scope is the same as the
//! graph's: the seeds and the excluded revision come from [`super::walk::scope_of`] (refs with
//! a missing object skipped, unknown revisions as `refs.not_found`) and are fed to git as
//! object ids on stdin, so no ref name or revision reaches git as an argument and the list
//! never exceeds the command line. Paths are passed with the `:(literal)` magic, so a name
//! with `*`, `?`, `[` or a leading `:` is a path, never a pattern. Replace refs are left out
//! ([`NO_REPLACE`]), as libgit2's walk of the graph leaves them out. `git log` is held against
//! the configuration that would change what it lists ([`LOG_ARGS`]), and the text goes as one
//! attached argument, so a text starting with `-` stays a value; "on a changed line" escapes
//! it for git's regular expressions ([`literal_regex`]). git's default order is the lazy order
//! of the engine and streams as it walks; `--date-order` is passed only for
//! [`WalkOrder::DateTopo`], since git sorts the whole list before the first line then. A
//! reader thread feeds the lines through a bounded channel, so a page can be returned early:
//! history simplification and the pickaxe cost a tree diff per commit, and a rarely changed
//! path or a rare text yields its 500th line seconds or minutes after the first, while the
//! graph should show the first rows at once. A page therefore closes when it is full,
//! [`PAGE_BUDGET`] after its first row once git pauses, or at [`PAGE_DEADLINE`] with what it
//! holds, rows or none, and not the last: a search that finds nothing for a while, or whose
//! lines the metadata predicate drops, still answers each call well inside its timeout.
//! Cancellation is polled while waiting rather than between blocking reads. stderr is drained
//! by its own thread (capped), so git never blocks on a full pipe. git runs without prompts
//! and in English, and a partial clone fetches nothing for the walk (`GIT_NO_LAZY_FETCH`, git
//! 2.45): a listing is a read, and git stops at the first object the clone lacks, which the
//! walk reports as [`GitError::BlobMissing`] after the rows before it, an object a partial
//! clone cannot read included, where elsewhere it is corrupt. The process is killed
//! on drop and on cancel, and each hash is read with libgit2 from the engine's own second
//! handle; the metadata predicate runs on that commit before the row is built, so every filter
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
use crate::types::{CommitNode, ContentFilter, Page, Prompts, WalkOptions, WalkOrder, WalkScope};

/// Longest a page waits for more lines once it holds a row and git pauses; a partial page is
/// sent then.
const PAGE_BUDGET: Duration = Duration::from_millis(200);
/// Longest a page waits for git at all: it closes then with the rows it holds, none if git
/// listed nothing it kept, and is not the last. A few seconds, so that a call of a few pages
/// stays far inside the app's timeout while git reads a large history.
const PAGE_DEADLINE: Duration = Duration::from_secs(5);
/// How often cancellation is checked while waiting for a line.
const CANCEL_POLL: Duration = Duration::from_millis(50);
/// Lines the reader thread may run ahead of the pages; git is paused beyond it (the pipe
/// fills and it blocks on its write). A walk nobody pages holds at most this many lines, but
/// git, writing rarely, keeps reading the history until the walk is dropped.
const LINE_BUFFER: usize = 256;
/// Most bytes of stderr kept for the error report.
const STDERR_CAP: usize = 64 * 1024;

/// git's options before the command of every walk: git honours `refs/replace` and libgit2
/// does not, so a walk that followed them would list commits the graph does not show.
const NO_REPLACE: &str = "--no-replace-objects";

/// `git log` as a lister of full hashes, one a line, whatever the configuration says:
/// `core.bigFileThreshold` would make `-G` skip a text file above it as binary, where the
/// app's diffs show its lines (512 MiB is git's default); `log.showSignature` would print gpg's
/// lines on stdout; textconv would search a filter's output rather than the stored content the
/// diffs show, running the filter's program; `log.follow` would follow a single path across
/// renames, a history the path filter does not list; `log.showRoot=false` would never diff the
/// root commit, so the commit that created a text would be missing; `diff.renames=false` or
/// `copies` would list a moved or copied file as changing its texts' count, and
/// `diff.renameLimit` would change how many moves are found (1,000 is git's default); a
/// submodule's commit would be searched as git's `Subproject commit <hash>` line, depending on
/// `diff.ignoreSubmodules`; `i18n.logOutputEncoding` or `i18n.commitEncoding` would re-encode
/// the hashes (UTF-16 among them).
const LOG_ARGS: [&str; 14] = [
    NO_REPLACE,
    "-c",
    "core.bigFileThreshold=512m",
    "log",
    "--stdin",
    "--no-show-signature",
    "--no-textconv",
    "--no-follow",
    "--root",
    "--find-renames",
    "-l1000",
    "--ignore-submodules=all",
    "--encoding=UTF-8",
    "--format=%H",
];

/// Starts a path or content history walk; see the module docs.
#[tracing::instrument(
    level = "debug",
    skip_all,
    fields(
        paths = ?options.filter.as_ref().map(|f| &f.paths),
        content = options.filter.as_ref().and_then(|f| f.content_search()).map(|c| if c.lines { "lines" } else { "count" }),
    )
)]
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
    let partial_clone = partial_clone(&repo);
    let content = filter.content_search();
    let mut args: Vec<String> = match content {
        Some(_) => LOG_ARGS.iter().map(|arg| (*arg).to_owned()).collect(),
        None => vec![
            NO_REPLACE.to_owned(),
            "rev-list".to_owned(),
            "--stdin".to_owned(),
        ],
    };
    if options.order == WalkOrder::DateTopo {
        args.push("--date-order".to_owned());
    }
    if let Some(content) = content {
        args.push(pickaxe(content));
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
        // Nothing to list (an unborn repository, or no name of the scope resolves): git
        // would read no revision and print nothing, so no process is needed.
        return Ok(Box::new(CliWalk::empty(repo, command_text)));
    }
    let mut child = cli::command(&engine.repo().root, &argv)
        .envs(cli::network_env(Prompts::Never))
        .env("GIT_NO_LAZY_FETCH", "1")
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
        .name("begitra-rev-list-in".to_owned())
        .spawn(move || {
            let mut stdin = stdin;
            // A closed pipe (git exited early) is reported through the exit status.
            let _ = stdin.write_all(revisions.as_bytes());
        })
        .map_err(|error| cli_error(format!("could not start the writer thread: {error}")))?;
    let drain = std::thread::Builder::new()
        .name("begitra-rev-list-err".to_owned())
        .spawn(move || {
            let mut text = Vec::new();
            let _ = stderr.take(STDERR_CAP as u64).read_to_end(&mut text);
            String::from_utf8_lossy(&text).into_owned()
        })
        .map_err(|error| cli_error(format!("could not start the stderr thread: {error}")))?;
    let (sender, lines) = mpsc::sync_channel::<io::Result<String>>(LINE_BUFFER);
    let reader = std::thread::Builder::new()
        .name("begitra-rev-list".to_owned())
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
        page_budget: PAGE_BUDGET,
        deadline: PAGE_DEADLINE,
        partial_clone,
    }))
}

/// Whether the repository leaves objects to a promisor remote: `extensions.partialClone`, or a
/// remote marked `promisor` (a recent git sets only that).
fn partial_clone(repo: &Repository) -> bool {
    let Ok(config) = repo.config().and_then(|mut config| config.snapshot()) else {
        return false;
    };
    if config.get_string("extensions.partialclone").is_ok() {
        return true;
    }
    let Ok(remotes) = repo.remotes() else {
        return false;
    };
    remotes
        .iter()
        .filter_map(|name| name.ok().flatten())
        .any(|name| {
            config
                .get_bool(&format!("remote.{name}.promisor"))
                .unwrap_or(false)
        })
}

/// The pickaxe of a content search, attached to its option so that git reads the whole text
/// as its value: `-S<text>`, or `-G` with the text as a literal regular expression.
fn pickaxe(content: &ContentFilter) -> String {
    if content.lines {
        format!("-G{}", literal_regex(&content.text))
    } else {
        format!("-S{}", content.text)
    }
}

/// `text` as a POSIX extended regular expression that matches it as written: git compiles
/// `-G` with `REG_EXTENDED` and has no fixed-string form for it. Each character ERE makes
/// special (`. [ \ ( ) * + ? { | ^ $`) gets a backslash; `]` and `}` are ordinary outside a
/// bracket expression or an interval and stay bare, because a backslash before an ordinary
/// character is undefined.
fn literal_regex(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        if matches!(
            c,
            '.' | '[' | '\\' | '(' | ')' | '*' | '+' | '?' | '{' | '|' | '^' | '$'
        ) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
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
    /// [`PAGE_BUDGET`], shorter in the unit tests.
    page_budget: Duration,
    /// [`PAGE_DEADLINE`], shorter in the unit tests.
    deadline: Duration,
    /// The repository leaves objects to a promisor remote: an object git cannot read is one
    /// the clone lacks, not a corrupt one.
    partial_clone: bool,
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
            page_budget: PAGE_BUDGET,
            deadline: PAGE_DEADLINE,
            partial_clone: false,
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
        } else if let Some(hash) = promised_object(&stderr) {
            // The clone leaves the object to its remote, which the walk does not ask.
            Err(GitError::BlobMissing(hash))
        } else if let Some(hash) = corrupt_object(&stderr).filter(|_| self.partial_clone) {
            // `unable to read tree (<hash>)` in a clone without trees, for one.
            Err(GitError::BlobMissing(hash))
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

/// The hash of the object git could not fetch from a partial clone's remote (`fatal: could
/// not fetch <hash> from promisor remote`, lazy fetching being off).
fn promised_object(stderr: &str) -> Option<String> {
    let line = stderr
        .lines()
        .find(|line| line.contains("from promisor remote"))?;
    let hash = line
        .split(|c: char| !c.is_ascii_hexdigit())
        .find(|token| token.len() >= 40)
        .unwrap_or("unknown");
    Some(hash.to_owned())
}

/// The hash git names when it dies on a missing or corrupt object (`fatal: bad object
/// <hash>`, `error: object file ... is empty`, `fatal: loose object <hash> ... is corrupt`,
/// `fatal: unable to read <hash>` from a diff).
fn corrupt_object(stderr: &str) -> Option<String> {
    let lower = stderr.to_ascii_lowercase();
    if !(lower.contains("corrupt")
        || lower.contains("bad object")
        || lower.contains("missing")
        || lower.contains("unable to read"))
    {
        return None;
    }
    let hash = stderr
        .split(|c: char| !c.is_ascii_hexdigit())
        .find(|token| token.len() >= 7 && token.len() <= 40)
        .unwrap_or("unknown");
    Some(hash.to_owned())
}

impl CommitWalk for CliWalk {
    fn stop_now(&mut self) {
        if let Some(child) = self.child.take() {
            cli::stop_tree(child);
        }
        self.stop();
    }

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
        let started = Instant::now();
        let mut first_row_at: Option<Instant> = None;
        while commits.len() < self.page_size {
            if cancel.is_cancelled() {
                self.stop();
                return Err(GitError::Cancelled);
            }
            // Past the deadline the page goes with what it holds, rows or none (git still
            // reading, or the predicate dropping its lines), and the next one goes on from here.
            if started.elapsed() >= self.deadline {
                break;
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
                    if first_row_at.is_some_and(|at| at.elapsed() >= self.page_budget) {
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
                    let error = self.cli_error(format!("unexpected output {text:?}: {error}"));
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

#[cfg(test)]
mod tests {
    use std::sync::mpsc::SyncSender;

    use super::*;

    #[test]
    fn literal_regex_escapes_what_ere_makes_special() {
        assert_eq!(literal_regex("decodeTile"), "decodeTile");
        assert_eq!(literal_regex("limit("), "limit\\(");
        assert_eq!(
            literal_regex(".[\\()*+?{|^$"),
            "\\.\\[\\\\\\(\\)\\*\\+\\?\\{\\|\\^\\$"
        );
        // Ordinary outside a bracket or an interval: a backslash before them is undefined.
        assert_eq!(literal_regex("a]b}c"), "a]b}c");
        assert_eq!(literal_regex("é \"q\" %x% <&>"), "é \"q\" %x% <&>");
    }

    #[test]
    fn the_pickaxe_is_one_attached_argument() {
        let search = |text: &str, lines: bool| {
            pickaxe(&ContentFilter {
                text: text.to_owned(),
                lines,
            })
        };
        assert_eq!(search("refreshToken", false), "-SrefreshToken");
        assert_eq!(search("-dash", false), "-S-dash");
        assert_eq!(search(" a.b", false), "-S a.b");
        assert_eq!(search("decodeTile(", true), "-GdecodeTile\\(");
        assert_eq!(search("-dash", true), "-G-dash");
    }

    /// A repository with two commits, by `ane` and by `bob`, for the rows a fed walk hydrates.
    fn two_commits() -> (tempfile::TempDir, Repository, Oid, Oid) {
        let dir = tempfile::tempdir().expect("temp dir");
        let repo = Repository::init(dir.path()).expect("init");
        let (by_a, by_b) = {
            let tree_id = repo
                .treebuilder(None)
                .expect("tree builder")
                .write()
                .expect("tree");
            let tree = repo.find_tree(tree_id).expect("tree object");
            let commit = |name: &str| {
                let signature =
                    git2::Signature::new(name, &format!("{name}@x"), &git2::Time::new(0, 0))
                        .expect("sig");
                repo.commit(None, &signature, &signature, name, &tree, &[])
                    .expect("commit")
            };
            (commit("ane"), commit("bob"))
        };
        (dir, repo, by_a, by_b)
    }

    /// A walk over lines the test sends, with short budgets and no process.
    fn fed(
        repo: Repository,
        page_budget: Duration,
        deadline: Duration,
    ) -> (CliWalk, SyncSender<io::Result<String>>) {
        let (sender, lines) = mpsc::sync_channel(LINE_BUFFER);
        let walk = CliWalk {
            repo,
            child: None,
            lines: Some(lines),
            reader: None,
            writer: None,
            drain: None,
            command: "log".to_owned(),
            page_size: 10,
            matcher: Matcher::new(&Default::default()),
            decorations: HashMap::new(),
            finished: false,
            pending_error: None,
            page_budget,
            deadline,
            partial_clone: false,
        };
        (walk, sender)
    }

    /// Sends `oid` every 10 ms until the walk is gone, or for three seconds at most, so that a
    /// page that never closes fails its test (the walk sees the end) rather than hanging it.
    fn keep_sending(
        sender: SyncSender<io::Result<String>>,
        oid: Oid,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < until {
                if sender.send(Ok(oid.to_string())).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    }

    #[test]
    fn a_page_closes_empty_but_not_last_when_nothing_comes() {
        let (_dir, repo, oid, _) = two_commits();
        let (mut walk, sender) = fed(repo, Duration::from_millis(50), Duration::from_millis(150));
        // A page that never closes on its own fails the test rather than hanging it.
        let (closed, watched) = mpsc::channel::<()>();
        let alarm = sender.clone();
        let watchdog = std::thread::spawn(move || {
            if watched.recv_timeout(Duration::from_secs(3)).is_err() {
                let _ = alarm.send(Err(io::Error::other("the page never closed")));
            }
        });
        let started = Instant::now();
        let page = walk.next_page(&Cancel::never()).expect("empty page");
        let _ = closed.send(());
        watchdog.join().expect("watchdog");
        assert!(page.commits.is_empty());
        assert!(!page.done, "git is still reading");
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(150), "{waited:?}");
        assert!(waited < Duration::from_secs(2), "{waited:?}");
        // The next page goes on with git's listing, then the end.
        sender.send(Ok(oid.to_string())).expect("send");
        let page = walk.next_page(&Cancel::never()).expect("a row");
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].hash, oid.to_string());
        assert!(!page.done);
        drop(sender);
        let page = walk.next_page(&Cancel::never()).expect("the end");
        assert!(page.commits.is_empty() && page.done);
    }

    #[test]
    fn a_page_with_rows_closes_once_git_pauses() {
        let (_dir, repo, first, second) = two_commits();
        // The row budget, not the deadline, closes a page whose lines stop coming.
        let (mut walk, sender) = fed(repo, Duration::from_millis(150), Duration::from_secs(3));
        sender.send(Ok(first.to_string())).expect("send");
        let later = sender.clone();
        let feeder = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            let _ = later.send(Ok(second.to_string()));
        });
        let started = Instant::now();
        let page = walk.next_page(&Cancel::never()).expect("two rows");
        let waited = started.elapsed();
        feeder.join().expect("feeder");
        assert_eq!(
            page.commits.len(),
            2,
            "the second row came within the budget"
        );
        assert!(!page.done);
        assert!(waited < Duration::from_secs(1), "{waited:?}");
        drop(sender);
    }

    #[test]
    fn a_page_with_a_row_closes_by_its_deadline_while_dropped_lines_keep_coming() {
        let (_dir, repo, kept, dropped) = two_commits();
        let (mut walk, sender) = fed(repo, Duration::from_millis(150), Duration::from_millis(300));
        walk.matcher = Matcher::new(&crate::types::WalkFilter {
            author: Some("ane".to_owned()),
            ..Default::default()
        });
        sender.send(Ok(kept.to_string())).expect("send");
        // Lines every 10 ms never leave git silent for the row budget: the deadline closes it.
        let feeder = keep_sending(sender, dropped);
        let started = Instant::now();
        let page = walk.next_page(&Cancel::never()).expect("a row");
        let waited = started.elapsed();
        assert_eq!(page.commits.len(), 1);
        assert!(!page.done, "git is still writing");
        assert!(waited < Duration::from_secs(2), "{waited:?}");
        drop(walk);
        feeder.join().expect("feeder");
    }

    #[test]
    fn lines_the_filter_drops_count_as_nothing_to_show() {
        let (_dir, repo, _, dropped) = two_commits();
        let (mut walk, sender) = fed(repo, Duration::from_millis(50), Duration::from_millis(150));
        walk.matcher = Matcher::new(&crate::types::WalkFilter {
            author: Some("ane".to_owned()),
            ..Default::default()
        });
        // git keeps writing lines the metadata filter drops: the page still closes empty.
        let feeder = keep_sending(sender, dropped);
        let page = walk.next_page(&Cancel::never()).expect("empty page");
        assert!(page.commits.is_empty());
        assert!(!page.done);
        drop(walk);
        feeder.join().expect("feeder");
    }

    #[test]
    fn a_partial_clone_s_missing_object_and_a_missing_one_are_named() {
        assert_eq!(
            promised_object(
                "warning: lazy fetching disabled; some objects may not be available\n\
                 fatal: could not fetch e9fe35502372ff97412030cccc20cf4920b0ebe8 from promisor remote\n"
            )
            .as_deref(),
            Some("e9fe35502372ff97412030cccc20cf4920b0ebe8")
        );
        assert_eq!(promised_object("fatal: bad object deadbeef"), None);
        assert_eq!(
            corrupt_object("fatal: unable to read c586200a6f4d5113ff88a145430672a4c61e8069\n")
                .as_deref(),
            Some("c586200a6f4d5113ff88a145430672a4c61e8069")
        );
    }
}
