//! The watcher against git operations made outside the app: the real `RepoWatcher` over a fresh
//! repository while the git CLI makes each operation, as a terminal or an agent would. Each
//! test waits for the kinds of change that make the app reload what the operation touched
//! (the platform may report more, or split a batch), and reads must report nothing: the app's
//! own reloads read the repository, so a read that counted would make each reload start the
//! next.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use begitra_lib::events::{RepoChangeKind, RepoChanged};
use begitra_lib::watcher::{RepoWatcher, WatchBases, WatchBasesExt, DEBOUNCE};

use RepoChangeKind::{Index, Refs, Status, Worktrees};

/// Time the platform watcher gets to start before an operation; what it reports meanwhile is
/// dropped.
const SETTLE: Duration = Duration::from_millis(400);
/// Longest a measurement waits for the kinds it expects.
const PATIENCE: Duration = Duration::from_secs(10);
/// How long reads are watched for an event that must not come.
const SILENCE: Duration = Duration::from_millis(1500);
/// How long a step of a session waits without events before the next one.
const QUIET: Duration = Duration::from_millis(600);

/// A repository in a temporary folder with one commit, and git isolated from the machine's
/// configuration and from any git process the tests run under (a hook).
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
        let mut command = Command::new("git");
        for inherited in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_COUNT",
        ] {
            command.env_remove(inherited);
        }
        command
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                self.dir.path().join("no-global-config"),
            )
            // `~/.config/git/attributes` and `ignore` apply without a global configuration.
            .env("HOME", self.dir.path())
            .env("XDG_CONFIG_HOME", self.dir.path().join("no-xdg"))
            // Repositories nested in the fixture commit too.
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.com")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.com")
            .env("GIT_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs")
    }

    /// Runs git in `dir`; it must succeed.
    fn git_in(&self, dir: &Path, args: &[&str]) -> String {
        let output = self.command(dir, args);
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    /// Runs git in the repository; it must succeed.
    fn git(&self, args: &[&str]) -> String {
        self.git_in(&self.root, args)
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

    /// A folder beside the repository, as git names paths in its arguments.
    fn beside(&self, name: &str) -> (PathBuf, String) {
        let path = self.dir.path().join(name);
        let arg = path.to_str().expect("utf-8 temp path").to_owned();
        (path, arg)
    }

    /// Starts a watcher on `bases`, runs `operation`, and collects the events until `enough`
    /// says so or `patience` runs out.
    fn watch(
        bases: WatchBases,
        operation: impl FnOnce(),
        enough: impl Fn(&[RepoChanged]) -> bool,
        patience: Duration,
    ) -> Vec<RepoChanged> {
        let session = Session::start(bases);
        operation();
        session.collect(enough, Duration::ZERO, patience)
    }

    /// Runs `operation` in the repository and asserts that the watcher reports `expected`.
    #[track_caller]
    fn expect(&self, operation: impl FnOnce(&Self), expected: &[RepoChangeKind]) {
        let events = Self::watch(
            WatchBases::main(&self.root),
            || operation(self),
            |events| expected.iter().all(|kind| kinds(events).contains(kind)),
            PATIENCE,
        );
        let seen = kinds(&events);
        for kind in expected {
            assert!(seen.contains(kind), "expected {kind:?} in {seen:?}");
        }
    }

    /// Runs `operation` and returns what the watcher reports within [`SILENCE`].
    fn events_within_silence(&self, operation: impl FnOnce(&Self)) -> Vec<RepoChanged> {
        Self::watch(
            WatchBases::main(&self.root),
            || operation(self),
            |_| false,
            SILENCE,
        )
    }
}

/// One watcher for several operations: git replaces a file by renaming a lock over it, which
/// ends a watch on the file itself on Linux, so a second operation must be seen by the watcher
/// that saw the first.
struct Session {
    _watcher: RepoWatcher,
    events: Receiver<RepoChanged>,
}

impl Session {
    /// Starts a watcher on `bases` and lets it settle; what it reports meanwhile is dropped.
    fn start(bases: WatchBases) -> Self {
        let (tx, events) = mpsc::channel();
        let watcher = RepoWatcher::start(bases, move |payload| {
            let _ = tx.send(payload);
        })
        .expect("the watcher starts");
        std::thread::sleep(SETTLE.max(DEBOUNCE * 2));
        while events.try_recv().is_ok() {}
        Self {
            _watcher: watcher,
            events,
        }
    }

    /// Collects events until `enough` says so and no event came for `quiet`, or `patience`
    /// runs out.
    fn collect(
        &self,
        enough: impl Fn(&[RepoChanged]) -> bool,
        quiet: Duration,
        patience: Duration,
    ) -> Vec<RepoChanged> {
        let mut events = Vec::new();
        let until = Instant::now() + patience;
        let mut last = Instant::now();
        loop {
            let now = Instant::now();
            if now >= until || (enough(&events) && now.duration_since(last) >= quiet) {
                break;
            }
            match self.events.recv_timeout(Duration::from_millis(50)) {
                Ok(payload) => {
                    events.push(payload);
                    last = Instant::now();
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        events
    }
}

fn kinds(events: &[RepoChanged]) -> Vec<RepoChangeKind> {
    let mut kinds = Vec::new();
    for kind in events.iter().flat_map(|event| event.kinds.iter().copied()) {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }
    kinds
}

#[test]
fn reads_report_nothing() {
    let repo = Repo::new();
    let events = repo.events_within_silence(|r| {
        std::fs::read(r.root.join("a.txt")).expect("read");
        r.git(&["rev-parse", "HEAD"]);
        r.git(&["config", "--get", "user.name"]);
        r.git(&["--no-optional-locks", "status", "--porcelain"]);
        r.git(&["log", "--oneline", "-1"]);
    });
    assert!(events.is_empty(), "reads reported changes: {events:?}");
}

#[test]
fn a_commit_and_an_amend_report_refs() {
    let repo = Repo::new();
    repo.write("a.txt", "two\n");
    repo.git(&["add", "a.txt"]);
    repo.expect(
        |r| {
            r.git(&["commit", "-q", "-m", "c2"]);
        },
        &[Refs],
    );
    repo.expect(
        |r| {
            r.git(&["commit", "-q", "--amend", "-m", "c2 again"]);
        },
        &[Refs],
    );
}

#[test]
fn a_branch_and_a_tag_report_refs() {
    let repo = Repo::new();
    repo.expect(
        |r| {
            r.git(&["branch", "feature"]);
            r.git(&["tag", "v1"]);
        },
        &[Refs],
    );
}

#[test]
fn a_switch_and_resets_report_what_they_move() {
    let repo = Repo::new();
    repo.git(&["switch", "-q", "-c", "other"]);
    repo.write("b.txt", "b\n");
    repo.commit_all("b");
    repo.git(&["switch", "-q", "main"]);
    repo.expect(
        |r| {
            r.git(&["switch", "-q", "other"]);
        },
        &[Refs, Index, Status],
    );
    // A soft reset moves the branch alone: the staged list follows the refs.
    repo.expect(
        |r| {
            r.git(&["reset", "-q", "--soft", "main"]);
        },
        &[Refs],
    );
    repo.expect(
        |r| {
            r.git(&["reset", "-q", "--hard", "main"]);
        },
        &[Refs, Index, Status],
    );
}

#[test]
fn a_stash_push_pop_and_drop_report_what_they_touch() {
    let repo = Repo::new();
    repo.write("a.txt", "work in progress\n");
    repo.expect(
        |r| {
            r.git(&["stash", "push", "-q"]);
        },
        &[Refs, Index, Status],
    );
    repo.expect(
        |r| {
            r.git(&["stash", "pop", "-q"]);
        },
        &[Refs, Index, Status],
    );
    repo.git(&["stash", "push", "-q"]);
    repo.expect(
        |r| {
            r.git(&["stash", "drop", "-q"]);
        },
        &[Refs],
    );
}

#[test]
fn a_merge_stopped_on_a_conflict_its_abort_and_its_quit_report_refs() {
    let repo = Repo::new().with_conflicting_branches();
    repo.expect(
        |r| r.git_may_fail(&["merge", "other"]),
        &[Refs, Index, Status],
    );
    repo.expect(
        |r| {
            r.git(&["merge", "--abort"]);
        },
        &[Refs, Index, Status],
    );
    repo.git_may_fail(&["merge", "other"]);
    // `--quit` forgets the merge and leaves the index and the files as they are: only git's
    // own state for the merge goes.
    repo.expect(
        |r| {
            r.git(&["merge", "--quit"]);
        },
        &[Refs],
    );
}

#[test]
fn a_rebase_stopped_on_a_conflict_and_its_quit_report_refs() {
    let repo = Repo::new().with_conflicting_branches();
    repo.git(&["switch", "-q", "other"]);
    repo.expect(
        |r| r.git_may_fail(&["rebase", "main"]),
        &[Refs, Index, Status],
    );
    repo.expect(
        |r| {
            r.git(&["rebase", "--quit"]);
        },
        &[Refs],
    );
}

#[test]
fn a_cherry_pick_quit_reports_refs() {
    let repo = Repo::new().with_conflicting_branches();
    repo.git_may_fail(&["cherry-pick", "other"]);
    repo.expect(
        |r| {
            r.git(&["cherry-pick", "--quit"]);
        },
        &[Refs],
    );
}

#[test]
fn a_fetch_a_remote_added_and_an_upstream_set_report_refs() {
    let repo = Repo::new();
    let (_, remote) = repo.beside("remote.git");
    repo.git(&["clone", "-q", "--bare", ".", &remote]);
    // Another clone pushes a commit the repository has not fetched yet.
    let (other, other_arg) = repo.beside("other");
    repo.git(&["clone", "-q", &remote, &other_arg]);
    std::fs::write(other.join("c.txt"), "c\n").expect("write");
    let identity = ["-c", "user.name=Other", "-c", "user.email=o@example.com"];
    repo.git_in(&other, &[&identity[..], &["add", "c.txt"]].concat());
    repo.git_in(
        &other,
        &[
            &identity[..],
            &["commit", "-q", "-m", "from the other clone"],
        ]
        .concat(),
    );
    repo.git_in(&other, &["push", "-q", "origin", "main"]);
    repo.expect(
        |r| {
            r.git(&["remote", "add", "origin", &remote]);
        },
        &[Refs],
    );
    repo.expect(
        |r| {
            r.git(&["fetch", "-q", "origin"]);
        },
        &[Refs],
    );
    repo.expect(
        |r| {
            r.git(&["branch", "-q", "-u", "origin/main"]);
        },
        &[Refs],
    );
}

#[test]
fn a_setting_that_changes_the_status_reports_status() {
    let repo = Repo::new();
    let (ignore, ignore_arg) = repo.beside("global-ignore");
    std::fs::write(ignore, "*.log\n").expect("ignore file");
    repo.write("debug.log", "noise\n");
    repo.expect(
        |r| {
            r.git(&["config", "core.excludesFile", &ignore_arg]);
        },
        &[Refs, Status],
    );
}

#[test]
fn a_worktree_added_and_removed_reports_worktrees() {
    let repo = Repo::new();
    let (_, path) = repo.beside("wt");
    repo.expect(
        |r| {
            r.git(&["worktree", "add", "-q", "-b", "wt", &path]);
        },
        &[Worktrees, Refs],
    );
    repo.expect(
        |r| {
            r.git(&["worktree", "remove", &path]);
        },
        &[Worktrees],
    );
}

#[test]
fn a_file_edited_deep_in_the_tree_reports_its_path() {
    let repo = Repo::new();
    std::fs::create_dir_all(repo.root.join("src").join("deep")).expect("folders");
    let events = Repo::watch(
        WatchBases::main(&repo.root),
        || repo.write("src/deep/file.txt", "new\n"),
        |events| {
            events
                .iter()
                .any(|e| e.paths.iter().any(|p| p == "src/deep/file.txt"))
        },
        PATIENCE,
    );
    assert!(
        events
            .iter()
            .any(|e| e.kinds.contains(&Status) && e.paths.iter().any(|p| p == "src/deep/file.txt")),
        "{events:?}"
    );
}

#[test]
fn the_exclude_and_attribute_rules_report_status() {
    let repo = Repo::new();
    let info = repo.root.join(".git").join("info");
    std::fs::create_dir_all(&info).expect("info folder");
    repo.expect(
        |_| std::fs::write(info.join("exclude"), "*.log\n").expect("exclude"),
        &[Status],
    );
    // The attributes mark files generated or binary in the lists.
    repo.expect(
        |_| std::fs::write(info.join("attributes"), "*.txt -diff\n").expect("attributes"),
        &[Status],
    );
}

#[test]
fn a_tracked_file_under_a_build_folder_reports_its_path() {
    let repo = Repo::new();
    repo.write("dist/index.js", "built\n");
    repo.commit_all("committed build output");
    let bases = git_core::git2_engine::Git2Engine::open(&repo.root)
        .expect("the repository opens")
        .watch_bases();
    let session = Session::start(bases);
    let reported = |events: &[RepoChanged], path: &str| {
        events.iter().any(|e| e.paths.iter().any(|p| p == path))
    };
    repo.write("dist/index.js", "rebuilt\n");
    let events = session.collect(|events| reported(events, "dist/index.js"), QUIET, PATIENCE);
    assert!(reported(&events, "dist/index.js"), "{events:?}");
    // A build folder without tracked files stays quiet.
    repo.write("node_modules/dep/index.js", "installed\n");
    let events = session.collect(|_| false, Duration::ZERO, SILENCE);
    assert!(events.is_empty(), "{events:?}");
}

#[test]
fn a_repository_nested_in_the_tree_reports_its_folder_and_no_path_of_its_git_folder() {
    let repo = Repo::new();
    let nested = repo.root.join("nested");
    std::fs::create_dir_all(&nested).expect("nested folder");
    let session = Session::start(WatchBases::main(&repo.root));
    repo.git_in(&nested, &["init", "-q", "-b", "main"]);
    std::fs::write(nested.join("n.txt"), "n\n").expect("write");
    repo.git_in(&nested, &["add", "n.txt"]);
    repo.git_in(&nested, &["commit", "-q", "-m", "nested"]);
    // Its working file is this tree's change, and its folder became a repository.
    let reported = |events: &[RepoChanged], path: &str| {
        events.iter().any(|e| e.paths.iter().any(|p| p == path))
    };
    let events = session.collect(
        |events| reported(events, "nested/n.txt") && reported(events, "nested"),
        QUIET,
        PATIENCE,
    );
    assert!(reported(&events, "nested/n.txt"), "{events:?}");
    assert!(reported(&events, "nested"), "{events:?}");
    let git_paths: Vec<&String> = events
        .iter()
        .flat_map(|e| e.paths.iter())
        .filter(|p| p.split('/').any(|component| component == ".git"))
        .collect();
    assert!(git_paths.is_empty(), "{git_paths:?}");
}

#[test]
fn an_embedded_repository_reports_its_folder_when_its_checkout_moves() {
    let repo = Repo::new();
    let dep = repo.root.join("dep");
    std::fs::create_dir_all(&dep).expect("dep folder");
    repo.git_in(&dep, &["init", "-q", "-b", "main"]);
    std::fs::write(dep.join("d.txt"), "d\n").expect("write");
    repo.git_in(&dep, &["add", "d.txt"]);
    repo.git_in(&dep, &["commit", "-q", "-m", "d1"]);
    // Recorded as a gitlink: the parent lists `dep` as changed when its HEAD moves.
    repo.git(&["add", "dep"]);
    repo.git(&["commit", "-q", "-m", "embed"]);
    let session = Session::start(WatchBases::main(&repo.root));
    let reported = |events: &[RepoChanged]| {
        events
            .iter()
            .any(|e| e.kinds.contains(&Status) && e.paths.iter().any(|p| p == "dep"))
    };
    for step in ["d2", "d3"] {
        repo.git_in(&dep, &["commit", "-q", "--allow-empty", "-m", step]);
        let events = session.collect(reported, QUIET, PATIENCE);
        assert!(reported(&events), "{step}: {events:?}");
    }
    std::fs::remove_dir_all(dep.join(".git")).expect("remove dep/.git");
    let events = session.collect(reported, QUIET, PATIENCE);
    assert!(reported(&events), "removed: {events:?}");
}
