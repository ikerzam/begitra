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
    /// The watcher of the open repository, with its root.
    watcher: Mutex<Option<(PathBuf, RepoWatcher)>>,
    /// The token classes of the last files viewed, per repository, keyed by path and content.
    highlights: Mutex<HashMap<PathBuf, VecDeque<CachedHighlight>>>,
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

    /// Replaces the repository watcher with `watcher` for `root`; the previous one is
    /// returned so the caller drops it off the async runtime.
    pub fn set_watcher(
        &self,
        root: PathBuf,
        watcher: RepoWatcher,
    ) -> Option<(PathBuf, RepoWatcher)> {
        let mut slot = self
            .inner
            .watcher
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.replace((root, watcher))
    }

    /// Whether `root` is the repository being watched.
    pub fn is_watching(&self, root: &Path) -> bool {
        self.inner
            .watcher
            .lock()
            .map(|slot| slot.as_ref().is_some_and(|(watched, _)| watched == root))
            .unwrap_or(false)
    }

    /// Removes the watcher of `root`, if that is the one running; returned to be dropped off
    /// the async runtime.
    pub fn take_watcher(&self, root: &Path) -> Option<(PathBuf, RepoWatcher)> {
        let mut slot = self
            .inner
            .watcher
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.as_ref().is_some_and(|(watched, _)| watched == root) {
            slot.take()
        } else {
            None
        }
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
