//! One filesystem watcher per open repository: `notify` events are collected for
//! 150 ms after the first one, classified into the kinds of `repo:changed`, and emitted as one
//! event with the changed paths relative to the root.

use std::collections::BTreeSet;
use std::path::{Component, Path};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use crate::events::{RepoChangeKind, RepoChanged};

/// Quiet time after the first event before the batch is emitted.
pub const DEBOUNCE: Duration = Duration::from_millis(150);

/// Most paths carried by one event; the kinds still cover everything.
pub const MAX_PATHS: usize = 200;

/// A running watcher; dropping it stops the watch and the debounce thread.
pub struct RepoWatcher {
    _watcher: RecommendedWatcher,
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl RepoWatcher {
    /// Starts watching `root` recursively; `emit` receives one payload per debounced batch.
    /// Fails when the platform watcher cannot be created or the root cannot be watched (too
    /// many watches, an unsupported filesystem), which the caller reports as a warning.
    pub fn start(
        root: &Path,
        emit: impl Fn(RepoChanged) + Send + 'static,
    ) -> Result<Self, notify::Error> {
        let (raw_tx, raw_rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(raw_tx)?;
        watcher.watch(root, RecursiveMode::Recursive)?;
        let (stop, stop_rx) = mpsc::channel::<()>();
        let root = root.to_path_buf();
        let thread = thread::Builder::new()
            .name("begira-watcher".to_owned())
            .spawn(move || debounce_loop(&root, &raw_rx, &stop_rx, emit))
            .map_err(notify::Error::io)?;
        Ok(Self {
            _watcher: watcher,
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Collects raw events, waits [`DEBOUNCE`] after the first of a batch, and emits the batch.
fn debounce_loop(
    root: &Path,
    raw: &Receiver<notify::Result<notify::Event>>,
    stop: &Receiver<()>,
    emit: impl Fn(RepoChanged),
) {
    let mut batch = Batch::default();
    let mut deadline: Option<Instant> = None;
    loop {
        if stop.try_recv().is_ok() {
            return;
        }
        let wait = deadline.map_or(Duration::from_millis(500), |d| {
            d.saturating_duration_since(Instant::now())
        });
        match raw.recv_timeout(wait) {
            Ok(Ok(event)) => {
                for path in &event.paths {
                    batch.add(root, path);
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
                if let Some(payload) = batch.take(root) {
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
    Status,
}

impl Batch {
    /// Adds one changed path, classified by where it sits relative to `root`.
    pub fn add(&mut self, root: &Path, path: &Path) {
        let Some(classified) = classify(root, path) else {
            return;
        };
        match classified {
            Classified::Refs => {
                self.kinds.insert(Kind::Refs);
            }
            Classified::Index => {
                self.kinds.insert(Kind::Index);
            }
            Classified::Status(relative) => {
                self.kinds.insert(Kind::Status);
                if self.paths.len() < MAX_PATHS {
                    self.paths.insert(relative);
                } else {
                    self.dropped = true;
                }
            }
        }
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
    Status(String),
}

/// Where a changed path sits: `.git/HEAD`, `.git/refs/**`, `.git/packed-refs` and
/// `.git/logs/**` are refs; `.git/index` is the index; other `.git` content (objects, lock
/// files, hooks) is ignored; anything else is a working tree path, except lock files git
/// writes while committing.
fn classify(root: &Path, path: &Path) -> Option<Classified> {
    let relative = path.strip_prefix(root).ok()?;
    let components: Vec<String> = relative
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let first = components.first()?;
    // Lock files come and go while git writes; the write itself is what matters.
    if components
        .last()
        .is_some_and(|last| last.ends_with(".lock"))
    {
        return None;
    }
    if first == ".git" {
        let second = components.get(1)?;
        return match second.as_str() {
            "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "packed-refs" | "refs" | "logs" => {
                Some(Classified::Refs)
            }
            "index" => Some(Classified::Index),
            _ => None,
        };
    }
    Some(Classified::Status(components.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_git_metadata_and_working_tree_paths() {
        let root = std::path::PathBuf::from("/r");
        let mut batch = Batch::default();
        batch.add(&root, Path::new("/r/.git/HEAD"));
        batch.add(&root, Path::new("/r/.git/refs/heads/main"));
        batch.add(&root, Path::new("/r/.git/refs/heads/main.lock"));
        batch.add(&root, Path::new("/r/.git/objects/ab/cdef"));
        batch.add(&root, Path::new("/r/.git/index"));
        batch.add(&root, Path::new("/r/src/app.ts"));
        batch.add(&root, Path::new("/r/src/app.ts"));
        batch.add(&root, Path::new("/r/deep/dir/file.rs"));
        batch.add(&root, Path::new("/r/.git/index.lock"));
        batch.add(&root, Path::new("/elsewhere/file"));
        let payload = batch.take(&root).expect("payload");
        assert_eq!(
            payload.kinds,
            vec![
                RepoChangeKind::Refs,
                RepoChangeKind::Index,
                RepoChangeKind::Status
            ]
        );
        assert_eq!(payload.paths, vec!["deep/dir/file.rs", "src/app.ts"]);
        assert!(batch.take(&root).is_none());
        // A ref lock alone is not a change.
        batch.add(&root, Path::new("/r/.git/refs/heads/main.lock"));
        assert!(batch.take(&root).is_none());
    }

    #[test]
    fn too_many_paths_keep_the_kinds_and_drop_the_list() {
        let root = std::path::PathBuf::from("/r");
        let mut batch = Batch::default();
        for i in 0..(MAX_PATHS + 10) {
            batch.add(&root, &root.join(format!("f{i}.txt")));
        }
        let payload = batch.take(&root).expect("payload");
        assert_eq!(payload.kinds, vec![RepoChangeKind::Status]);
        assert!(payload.paths.is_empty());
    }

    #[test]
    fn a_real_watcher_debounces_a_burst_into_one_event() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join(".git").join("refs").join("heads")).expect("mkdir");
        let (tx, rx) = mpsc::channel();
        let watcher = RepoWatcher::start(&root, move |payload| {
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
        let payload = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("one event within three seconds");
        assert!(payload.kinds.contains(&RepoChangeKind::Status));
        assert!(payload.kinds.contains(&RepoChangeKind::Refs));
        assert!(payload.paths.iter().any(|p| p == "file-0.txt"));
        assert!(
            rx.recv_timeout(Duration::from_millis(400)).is_err(),
            "the burst arrived as one event"
        );
        drop(watcher);
    }
}
