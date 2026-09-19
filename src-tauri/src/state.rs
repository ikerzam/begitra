//! Per-process state: open engines by repository root, walk handles by id, and the operation
//! registry. Cloning the state clones a handle to the same maps, so commands can move it into
//! blocking closures.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use git_core::engine::{CommitWalk, GitEngine};
use git_core::error::GitResult;
use git_core::git2_engine::Git2Engine;

use crate::error::AppError;
use crate::ops::Operations;

/// Walk handles idle for longer than this are dropped.
pub const WALK_IDLE_LIMIT: Duration = Duration::from_secs(5 * 60);

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

    /// Closes the engine rooted at `root` and drops its walks; returns whether it was open.
    pub fn close(&self, root: &Path) -> bool {
        let removed = self
            .inner
            .engines
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(root)
            .is_some();
        let mut walks = self
            .inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        walks.retain(|_, entry| entry.repo != root);
        removed
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

    /// Drops a walk handle; returns whether it existed.
    pub fn drop_walk(&self, walk_id: &str) -> bool {
        self.inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(walk_id)
            .is_some()
    }

    /// Drops walks idle for longer than `limit`; returns how many were dropped.
    pub fn evict_idle_walks(&self, limit: Duration) -> usize {
        let mut walks = self
            .inner
            .walks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = walks.len();
        let now = Instant::now();
        walks
            .retain(|_, entry| entry.walk.is_none() || now.duration_since(entry.last_used) < limit);
        before - walks.len()
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

        assert!(state.drop_walk(&id));
        assert!(!state.drop_walk(&id));
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
        assert_eq!(state.evict_idle_walks(Duration::from_secs(60)), 0);
        assert_eq!(state.evict_idle_walks(Duration::ZERO), 2);
        assert_eq!(state.walk_count(), 0);

        state.store_walk(&a, PathBuf::from("/a"), Box::new(FakeWalk));
        assert!(!state.close(Path::new("/a")));
        assert_eq!(state.walk_count(), 0);
    }
}
