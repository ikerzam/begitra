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
    /// The noisy folders ([`NOISY`]) that hold tracked files, reported like any other folder:
    /// a committed `dist/` changes what git lists. Read from the index when the watch starts.
    tracked: Vec<String>,
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
        let tracked = self.tracked_folders(&NOISY).unwrap_or_else(|error| {
            tracing::warn!(%error, "the index could not tell which build folders are tracked");
            Vec::new()
        });
        WatchBases::new(self.repo().root.clone(), gitdir, commondir).with_tracked(tracked)
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
            tracked: Vec::new(),
        }
    }

    /// The same bases with the noisy folders that hold tracked files, which are then
    /// reported like any other folder.
    pub fn with_tracked(mut self, tracked: Vec<String>) -> Self {
        self.tracked = tracked;
        self
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
            // A read is not a change: inotify reports every open and close, and the app's own
            // reloads read the repository, so counting reads makes each reload start the next.
            Ok(Ok(event)) if matches!(event.kind, notify::EventKind::Access(_)) => {}
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
            Ok(Err(error)) => {
                tracing::warn!(error = %error, "watcher error");
                // A folder created past the platform's limit is not watched: what changes in
                // it is lost, so everything may have changed.
                if matches!(error.kind, notify::ErrorKind::MaxFilesWatch) {
                    batch.add_everything();
                    if deadline.is_none() {
                        deadline = Some(Instant::now() + DEBOUNCE);
                    }
                }
            }
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
            Classified::Config => {
                self.kinds.extend([Kind::Refs, Kind::Status]);
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
    /// The configuration: the remotes and upstreams, and settings that change the status.
    Config,
}

/// Folder names whose content is not reported as a working tree change: build outputs and
/// caches churn while nothing the user reviews changed. One that holds tracked files is
/// reported all the same ([`WatchBases::with_tracked`]).
const NOISY: [&str; 6] = [
    "node_modules",
    "target",
    "dist",
    "build",
    ".cache",
    "__pycache__",
];

/// Where a changed path sits. Inside a git directory (the repository's own or the shared
/// one): `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `packed-refs`, `refs/**`, `logs/**` and an
/// operation's state (`MERGE_HEAD` and the other pseudo-refs, `rebase-merge/`,
/// `rebase-apply/`, `sequencer/`, `BISECT_*`) are refs; the configuration is refs and a
/// status change; `index` is the index; `worktrees/**` is worktrees; `info/exclude`,
/// `info/sparse-checkout`, `info/attributes` and what a submodule has checked out under
/// `modules/` are a status change without a path; lock files and the rest (objects, hooks)
/// are ignored. Under the working tree: a repository-relative path, except the noisy
/// folders that hold no tracked file and git's lock files; a nested repository's `.git`
/// counts only for what it has checked out, as a change of its folder.
fn classify(bases: &WatchBases, path: &Path) -> Option<Classified> {
    let under = |base: &Path, real: &Path| strip(path, base).or_else(|| strip(path, real));
    if let Some(inside) = under(&bases.gitdir, &bases.real.gitdir)
        .or_else(|| under(&bases.commondir, &bases.real.commondir))
    {
        return classify_git(&inside);
    }
    let inside = under(&bases.root, &bases.real.root)?;
    if inside.first().is_some_and(|first| first == ".git") {
        return classify_git(inside.get(1..).unwrap_or_default());
    }
    if inside.first().is_some_and(|first| {
        NOISY.contains(&first.as_str()) && !bases.tracked.iter().any(|name| name == first)
    }) {
        return None;
    }
    // A repository nested in the tree keeps its own `.git` (a clone, a submodule that is not
    // absorbed). What it has checked out changes what git lists for its folder (a gitlink's
    // new commit, a folder that becomes a repository or stops being one); the rest of its
    // churn (objects, reflogs, fetches) does not.
    if let Some(at) = inside.iter().position(|component| component == ".git") {
        let folder = inside.get(..at).unwrap_or_default().join("/");
        return match inside.get(at + 1..).unwrap_or_default() {
            [] => Some(Classified::Status(folder)),
            [.., last] if last.ends_with(".lock") => None,
            below if submodule_checkout(below) => Some(Classified::Status(folder)),
            _ => None,
        };
    }
    let last = inside.last()?;
    if inside.len() == 1 && (last == "index.lock" || last == ".gitmodules.lock") {
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
        // The remotes and the upstreams, which the refs listing reads, and settings that
        // change the status (`core.excludesFile`, `status.showUntrackedFiles`).
        "config" | "config.worktree" => Some(Classified::Config),
        "index" => Some(Classified::Index),
        "worktrees" => Some(Classified::Worktrees),
        // The rules that decide which working files are ignored or checked out, and the
        // attributes that mark files generated or binary in the lists.
        "info"
            if matches!(
                inside.get(1).map(String::as_str),
                Some("exclude" | "sparse-checkout" | "attributes")
            ) =>
        {
            Some(Classified::StatusRules)
        }
        // What a submodule has checked out (its HEAD, its index, its branches): the parent
        // lists the submodule as changed even when none of its files moved (a
        // `git -C sub reset --soft`). Its reflogs, remote-tracking refs and objects are not.
        "modules" if submodule_checkout(inside) => Some(Classified::StatusRules),
        _ => None,
    }
}

/// Whether a path in a submodule's git directory is what it has checked out: a branch, or
/// its `HEAD`, `index` or `packed-refs` outside its remote-tracking refs and tags. Read from
/// the path's pairs, not from its first components, because a submodule's name may hold
/// `logs` or `refs` itself. Its reflog of HEAD counts too, written with HEAD.
fn submodule_checkout(inside: &[String]) -> bool {
    let through = |kind: &str| {
        inside
            .windows(2)
            .any(|pair| matches!(pair, [refs, next] if refs == "refs" && next == kind))
    };
    if through("heads") {
        return true;
    }
    matches!(
        inside.last().map(String::as_str),
        Some("HEAD" | "index" | "packed-refs")
    ) && !through("remotes")
        && !through("tags")
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
    fn a_build_folder_that_holds_tracked_files_is_reported() {
        let bases = WatchBases::main(Path::new("/r")).with_tracked(vec!["dist".to_owned()]);
        let mut batch = Batch::default();
        batch.add(&bases, Path::new("/r/dist/index.js"));
        batch.add(&bases, Path::new("/r/node_modules/dep/index.js"));
        let payload = batch.take(&bases.root).expect("payload");
        assert_eq!(payload.paths, vec!["dist/index.js"]);
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
            "/r/.git/info/attributes",
            "/r/.git/modules/sub/HEAD",
            "/r/.git/modules/sub/refs/heads/main",
            "/r/.git/modules/sub/modules/nested/index",
            "/r/.git/modules/services/logs/HEAD",
            "/r/.git/modules/docs/refs/index",
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
            "/r/.git/config.lock",
            "/r/.git/modules/sub/objects/ab/cdef",
            "/r/.git/modules/sub/refs/remotes/origin/HEAD",
            "/r/.git/modules/sub/refs/tags/v1",
            "/r/.git/modules/sub/logs/refs/remotes/origin/main",
            "/r/vendor/lib/.git/objects/ab/cdef",
            "/r/vendor/lib/.git/index.lock",
            "/r/vendor/lib/.git/FETCH_HEAD",
            "/r/node_modules/dep/.git/index",
            "/r/.gitmodules.lock",
        ] {
            batch.add(&bases, Path::new(path));
        }
        assert!(batch.take(&bases.root).is_none());
        // The configuration names the remotes and upstreams, and settings that change the
        // status.
        let mut batch = Batch::default();
        batch.add(&bases, Path::new("/r/.git/config"));
        let payload = batch.take(&bases.root).expect("config");
        assert_eq!(
            payload.kinds,
            vec![RepoChangeKind::Refs, RepoChangeKind::Status]
        );
        // A nested repository's checkout is a change of its folder: a commit there moves the
        // gitlink, and `git init` turns its files into one entry.
        for path in [
            "/r/vendor/lib/.git",
            "/r/vendor/lib/.git/index",
            "/r/vendor/lib/.git/HEAD",
            "/r/vendor/lib/.git/refs/heads/main",
        ] {
            let mut batch = Batch::default();
            batch.add(&bases, Path::new(path));
            let payload = batch.take(&bases.root).expect(path);
            assert_eq!(payload.kinds, vec![RepoChangeKind::Status], "{path}");
            assert_eq!(payload.paths, vec!["vendor/lib".to_owned()], "{path}");
        }
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
