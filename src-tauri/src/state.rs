//! Per-process state: open engines by repository root, walk handles by id, and the operation
//! registry. Cloning the state clones a handle to the same maps, so commands can move it into
//! blocking closures.

use std::collections::{HashMap, HashSet, VecDeque};
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
use crate::watcher::{RepoWatcher, WatchBases, WatchBasesExt};

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

/// The folder view's watchers: the roots its latest sync lists, the watchers running, and the
/// roots a start runs for, so that one start runs per root however many syncs come.
#[derive(Default)]
struct FolderWatchers {
    /// The first [`FOLDER_WATCH_LIMIT`] roots of the latest sync, the open repository's
    /// included; empty once the view has stopped its watchers.
    listed: Vec<PathBuf>,
    running: HashMap<PathBuf, RepoWatcher>,
    starting: HashSet<PathBuf>,
}

/// What a folder sync leaves to its caller: the roots it claimed, each to start
/// ([`AppState::run_folder_starts`]) or give up, and the watchers it took out, to drop off the
/// async runtime.
pub struct FolderSync {
    /// Roots to watch with no watcher and no start yet, in the order given.
    pub start: Vec<PathBuf>,
    /// Watchers of roots the sync left out.
    pub dropped: Vec<RepoWatcher>,
}

/// One cached highlight with the bytes it holds.
struct CachedHighlight {
    key: String,
    bytes: usize,
    highlight: Arc<Highlight>,
    /// Whether a cut-off answer had its one more try (see `highlight_file`).
    retried: bool,
}

