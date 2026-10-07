//! The copies a discard keeps so that its Undo can write the files back (ADR-0020).
//!
//! Before git discards files, a hunk or lines, [`Discards::keep`] copies each path the
//! discard touches into this session's folder under the app's data folder: a file's bytes
//! with its permissions, a link's target, or that nothing was there. Right after git ran,
//! [`Discards::seal`] records the state git left each path in, or, when git failed part-way,
//! [`Discards::seal_changed`] keeps only the paths git changed. [`Discards::undo`] writes back
//! each path that still holds that state, through a temporary name renamed over it, and leaves
//! a path changed since as it is. One copy stands at a time, the last one sealed; it goes with
//! its toast ([`Discards::forget`]), after its Undo, and with its session: each session holds a
//! lock in its folder and removes the folder when Begitra exits ([`Discards::close`]), and a
//! start removes the folders no running Begitra holds ([`Discards::sweep`]).

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::hash::{DefaultHasher, Hasher};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{codes, AppError};

/// Most bytes one copy holds: a discard of a few files copies kilobytes, and past this the
/// copy would take longer than the discard is worth.
pub const COPY_LIMIT: u64 = 256 * 1024 * 1024;

/// The file each session holds locked in its folder while it runs.
const LOCK_FILE: &str = "session.lock";

/// How old a session folder no lock holds must be before a start removes it: another start
/// makes its folder, then takes its lock.
const UNLOCKED_GRACE: Duration = Duration::from_secs(60);

/// Most threads the copy, the record and Undo spread their files over: each file costs an
/// open, a read and a close, which Windows makes slow (its antivirus looks at each), and an
/// SSD answers several at once.
const MAX_THREADS: usize = 8;

/// Fewer files than this are done on the calling thread.
const PARALLEL_FROM: usize = 64;

/// What a path holds, as far as Undo compares it with what the discard left.
#[derive(Clone, Debug, PartialEq, Eq)]
enum State {
    /// Nothing, or a path behind a link: Undo never writes there.
    Absent,
    /// A symbolic link or a junction, and its target.
    Link(PathBuf),
    /// A regular file: its length and a hash of its bytes, enough to tell an edit within a
    /// session (not a security boundary).
    File { len: u64, hash: u64 },
    /// A folder or anything else.
    Other,
}

/// What a path holds before git runs, before anything is copied.
enum Found {
    Absent,
    Link(PathBuf),
    /// A regular file and its length.
    File(u64),
}

/// How a path is written back.
#[derive(Debug)]
enum Kept {
    /// Nothing was there: Undo deletes the path again.
    Absent,
    /// A link and its target.
    Link(PathBuf),
    /// A regular file, copied with its permissions to this file of the copy's folder.
    File(PathBuf),
}

/// One path of a copy.
#[derive(Debug)]
struct Entry {
    /// Relative to the working tree, as git lists it.
    path: String,
    kept: Kept,
    /// The state git left the path in; `None` until sealed, and when it could not be read.
    after: Option<State>,
}

/// A sealed copy.
#[derive(Debug)]
struct Record {
    /// The working tree's root.
    root: PathBuf,
    folder: PathBuf,
    entries: Vec<Entry>,
}

/// A copy kept before git runs. Dropped unsealed (git refused the discard), its folder goes.
#[derive(Debug)]
pub struct Pending {
    id: String,
    root: PathBuf,
    folder: PathBuf,
    entries: Vec<Entry>,
    /// Whether dropping it removes the folder: until a seal takes it.
    armed: bool,
}

impl Drop for Pending {
    fn drop(&mut self) {
        if self.armed {
            remove_folder(&self.folder);
        }
    }
}

/// This session's folder, and the lock that keeps other starts from removing it.
#[derive(Debug)]
struct Session {
    parent: PathBuf,
    folder: PathBuf,
    _lock: File,
}

#[derive(Debug, Default)]
struct Inner {
    session: Option<Session>,
    records: HashMap<String, Record>,
    next: u64,
}

/// The copies of this session's discards.
#[derive(Debug)]
pub struct Discards {
    inner: Mutex<Inner>,
    limit: u64,
}

impl Default for Discards {
    fn default() -> Self {
        Self::with_limit(COPY_LIMIT)
    }
}

/// What an Undo did, path by path.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    /// Written back as they were before the discard.
    pub restored: Vec<String>,
    /// Changed since the discard, left as they are.
    pub changed: Vec<String>,
    /// Not written back; their copy stays for another Undo.
    pub failed: Vec<UndoFailure>,
}

/// A path Undo could not write back, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoFailure {
    /// Relative to the working tree.
    pub path: String,
    /// The system's words.
    pub reason: String,
}

/// What a write-back did.
enum Written {
    Back,
    /// The path changed just before the write, which then did not happen.
    Changed,
}

/// A path's kind, length and modification time when Undo looked at it: a write landing since
/// changes it.
#[derive(Debug, PartialEq, Eq)]
struct Stamp {
    link: bool,
    len: u64,
    modified: Option<SystemTime>,
}

