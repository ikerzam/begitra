//! Per-process state: open engines by repository root, walk handles by id, and the operation
//! registry. Cloning the state clones a handle to the same maps, so commands can move it into
//! blocking closures.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use git_core::engine::{CommitWalk, GitEngine};
use git_core::error::GitResult;
use git_core::git2_engine::Git2Engine;
use repo_index::Index;
use syntax::Highlight;

use crate::error::AppError;
use crate::ops::Operations;
use crate::watcher::RepoWatcher;

/// Walk handles idle for longer than this are dropped.
pub const WALK_IDLE_LIMIT: Duration = Duration::from_secs(5 * 60);

/// What [`AppState::close`] removed, to be dropped off the async runtime.
pub struct Closed {
    /// The engine, when the repository was open.
    pub engine: Option<Arc<Git2Engine>>,
    /// Its walk handles that were not in use.
    pub walks: Vec<Box<dyn CommitWalk>>,
    /// Its filesystem watcher, when it was the watched repository.
    pub watcher: Option<RepoWatcher>,
}

/// A stored walk: the handle, its repository, and when it was last used.
struct WalkEntry {
    walk: Option<Box<dyn CommitWalk>>,
    repo: PathBuf,
    last_used: Instant,
}

#[derive(Default)]
struct Inner {
    ops: Operations,
    engines: Mutex<HashMap<PathBuf, Arc<Git2Engine>>>,
    walks: Mutex<HashMap<String, WalkEntry>>,
    next_walk: AtomicU64,
    /// The repository index; in memory until [`AppState::open_index`] points it at a file.
    index: Mutex<Option<Index>>,
    /// The watcher of the open repository, and the start that may replace it.
    watcher: Mutex<WatchSlot>,
    /// The folder view's watchers, beside the open repository's.
    folder_watchers: Mutex<FolderWatchers>,
    /// The token classes of the last files viewed, per repository, keyed by path and content.
    highlights: Mutex<HashMap<PathBuf, VecDeque<CachedHighlight>>>,
    /// The day file the log is written to, once the folder is resolved.
    log_file: Mutex<Option<PathBuf>>,
}

/// The watcher of the open repository and the start in flight. A start walks the whole tree
/// before it can be installed (seconds on a large tree on Linux, and notify cannot cancel
/// it), so a later start, or a close of the repository it is for, must win over it
/// when it ends: otherwise the app would watch one repository while it shows another.
#[derive(Default)]
struct WatchSlot {
    /// The running watcher and its root.
    running: Option<(PathBuf, RepoWatcher)>,
    /// The repository of the latest start, while it runs.
    pending: Option<PathBuf>,
    /// Bumped by every start, and by a close of the repository the latest start is for.
    generation: u64,
}

/// Most watchers the folder view keeps: the repositories after the first ones in
/// its order read again on the window's focus instead.
pub const FOLDER_WATCH_LIMIT: usize = 20;

/// The folder view's watchers, one per repository of the view but the open one, and the
/// generation that lets a later sync, or leaving the view, win over starts still running.
#[derive(Default)]
struct FolderWatchers {
    running: HashMap<PathBuf, RepoWatcher>,
    /// Bumped by every sync and when the view stops its watchers.
    generation: u64,
}

/// What a folder sync leaves to its caller: the roots to start, installed through
/// [`AppState::install_folder_watcher`] with `ticket`, and the watchers it took out, to drop
/// off the async runtime.
pub struct FolderSync {
    /// The sync's generation.
    pub ticket: u64,
    /// Roots to watch that have no watcher yet, in the order given.
    pub start: Vec<PathBuf>,
    /// Watchers of roots the sync left out.
    pub dropped: Vec<RepoWatcher>,
}

/// One cached highlight with the bytes it holds.
struct CachedHighlight {
    key: String,
    bytes: usize,
    highlight: Arc<Highlight>,
}

/// Highlights kept per repository.
const HIGHLIGHT_CACHE: usize = 32;
/// Bytes of tokens the highlights of one process may hold together (the budget keeps the
/// idle footprint under 200 MB; a dense 50,000-line file is about 10 MB).
const HIGHLIGHT_CACHE_BYTES: usize = 48 * 1024 * 1024;

