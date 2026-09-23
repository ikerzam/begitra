//! One filesystem watcher per open repository: `notify` events are collected for
//! 150 ms after the first one, classified into the kinds of `repo:changed`, and emitted as one
//! event with the changed paths relative to the root.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use git_core::engine::GitEngine;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::events::{RepoChangeKind, RepoChanged};

/// Quiet time after the first event before the batch is emitted.
pub const DEBOUNCE: Duration = Duration::from_millis(150);

/// Most paths carried by one event; the kinds still cover everything.
pub const MAX_PATHS: usize = 200;

/// Where the git metadata of the watched repository lives, so paths can be classified.
#[derive(Clone, Debug)]
pub struct WatchBases {
    /// Working tree root.
    pub root: PathBuf,
    /// The repository's own git directory: `<root>/.git` for a main repository, the
    /// `.git/worktrees/<name>` folder of the owner for a linked worktree.
    pub gitdir: PathBuf,
    /// The shared git directory (refs, packed-refs, objects); equals `gitdir` for a main
    /// repository.
    pub commondir: PathBuf,
    /// The three above with their symlinks resolved, because the platform watcher reports
    /// the real path of a change (`/private/var/…` for a folder opened as `/var/…` on
    /// macOS) while the app keeps the path the user opened, which is what it reports back.
    /// A path that cannot be resolved (it is gone, or the platform does not do this) keeps
    /// its given form, and the given form is always tried first.
    real: Real,
}

/// The bases as the platform names them; see [`WatchBases::real`].
#[derive(Clone, Debug, PartialEq, Eq)]
struct Real {
    root: PathBuf,
    gitdir: PathBuf,
    commondir: PathBuf,
}

impl Real {
    fn of(root: &Path, gitdir: &Path, commondir: &Path) -> Self {
        let resolve =
            |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        Self {
            root: resolve(root),
            gitdir: resolve(gitdir),
            commondir: resolve(commondir),
        }
    }
}

/// The watch bases of an open engine.
pub trait WatchBasesExt {
    /// Root, own git directory and shared git directory.
    fn watch_bases(&self) -> WatchBases;
}

impl WatchBasesExt for git_core::git2_engine::Git2Engine {
    fn watch_bases(&self) -> WatchBases {
        let (gitdir, commondir) = self.git_dirs();
        WatchBases::new(self.repo().root.clone(), gitdir, commondir)
    }
}

impl WatchBases {
    /// The bases of a repository, with the real forms resolved once.
    pub fn new(root: PathBuf, gitdir: PathBuf, commondir: PathBuf) -> Self {
        let real = Real::of(&root, &gitdir, &commondir);
        Self {
            root,
            gitdir,
            commondir,
            real,
        }
    }

    /// Bases of a main repository at `root`.
    pub fn main(root: &Path) -> Self {
        let gitdir = root.join(".git");
        Self::new(root.to_path_buf(), gitdir.clone(), gitdir)
    }

    fn is_linked(&self) -> bool {
        self.gitdir != self.root.join(".git")
    }
}

/// A running watcher; dropping it stops the watch and the debounce thread.
pub struct RepoWatcher {
    watcher: Option<RecommendedWatcher>,
    thread: Option<JoinHandle<()>>,
}