/// The stamp of `full`, or `None` when nothing is there.
fn stamp_of(full: &Path) -> Option<Stamp> {
    fs::symlink_metadata(full).ok().map(|meta| Stamp {
        link: meta.file_type().is_symlink(),
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// Runs `work` over `items` with a [`Probe`] of `root` each, spread over up to
/// [`MAX_THREADS`] threads in runs of neighbouring items, and answers the results in the
/// items' order.
fn in_parallel<T, R>(
    root: &Path,
    items: Vec<T>,
    work: impl Fn(&mut Probe<'_>, T) -> R + Sync,
) -> Vec<R>
where
    T: Send,
    R: Send,
{
    let threads = std::thread::available_parallelism()
        .map_or(1, |count| count.get())
        .min(MAX_THREADS);
    if threads <= 1 || items.len() < PARALLEL_FROM {
        let mut probe = Probe::new(root);
        return items
            .into_iter()
            .map(|item| work(&mut probe, item))
            .collect();
    }
    let size = items.len().div_ceil(threads);
    let mut runs: Vec<Vec<T>> = Vec::with_capacity(threads);
    let mut items = items.into_iter();
    loop {
        let run: Vec<T> = items.by_ref().take(size).collect();
        if run.is_empty() {
            break;
        }
        runs.push(run);
    }
    let work = &work;
    std::thread::scope(|scope| {
        let handles: Vec<_> = runs
            .into_iter()
            .map(|run| {
                scope.spawn(move || {
                    let mut probe = Probe::new(root);
                    run.into_iter()
                        .map(|item| work(&mut probe, item))
                        .collect::<Vec<R>>()
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
            })
            .collect()
    })
}

impl Discards {
    /// A store whose copies hold at most `limit` bytes each.
    pub fn with_limit(limit: u64) -> Self {
        Self {
            inner: Mutex::default(),
            limit,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Makes this session's folder under `parent` (the app's data folder's `discards`) and
    /// locks it for the session's life. Until it is open, no copy is kept and every discard
    /// asks its second confirmation.
    pub fn open(&self, parent: &Path) -> io::Result<()> {
        fs::create_dir_all(parent)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let folder = parent.join(format!("{}-{stamp}", std::process::id()));
        fs::create_dir(&folder)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(folder.join(LOCK_FILE))?;
        lock.try_lock().map_err(|error| match error {
            TryLockError::Error(error) => error,
            TryLockError::WouldBlock => io::Error::other("the session's lock is held"),
        })?;
        self.lock().session = Some(Session {
            parent: parent.to_path_buf(),
            folder,
            _lock: lock,
        });
        Ok(())
    }

    /// Removes this session's folder and every copy in it, when Begitra exits: no copy
    /// outlives its session.
    pub fn close(&self) {
        let session = {
            let mut inner = self.lock();
            inner.records.clear();
            inner.session.take()
        };
        if let Some(Session {
            folder,
            _lock: lock,
            ..
        }) = session
        {
            drop(lock);
            remove_folder(&folder);
        }
    }

    /// Removes what no running Begitra holds beside this session's folder: the copies of a
    /// session that crashed. Blocking: run it off the async runtime.
    pub fn sweep(&self) {
        self.sweep_older_than(UNLOCKED_GRACE);
    }

    /// [`Discards::sweep`], removing the session folders no lock holds once older than
    /// `grace`.
    fn sweep_older_than(&self, grace: Duration) {
        let Some((parent, own)) = self
            .lock()
            .session
            .as_ref()
            .map(|session| (session.parent.clone(), session.folder.clone()))
        else {
            return;
        };
        let entries = match fs::read_dir(&parent) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(%error, "the discards' folder could not be read");
                return;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path == own {
                continue;
            }
            let removed = match entry.file_type() {
                Ok(kind) if kind.is_dir() => {
                    if !abandoned(&path, grace) {
                        continue;
                    }
                    fs::remove_dir_all(&path)
                }
                Ok(_) => fs::remove_file(&path),
                Err(error) => Err(error),
            };
            if let Err(error) = removed {
                // Another start may have removed it first.
                if error.kind() != io::ErrorKind::NotFound {
                    tracing::warn!(%error, path = %path.display(), "a discard's copy left behind could not be removed");
                }
            }
        }
    }

    /// Copies each of `paths` (relative to `root`, the working tree) as it is on disk, before
    /// git discards them. Nothing is copied, and the discard must not run, when a path is a
    /// folder or something else that is not a file, when it is behind a link or a junction
    /// (git for Windows writes through a junction, outside the working tree), when the files
    /// add up to more than the limit, or when a copy fails.
    pub fn keep<'a>(
        &self,
        root: &Path,
        paths: impl IntoIterator<Item = &'a str>,
    ) -> Result<Pending, AppError> {
        let session = self
            .lock()
            .session
            .as_ref()
            .map(|session| session.folder.clone())
            .ok_or_else(|| copy_failed("the app's data folder is not available"))?;
        let paths = paths.into_iter();
        let mut seen = HashSet::with_capacity(paths.size_hint().0);
        let mut unique = Vec::with_capacity(paths.size_hint().0);
        for path in paths {
            if !inside(path) {
                return Err(AppError::invalid_argument(
                    "paths",
                    format!("{path} is not inside the working tree"),
                ));
            }
            if seen.insert(path) {
                unique.push(path);
            }
        }
        let found = in_parallel(root, unique, |probe, path| {
            probe.find(path).map(|what| (path, what))
        })
        .into_iter()
        .collect::<Result<Vec<_>, AppError>>()?;
        let total = found
            .iter()
            .map(|(_, what)| match what {
                Found::File(len) => *len,
                _ => 0,
            })
            .fold(0u64, u64::saturating_add);
        if total > self.limit {
            return Err(too_large(total, self.limit));
        }
        let id = {
            let mut inner = self.lock();
            inner.next += 1;
            inner.next.to_string()
        };
        let folder = session.join(&id);
        fs::create_dir(&folder).map_err(|error| copy_failed(error.to_string()))?;
        let mut pending = Pending {
            id,
            root: root.to_path_buf(),
            folder,
            entries: Vec::new(),
            armed: true,
        };
        let numbered: Vec<_> = found.into_iter().enumerate().collect();
        let folder = &pending.folder;
        let entries = in_parallel(root, numbered, |_probe, (index, (path, what))| {
            let kept = match what {
                Found::Absent => Kept::Absent,
                Found::Link(target) => Kept::Link(target),
                Found::File(_) => {
                    let shard = folder.join((index / 256).to_string());
                    fs::create_dir_all(&shard).map_err(|error| copy_failed(error.to_string()))?;
                    let copy = shard.join(index.to_string());
                    fs::copy(root.join(path), &copy)
                        .map_err(|error| copy_failed(format!("{path}: {error}")))?;
                    Kept::File(copy)
                }
            };
            Ok(Entry {
                path: path.to_owned(),
                kept,
                after: None,
            })
        })
        .into_iter()
        .collect::<Result<Vec<_>, AppError>>()?;
        pending.entries = entries;
        Ok(pending)
    }

    /// Records the state git left each path of `pending` in, right after git ran, and keeps
    /// the copy as the one Undo stands for: the copies sealed before it go. Answers its id.
    pub fn seal(&self, mut pending: Pending) -> String {
        let entries = std::mem::take(&mut pending.entries);
        pending.entries = in_parallel(&pending.root, entries, |probe, mut entry| {
            entry.after = probe.state_twice(&entry.path);
            entry
        });
        self.install(pending)
    }

    /// After git failed part-way: keeps, as [`Discards::seal`] does, the copy of the paths git
    /// changed before it failed (and of those whose state cannot be read), and answers its id;
    /// when git changed nothing, the copy goes and nothing is answered.
    pub fn seal_changed(&self, mut pending: Pending) -> Option<String> {
        let entries = std::mem::take(&mut pending.entries);
        let changed: Vec<Entry> = in_parallel(&pending.root, entries, |probe, mut entry| {
            let after = probe.state_twice(&entry.path);
            let before = match &entry.kept {
                Kept::Absent => Some(State::Absent),
                Kept::Link(target) => Some(State::Link(target.clone())),
                Kept::File(copy) => probe.file_state(copy).ok(),
            };
            (after.is_none() || before.is_none() || after != before).then(|| {
                entry.after = after;
                entry
            })
        })
        .into_iter()
        .flatten()
        .collect();
        if changed.is_empty() {
            return None;
        }
        pending.entries = changed;
        Some(self.install(pending))
    }

    /// Keeps `pending` as the copy Undo stands for, the copies before it removed.
    fn install(&self, mut pending: Pending) -> String {
        pending.armed = false;
        let id = std::mem::take(&mut pending.id);
        let record = Record {
            root: std::mem::take(&mut pending.root),
            folder: std::mem::take(&mut pending.folder),
            entries: std::mem::take(&mut pending.entries),
        };
        let replaced: Vec<Record> = {
            let mut inner = self.lock();
            let replaced = inner.records.drain().map(|(_, record)| record).collect();
            inner.records.insert(id.clone(), record);
            replaced
        };
        for record in replaced {
            remove_folder(&record.folder);
        }
        id
    }

    /// Writes back each path of the copy `id` that still holds what the discard left, and
    /// names the paths changed since, which stay as they are. A path that could not be read
    /// or written keeps its copy for another Undo; otherwise the copy goes.
    pub fn undo(&self, id: &str, root: &Path) -> Result<UndoOutcome, AppError> {
        let record = {
            let mut inner = self.lock();
            let Some(record) = inner.records.remove(id) else {
                return Err(copy_gone());
            };
            if record.root != root {
                inner.records.insert(id.to_owned(), record);
                return Err(AppError::invalid_argument(
                    "copy",
                    "a discard of another repository",
                ));
            }
            record
        };
        let Record {
            root,
            folder,
            entries,
        } = record;
        let answers = in_parallel(&root, entries, |probe, entry| {
            let Some(after) = entry.after.clone() else {
                let unread = io::Error::other("the state the discard left could not be read");
                return (entry, Err(unread));
            };
            // Looked at before its bytes are read: a write landing from now on changes it.
            let stamp = stamp_of(&probe.root.join(&entry.path));
            let written = probe.state(&entry.path).and_then(|now| {
                if now != after {
                    Ok(Written::Changed)
                } else if matches!(entry.kept, Kept::Absent) && now == State::Absent {
                    // Absent before and after: the path holds what it held.
                    Ok(Written::Back)
                } else {
                    write_back(probe, &entry.path, &entry.kept, &stamp)
                }
            });
            (entry, written)
        });
        let mut outcome = UndoOutcome::default();
        let mut left = Vec::new();
        for (entry, written) in answers {
            match written {
                Ok(Written::Back) => outcome.restored.push(entry.path),
                Ok(Written::Changed) => outcome.changed.push(entry.path),
                Err(error) => {
                    outcome.failed.push(UndoFailure {
                        path: entry.path.clone(),
                        reason: error.to_string(),
                    });
                    left.push(entry);
                }
            }
        }
        if left.is_empty() {
            remove_folder(&folder);
        } else {
            self.lock().records.insert(
                id.to_owned(),
                Record {
                    root,
                    folder,
                    entries: left,
                },
            );
        }
        Ok(outcome)
    }

    /// Removes the copy `id`, when its toast goes; a copy already gone is fine.
    pub fn forget(&self, id: &str) {
        let removed = self.lock().records.remove(id);
        if let Some(record) = removed {
            remove_folder(&record.folder);
        }
    }
}

/// Reads what paths under one working tree hold, remembering which folders on their way are
/// links (a discard of thousands of files shares its folders) and reusing one read buffer.
struct Probe<'a> {
    root: &'a Path,
    links: HashMap<PathBuf, bool>,
    /// The folders a write-back of this pass found or made real folders.
    folders: HashSet<PathBuf>,
    buffer: Vec<u8>,
}

impl<'a> Probe<'a> {
    fn new(root: &'a Path) -> Self {
        Self {
            root,
            links: HashMap::new(),
            folders: HashSet::new(),
            buffer: Vec::new(),
        }
    }

    /// Whether a folder on the way from the root to `path` is a link or a junction.
    fn behind_link(&mut self, path: &str) -> bool {
        let names: Vec<&str> = segments(path).collect();
        let mut current = self.root.to_path_buf();
        for name in names.iter().take(names.len().saturating_sub(1)) {
            current.push(name);
            let link = match self.links.get(&current) {
                Some(link) => *link,
                None => {
                    let link = fs::symlink_metadata(&current)
                        .is_ok_and(|meta| meta.file_type().is_symlink());
                    self.links.insert(current.clone(), link);
                    link
                }
            };
            if link {
                return true;
            }
        }
        false
    }

    /// What `path` holds before git runs; a folder or something else that is not a file, and
    /// a path behind a link, refuse the copy.
    fn find(&mut self, path: &str) -> Result<Found, AppError> {
        if self.behind_link(path) {
            return Err(behind_link(path));
        }
        let full = self.root.join(path);
        match fs::symlink_metadata(&full) {
            Ok(meta) if meta.file_type().is_symlink() => {
                // A link to a folder comes back on Windows only with Developer Mode: no copy.
                if cfg!(windows) && fs::metadata(&full).is_ok_and(|meta| meta.is_dir()) {
                    return Err(not_a_file(path));
                }
                fs::read_link(&full)
                    .map(Found::Link)
                    .map_err(|error| copy_failed(format!("{path}: {error}")))
            }
            Ok(meta) if meta.is_file() => Ok(Found::File(meta.len())),
            Ok(_) => Err(not_a_file(path)),
            Err(error) if absent(&error) => Ok(Found::Absent),
            Err(error) => Err(copy_failed(format!("{path}: {error}"))),
        }
    }

    /// What `path` holds now.
    fn state(&mut self, path: &str) -> io::Result<State> {
        if self.behind_link(path) {
            return Ok(State::Absent);
        }
        let full = self.root.join(path);
        let meta = match fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(error) if absent(&error) => return Ok(State::Absent),
            Err(error) => return Err(error),
        };
        if meta.file_type().is_symlink() {
            return fs::read_link(&full).map(State::Link);
        }
        if !meta.is_file() {
            return Ok(State::Other);
        }
        self.file_state(&full)
    }

    /// [`Probe::state`], read once more when the first read fails (another program held the
    /// file for a moment); `None` when neither read did.
    fn state_twice(&mut self, path: &str) -> Option<State> {
        self.state(path).or_else(|_| self.state(path)).ok()
    }

    /// The state of the regular file at `full`: its length and the hash of its bytes.
    fn file_state(&mut self, full: &Path) -> io::Result<State> {
        let mut file = File::open(full)?;
        if self.buffer.is_empty() {
            self.buffer = vec![0; 64 * 1024];
        }
        let mut hasher = DefaultHasher::new();
        let mut len: u64 = 0;
        loop {
            match file.read(&mut self.buffer) {
                Ok(0) => {
                    return Ok(State::File {
                        len,
                        hash: hasher.finish(),
                    })
                }
                Ok(read) => {
                    hasher.write(&self.buffer[..read]);
                    len += read as u64;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }
}

/// Whether `path` names something inside the working tree: relative, with no `.` or `..`.
fn inside(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

/// Whether the error says nothing is at the path.
fn absent(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

/// The names in a path as git lists it: `/` separates them, and `\` too on Windows.
fn segments(path: &str) -> impl Iterator<Item = &str> {
    path.split(|c: char| c == '/' || (cfg!(windows) && c == '\\'))
        .filter(|name| !name.is_empty())
}

/// Makes sure every folder on the way from the root to `path` is a folder, not a link, a
/// junction or a file, so that a write lands inside the working tree; makes the missing ones
/// (another thread of the same Undo may make one first). A folder found or made once in the
/// pass is not looked at again.
fn prepare_parents(probe: &mut Probe<'_>, path: &str) -> io::Result<()> {
    let names: Vec<&str> = segments(path).collect();
    let mut current = probe.root.to_path_buf();
    for (index, name) in names.iter().enumerate().take(names.len().saturating_sub(1)) {
        current.push(name);
        if probe.folders.contains(&current) {
            continue;
        }
        let shown = || names[..=index].join("/");
        let meta = match fs::symlink_metadata(&current) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => {
                        probe.folders.insert(current.clone());
                        continue;
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        fs::symlink_metadata(&current)?
                    }
                    Err(error) => return Err(error),
                }
            }
            other => other?,
        };
        if meta.file_type().is_symlink() {
            return Err(io::Error::other(format!("{} is a link", shown())));
        }
        if !meta.is_dir() {
            return Err(io::Error::other(format!("{} is not a folder", shown())));
        }
        probe.folders.insert(current.clone());
    }
    Ok(())
}

/// Writes `kept` back at `path`, which held what the discard left when Undo looked, its stamp
/// then `stamp`: a file or a link is made under a temporary name first, the path's stamp is
/// looked at again, and the temporary renamed over it, so that only a write landing in that
/// instant is overwritten; a path that was absent is deleted again.
fn write_back(
    probe: &mut Probe<'_>,
    path: &str,
    kept: &Kept,
    stamp: &Option<Stamp>,
) -> io::Result<Written> {
    prepare_parents(probe, path)?;
    let full = probe.root.join(path);
    let unchanged = || stamp_of(&full) == *stamp;
    match kept {
        Kept::Absent => {
            if !unchanged() {
                return Ok(Written::Changed);
            }
            remove_entry(&full).map(|()| Written::Back)
        }
        Kept::File(copy) => replace(
            &full,
            |temporary| fs::copy(copy, temporary).map(|_| ()),
            || Ok(unchanged()),
        ),
        Kept::Link(target) => replace(
            &full,
            |temporary| link(target, temporary),
            || Ok(unchanged()),
        ),
    }
}

/// Writes `full` through a temporary name beside it: `write` makes the temporary, and once
/// `unchanged` says the path still holds what it held, the temporary is renamed over it, so
/// that a failed write never leaves half a file.
fn replace(
    full: &Path,
    write: impl FnOnce(&Path) -> io::Result<()>,
    unchanged: impl FnOnce() -> io::Result<bool>,
) -> io::Result<Written> {
    let temporary = temporary_beside(full)?;
    let written = write(&temporary).and_then(|()| {
        if unchanged()? {
            fs::rename(&temporary, full).map(|()| Written::Back)
        } else {
            Ok(Written::Changed)
        }
    });
    if !matches!(written, Ok(Written::Back)) {
        // The temporary may not exist; the write's own answer is the one to report.
        let _ = remove_entry(&temporary);
    }
    written
}

/// A free name beside `full` for [`replace`]'s temporary: `.<name>.begitra-undo`, then with a
/// number.
fn temporary_beside(full: &Path) -> io::Result<PathBuf> {
    let (Some(parent), Some(name)) = (full.parent(), full.file_name()) else {
        return Err(io::Error::other(format!(
            "{} has no file name",
            full.display()
        )));
    };
    let name = name.to_string_lossy();
    for attempt in 0..100 {
        let candidate = match attempt {
            0 => parent.join(format!(".{name}.begitra-undo")),
            n => parent.join(format!(".{name}.begitra-undo-{n}")),
        };
        if let Err(error) = fs::symlink_metadata(&candidate) {
            if error.kind() == io::ErrorKind::NotFound {
                return Ok(candidate);
            }
        }
    }
    Err(io::Error::other(format!(
        "no free name beside {}",
        full.display()
    )))
}

#[cfg(unix)]
fn link(target: &Path, at: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, at)
}

/// A link to a file; one that needs Developer Mode or the right to make links, and a refusal
/// leaves the path named as not written back. A link to a folder keeps no copy.
#[cfg(windows)]
fn link(target: &Path, at: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(target, at)
}

/// Removes a file or a link, a link to a folder included, which Windows removes as a folder.
fn remove_entry(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if is_folder_link(path) => fs::remove_dir(path).map_err(|_| error),
        result => result,
    }
}

#[cfg(windows)]
fn is_folder_link(path: &Path) -> bool {
    use std::os::windows::fs::FileTypeExt;
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink_dir())
}

#[cfg(not(windows))]
fn is_folder_link(_path: &Path) -> bool {
    false
}

/// Whether no running Begitra holds the session folder: no lock is taken in it (or it has no
/// lock file yet), and it is older than `grace`, since a start makes its folder before it
/// takes its lock.
fn abandoned(folder: &Path, grace: Duration) -> bool {
    let free = match OpenOptions::new().write(true).open(folder.join(LOCK_FILE)) {
        Ok(lock) => lock.try_lock().is_ok(),
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    };
    free && fs::metadata(folder)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= grace)
}

/// Removes a copy's folder; a failure is logged, and the next start removes what is left.
fn remove_folder(folder: &Path) {
    if let Err(error) = fs::remove_dir_all(folder) {
        if error.kind() != io::ErrorKind::NotFound {
            tracing::warn!(%error, folder = %folder.display(), "a discard's copy could not be removed");
        }
    }
}

fn too_large(total: u64, limit: u64) -> AppError {
    AppError::new(
        codes::DISCARD_TOO_LARGE,
        format!(
            "The files add up to more than {} MB, past what a copy holds",
            limit / (1024 * 1024)
        ),
    )
    .with_detail(format!("{total} bytes"))
}

fn not_a_file(path: &str) -> AppError {
    AppError::new(
        codes::DISCARD_NOT_A_FILE,
        format!("{path} is not a file, which a copy does not hold"),
    )
    .with_detail(path)
}

fn behind_link(path: &str) -> AppError {
    AppError::new(
        codes::DISCARD_BEHIND_LINK,
        format!("{path} is behind a link or a junction, which can lead outside the working tree"),
    )
    .with_detail(path)
}

fn copy_failed(reason: impl Into<String>) -> AppError {
    AppError::new(
        codes::DISCARD_COPY_FAILED,
        "No copy of the discarded files could be kept",
    )
    .with_detail(reason)
}

fn copy_gone() -> AppError {
    AppError::new(codes::DISCARD_COPY_GONE, "The copy of this discard is gone")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::Duration;

    use super::*;
    use crate::error::codes;

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        parent: PathBuf,
        store: Discards,
    }

    fn fixture(limit: u64) -> Fixture {
        let dir = tempfile::tempdir().expect("temporary folder");
        let root = dir.path().join("repo");
        fs::create_dir(&root).expect("working tree");
        let parent = dir.path().join("data").join("discards");
        let store = Discards::with_limit(limit);
        store.open(&parent).expect("session folder");
        Fixture {
            _dir: dir,
            root,
            parent,
            store,
        }
    }

    fn write(root: &Path, path: &str, text: &str) {
        let full = root.join(path);
        fs::create_dir_all(full.parent().expect("a parent")).expect("folders");
        fs::write(full, text).expect("written");
    }

    fn read(root: &Path, path: &str) -> Option<String> {
        fs::read_to_string(root.join(path)).ok()
    }

    fn session(store: &Discards) -> PathBuf {
        store
            .lock()
            .session
            .as_ref()
            .expect("an open session")
            .folder
            .clone()
    }

    /// The copies in the session's folder.
    fn copies(store: &Discards) -> usize {
        fs::read_dir(session(store))
            .expect("session folder")
            .filter(|entry| {
                entry
                    .as_ref()
                    .expect("entry")
                    .file_type()
                    .expect("type")
                    .is_dir()
            })
            .count()
    }

    /// Temporary files Undo left in the working tree.
    fn leftovers(root: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut folders = vec![root.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(folder).expect("folder").flatten() {
                let path = entry.path();
                if entry.file_type().expect("type").is_dir() {
                    folders.push(path);
                } else if path.to_string_lossy().contains(".begitra-undo") {
                    found.push(path);
                }
            }
        }
        found
    }

    #[cfg(unix)]
    fn folder_link(target: &Path, at: &Path) {
        std::os::unix::fs::symlink(target, at).expect("link");
    }

    /// A junction, which Windows makes without Developer Mode.
    #[cfg(windows)]
    fn folder_link(target: &Path, at: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(at)
            .arg(target)
            .output()
            .expect("mklink");
        assert!(status.status.success(), "{status:?}");
    }

    #[cfg(unix)]
    fn remove_folder_link(at: &Path) {
        fs::remove_file(at).expect("link removed");
    }

    #[cfg(windows)]
    fn remove_folder_link(at: &Path) {
        fs::remove_dir(at).expect("junction removed");
    }

    #[test]
    fn undo_writes_a_discarded_edit_back() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "src/a.txt", "mine\n");
        let pending = f.store.keep(&f.root, ["src/a.txt"]).expect("kept");
        // What `git restore` leaves.
        write(&f.root, "src/a.txt", "theirs\n");
        let id = f.store.seal(pending);
        assert_eq!(copies(&f.store), 1);

        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["src/a.txt"]);
        assert!(outcome.changed.is_empty() && outcome.failed.is_empty());
        assert_eq!(read(&f.root, "src/a.txt").as_deref(), Some("mine\n"));
        assert_eq!(copies(&f.store), 0);
        assert!(leftovers(&f.root).is_empty());
    }

    #[test]
    fn undo_brings_back_a_cleaned_file_and_deletes_a_restored_one() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "new.txt", "untracked\n");
        // `gone.txt` is a tracked file deleted in the working tree: nothing is there.
        let pending = f
            .store
            .keep(&f.root, ["new.txt", "gone.txt"])
            .expect("kept");
        fs::remove_file(f.root.join("new.txt")).expect("git clean");
        write(&f.root, "gone.txt", "restored\n");
        let id = f.store.seal(pending);

        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["new.txt", "gone.txt"]);
        assert_eq!(read(&f.root, "new.txt").as_deref(), Some("untracked\n"));
        assert!(!f.root.join("gone.txt").exists());
    }

    #[test]
    fn a_file_changed_since_is_left_and_named() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "mine\n");
        write(&f.root, "b.txt", "mine too\n");
        let pending = f.store.keep(&f.root, ["a.txt", "b.txt"]).expect("kept");
        write(&f.root, "a.txt", "abc\n");
        write(&f.root, "b.txt", "git\n");
        let id = f.store.seal(pending);
        // An editor saves `a.txt` again, as long as git's version.
        write(&f.root, "a.txt", "abd\n");

        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.changed, ["a.txt"]);
        assert_eq!(outcome.restored, ["b.txt"]);
        assert_eq!(read(&f.root, "a.txt").as_deref(), Some("abd\n"));
        assert_eq!(read(&f.root, "b.txt").as_deref(), Some("mine too\n"));
        assert_eq!(copies(&f.store), 0);
    }

    #[test]
    fn a_path_twice_is_kept_once() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "mine\n");
        let pending = f.store.keep(&f.root, ["a.txt", "a.txt"]).expect("kept");
        write(&f.root, "a.txt", "git\n");
        let id = f.store.seal(pending);
        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["a.txt"]);
    }

    #[test]
    fn a_path_that_is_not_a_file_is_refused() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "x");
        fs::create_dir_all(f.root.join("nested").join(".git")).expect("nested repository");
        let error = f
            .store
            .keep(&f.root, ["a.txt", "nested/"])
            .expect_err("refused");
        assert_eq!(error.code, codes::DISCARD_NOT_A_FILE);
        assert_eq!(error.detail.as_deref(), Some("nested/"));
        assert_eq!(copies(&f.store), 0);
    }

    #[test]
    fn a_copy_past_the_limit_is_refused() {
        let f = fixture(10);
        write(&f.root, "a.txt", "12345");
        write(&f.root, "b.txt", "123456");
        let error = f
            .store
            .keep(&f.root, ["a.txt", "b.txt"])
            .expect_err("refused");
        assert_eq!(error.code, codes::DISCARD_TOO_LARGE);
        assert_eq!(copies(&f.store), 0);
        assert!(f.store.keep(&f.root, ["a.txt"]).is_ok());
    }

    #[test]
    fn without_a_data_folder_no_copy_is_kept() {
        let store = Discards::default();
        let error = store.keep(Path::new("."), ["a.txt"]).expect_err("refused");
        assert_eq!(error.code, codes::DISCARD_COPY_FAILED);
    }

    #[test]
    fn a_copy_never_sealed_goes() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "x");
        let pending = f.store.keep(&f.root, ["a.txt"]).expect("kept");
        assert_eq!(copies(&f.store), 1);
        drop(pending);
        assert_eq!(copies(&f.store), 0);
    }

    #[test]
    fn forget_removes_the_copy() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "x");
        let pending = f.store.keep(&f.root, ["a.txt"]).expect("kept");
        let id = f.store.seal(pending);
        f.store.forget(&id);
        assert_eq!(copies(&f.store), 0);
        let error = f.store.undo(&id, &f.root).expect_err("gone");
        assert_eq!(error.code, codes::DISCARD_COPY_GONE);
        f.store.forget(&id);
    }

    #[test]
    fn one_copy_stands_at_a_time() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "first\n");
        let first = f.store.keep(&f.root, ["a.txt"]).expect("kept");
        write(&f.root, "a.txt", "git\n");
        let first = f.store.seal(first);
        write(&f.root, "b.txt", "second\n");
        let second = f.store.keep(&f.root, ["b.txt"]).expect("kept");
        fs::remove_file(f.root.join("b.txt")).expect("git clean");
        let second = f.store.seal(second);
        assert_ne!(first, second);
        assert_eq!(copies(&f.store), 1);

        let error = f.store.undo(&first, &f.root).expect_err("replaced");
        assert_eq!(error.code, codes::DISCARD_COPY_GONE);
        let outcome = f.store.undo(&second, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["b.txt"]);
    }

    #[test]
    fn another_repository_is_refused_and_the_copy_stays() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "mine\n");
        let pending = f.store.keep(&f.root, ["a.txt"]).expect("kept");
        write(&f.root, "a.txt", "git\n");
        let id = f.store.seal(pending);
        let other = f.root.with_file_name("other");
        let error = f.store.undo(&id, &other).expect_err("refused");
        assert_eq!(error.code, codes::IPC_INVALID_ARGUMENT);
        assert_eq!(copies(&f.store), 1);
        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["a.txt"]);
    }

    #[test]
    fn a_write_that_fails_keeps_its_copy_for_another_undo() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "d/new.txt", "untracked\n");
        let pending = f.store.keep(&f.root, ["d/new.txt"]).expect("kept");
        fs::remove_file(f.root.join("d").join("new.txt")).expect("git clean");
        let id = f.store.seal(pending);
        // `d` becomes a link to a folder outside the working tree: nothing is written there.
        let outside = f.root.with_file_name("outside");
        fs::create_dir(&outside).expect("outside");
        fs::remove_dir(f.root.join("d")).expect("d removed");
        folder_link(&outside, &f.root.join("d"));

        let outcome = f.store.undo(&id, &f.root).expect("answered");
        assert!(outcome.restored.is_empty() && outcome.changed.is_empty());
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].path, "d/new.txt");
        assert_eq!(outcome.failed[0].reason, "d is a link");
        assert!(!outside.join("new.txt").exists());
        assert_eq!(copies(&f.store), 1);

        // With the folder back, Undo again writes the file.
        remove_folder_link(&f.root.join("d"));
        fs::create_dir(f.root.join("d")).expect("d again");
        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["d/new.txt"]);
        assert_eq!(read(&f.root, "d/new.txt").as_deref(), Some("untracked\n"));
        assert_eq!(copies(&f.store), 0);
    }

    #[test]
    fn a_path_behind_a_link_gets_no_copy() {
        let f = fixture(COPY_LIMIT);
        let outside = f.root.with_file_name("outside");
        fs::create_dir(&outside).expect("outside");
        fs::write(outside.join("keep.txt"), "outside\n").expect("file");
        folder_link(&outside, &f.root.join("j"));
        let error = f.store.keep(&f.root, ["j/keep.txt"]).expect_err("refused");
        assert_eq!(error.code, codes::DISCARD_BEHIND_LINK);
        assert_eq!(error.detail.as_deref(), Some("j/keep.txt"));
        assert_eq!(copies(&f.store), 0);
        remove_folder_link(&f.root.join("j"));
    }

    #[test]
    fn a_path_outside_the_working_tree_is_refused() {
        let f = fixture(COPY_LIMIT);
        let mut outside = vec!["../x.txt", "a/../../x.txt", "/etc/passwd", "./a.txt", ""];
        if cfg!(windows) {
            outside.extend(["C:\\x.txt", "C:x.txt", "\\\\server\\share\\x.txt"]);
        }
        for path in outside {
            let error = f.store.keep(&f.root, [path]).expect_err("refused");
            assert_eq!(error.code, codes::IPC_INVALID_ARGUMENT, "{path:?}");
        }
        assert_eq!(copies(&f.store), 0);
    }

    #[test]
    fn a_discard_git_stopped_keeps_what_it_changed() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "mine a\n");
        write(&f.root, "b.txt", "mine b\n");
        write(&f.root, "new.txt", "untracked\n");
        let pending = f
            .store
            .keep(&f.root, ["a.txt", "b.txt", "new.txt"])
            .expect("kept");
        // git restores a.txt and removes new.txt, then fails on b.txt.
        write(&f.root, "a.txt", "git a\n");
        fs::remove_file(f.root.join("new.txt")).expect("git clean");
        let id = f.store.seal_changed(pending).expect("a copy");

        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["a.txt", "new.txt"]);
        assert!(outcome.changed.is_empty() && outcome.failed.is_empty());
        assert_eq!(read(&f.root, "a.txt").as_deref(), Some("mine a\n"));
        assert_eq!(read(&f.root, "b.txt").as_deref(), Some("mine b\n"));
        assert_eq!(read(&f.root, "new.txt").as_deref(), Some("untracked\n"));
        assert_eq!(copies(&f.store), 0);
    }

    #[test]
    fn a_discard_git_refused_whole_keeps_nothing() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "mine\n");
        let pending = f.store.keep(&f.root, ["a.txt", "gone.txt"]).expect("kept");
        assert_eq!(f.store.seal_changed(pending), None);
        assert_eq!(copies(&f.store), 0);
    }

    /// A file another program holds open without sharing it cannot be read: its Undo fails,
    /// keeps the copy, and the next Undo writes it.
    #[cfg(windows)]
    #[test]
    fn a_file_another_program_holds_stays_for_another_undo() {
        use std::os::windows::fs::OpenOptionsExt;

        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "mine\n");
        let pending = f.store.keep(&f.root, ["a.txt"]).expect("kept");
        write(&f.root, "a.txt", "git\n");
        let id = f.store.seal(pending);
        let held = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(f.root.join("a.txt"))
            .expect("held");
        let outcome = f.store.undo(&id, &f.root).expect("answered");
        assert!(outcome.restored.is_empty() && outcome.changed.is_empty());
        assert_eq!(outcome.failed.len(), 1);
        assert_eq!(outcome.failed[0].path, "a.txt");
        assert_eq!(copies(&f.store), 1);
        drop(held);

        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["a.txt"]);
        assert_eq!(read(&f.root, "a.txt").as_deref(), Some("mine\n"));
    }

    #[test]
    fn many_files_go_and_come_back_across_threads() {
        let f = fixture(COPY_LIMIT);
        let paths: Vec<String> = (0..300)
            .map(|i| format!("d/sub{}/f{i}.txt", i % 10))
            .collect();
        for (i, path) in paths.iter().enumerate() {
            write(
                &f.root,
                path,
                &format!(
                    "mine {i}
"
                ),
            );
        }
        let pending = f
            .store
            .keep(&f.root, paths.iter().map(String::as_str))
            .expect("kept");
        // git clean takes every file, and the folders go with them.
        fs::remove_dir_all(f.root.join("d")).expect("git clean");
        let id = f.store.seal(pending);
        // An editor writes one of them again meanwhile.
        write(
            &f.root,
            "d/sub3/f3.txt",
            "editor
",
        );

        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.changed, ["d/sub3/f3.txt"]);
        assert_eq!(outcome.restored.len(), 299);
        assert_eq!(outcome.restored[0], "d/sub0/f0.txt");
        assert!(outcome.failed.is_empty());
        assert_eq!(
            read(&f.root, "d/sub7/f7.txt").as_deref(),
            Some(
                "mine 7
"
            )
        );
        assert_eq!(
            read(&f.root, "d/sub3/f3.txt").as_deref(),
            Some(
                "editor
"
            )
        );
        assert!(leftovers(&f.root).is_empty());
        assert_eq!(copies(&f.store), 0);
    }

    #[test]
    fn close_removes_the_session_folder() {
        let f = fixture(COPY_LIMIT);
        write(&f.root, "a.txt", "mine\n");
        let pending = f.store.keep(&f.root, ["a.txt"]).expect("kept");
        let id = f.store.seal(pending);
        let folder = session(&f.store);
        f.store.close();
        assert!(!folder.exists());
        let error = f.store.undo(&id, &f.root).expect_err("gone");
        assert_eq!(error.code, codes::DISCARD_COPY_GONE);
        let error = f.store.keep(&f.root, ["a.txt"]).expect_err("closed");
        assert_eq!(error.code, codes::DISCARD_COPY_FAILED);
    }

    #[test]
    fn sweep_removes_what_no_running_session_holds() {
        let f = fixture(COPY_LIMIT);
        // A crashed session's folder: its lock is free.
        let crashed = f.parent.join("1-1");
        write(&crashed, "1/0", "a copy");
        fs::write(crashed.join(LOCK_FILE), "").expect("lock file");
        // A running session's folder: its lock is held.
        let running = f.parent.join("2-2");
        fs::create_dir(&running).expect("running");
        let held = File::create(running.join(LOCK_FILE)).expect("lock file");
        held.try_lock().expect("held");
        // A start making its folder, its lock not taken yet.
        let starting = f.parent.join("3-3");
        fs::create_dir(&starting).expect("starting");
        // A stray file.
        fs::write(f.parent.join("stray"), "").expect("stray");

        // Young folders stay whatever their lock: a start may be making one.
        f.store.sweep_older_than(Duration::from_secs(3600));
        assert!(crashed.exists() && running.exists() && starting.exists());
        assert!(!f.parent.join("stray").exists());
        f.store.sweep_older_than(Duration::ZERO);
        assert!(!crashed.exists());
        assert!(!starting.exists());
        assert!(running.exists());
        assert!(session(&f.store).exists());
        drop(held);
    }

    #[cfg(unix)]
    #[test]
    fn permissions_and_links_come_back() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let f = fixture(COPY_LIMIT);
        write(&f.root, "run.sh", "#!/bin/sh\n");
        fs::set_permissions(f.root.join("run.sh"), fs::Permissions::from_mode(0o755))
            .expect("executable");
        symlink("run.sh", f.root.join("latest")).expect("link");
        let pending = f.store.keep(&f.root, ["run.sh", "latest"]).expect("kept");
        // git puts plain files back at both paths.
        fs::remove_file(f.root.join("latest")).expect("link removed");
        write(&f.root, "latest", "run.sh");
        write(&f.root, "run.sh", "echo\n");
        fs::set_permissions(f.root.join("run.sh"), fs::Permissions::from_mode(0o644))
            .expect("not executable");
        let id = f.store.seal(pending);

        let outcome = f.store.undo(&id, &f.root).expect("undone");
        assert_eq!(outcome.restored, ["run.sh", "latest"]);
        let mode = fs::metadata(f.root.join("run.sh"))
            .expect("run.sh")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(
            fs::read_link(f.root.join("latest")).expect("a link"),
            Path::new("run.sh")
        );
    }
}