/// Heap bytes a highlight holds: the token vectors and one header per line.
fn highlight_bytes(highlight: &Highlight) -> usize {
    highlight
        .lines
        .iter()
        .map(|line| {
            std::mem::size_of::<Vec<syntax::Token>>()
                + line.capacity() * std::mem::size_of::<syntax::Token>()
        })
        .sum()
}

/// Shared application state managed by Tauri.
#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<Inner>,
}

impl AppState {
    /// The operation registry.
    pub fn ops(&self) -> &Operations {
        &self.inner.ops
    }

    /// Records the log file the subscriber writes to.
    pub fn set_log_file(&self, path: PathBuf) {
        let mut slot = self
            .inner
            .log_file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(path);
    }

    /// The log file the subscriber writes to, when one was attached.
    pub fn log_file(&self) -> Option<PathBuf> {
        self.inner
            .log_file
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The cached token classes of `key` in the repository at `root`; the handle is cloned
    /// under the lock, never the tokens.
    pub fn cached_highlight(&self, root: &Path, key: &str) -> Option<Arc<Highlight>> {
        let cache = self
            .inner
            .highlights
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache
            .get(root)?
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| Arc::clone(&entry.highlight))
    }

    /// Remembers the token classes of `key`, dropping the oldest entries beyond the count
    /// per repository and beyond the byte bound of the process.
    pub fn cache_highlight(&self, root: &Path, key: String, highlight: Arc<Highlight>) {
        let bytes = highlight_bytes(&highlight);
        let mut cache = self
            .inner
            .highlights
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entries = cache.entry(root.to_path_buf()).or_default();
        entries.retain(|entry| entry.key != key);
        entries.push_back(CachedHighlight {
            key,
            bytes,
            highlight,
        });
        while entries.len() > HIGHLIGHT_CACHE {
            entries.pop_front();
        }
        // The byte bound is per process: the oldest entry of the fullest repository goes
        // first, so the one just added is the last of its repository to go.
        let mut total: usize = cache.values().flatten().map(|entry| entry.bytes).sum();
        while total > HIGHLIGHT_CACHE_BYTES {
            let fullest = cache
                .iter_mut()
                .max_by_key(|(_, entries)| entries.iter().map(|entry| entry.bytes).sum::<usize>());
            let Some((_, entries)) = fullest else {
                break;
            };
            match entries.pop_front() {
                Some(dropped) => total -= dropped.bytes,
                None => break,
            }
        }
        cache.retain(|_, entries| !entries.is_empty());
    }

    /// Bytes of tokens the highlight cache holds.
    #[cfg(test)]
    fn highlight_cache_bytes(&self) -> usize {
        self.inner
            .highlights
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .flatten()
            .map(|entry| entry.bytes)
            .sum()
    }

    /// Opens the index database at `path` (created and migrated when missing), replacing the
    /// in-memory one. Blocking: call from `spawn_blocking` or setup.
    pub fn open_index(&self, path: &Path) -> Result<(), AppError> {
        let index = Index::open(path)?;
        let mut slot = self
            .inner
            .index
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(index);
        Ok(())
    }

