//! The watcher against git operations made outside the app: the real `RepoWatcher` over a fresh
//! repository while the git CLI makes each operation, as a terminal or an agent would. Each
//! test asserts the kinds of change that make the app reload what the operation touched; the
//! exact set can hold more (the platform reports some paths twice or splits a batch).

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use begitra_lib::events::{RepoChangeKind, RepoChanged};
use begitra_lib::watcher::{RepoWatcher, WatchBases};

/// Time the platform watcher gets to start before an operation.
const SETTLE: Duration = Duration::from_millis(250);
/// Quiet time after the last event that ends a measurement.
const QUIET: Duration = Duration::from_millis(800);
/// Longest a measurement waits for its first event.
const FIRST_EVENT: Duration = Duration::from_secs(10);

/// A repository in a temporary folder with one commit, and git isolated from the machine's
/// configuration.
struct Repo {
    dir: tempfile::TempDir,
    root: PathBuf,
}

impl Repo {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).expect("repo folder");
        let repo = Self { dir, root };
        repo.git(&["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Fixture"),
            ("user.email", "fixture@example.com"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
            ("gc.auto", "0"),
        ] {
            repo.git(&["config", key, value]);
        }
        repo.write("a.txt", "one\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "c1"]);
        repo
    }

    fn command(&self, dir: &Path, args: &[&str]) -> Output {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                self.dir.path().join("no-global-config"),
            )
            .env("GIT_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs")
    }

    /// Runs git in the repository; it must succeed.
    fn git(&self, args: &[&str]) -> String {
        let output = self.command(&self.root, args);
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// Runs git in the repository where it may fail (a merge that stops on a conflict).
    fn git_may_fail(&self, args: &[&str]) {
        self.command(&self.root, args);
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("folders");
        }
        std::fs::write(path, content).expect("write");
    }

    fn commit_all(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
    }

    /// `main` and `other` both change the line of `a.txt` from `c1`, so merging, rebasing or
    /// cherry-picking one onto the other stops on a conflict.
    fn with_conflicting_branches(self) -> Self {
        self.git(&["switch", "-q", "-c", "other"]);
        self.write("a.txt", "other\n");
        self.commit_all("other");
        self.git(&["switch", "-q", "main"]);
        self.write("a.txt", "main\n");
        self.commit_all("main");
        self
    }

    /// Starts a watcher, runs `operation`, and returns every event the watcher reported for
    /// it, once they have been quiet for [`QUIET`].
    fn watch(&self, operation: impl FnOnce(&Self)) -> Vec<RepoChanged> {
        let (tx, rx) = mpsc::channel();
        let watcher = RepoWatcher::start(WatchBases::main(&self.root), move |payload| {
            let _ = tx.send(payload);
        })
        .expect("the watcher starts");
        std::thread::sleep(SETTLE);
        operation(self);
        let mut events = Vec::new();
        let first_by = Instant::now() + FIRST_EVENT;
        let mut quiet_by: Option<Instant> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(payload) => {
                    events.push(payload);
                    quiet_by = Some(Instant::now() + QUIET);
                }
                Err(RecvTimeoutError::Timeout) => {
                    let now = Instant::now();
                    if quiet_by.map_or(now >= first_by, |quiet| now >= quiet) {
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(watcher);
        events
    }

    /// The kinds of every event [`Repo::watch`] collected for `operation`.
    fn kinds_of(&self, operation: impl FnOnce(&Self)) -> Vec<RepoChangeKind> {
        let mut kinds: Vec<RepoChangeKind> = Vec::new();
        for kind in self
            .watch(operation)
            .into_iter()
            .flat_map(|event| event.kinds)
        {
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
        kinds
    }
}

#[track_caller]
fn assert_has(kinds: &[RepoChangeKind], expected: &[RepoChangeKind]) {
    for kind in expected {
        assert!(kinds.contains(kind), "expected {kind:?} in {kinds:?}");
    }
}

use RepoChangeKind::{Index, Refs, Status, Worktrees};

#[test]
fn a_commit_and_an_amend_report_refs() {
    let repo = Repo::new();
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["commit", "-q", "-m", "c2"]);
        }),
        &[Refs],
    );
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["commit", "-q", "--amend", "-m", "c2 again"]);
        }),
        &[Refs],
    );
}

#[test]
fn a_branch_and_a_tag_report_refs() {
    let repo = Repo::new();
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["branch", "feature"]);
            r.git(&["tag", "v1"]);
        }),
        &[Refs],
    );
}

#[test]
fn a_switch_and_a_reset_report_the_refs_and_the_working_tree() {
    let repo = Repo::new();
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write("b.txt", "b\n");
    repo.commit_all("b");
    repo.git(&["switch", "-q", "main"]);
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["switch", "-q", "other"]);
        }),
        &[Refs, Index, Status],
    );
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["reset", "-q", "--hard", "main"]);
        }),
        &[Refs, Index, Status],
    );
}