/// Highlights with tokens kept per repository, the least recently used going first.
const HIGHLIGHT_CACHE: usize = 32;
/// Entries of any kind kept per repository: the answers without tokens (no known syntax)
/// weigh nothing and do not count against [`HIGHLIGHT_CACHE`], but stay bounded.
const HIGHLIGHT_CACHE_ENTRIES: usize = 256;
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

    /// The cached token classes of `key` in the repository at `root`, and whether a cut-off
    /// answer had its one more try; a hit becomes the most recently used entry, and the
    /// handle is cloned under the lock, never the tokens.
    pub fn cached_highlight(&self, root: &Path, key: &str) -> Option<(Arc<Highlight>, bool)> {
        let mut cache = self
            .inner
            .highlights
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entries = cache.get_mut(root)?;
        let at = entries.iter().position(|entry| entry.key == key)?;
        let entry = entries.remove(at)?;
        let hit = (Arc::clone(&entry.highlight), entry.retried);
        entries.push_back(entry);
        Some(hit)
    }

    /// Remembers the token classes of `key`, dropping the least recently used entries beyond
    /// the counts per repository and beyond the byte bound of the process.
    pub fn cache_highlight(
        &self,
        root: &Path,
        key: String,
        highlight: Arc<Highlight>,
        retried: bool,
    ) {
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
            retried,
        });
        while entries.iter().filter(|entry| entry.bytes > 0).count() > HIGHLIGHT_CACHE {
            match entries.iter().position(|entry| entry.bytes > 0) {
                Some(oldest) => {
                    entries.remove(oldest);
                }
                None => break,
            }
        }
        while entries.len() > HIGHLIGHT_CACHE_ENTRIES {
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
    /// [`AppState::finish_watch`] unless a later start, or a close of `root`, came first.
    pub fn begin_watch(&self, root: &Path) -> u64 {
        let mut slot = self.watch_slot();
        slot.generation += 1;
        slot.pending = Some(root.to_path_buf());
        slot.generation
    }

    /// Ends the slot's start that `ticket` began for `root`: `started` is what the platform
    /// answered, and `taken` the folder view's watcher of `root`, taken out for the start
    /// ([`AppState::take_folder_watcher`]). A watcher that started runs in the slot and the
    /// view's goes. A refused start falls back on the view's watcher, whose index changes read
    /// the lists whole, and reports the refusal only without one, taking the watcher of the
    /// repository shown before with it, since the app ignores its events. A start that another
    /// start or a close superseded reports nothing and gives the view's watcher back to the
    /// view. Returns the refusal to report and the watchers to drop off the async runtime.
    pub fn finish_watch(
        &self,
        ticket: u64,
        root: &Path,
        started: Result<RepoWatcher, notify::Error>,
        taken: Option<RepoWatcher>,
    ) -> (Option<notify::Error>, Vec<RepoWatcher>) {
        let mut dropped = Vec::new();
        let mut slot = self.watch_slot();
        if slot.generation != ticket {
            drop(slot);
            dropped.extend(started.ok());
            dropped.extend(taken.and_then(|watcher| self.keep_for_folder(root, watcher)));
            return (None, dropped);
        }
        slot.pending = None;
        let (running, refusal) = match (started, taken) {
            (Ok(watcher), taken) => {
                dropped.extend(taken);
                (Some(watcher), None)
            }
            (Err(error), Some(fallback)) => {
                tracing::warn!(root = %root.display(), %error, "the open repository keeps the folder view's watcher: its own did not start");
                (Some(fallback), None)
            }
            (Err(error), None) => (None, Some(error)),
        };
        let previous = match running {
            Some(watcher) => slot.running.replace((root.to_path_buf(), watcher)),
            None => slot.running.take(),
        };
        dropped.extend(previous.map(|(_, watcher)| watcher));
        (refusal, dropped)
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

    /// The root the open repository's slot watches, and the one a start of the slot runs for.
    fn slot_roots(&self) -> (Option<PathBuf>, Option<PathBuf>) {
        let slot = self.watch_slot();
        (
            slot.running.as_ref().map(|(root, _)| root.clone()),
            slot.pending.clone(),
        )
    }

    /// Makes the folder watchers follow `roots`: the first [`FOLDER_WATCH_LIMIT`] distinct
    /// roots are listed, and each gets a watcher but the one the open repository's slot
    /// watches; the one a start of the slot runs for keeps the folder's watcher it has until
    /// that start ends ([`AppState::finish_watch`]) and gets no new one. The watchers of roots
    /// no longer listed are taken out, and the roots with neither a watcher nor a start in
    /// flight are claimed.
    pub fn begin_folder_sync(&self, roots: &[PathBuf]) -> FolderSync {
        let mut listed: Vec<PathBuf> = Vec::with_capacity(FOLDER_WATCH_LIMIT);
        for root in roots {
            if listed.len() == FOLDER_WATCH_LIMIT {
                break;
            }
            if !listed.contains(root) {
                listed.push(root.clone());
            }
        }
        // The slot's lock is held until the set is in step, so a watcher the slot gives back
        // meanwhile is not dropped as the open repository's.
        let slot = self.watch_slot();
        let open = slot.running.as_ref().map(|(root, _)| root.clone());
        let pending = slot.pending.clone();
        let mut folders = self.folder_watchers();
        let mut dropped = Vec::new();
        for (root, watcher) in std::mem::take(&mut folders.running) {
            if listed.contains(&root) && open.as_ref() != Some(&root) {
                folders.running.insert(root, watcher);
            } else {
                dropped.push(watcher);
            }
        }
        let start: Vec<PathBuf> = listed
            .iter()
            .filter(|root| {
                open.as_ref() != Some(*root)
                    && pending.as_ref() != Some(*root)
                    && !folders.running.contains_key(*root)
                    && !folders.starting.contains(*root)
            })
            .cloned()
            .collect();
        folders.starting.extend(start.iter().cloned());
        folders.listed = listed;
        FolderSync { start, dropped }
    }

    /// Whether a claimed start of `root` is still worth running: the latest sync lists it, and
    /// the open repository's slot neither watches it nor starts to.
    pub fn folder_wants(&self, root: &Path) -> bool {
        let (open, pending) = self.slot_roots();
        if open.as_deref() == Some(root) || pending.as_deref() == Some(root) {
            return false;
        }
        self.folder_watchers()
            .listed
            .iter()
            .any(|listed| listed == root)
    }

    /// Ends a claimed start with its watcher: installed while [`AppState::folder_wants`] still
    /// holds, else returned to be dropped off the async runtime. The slot's lock is held while
    /// the watcher goes in, so the slot cannot take the root in between.
    pub fn install_folder_watcher(
        &self,
        root: PathBuf,
        watcher: RepoWatcher,
    ) -> Option<RepoWatcher> {
        let slot = self.watch_slot();
        let taken = slot
            .running
            .as_ref()
            .is_some_and(|(watched, _)| *watched == root)
            || slot.pending.as_ref() == Some(&root);
        let mut folders = self.folder_watchers();
        folders.starting.remove(&root);
        if taken || !folders.listed.contains(&root) {
            return Some(watcher);
        }
        folders.running.insert(root, watcher)
    }

    /// Ends a claimed start without a watcher (its repository or watcher did not start, or it
    /// is no longer wanted), so a later sync may claim the root again.
    pub fn abandon_folder_start(&self, root: &Path) {
        self.folder_watchers().starting.remove(root);
    }

    /// Runs the starts a folder sync claimed, one after another, so the first repositories
    /// follow their changes while the rest start. Each root still wanted gets its watcher from
    /// its engine when one is open, else from one opened for the start and dropped after it, so
    /// a view that closed meanwhile leaves no engine behind; a root no longer wanted is given
    /// up, and so is every root left once the platform's limit of watches is reached.
    /// Blocking: call from `spawn_blocking`.
    pub fn run_folder_starts(
        &self,
        roots: Vec<PathBuf>,
        start: impl Fn(WatchBases) -> Result<RepoWatcher, notify::Error>,
    ) {
        let mut claimed = roots.into_iter();
        while let Some(root) = claimed.next() {
            if !self.folder_wants(&root) {
                self.abandon_folder_start(&root);
                continue;
            }
            let bases = match self.engine_for(&root) {
                Some(engine) => engine.watch_bases(),
                None => match Git2Engine::open(&root) {
                    Ok(engine) => engine.watch_bases(),
                    Err(error) => {
                        tracing::warn!(root = %root.display(), error = %error, "folder watcher: the repository did not open");
                        self.abandon_folder_start(&root);
                        continue;
                    }
                },
            };
            match start(bases) {
                Ok(watcher) => drop(self.install_folder_watcher(root, watcher)),
                Err(error) if matches!(error.kind, notify::ErrorKind::MaxFilesWatch) => {
                    tracing::warn!(root = %root.display(), "folder watchers stop: too many watched folders for this system (inotify limit)");
                    self.abandon_folder_start(&root);
                    for rest in claimed.by_ref() {
                        self.abandon_folder_start(&rest);
                    }
                }
                Err(error) => {
                    tracing::warn!(root = %root.display(), error = %error, "folder watcher did not start");
                    self.abandon_folder_start(&root);
                }
            }
        }
    }

    /// The roots the folder watchers watch, sorted.
    pub fn folder_watched(&self) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = self.folder_watchers().running.keys().cloned().collect();
        roots.sort();
        roots
    }

    /// Takes every folder watcher out, leaving the folder view; the starts still running find
    /// nothing listed when they end, and their watchers go.
    pub fn stop_folder_watchers(&self) -> Vec<RepoWatcher> {
        let mut folders = self.folder_watchers();
        folders.listed.clear();
        folders
            .running
            .drain()
            .map(|(_, watcher)| watcher)
            .collect()
    }

    /// Takes the folder watcher of `root` out while the open repository's slot starts its own,
    /// which keeps the index snapshot the folder's lacks; [`AppState::finish_watch`] drops it
    /// once that start ends, or keeps it.
    pub fn take_folder_watcher(&self, root: &Path) -> Option<RepoWatcher> {
        self.folder_watchers().running.remove(root)
    }

    /// Gives the folder view `watcher` of `root` (the open repository's, when it closes, or the
    /// view's own that a superseded start took out) while the view's latest sync lists `root`
    /// and the slot neither watches it nor starts to; it keeps a digest of the index from then
    /// on, as the view's watchers do. Returns it otherwise, to be dropped off the async
    /// runtime. The slot's lock is held first, as everywhere the two are taken.
    pub fn keep_for_folder(&self, root: &Path, watcher: RepoWatcher) -> Option<RepoWatcher> {
        let slot = self.watch_slot();
        let slot_has_it = slot
            .running
            .as_ref()
            .is_some_and(|(watched, _)| watched == root)
            || slot.pending.as_deref() == Some(root);
        let mut folders = self.folder_watchers();
        if slot_has_it
            || !folders.listed.iter().any(|listed| listed == root)
            || folders.running.contains_key(root)
        {
            return Some(watcher);
        }
        watcher.forget_index();
        folders.running.insert(root.to_path_buf(), watcher);
        None
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
        // A repository the folder view lists keeps being watched, by the view's watchers.
        let watcher = self
            .take_watcher(root)
            .and_then(|(_, watcher)| self.keep_for_folder(root, watcher));
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
        let start = |root: &Path| Ok(watcher_of(root));
        let refusal = || Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
        let state = AppState::default();
        // A opens, then B while A's start still walks its tree: B's ends first and stays.
        let slow = state.begin_watch(&a);
        let fast = state.begin_watch(&b);
        let (refused, dropped) = state.finish_watch(fast, &b, start(&b), None);
        assert!(refused.is_none() && dropped.is_empty());
        let (refused, dropped) = state.finish_watch(slow, &a, start(&a), None);
        assert!(refused.is_none());
        assert_eq!(dropped.len(), 1, "A's watcher came too late");
        assert!(state.is_watching(&b));
        assert!(!state.is_watching(&a));
        // B closes while a start for it is in flight: that start installs nothing.
        let restart = state.begin_watch(&b);
        assert!(!state.is_watching(&b), "a start is in flight");
        assert!(state.take_watcher(&b).is_some());
        let (_, dropped) = state.finish_watch(restart, &b, start(&b), None);
        assert_eq!(dropped.len(), 1);
        assert!(!state.is_watching(&b));
        // A close of another repository (an abandoned open) leaves the start alone.
        let current = state.begin_watch(&b);
        assert!(state.take_watcher(&a).is_none());
        let (_, dropped) = state.finish_watch(current, &b, start(&b), None);
        assert!(dropped.is_empty());
        assert!(state.is_watching(&b));
        // A refused start takes the watcher of the repository shown before with it; one
        // that a later start superseded concerns nothing.
        let superseded = state.begin_watch(&b);
        let latest = state.begin_watch(&a);
        let (refused, dropped) = state.finish_watch(superseded, &b, refusal(), None);
        assert!(refused.is_none() && dropped.is_empty());
        let (refused, dropped) = state.finish_watch(latest, &a, refusal(), None);
        assert!(refused.is_some());
        assert_eq!(dropped.len(), 1, "B's watcher");
        assert!(!state.is_watching(&b));
    }

    /// A watcher of `root` that reports nothing.
    fn watcher_of(root: &Path) -> RepoWatcher {
        RepoWatcher::start(crate::watcher::WatchBases::main(root), |_| {}).expect("watcher")
    }

    /// Folders `names` created under `dir`.
    fn folders(dir: &Path, names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| {
                let path = dir.join(name);
                std::fs::create_dir_all(&path).expect("folder");
                path
            })
            .collect()
    }

    /// Repositories `names` under `dir`, made by `git init`.
    fn repositories(dir: &Path, names: &[&str]) -> Vec<PathBuf> {
        let roots = folders(dir, names);
        for root in &roots {
            let status = git_core::cli::command(root, &["init", "-q"])
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", dir.join("no-global-config"))
                .status()
                .expect("git runs");
            assert!(status.success(), "git init");
        }
        roots
    }

    /// A folder sync run to its end with watchers that report nothing; answers how many
    /// watchers it took out.
    fn sync(state: &AppState, roots: &[PathBuf]) -> usize {
        let sync = state.begin_folder_sync(roots);
        for root in sync.start {
            let watcher = watcher_of(&root);
            assert!(state.install_folder_watcher(root, watcher).is_none());
        }
        sync.dropped.len()
    }

    #[test]
    fn folder_watchers_follow_the_roots_up_to_the_cap() {
        let dir = tempfile::tempdir().expect("temp dir");
        let names: Vec<String> = (0..22).map(|i| format!("r{i:02}")).collect();
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
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
    fn back_to_back_syncs_start_a_root_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        let roots = folders(dir.path(), &["a", "b", "c"]);
        let (a, b, c) = (roots[0].clone(), roots[1].clone(), roots[2].clone());
        let state = AppState::default();
        let first = state.begin_folder_sync(std::slice::from_ref(&a));
        assert_eq!(first.start, vec![a.clone()]);
        // A second sync while a's start runs claims b alone.
        let second = state.begin_folder_sync(&[a.clone(), b.clone()]);
        assert_eq!(second.start, vec![b.clone()]);
        // a's start ends after the second sync: that sync lists a, so it goes in.
        assert!(state
            .install_folder_watcher(a.clone(), watcher_of(&a))
            .is_none());
        assert!(state
            .install_folder_watcher(b.clone(), watcher_of(&b))
            .is_none());
        assert_eq!(state.folder_watched(), vec![a.clone(), b.clone()]);
        // A claim given up is claimed again by the next sync.
        let third = state.begin_folder_sync(&roots);
        assert_eq!(third.start, vec![c.clone()]);
        state.abandon_folder_start(&c);
        assert_eq!(state.begin_folder_sync(&roots).start, vec![c]);
    }

    #[test]
    fn the_open_repository_watches_on_its_own_and_gives_its_watcher_to_the_view() {
        let dir = tempfile::tempdir().expect("temp dir");
        let roots = folders(dir.path(), &["a", "b", "c"]);
        let (a, b, c) = (roots[0].clone(), roots[1].clone(), roots[2].clone());
        let state = AppState::default();
        sync(&state, &roots);
        // b opens. While the slot's start runs, a sync claims nothing for b; b's folder watcher,
        // which keeps no index snapshot, leaves the view and stops once the slot's own runs.
        let ticket = state.begin_watch(&b);
        let during = state.begin_folder_sync(&roots);
        assert!(during.start.is_empty() && during.dropped.is_empty());
        let folder_b = state.take_folder_watcher(&b);
        assert!(folder_b.is_some(), "b's folder watcher");
        let (refusal, dropped) = state.finish_watch(ticket, &b, Ok(watcher_of(&b)), folder_b);
        assert!(refusal.is_none());
        assert_eq!(dropped.len(), 1, "the view's watcher of b goes");
        assert!(state.is_watching(&b));
        assert_eq!(state.folder_watched(), vec![a.clone(), c.clone()]);
        // While b is open, the view leaves it to the slot.
        let open = state.begin_folder_sync(&roots);
        assert!(open.start.is_empty() && open.dropped.is_empty());
        // b closes while the view lists it: its watcher goes back to the view.
        let closed = state.close(&b);
        assert!(closed.is_none_or(|closed| closed.watcher.is_none()));
        assert_eq!(state.folder_watched(), vec![a, b.clone(), c]);
        // Once the view left, the slot's watcher goes with its repository, as before.
        drop(state.stop_folder_watchers());
        let ticket = state.begin_watch(&b);
        let (_, dropped) = state.finish_watch(ticket, &b, Ok(watcher_of(&b)), None);
        assert!(dropped.is_empty());
        assert!(state
            .close(&b)
            .is_some_and(|closed| closed.watcher.is_some()));
    }

    #[test]
    fn a_refused_superseded_or_closed_start_keeps_the_view_s_watcher() {
        let dir = tempfile::tempdir().expect("temp dir");
        let roots = folders(dir.path(), &["a", "b", "c"]);
        let (a, b, c) = (roots[0].clone(), roots[1].clone(), roots[2].clone());
        let outside = folders(dir.path(), &["outside"]).remove(0);
        let refused = || Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
        let state = AppState::default();
        sync(&state, &roots);
        let ticket = state.begin_watch(&b);
        let taken = state.take_folder_watcher(&b);
        drop(state.finish_watch(ticket, &b, Ok(watcher_of(&b)), taken));
        // a opens, then c before a's start ends: a's watcher never runs, and the view gets its
        // own watcher of a back.
        let slow = state.begin_watch(&a);
        let taken_a = state.take_folder_watcher(&a);
        let fast = state.begin_watch(&c);
        let taken_c = state.take_folder_watcher(&c);
        let (refusal, dropped) = state.finish_watch(slow, &a, Ok(watcher_of(&a)), taken_a);
        assert!(refusal.is_none());
        assert_eq!(dropped.len(), 1, "a's own watcher");
        assert_eq!(state.folder_watched(), vec![a.clone()]);
        // The platform refuses c's watcher: the view's keeps watching c in the slot, and b's
        // goes with b.
        let (refusal, dropped) = state.finish_watch(fast, &c, refused(), taken_c);
        assert!(refusal.is_none());
        assert_eq!(dropped.len(), 1, "b's watcher");
        assert!(state.is_watching(&c));
        // A repository the view does not list reports its refusal, and nothing is watched.
        let ticket = state.begin_watch(&outside);
        let (refusal, dropped) = state.finish_watch(ticket, &outside, refused(), None);
        assert!(refusal.is_some());
        assert_eq!(dropped.len(), 1, "c's watcher");
        assert!(!state.is_watching(&outside) && !state.is_watching(&c));
        // The next sync watches b and c again.
        assert_eq!(sync(&state, &roots), 0);
        assert_eq!(
            state.folder_watched(),
            vec![a.clone(), b.clone(), c.clone()]
        );
        // a opens and closes before its start ends: the view keeps its watcher of a.
        let ticket = state.begin_watch(&a);
        let taken = state.take_folder_watcher(&a);
        assert!(state.close(&a).is_none());
        let (refusal, dropped) = state.finish_watch(ticket, &a, Ok(watcher_of(&a)), taken);
        assert!(refusal.is_none());
        assert_eq!(dropped.len(), 1, "a's own watcher");
        assert_eq!(
            state.folder_watched(),
            vec![a.clone(), b.clone(), c.clone()]
        );
        // a opens twice in a row: the first start, which the second supersedes, gives the
        // view nothing back while the slot starts a.
        let first = state.begin_watch(&a);
        let taken = state.take_folder_watcher(&a);
        let second = state.begin_watch(&a);
        let (_, dropped) = state.finish_watch(first, &a, Ok(watcher_of(&a)), taken);
        assert_eq!(dropped.len(), 2, "a's first watcher and the view's");
        let (_, dropped) = state.finish_watch(second, &a, Ok(watcher_of(&a)), None);
        assert!(dropped.is_empty());
        assert!(state.is_watching(&a));
        assert_eq!(state.folder_watched(), vec![b, c]);
    }

    #[test]
    fn a_folder_start_that_ends_after_the_view_left_or_the_slot_took_its_root_is_dropped() {
        let dir = tempfile::tempdir().expect("temp dir");
        let roots = folders(dir.path(), &["a"]);
        let a = roots[0].clone();
        let state = AppState::default();
        // Leaving the view while a start runs: it installs nothing.
        let late = state.begin_folder_sync(&roots);
        assert_eq!(late.start, vec![a.clone()]);
        assert!(state.stop_folder_watchers().is_empty());
        assert!(!state.folder_wants(&a));
        assert!(state
            .install_folder_watcher(a.clone(), watcher_of(&a))
            .is_some());
        assert!(state.folder_watched().is_empty());
        // The open repository's slot starts to watch a while a folder start of it runs.
        assert_eq!(state.begin_folder_sync(&roots).start, vec![a.clone()]);
        state.begin_watch(&a);
        assert!(!state.folder_wants(&a));
        assert!(state
            .install_folder_watcher(a.clone(), watcher_of(&a))
            .is_some());
        assert!(state.folder_watched().is_empty());
    }

    #[test]
    fn folder_starts_watch_what_is_wanted_report_their_root_and_stop_at_the_platform_limit() {
        let dir = tempfile::tempdir().expect("temp dir");
        let roots = repositories(dir.path(), &["a", "b", "c"]);
        let (a, b, c) = (roots[0].clone(), roots[1].clone(), roots[2].clone());
        let state = AppState::default();
        let claimed = state.begin_folder_sync(&roots);
        let (sender, changes) = std::sync::mpsc::channel();
        // The platform refuses b's watches as it does past the inotify limit.
        state.run_folder_starts(claimed.start, |bases| {
            if bases.root == b {
                return Err(notify::Error::new(notify::ErrorKind::MaxFilesWatch));
            }
            let sender = sender.clone();
            RepoWatcher::start(bases, move |payload| {
                let _ = sender.send(payload);
            })
        });
        assert_eq!(state.folder_watched(), vec![a.clone()]);
        // b and the root after it were given up: the next sync claims them.
        let again = state.begin_folder_sync(&roots);
        assert_eq!(again.start, vec![b, c.clone()]);
        state.abandon_folder_start(&c);
        // No engine stays behind for a start.
        assert_eq!(state.open_count(), 0);
        // A change in a reaches its watcher, named by its root.
        std::thread::sleep(Duration::from_millis(400));
        std::fs::write(a.join("new.txt"), "new\n").expect("write");
        let change = changes
            .recv_timeout(Duration::from_secs(10))
            .expect("a change");
        assert_eq!(change.repo, a);
        // A root no longer wanted when its turn comes is given up, not started.
        let later = state.begin_folder_sync(std::slice::from_ref(&c));
        assert_eq!(later.dropped.len(), 1, "a is no longer listed");
        assert!(state.stop_folder_watchers().is_empty());
        state.run_folder_starts(later.start, |_| panic!("c is not wanted any more"));
        assert_eq!(
            state.begin_folder_sync(std::slice::from_ref(&c)).start,
            vec![c]
        );
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
        state.cache_highlight(root, "a.rs:1".to_owned(), highlight_of(2, 1), false);
        let (first, retried) = state.cached_highlight(root, "a.rs:1").expect("cached");
        assert_eq!(first.lines.len(), 2);
        assert!(!retried);
        assert!(state.cached_highlight(root, "a.rs:2").is_none());
        // The same key replaces the entry rather than adding one.
        state.cache_highlight(root, "a.rs:1".to_owned(), highlight_of(3, 1), true);
        let (replaced, retried) = state.cached_highlight(root, "a.rs:1").expect("replaced");
        assert_eq!(replaced.lines.len(), 3);
        assert!(retried);
        let bytes_of_three = state.highlight_cache_bytes();
        // The count bound per repository keeps the newest 32.
        for i in 0..40 {
            state.cache_highlight(root, format!("f{i}.rs"), highlight_of(1, 1), false);
        }
        assert!(state.cached_highlight(root, "a.rs:1").is_none());
        assert!(state.cached_highlight(root, "f7.rs").is_none());
        assert!(state.cached_highlight(root, "f8.rs").is_some());
        assert!(state.highlight_cache_bytes() < bytes_of_three * 32);
        // The byte bound of the process evicts the oldest entries of the fullest repository.
        let dense = highlight_of(50_000, 20);
        assert!(highlight_bytes(&dense) > HIGHLIGHT_CACHE_BYTES / 4);
        for i in 0..6 {
            state.cache_highlight(
                Path::new("/b"),
                format!("d{i}.rs"),
                Arc::clone(&dense),
                false,
            );
        }
        assert!(state.highlight_cache_bytes() <= HIGHLIGHT_CACHE_BYTES);
        assert!(state.cached_highlight(Path::new("/b"), "d0.rs").is_none());
        assert!(state.cached_highlight(Path::new("/b"), "d5.rs").is_some());
        // Closing a repository drops its highlights.
        state.close(Path::new("/b"));
        assert!(state.cached_highlight(Path::new("/b"), "d5.rs").is_none());
        assert!(state.cached_highlight(root, "f39.rs").is_some());
    }

    #[test]
    fn a_hit_is_the_most_recent_and_answers_without_tokens_take_no_slot() {
        let state = AppState::default();
        let root = Path::new("/a");
        for i in 0..32 {
            state.cache_highlight(root, format!("f{i}.rs"), highlight_of(1, 1), false);
        }
        // f0 is read, so f1 is now the least recently used.
        assert!(state.cached_highlight(root, "f0.rs").is_some());
        state.cache_highlight(root, "g.rs".to_owned(), highlight_of(1, 1), false);
        assert!(state.cached_highlight(root, "f0.rs").is_some());
        assert!(state.cached_highlight(root, "f1.rs").is_none());
        // Files of no known language fill no slot of the 32.
        for i in 0..100 {
            state.cache_highlight(
                root,
                format!("n{i}.txt"),
                Arc::new(Highlight::nothing()),
                false,
            );
        }
        assert!(state.cached_highlight(root, "g.rs").is_some());
        assert!(state.cached_highlight(root, "n0.txt").is_some());
    }
}