    /// Runs `f` with the index, opening an in-memory one on first use when no file was set.
    /// Blocking: SQLite calls run inline.
    pub fn with_index<T>(
        &self,
        f: impl FnOnce(&Index) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut slot = self
            .inner
            .index
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(Index::in_memory()?);
        }
        match slot.as_ref() {
            Some(index) => f(index),
            None => Err(AppError::internal("the index could not be opened")),
        }
    }

    fn watch_slot(&self) -> std::sync::MutexGuard<'_, WatchSlot> {
        self.inner
            .watcher
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether `root` is the repository being watched, with no other start in flight.
    pub fn is_watching(&self, root: &Path) -> bool {
        let slot = self.watch_slot();
        slot.pending.is_none()
            && slot
                .running
                .as_ref()
                .is_some_and(|(watched, _)| watched == root)
    }

    /// Begins a watcher start for `root`: the ticket installs it through
    /// [`AppState::install_watcher`] unless a later start, or a close of `root`, came first.
    pub fn begin_watch(&self, root: &Path) -> u64 {
        let mut slot = self.watch_slot();
        slot.generation += 1;
        slot.pending = Some(root.to_path_buf());
        slot.generation
    }

    /// Installs `watcher` for `root` when `ticket` is still the latest start. Returns the
    /// watcher to drop off the async runtime: the one replaced, or `watcher` itself when it
    /// came too late.
    pub fn install_watcher(
        &self,
        ticket: u64,
        root: PathBuf,
        watcher: RepoWatcher,
    ) -> Option<RepoWatcher> {
        let mut slot = self.watch_slot();
        if slot.generation != ticket {
            return Some(watcher);
        }
        slot.pending = None;
        slot.running
            .replace((root, watcher))
            .map(|(_, previous)| previous)
    }

    /// Ends the start that `ticket` began when the platform refused it. Returns whether it
    /// was still the latest start (a superseded one concerns nothing the app shows) and, when
    /// it was, the watcher of the repository shown before, which goes too since the app
    /// ignores its events: to be dropped off the async runtime.
    pub fn abandon_watch(&self, ticket: u64) -> (bool, Option<RepoWatcher>) {
        let mut slot = self.watch_slot();
        if slot.generation != ticket {
            return (false, None);
        }
        slot.pending = None;
        (true, slot.running.take().map(|(_, previous)| previous))
    }

    /// Removes the watcher of `root`, if that is the one running, and supersedes a start in
    /// flight for it; returned to be dropped off the async runtime.
    pub fn take_watcher(&self, root: &Path) -> Option<(PathBuf, RepoWatcher)> {
        let mut slot = self.watch_slot();
        if slot.pending.as_deref() == Some(root) {
            slot.generation += 1;
            slot.pending = None;
        }
        if slot
            .running
            .as_ref()
            .is_some_and(|(watched, _)| watched == root)
        {
            slot.running.take()
        } else {
            None
        }
    }

    fn folder_watchers(&self) -> std::sync::MutexGuard<'_, FolderWatchers> {
        self.inner
            .folder_watchers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The roots the open repository's slot watches or is starting to watch.
    fn slot_roots(&self) -> Vec<PathBuf> {
        let slot = self.watch_slot();
        slot.running
            .iter()
            .map(|(root, _)| root.clone())
            .chain(slot.pending.clone())
            .collect()
    }

    /// Makes the folder watchers follow `roots`: the first [`FOLDER_WATCH_LIMIT`] distinct
    /// roots are to be watched, but the one the open repository's slot watches or starts,
    /// which keeps its own; the watchers of the other roots are taken out. Every sync
    /// supersedes the starts of the ones before it.
    pub fn begin_folder_sync(&self, roots: &[PathBuf]) -> FolderSync {
        let open = self.slot_roots();
        let mut listed: Vec<&PathBuf> = Vec::with_capacity(FOLDER_WATCH_LIMIT);
        for root in roots {
            if listed.len() == FOLDER_WATCH_LIMIT {
                break;
            }
            if !listed.contains(&root) {
                listed.push(root);
            }
        }
        let wanted: Vec<PathBuf> = listed
            .into_iter()
            .filter(|root| !open.contains(root))
            .cloned()
            .collect();
        let mut folders = self.folder_watchers();
        folders.generation += 1;
        let mut dropped = Vec::new();
        for (root, watcher) in std::mem::take(&mut folders.running) {
            if wanted.contains(&root) {
                folders.running.insert(root, watcher);
            } else {
                dropped.push(watcher);
            }
        }
        let start = wanted
            .into_iter()
            .filter(|root| !folders.running.contains_key(root))
            .collect();
        FolderSync {
            ticket: folders.generation,
            start,
            dropped,
        }
    }

    /// Whether `ticket` is still the latest folder sync, so its starts are worth running.
    pub fn folder_sync_current(&self, ticket: u64) -> bool {
        self.folder_watchers().generation == ticket
    }

    /// Installs the folder watcher of `root` when `ticket` is still the latest sync and the
    /// open repository's slot does not watch `root` meanwhile. Returns the watcher to drop off
    /// the async runtime: `watcher` itself when it came too late.
    pub fn install_folder_watcher(
        &self,
        ticket: u64,
        root: PathBuf,
        watcher: RepoWatcher,
    ) -> Option<RepoWatcher> {
        if self.slot_roots().contains(&root) {
            return Some(watcher);
        }
        let mut folders = self.folder_watchers();
        if folders.generation != ticket {
            return Some(watcher);
        }
        folders.running.insert(root, watcher)
    }

    /// The roots the folder watchers watch, sorted.
    pub fn folder_watched(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self.folder_watchers().running.keys().cloned().collect();
        roots.sort();
        roots
    }

    /// Takes every folder watcher out, leaving the folder view, and supersedes the starts in
    /// flight; returned to be dropped off the async runtime.
    pub fn stop_folder_watchers(&self) -> Vec<RepoWatcher> {
        let mut folders = self.folder_watchers();
        folders.generation += 1;
        folders
            .running
            .drain()
            .map(|(_, watcher)| watcher)
            .collect()
    }

    /// Takes the folder watcher of `root` out, once the open repository's slot watches it.
    pub fn take_folder_watcher(&self, root: &Path) -> Option<RepoWatcher> {
        self.folder_watchers().running.remove(root)
    }

    /// Opens the repository containing `path`, or returns the engine already open for its
    /// root. Blocking: call from `spawn_blocking`.
    pub fn open(&self, path: &Path) -> GitResult<Arc<Git2Engine>> {
        if let Some(engine) = self.engine_for(path) {
            return Ok(engine);
        }
        let engine = Arc::new(Git2Engine::open(path)?);
        let root = engine.repo().root.clone();
        let mut engines = self
            .inner
            .engines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(Arc::clone(engines.entry(root).or_insert(engine)))
    }

    /// The engine whose root equals `path`, if one is open.
    pub fn engine_for(&self, path: &Path) -> Option<Arc<Git2Engine>> {
        let engines = self
            .inner
            .engines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        engines.get(path).map(Arc::clone)
    }

    /// Closes the engine rooted at `root` and takes its walks out of the state. Returns what
    /// was removed so the caller can drop it off the async runtime (freeing a libgit2
    /// repository is not instant on a large one), and `None` when nothing was open.
    pub fn close(&self, root: &Path) -> Option<Closed> {
        let engine = self
            .inner
            .engines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(root);
        let mut walks = self
            .inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut dropped = Vec::new();
        walks.retain(|_, entry| {
            if entry.repo == root {
                if let Some(walk) = entry.walk.take() {
                    dropped.push(walk);
                }
                false
            } else {
                true
            }
        });
        drop(walks);
        self.inner
            .highlights
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(root);
        let watcher = self.take_watcher(root).map(|(_, watcher)| watcher);
        if engine.is_none() && dropped.is_empty() && watcher.is_none() {
            return None;
        }
        Some(Closed {
            engine,
            walks: dropped,
            watcher,
        })
    }

    /// Number of open engines.
    pub fn open_count(&self) -> usize {
        self.inner
            .engines
            .lock()
            .map(|engines| engines.len())
            .unwrap_or(0)
    }

    /// A fresh walk id.
    pub fn new_walk_id(&self) -> String {
        let n = self.inner.next_walk.fetch_add(1, Ordering::Relaxed) + 1;
        format!("walk-{n}")
    }

    /// Stores a walk handle under `walk_id` for later continuation.
    pub fn store_walk(&self, walk_id: &str, repo: PathBuf, walk: Box<dyn CommitWalk>) {
        let mut walks = self
            .inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        walks.insert(
            walk_id.to_owned(),
            WalkEntry {
                walk: Some(walk),
                repo,
                last_used: Instant::now(),
            },
        );
    }

    /// Takes the walk handle out for use; the entry stays reserved until [`AppState::put_walk`]
    /// or [`AppState::drop_walk`]. Fails with `op.unknown_walk` when the id is unknown, was
    /// evicted, or is in use.
    pub fn take_walk(&self, walk_id: &str) -> Result<(PathBuf, Box<dyn CommitWalk>), AppError> {
        let mut walks = self
            .inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = walks
            .get_mut(walk_id)
            .ok_or_else(|| AppError::unknown_walk(walk_id))?;
        let walk = entry
            .walk
            .take()
            .ok_or_else(|| AppError::unknown_walk(walk_id))?;
        entry.last_used = Instant::now();
        Ok((entry.repo.clone(), walk))
    }

    /// Returns a walk handle taken with [`AppState::take_walk`].
    pub fn put_walk(&self, walk_id: &str, walk: Box<dyn CommitWalk>) {
        let mut walks = self
            .inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = walks.get_mut(walk_id) {
            entry.walk = Some(walk);
            entry.last_used = Instant::now();
        }
    }

    /// Takes a walk handle out of the state; `None` when it did not exist. The caller drops
    /// it off the async runtime.
    pub fn drop_walk(&self, walk_id: &str) -> Option<Option<Box<dyn CommitWalk>>> {
        self.inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(walk_id)
            .map(|entry| entry.walk)
    }

    /// Takes the walks idle for longer than `limit` out of the state and returns them, so the
    /// caller drops them off the async runtime.
    pub fn evict_idle_walks(&self, limit: Duration) -> Vec<Box<dyn CommitWalk>> {
        let mut walks = self
            .inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let mut evicted = Vec::new();
        walks.retain(|_, entry| {
            let idle = entry.walk.is_some() && now.duration_since(entry.last_used) >= limit;
            if idle {
                if let Some(walk) = entry.walk.take() {
                    evicted.push(walk);
                }
            }
            !idle
        });
        evicted
    }

    /// Number of stored walks.
    pub fn walk_count(&self) -> usize {
        self.inner
            .walks
            .lock()
            .map(|walks| walks.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use git_core::engine::Cancel;
    use git_core::types::Page;

    use super::*;
    use crate::error::codes;

    struct FakeWalk;

    impl CommitWalk for FakeWalk {
        fn next_page(&mut self, _cancel: &Cancel) -> GitResult<Page> {
            Ok(Page {
                commits: Vec::new(),
                done: true,
            })
        }
    }

    #[test]
    fn a_watcher_start_that_came_too_late_is_dropped_not_installed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).expect("a");
        std::fs::create_dir_all(&b).expect("b");
        let start = |root: &Path| {
            RepoWatcher::start(crate::watcher::WatchBases::main(root), |_| {}).expect("watcher")
        };
        let state = AppState::default();
        // A opens, then B while A's start still walks its tree: B's ends first and stays.
        let slow = state.begin_watch(&a);
        let fast = state.begin_watch(&b);
        assert!(state.install_watcher(fast, b.clone(), start(&b)).is_none());
        assert!(state.install_watcher(slow, a.clone(), start(&a)).is_some());
        assert!(state.is_watching(&b));
        assert!(!state.is_watching(&a));
        // B closes while a start for it is in flight: that start installs nothing.
        let restart = state.begin_watch(&b);
        assert!(!state.is_watching(&b), "a start is in flight");
        assert!(state.take_watcher(&b).is_some());
        assert!(state
            .install_watcher(restart, b.clone(), start(&b))
            .is_some());
        assert!(!state.is_watching(&b));
        // A close of another repository (an abandoned open) leaves the start alone.
        let current = state.begin_watch(&b);
        assert!(state.take_watcher(&a).is_none());
        assert!(state
            .install_watcher(current, b.clone(), start(&b))
            .is_none());
        assert!(state.is_watching(&b));
        // A refused start takes the watcher of the repository shown before with it; one
        // that a later start superseded concerns nothing.
        let superseded = state.begin_watch(&b);
        let refused = state.begin_watch(&a);
        assert!(matches!(state.abandon_watch(superseded), (false, None)));
        let (latest, previous) = state.abandon_watch(refused);
        assert!(latest && previous.is_some());
        assert!(!state.is_watching(&b));
    }

    /// A watcher of `root` that reports nothing.
    fn watcher_of(root: &Path) -> RepoWatcher {
        RepoWatcher::start(crate::watcher::WatchBases::main(root), |_| {}).expect("watcher")
    }

    /// Folders `names` created under `dir`.
    fn folders(dir: &Path, names: &[String]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| {
                let path = dir.join(name);
                std::fs::create_dir_all(&path).expect("folder");
                path
            })
            .collect()
    }

    /// A folder sync run to its end as `watch_folder` runs it; answers how many watchers it
    /// took out.
    fn sync(state: &AppState, roots: &[PathBuf]) -> usize {
        let sync = state.begin_folder_sync(roots);
        for root in sync.start {
            let watcher = watcher_of(&root);
            assert!(state
                .install_folder_watcher(sync.ticket, root, watcher)
                .is_none());
        }
        sync.dropped.len()
    }

    #[test]
    fn folder_watchers_follow_the_roots_up_to_the_cap() {
        let dir = tempfile::tempdir().expect("temp dir");
        let names: Vec<String> = (0..22).map(|i| format!("r{i:02}")).collect();
        let roots = folders(dir.path(), &names);
        let state = AppState::default();
        assert_eq!(sync(&state, &roots), 0);
        // The first twenty in the order given are watched, the last two are not.
        assert_eq!(state.folder_watched(), roots[..FOLDER_WATCH_LIMIT].to_vec());
        // Another list: the roots it leaves out stop, the ones it adds start, the rest stay,
        // and a root given twice counts once.
        let mut next = roots[5..].to_vec();
        next.push(roots[5].clone());
        assert_eq!(sync(&state, &next), 5);
        assert_eq!(state.folder_watched(), roots[5..].to_vec());
        // Leaving the view stops them all.
        assert_eq!(state.stop_folder_watchers().len(), 17);
        assert!(state.folder_watched().is_empty());
    }

    #[test]
    fn the_open_repository_keeps_its_own_watcher_and_gets_no_folder_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let roots = folders(
            dir.path(),
            &["a".to_owned(), "b".to_owned(), "c".to_owned()],
        );
        let (a, b, c) = (roots[0].clone(), roots[1].clone(), roots[2].clone());
        let state = AppState::default();
        let ticket = state.begin_watch(&a);
        assert!(state
            .install_watcher(ticket, a.clone(), watcher_of(&a))
            .is_none());
        sync(&state, &roots);
        assert_eq!(state.folder_watched(), vec![b.clone(), c.clone()]);
        // b opens: its own watcher replaces a's, and its folder watcher goes.
        let ticket = state.begin_watch(&b);
        assert!(state
            .install_watcher(ticket, b.clone(), watcher_of(&b))
            .is_some());
        assert!(state.take_folder_watcher(&b).is_some());
        assert!(state.take_folder_watcher(&b).is_none());
        assert_eq!(state.folder_watched(), vec![c.clone()]);
        // The next sync watches a again and leaves b to its own.
        sync(&state, &roots);
        assert_eq!(state.folder_watched(), vec![a, c]);
    }

    #[test]
    fn a_folder_start_that_came_too_late_is_dropped_not_installed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let roots = folders(dir.path(), &["a".to_owned(), "b".to_owned()]);
        let (a, b) = (roots[0].clone(), roots[1].clone());
        let state = AppState::default();
        // A second sync while the first one's starts run: the first one's go.
        let first = state.begin_folder_sync(std::slice::from_ref(&a));
        let second = state.begin_folder_sync(std::slice::from_ref(&b));
        assert!(!state.folder_sync_current(first.ticket));
        assert!(state.folder_sync_current(second.ticket));
        assert!(state
            .install_folder_watcher(first.ticket, a.clone(), watcher_of(&a))
            .is_some());
        assert!(state
            .install_folder_watcher(second.ticket, b.clone(), watcher_of(&b))
            .is_none());
        // Leaving the view while a start runs: it installs nothing.
        let late = state.begin_folder_sync(&roots);
        assert_eq!(late.start, vec![a.clone()]);
        assert_eq!(state.stop_folder_watchers().len(), 1);
        assert!(state
            .install_folder_watcher(late.ticket, a.clone(), watcher_of(&a))
            .is_some());
        assert!(state.folder_watched().is_empty());
        // A root that the open repository started to watch meanwhile gets no second watcher.
        let sync = state.begin_folder_sync(std::slice::from_ref(&a));
        state.begin_watch(&a);
        assert!(state
            .install_folder_watcher(sync.ticket, a.clone(), watcher_of(&a))
            .is_some());
        assert!(state.folder_watched().is_empty());
    }

    #[test]
    fn walks_are_taken_put_back_and_dropped() {
        let state = AppState::default();
        let id = state.new_walk_id();
        assert_eq!(id, "walk-1");
        state.store_walk(&id, PathBuf::from("/r"), Box::new(FakeWalk));
        assert_eq!(state.walk_count(), 1);

        let (repo, walk) = state.take_walk(&id).expect("taken");
        assert_eq!(repo, PathBuf::from("/r"));
        assert_eq!(
            state.take_walk(&id).err().map(|e| e.code),
            Some(codes::OP_UNKNOWN_WALK.to_owned())
        );
        state.put_walk(&id, walk);
        assert!(state.take_walk(&id).is_ok());

        assert!(state.drop_walk(&id).is_some());
        assert!(state.drop_walk(&id).is_none());
        assert_eq!(
            state.take_walk(&id).err().map(|e| e.code),
            Some(codes::OP_UNKNOWN_WALK.to_owned())
        );
    }

    #[test]
    fn idle_walks_are_evicted_and_closing_a_repo_drops_its_walks() {
        let state = AppState::default();
        let a = state.new_walk_id();
        let b = state.new_walk_id();
        state.store_walk(&a, PathBuf::from("/a"), Box::new(FakeWalk));
        state.store_walk(&b, PathBuf::from("/b"), Box::new(FakeWalk));
        assert!(state.evict_idle_walks(Duration::from_secs(60)).is_empty());
        assert_eq!(state.evict_idle_walks(Duration::ZERO).len(), 2);
        assert_eq!(state.walk_count(), 0);

        state.store_walk(&a, PathBuf::from("/a"), Box::new(FakeWalk));
        let closed = state.close(Path::new("/a")).expect("a walk was dropped");
        assert!(closed.engine.is_none());
        assert_eq!(closed.walks.len(), 1);
        assert!(state.close(Path::new("/a")).is_none());
        assert_eq!(state.walk_count(), 0);
    }

    /// A highlight of `lines` lines with `per_line` tokens each.
    fn highlight_of(lines: usize, per_line: usize) -> Arc<Highlight> {
        let token = syntax::Token {
            start: 0,
            end: 1,
            class: syntax::TokenClass::Keyword,
        };
        Arc::new(Highlight {
            syntax: Some("Rust".to_owned()),
            lines: (0..lines).map(|_| vec![token.clone(); per_line]).collect(),
            complete: true,
        })
    }

    #[test]
    fn highlights_are_keyed_replaced_bounded_and_dropped_with_the_repository() {
        let state = AppState::default();
        let root = Path::new("/a");
        state.cache_highlight(root, "a.rs:1".to_owned(), highlight_of(2, 1));
        let first = state.cached_highlight(root, "a.rs:1").expect("cached");
        assert_eq!(first.lines.len(), 2);
        assert!(state.cached_highlight(root, "a.rs:2").is_none());
        // The same key replaces the entry rather than adding one.
        state.cache_highlight(root, "a.rs:1".to_owned(), highlight_of(3, 1));
        assert_eq!(
            state
                .cached_highlight(root, "a.rs:1")
                .expect("replaced")
                .lines
                .len(),
            3
        );
        let bytes_of_three = state.highlight_cache_bytes();
        // The count bound per repository keeps the newest 32.
        for i in 0..40 {
            state.cache_highlight(root, format!("f{i}.rs"), highlight_of(1, 1));
        }
        assert!(state.cached_highlight(root, "a.rs:1").is_none());
        assert!(state.cached_highlight(root, "f7.rs").is_none());
        assert!(state.cached_highlight(root, "f8.rs").is_some());
        assert!(state.highlight_cache_bytes() < bytes_of_three * 32);
        // The byte bound of the process evicts the oldest entries of the fullest repository.
        let dense = highlight_of(50_000, 20);
        assert!(highlight_bytes(&dense) > HIGHLIGHT_CACHE_BYTES / 4);
        for i in 0..6 {
            state.cache_highlight(Path::new("/b"), format!("d{i}.rs"), Arc::clone(&dense));
        }
        assert!(state.highlight_cache_bytes() <= HIGHLIGHT_CACHE_BYTES);
        assert!(state.cached_highlight(Path::new("/b"), "d0.rs").is_none());
        assert!(state.cached_highlight(Path::new("/b"), "d5.rs").is_some());
        // Closing a repository drops its highlights.
        state.close(Path::new("/b"));
        assert!(state.cached_highlight(Path::new("/b"), "d5.rs").is_none());
        assert!(state.cached_highlight(root, "f39.rs").is_some());
    }
}