#[test]
fn a_stash_push_pop_and_drop_report_what_they_touch() {
    let repo = Repo::new();
    repo.write("a.txt", "work in progress\n");
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["stash", "push", "-q"]);
        }),
        &[Refs, Index, Status],
    );
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["stash", "pop", "-q"]);
        }),
        &[Refs, Index, Status],
    );
    repo.git(&["stash", "push", "-q"]);
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["stash", "drop", "-q"]);
        }),
        &[Refs],
    );
}

#[test]
fn a_merge_stopped_on_a_conflict_its_abort_and_its_quit_report_refs() {
    let repo = Repo::new().with_conflicting_branches();
    assert_has(
        &repo.kinds_of(|r| r.git_may_fail(&["merge", "other"])),
        &[Refs, Index, Status],
    );
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["merge", "--abort"]);
        }),
        &[Refs, Index, Status],
    );
    repo.git_may_fail(&["merge", "other"]);
    // `--quit` forgets the merge and leaves the index and the files as they are: only git's
    // own state for the merge goes.
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["merge", "--quit"]);
        }),
        &[Refs],
    );
}

#[test]
fn a_rebase_stopped_on_a_conflict_and_its_quit_report_refs() {
    let repo = Repo::new().with_conflicting_branches();
    repo.git(&["switch", "-q", "other"]);
    assert_has(
        &repo.kinds_of(|r| r.git_may_fail(&["rebase", "main"])),
        &[Refs, Index, Status],
    );
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["rebase", "--quit"]);
        }),
        &[Refs],
    );
}

#[test]
fn a_cherry_pick_quit_reports_refs() {
    let repo = Repo::new().with_conflicting_branches();
    repo.git_may_fail(&["cherry-pick", "other"]);
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["cherry-pick", "--quit"]);
        }),
        &[Refs],
    );
}

#[test]
fn a_fetch_a_remote_added_and_an_upstream_set_report_refs() {
    let repo = Repo::new();
    let remote = repo.dir.path().join("remote.git");
    let remote_arg = remote.to_str().expect("utf-8 temp path");
    repo.git(&["clone", "-q", "--bare", ".", remote_arg]);
    // Another clone pushes a commit the repository has not fetched yet.
    let other = repo.dir.path().join("other");
    let other_arg = other.to_str().expect("utf-8 temp path");
    repo.git(&["clone", "-q", remote_arg, other_arg]);
    std::fs::write(other.join("c.txt"), "c\n").expect("write");
    for args in [
        &[
            "-c",
            "user.name=Other",
            "-c",
            "user.email=o@example.com",
            "add",
            "c.txt",
        ][..],
        &[
            "-c",
            "user.name=Other",
            "-c",
            "user.email=o@example.com",
            "commit",
            "-q",
            "-m",
            "from the other clone",
        ][..],
        &["push", "-q", "origin", "main"][..],
    ] {
        let output = repo.command(&other, args);
        assert!(output.status.success(), "git {args:?} in the other clone");
    }
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["remote", "add", "origin", remote_arg]);
        }),
        &[Refs],
    );
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["fetch", "-q", "origin"]);
        }),
        &[Refs],
    );
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["branch", "-q", "-u", "origin/main"]);
        }),
        &[Refs],
    );
}

#[test]
fn a_worktree_added_and_removed_reports_worktrees() {
    let repo = Repo::new();
    let path = repo.dir.path().join("wt");
    let path_arg = path.to_str().expect("utf-8 temp path");
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["worktree", "add", "-q", "-b", "wt", path_arg]);
        }),
        &[Worktrees, Refs],
    );
    assert_has(
        &repo.kinds_of(|r| {
            r.git(&["worktree", "remove", path_arg]);
        }),
        &[Worktrees],
    );
}

#[test]
fn a_file_edited_deep_in_the_tree_reports_its_path() {
    let repo = Repo::new();
    std::fs::create_dir_all(repo.root.join("src").join("deep")).expect("folders");
    let events = repo.watch(|r| r.write("src/deep/file.txt", "new\n"));
    let kinds: Vec<RepoChangeKind> = events.iter().flat_map(|e| e.kinds.clone()).collect();
    assert_has(&kinds, &[Status]);
    assert!(
        events
            .iter()
            .any(|e| e.paths.iter().any(|p| p == "src/deep/file.txt")),
        "{events:?}"
    );
}

#[test]
fn the_exclude_rules_report_status() {
    let repo = Repo::new();
    let exclude = repo.root.join(".git").join("info").join("exclude");
    std::fs::create_dir_all(exclude.parent().expect("info folder")).expect("info folder");
    assert_has(
        &repo.kinds_of(|_| std::fs::write(&exclude, "*.log\n").expect("exclude")),
        &[Status],
    );
}