impl RepoWatcher {
    /// Starts watching the working tree of `bases` recursively and, for a linked worktree,
    /// its own git directory and the shared refs, configuration and ignore rules of its
    /// owner; `emit` receives one payload per debounced batch. Fails when the platform
    /// watcher cannot be created or a path cannot be watched (too many watches, an
    /// unsupported filesystem), which the caller reports as a warning.
    pub fn start(
        bases: WatchBases,
        emit: impl Fn(RepoChanged) + Send + 'static,
    ) -> Result<Self, notify::Error> {
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(raw_tx)?;
        watcher.watch(&bases.root, RecursiveMode::Recursive)?;
        if bases.is_linked() {
            // HEAD, the index and an operation's state of a linked worktree live in its own
            // git directory; its refs, configuration and ignore rules are the owner's.
            watcher.watch(&bases.gitdir, RecursiveMode::Recursive)?;
            for shared in ["HEAD", "packed-refs", "config", "info"] {
                let path = bases.commondir.join(shared);
                if path.exists() {
                    watcher.watch(&path, RecursiveMode::NonRecursive)?;
                }
            }
            let refs = bases.commondir.join("refs");
            if refs.is_dir() {
                watcher.watch(&refs, RecursiveMode::Recursive)?;
            }
        }
        let thread = thread::Builder::new()
            .name("begitra-watcher".to_owned())
            .spawn(move || debounce_loop(&bases, &raw_rx, emit))
            .map_err(notify::Error::io)?;
        Ok(Self {
            watcher: Some(watcher),
            thread: Some(thread),
        })
    }
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        // Dropping the platform watcher closes the event sender, which wakes the debounce
        // thread at once through `Disconnected`.
        drop(self.watcher.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Collects raw events, waits [`DEBOUNCE`] after the first of a batch, and emits the batch.
fn debounce_loop(
    bases: &WatchBases,
    raw: &Receiver<notify::Result<notify::Event>>,
    emit: impl Fn(RepoChanged),
) {
    let mut batch = Batch::default();
    let mut deadline: Option<Instant> = None;
    loop {
        let wait = deadline.map_or(Duration::from_secs(3600), |d| {
            d.saturating_duration_since(Instant::now())
        });
        match raw.recv_timeout(wait) {
            Ok(Ok(event)) => {
                if event.need_rescan() {
                    // The platform lost events (a buffer overflow during a huge checkout):
                    // everything may have changed.
                    batch.add_everything();
                } else {
                    for path in &event.paths {
                        batch.add(bases, path);
                    }
                }
                if deadline.is_none() && !batch.is_empty() {
                    deadline = Some(Instant::now() + DEBOUNCE);
                }
            }
            Ok(Err(error)) => tracing::warn!(error = %error, "watcher error"),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        if let Some(d) = deadline {
            if Instant::now() >= d {
                deadline = None;
                if let Some(payload) = batch.take(&bases.root) {
                    emit(payload);
                }
            }
        }
    }
}

/// The changes collected since the last emission.
#[derive(Default)]
pub struct Batch {
    kinds: BTreeSet<Kind>,
    paths: BTreeSet<String>,
    dropped: bool,
}

/// Kinds ordered for a stable payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    Refs,
    Index,
    Worktrees,
    Status,
}

impl Batch {
    /// Adds one changed path, classified by where it sits relative to the bases.
    pub fn add(&mut self, bases: &WatchBases, path: &Path) {
        let Some(classified) = classify(bases, path) else {
            return;
        };
        match classified {
            Classified::Refs => {
                self.kinds.insert(Kind::Refs);
            }
            Classified::Index => {
                self.kinds.insert(Kind::Index);
            }
            Classified::Worktrees => {
                self.kinds.insert(Kind::Worktrees);
            }
            Classified::Status(relative) => {
                self.kinds.insert(Kind::Status);
                if self.paths.len() < MAX_PATHS {
                    self.paths.insert(relative);
                } else {
                    self.dropped = true;
                }
            }
            Classified::StatusRules => {
                // No path names what changed, as for a lost batch.
                self.kinds.insert(Kind::Status);
                self.dropped = true;
            }
        }
    }

    /// Marks every kind changed with no path list (the platform lost events).
    pub fn add_everything(&mut self) {
        self.kinds
            .extend([Kind::Refs, Kind::Index, Kind::Worktrees, Kind::Status]);
        self.paths.clear();
        self.dropped = true;
    }

    /// Whether nothing was collected.
    pub fn is_empty(&self) -> bool {
        self.kinds.is_empty()
    }

    /// The payload of what was collected, leaving the batch empty; `None` when empty.
    pub fn take(&mut self, root: &Path) -> Option<RepoChanged> {
        if self.kinds.is_empty() {
            return None;
        }
        let kinds = self
            .kinds
            .iter()
            .map(|kind| match kind {
                Kind::Refs => RepoChangeKind::Refs,
                Kind::Index => RepoChangeKind::Index,
                Kind::Worktrees => RepoChangeKind::Worktrees,
                Kind::Status => RepoChangeKind::Status,
            })
            .collect();
        let paths = if self.dropped {
            Vec::new()
        } else {
            self.paths.iter().cloned().collect()
        };
        self.kinds.clear();
        self.paths.clear();
        self.dropped = false;
        Some(RepoChanged {
            repo: root.to_path_buf(),
            kinds,
            paths,
        })
    }
}

enum Classified {
    Refs,
    Index,
    Worktrees,
    Status(String),
    /// The ignore or sparse rules changed: any working file may show or hide.
    StatusRules,
}

/// Folder names whose content is never reported as a working tree change: build outputs
/// and caches churn while nothing the user reviews changed.
const NOISY: [&str; 6] = [
    "node_modules",
    "target",
    "dist",
    "build",
    ".cache",
    "__pycache__",
];

/// Where a changed path sits. Inside a git directory (the repository's own or the shared
/// one): `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `packed-refs`, `refs/**`, `logs/**`, an operation's
/// state (`MERGE_HEAD` and the other pseudo-refs, `rebase-merge/`, `rebase-apply/`,
/// `sequencer/`, `BISECT_*`) and the configuration are refs; `index` is the index;
/// `worktrees/**` is worktrees; `info/exclude`, `info/sparse-checkout` and a submodule's
/// `HEAD` or `index` under `modules/` are a status change without a path; lock files and everything else there (objects, hooks) are ignored. Under
/// the working tree: a repository-relative path, except noisy folders and lock files.
fn classify(bases: &WatchBases, path: &Path) -> Option<Classified> {
    let under = |base: &Path, real: &Path| strip(path, base).or_else(|| strip(path, real));
    if let Some(inside) = under(&bases.gitdir, &bases.real.gitdir)
        .or_else(|| under(&bases.commondir, &bases.real.commondir))
    {
        return classify_git(&inside);
    }
    let inside = under(&bases.root, &bases.real.root)?;
    if inside.first().is_some_and(|first| first == ".git") {
        return classify_git(&inside[1..]);
    }
    let last = inside.last()?;
    if last.ends_with(".lock") && inside.len() == 1 && last == "index.lock" {
        return None;
    }
    if inside
        .first()
        .is_some_and(|first| NOISY.contains(&first.as_str()))
    {
        return None;
    }
    Some(Classified::Status(inside.join("/")))
}

/// Components of `path` below `base`, as strings; `None` when `path` is not below `base`.
fn strip(path: &Path, base: &Path) -> Option<Vec<String>> {
    let relative = path.strip_prefix(base).ok()?;
    Some(
        relative
            .components()
            .filter_map(|c| match c {
                Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect(),
    )
}

fn classify_git(inside: &[String]) -> Option<Classified> {
    let first = inside.first()?;
    if inside.last().is_some_and(|last| last.ends_with(".lock")) {
        return None;
    }
    match first.as_str() {
        "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "packed-refs" | "refs" | "logs" => {
            Some(Classified::Refs)
        }
        // The state of an operation in progress: pseudo-refs, and the folders and files of a
        // rebase, a cherry-pick or revert sequence and a bisect. `--quit` removes only these.
        "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "REBASE_HEAD" | "AUTO_MERGE"
        | "rebase-merge" | "rebase-apply" | "sequencer" => Some(Classified::Refs),
        name if name.starts_with("BISECT_") => Some(Classified::Refs),
        // The remotes and the upstreams, which the refs listing reads.
        "config" | "config.worktree" => Some(Classified::Refs),
        "index" => Some(Classified::Index),
        "worktrees" => Some(Classified::Worktrees),
        // The rules that decide which working files are ignored or checked out.
        "info"
            if matches!(
                inside.get(1).map(String::as_str),
                Some("exclude" | "sparse-checkout")
            ) =>
        {
            Some(Classified::StatusRules)
        }
        // A submodule's own HEAD or index: the parent lists the submodule as changed even
        // when none of its files moved (a `git -C sub reset --soft`).
        "modules" if matches!(inside.last().map(String::as_str), Some("HEAD" | "index")) => {
            Some(Classified::StatusRules)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_git_metadata_and_working_tree_paths() {
        let bases = WatchBases::main(Path::new("/r"));
        let root = bases.root.clone();
        let mut batch = Batch::default();
        batch.add(&bases, Path::new("/r/.git/HEAD"));
        batch.add(&bases, Path::new("/r/.git/refs/heads/main"));
        batch.add(&bases, Path::new("/r/.git/refs/heads/main.lock"));
        batch.add(&bases, Path::new("/r/.git/objects/ab/cdef"));
        batch.add(&bases, Path::new("/r/.git/index"));
        batch.add(&bases, Path::new("/r/.git/worktrees/feature/HEAD"));
        batch.add(&bases, Path::new("/r/src/app.ts"));
        batch.add(&bases, Path::new("/r/src/app.ts"));
        batch.add(&bases, Path::new("/r/deep/dir/file.rs"));
        batch.add(&bases, Path::new("/r/Cargo.lock"));
        batch.add(&bases, Path::new("/r/index.lock"));
        batch.add(&bases, Path::new("/r/.git/index.lock"));
        batch.add(&bases, Path::new("/r/target/debug/begitra.exe"));
        batch.add(&bases, Path::new("/elsewhere/file"));
        let payload = batch.take(&root).expect("payload");
        assert_eq!(
            payload.kinds,
            vec![
                RepoChangeKind::Refs,
                RepoChangeKind::Index,
                RepoChangeKind::Worktrees,
                RepoChangeKind::Status
            ]
        );
        assert_eq!(
            payload.paths,
            vec!["Cargo.lock", "deep/dir/file.rs", "src/app.ts"]
        );
        assert!(batch.take(&root).is_none());
        // A ref lock alone is not a change.
        batch.add(&bases, Path::new("/r/.git/refs/heads/main.lock"));
        assert!(batch.take(&root).is_none());
    }

    #[test]
    fn an_operations_state_the_configuration_and_the_rules_are_classified() {
        let bases = WatchBases::main(Path::new("/r"));
        let refs = [
            "/r/.git/MERGE_HEAD",
            "/r/.git/CHERRY_PICK_HEAD",
            "/r/.git/REVERT_HEAD",
            "/r/.git/REBASE_HEAD",
            "/r/.git/AUTO_MERGE",
            "/r/.git/rebase-merge/done",
            "/r/.git/rebase-apply/next",
            "/r/.git/sequencer/todo",
            "/r/.git/BISECT_LOG",
            "/r/.git/config",
        ];
        for path in refs {
            let mut batch = Batch::default();
            batch.add(&bases, Path::new(path));
            let payload = batch.take(&bases.root).expect(path);
            assert_eq!(payload.kinds, vec![RepoChangeKind::Refs], "{path}");
        }
        for path in [
            "/r/.git/info/exclude",
            "/r/.git/info/sparse-checkout",
            "/r/.git/modules/sub/HEAD",
            "/r/.git/modules/sub/modules/nested/index",
        ] {
            let mut batch = Batch::default();
            batch.add(&bases, Path::new("/r/src/app.ts"));
            batch.add(&bases, Path::new(path));
            let payload = batch.take(&bases.root).expect(path);
            assert_eq!(payload.kinds, vec![RepoChangeKind::Status], "{path}");
            // Any working file may show or hide: the event names none.
            assert!(payload.paths.is_empty(), "{path}");
        }
        let mut batch = Batch::default();
        for path in [
            "/r/.git/COMMIT_EDITMSG",
            "/r/.git/MERGE_MSG",
            "/r/.git/hooks/pre-commit",
            "/r/.git/info/attributes",
            "/r/.git/config.lock",
            "/r/.git/modules/sub/objects/ab/cdef",
            "/r/.git/modules/sub/refs/remotes/origin/main",
        ] {
            batch.add(&bases, Path::new(path));
        }
        assert!(batch.take(&bases.root).is_none());
    }

    #[test]
    fn a_linked_worktree_reads_its_own_gitdir_and_the_shared_refs() {
        let bases = WatchBases::new(
            PathBuf::from("/wt/feature"),
            PathBuf::from("/main/.git/worktrees/feature"),
            PathBuf::from("/main/.git"),
        );
        let mut batch = Batch::default();
        batch.add(&bases, Path::new("/main/.git/worktrees/feature/HEAD"));
        batch.add(&bases, Path::new("/main/.git/worktrees/feature/index"));
        batch.add(&bases, Path::new("/main/.git/refs/heads/feature"));
        batch.add(&bases, Path::new("/wt/feature/src/lib.rs"));
        let payload = batch.take(&bases.root).expect("payload");
        assert_eq!(
            payload.kinds,
            vec![
                RepoChangeKind::Refs,
                RepoChangeKind::Index,
                RepoChangeKind::Status
            ]
        );
        assert_eq!(payload.paths, vec!["src/lib.rs"]);
    }

    #[test]
    fn too_many_paths_keep_the_kinds_and_drop_the_list() {
        let bases = WatchBases::main(Path::new("/r"));
        let mut batch = Batch::default();
        for i in 0..(MAX_PATHS + 10) {
            batch.add(&bases, &bases.root.join(format!("f{i}.txt")));
        }
        let payload = batch.take(&bases.root).expect("payload");
        assert_eq!(payload.kinds, vec![RepoChangeKind::Status]);
        assert!(payload.paths.is_empty());
        batch.add_everything();
        let payload = batch.take(&bases.root).expect("payload");
        assert_eq!(payload.kinds.len(), 4);
    }

    #[test]
    fn a_real_watcher_debounces_a_burst_into_one_event_and_drops_fast() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join(".git").join("refs").join("heads")).expect("mkdir");
        let (tx, rx) = mpsc::channel();
        let watcher = RepoWatcher::start(WatchBases::main(&root), move |payload| {
            let _ = tx.send(payload);
        })
        .expect("watcher starts");
        // Let the platform watcher settle before writing.
        thread::sleep(Duration::from_millis(200));
        for i in 0..20 {
            std::fs::write(root.join(format!("file-{i}.txt")), b"x").expect("write");
        }
        std::fs::write(
            root.join(".git").join("refs").join("heads").join("main"),
            b"abc",
        )
        .expect("ref");
        // What is under test is the debouncing: twenty-one changes must not become
        // twenty-one events. How many batches the platform watcher needs for them is its
        // own business — a loaded runner splits the burst (inotify) or takes seconds to
        // deliver the first batch (FSEvents) — so the events are collected for a while and
        // judged together: few of them, and between them the whole burst.
        let mut events = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(payload) => {
                    events.push(payload);
                    // One more window after the first batch, in case the burst was split.
                    if let Ok(more) = rx.recv_timeout(Duration::from_millis(500)) {
                        events.push(more);
                    }
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(!events.is_empty(), "an event within fifteen seconds");
        assert!(
            events.len() <= 3,
            "the burst was debounced, not forwarded one by one: {} events",
            events.len()
        );
        let kinds: Vec<RepoChangeKind> = events.iter().flat_map(|e| e.kinds.clone()).collect();
        assert!(kinds.contains(&RepoChangeKind::Status), "{events:?}");
        assert!(kinds.contains(&RepoChangeKind::Refs), "{events:?}");
        assert!(
            events
                .iter()
                .any(|e| e.paths.iter().any(|p| p == "file-0.txt")),
            "{events:?}"
        );
        // The drop must not wait for a debounce cycle or a hung thread; the bound is loose
        // because the platform watcher's own shutdown takes a few hundred milliseconds on
        // a loaded machine (the pre-commit hook runs clippy alongside the tests).
        let started = Instant::now();
        drop(watcher);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "drop is quick: {:?}",
            started.elapsed()
        );
    }
}
