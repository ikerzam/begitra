//! A snapshot of the index entries, and the paths two snapshots differ in: what an `index`
//! change moved, so the working-tree lists read only those paths. A rewrite that refreshes
//! stat data (another tool running `git status`) changes no entry and names nothing. A digest
//! of the same entries tells only whether they moved, in 16 bytes where a snapshot keeps them
//! all.

use std::cmp::Ordering;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use git2::{Index, IndexEntryExtendedFlag, IndexEntryFlag, Oid};

use crate::error::{GitError, GitResult};

/// The entries of an index as git's status reads them, sorted by path and stage.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IndexSnapshot {
    entries: Vec<Entry>,
}

/// One entry: what makes git list it differently, not its stat data.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Entry {
    path: Vec<u8>,
    /// 0, or 1 to 3 for the sides of a conflict.
    stage: u16,
    id: Oid,
    mode: u32,
    /// The flags git's status honours: assume-unchanged, skip-worktree, intent-to-add.
    flags: u8,
}

const ASSUME_UNCHANGED: u8 = 1;
const SKIP_WORKTREE: u8 = 2;
const INTENT_TO_ADD: u8 = 4;

/// What differs between two snapshots.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IndexChanges {
    /// The paths whose entries differ, sorted and each once; `None` when one of them is not
    /// UTF-8, which the frontend could not name, or past the limit asked for.
    pub paths: Option<Vec<String>>,
    /// Whether an entry of stage 1 to 3 came, went or changed: the conflicts moved.
    pub conflicts: bool,
}

/// The entry as a snapshot keeps it.
fn entry_of(entry: git2::IndexEntry) -> Entry {
    let flags = IndexEntryFlag::from_bits_truncate(entry.flags);
    let extended = IndexEntryExtendedFlag::from_bits_truncate(entry.flags_extended);
    let mut kept = 0;
    if flags.contains(IndexEntryFlag::VALID) {
        kept |= ASSUME_UNCHANGED;
    }
    if extended.contains(IndexEntryExtendedFlag::SKIP_WORKTREE) {
        kept |= SKIP_WORKTREE;
    }
    if extended.contains(IndexEntryExtendedFlag::INTENT_TO_ADD) {
        kept |= INTENT_TO_ADD;
    }
    Entry {
        stage: (entry.flags >> 12) & 0x3,
        path: entry.path,
        id: entry.id,
        mode: entry.mode,
        flags: kept,
    }
}

impl IndexSnapshot {
    /// Reads the index file at `path` without taking its lock; a missing file is an empty
    /// index. Fails on an index libgit2 cannot read (a split or sparse index).
    pub fn read(path: &Path) -> GitResult<Self> {
        let index = Index::open(path).map_err(GitError::from)?;
        let mut entries: Vec<Entry> = Vec::with_capacity(index.len());
        entries.extend(index.iter().map(entry_of));
        // The index keeps this order already; sorting costs little when it holds.
        entries.sort_unstable_by(|a, b| key(a).cmp(&key(b)));
        Ok(Self { entries })
    }

    /// The paths whose entries differ in `newer`, at most `limit` of them (past it the paths
    /// are unknown, and no string is built for a checkout that moved thousands), and whether
    /// the conflicts moved.
    pub fn changes(&self, newer: &Self, limit: usize) -> IndexChanges {
        let mut changed: Vec<&Entry> = Vec::new();
        let mut olds = self.entries.iter().peekable();
        let mut news = newer.entries.iter().peekable();
        loop {
            match (olds.peek(), news.peek()) {
                (None, None) => break,
                (Some(&old), None) => {
                    changed.push(old);
                    olds.next();
                }
                (None, Some(&new)) => {
                    changed.push(new);
                    news.next();
                }
                (Some(&old), Some(&new)) => match key(old).cmp(&key(new)) {
                    Ordering::Less => {
                        changed.push(old);
                        olds.next();
                    }
                    Ordering::Greater => {
                        changed.push(new);
                        news.next();
                    }
                    Ordering::Equal => {
                        if old != new {
                            changed.push(new);
                        }
                        olds.next();
                        news.next();
                    }
                },
            }
        }
        let conflicts = changed.iter().any(|entry| entry.stage != 0);
        // Merged in path order, so a path's stages are next to each other.
        let mut paths: Vec<&[u8]> = changed.iter().map(|entry| entry.path.as_slice()).collect();
        paths.dedup();
        if paths.len() > limit {
            return IndexChanges {
                paths: None,
                conflicts,
            };
        }
        let paths = paths
            .into_iter()
            .map(|path| String::from_utf8(path.to_vec()).ok())
            .collect();
        IndexChanges { paths, conflicts }
    }
}

fn key(entry: &Entry) -> (&[u8], u16) {
    (&entry.path, entry.stage)
}

/// A digest of an index's entries as [`IndexSnapshot`] compares them, and of its conflicted
/// entries alone (a 64-bit hash each): two digests tell an index whose entries stayed (a
/// rewrite of stat data) from one whose entries moved, which they cannot name, and whether the
/// conflicts moved. Digests compare within one process; they are not stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IndexDigest {
    entries: u64,
    conflicts: u64,
}

impl IndexDigest {
    /// Reads the index file at `path` as [`IndexSnapshot::read`] does and keeps its digest.
    pub fn read(path: &Path) -> GitResult<Self> {
        let index = Index::open(path).map_err(GitError::from)?;
        let mut entries = DefaultHasher::new();
        let mut conflicts = DefaultHasher::new();
        // libgit2 keeps the entries sorted by path and stage, the order both digests follow.
        for entry in index.iter().map(entry_of) {
            entry.hash(&mut entries);
            if entry.stage != 0 {
                entry.hash(&mut conflicts);
            }
        }
        Ok(Self {
            entries: entries.finish(),
            conflicts: conflicts.finish(),
        })
    }

    /// What moved in `newer`: no path when the entries stayed, the paths unknown when they
    /// moved, and whether the conflicts moved.
    pub fn changes(&self, newer: &Self) -> IndexChanges {
        IndexChanges {
            paths: (self.entries == newer.entries).then(Vec::new),
            conflicts: self.conflicts != newer.conflicts,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &[u8], stage: u16, id: u8) -> Entry {
        Entry {
            path: path.to_vec(),
            stage,
            id: Oid::from_bytes(&[id; 20]).expect("id"),
            mode: 0o100_644,
            flags: 0,
        }
    }

    fn snapshot(entries: Vec<Entry>) -> IndexSnapshot {
        IndexSnapshot { entries }
    }

    #[test]
    fn a_path_is_named_once_for_all_its_stages() {
        let before = snapshot(vec![entry(b"a.txt", 0, 1), entry(b"b.txt", 0, 1)]);
        let after = snapshot(vec![
            entry(b"a.txt", 1, 1),
            entry(b"a.txt", 2, 2),
            entry(b"a.txt", 3, 3),
            entry(b"b.txt", 0, 1),
        ]);
        let changes = before.changes(&after, usize::MAX);
        assert_eq!(changes.paths, Some(vec!["a.txt".to_owned()]));
        assert!(changes.conflicts);
    }

    #[test]
    fn a_name_that_is_not_utf8_leaves_the_paths_unknown() {
        let before = snapshot(vec![entry(b"caf\xe9.txt", 0, 1)]);
        let after = snapshot(vec![entry(b"caf\xe9.txt", 0, 2)]);
        assert_eq!(before.changes(&after, usize::MAX).paths, None);
        assert_eq!(before.changes(&before, usize::MAX).paths, Some(Vec::new()));
    }

    /// Writes an index file at `path` holding `entries` as (path, stage, id byte, seconds of
    /// the stat data).
    fn write_index(path: &Path, entries: &[(&str, u16, u8, i32)]) {
        let mut index = Index::open(path).expect("index");
        index.clear().expect("clear");
        for &(name, stage, id, seconds) in entries {
            index
                .add(&git2::IndexEntry {
                    ctime: git2::IndexTime::new(seconds, 0),
                    mtime: git2::IndexTime::new(seconds, 0),
                    dev: 0,
                    ino: 0,
                    mode: 0o100_644,
                    uid: 0,
                    gid: 0,
                    file_size: 3,
                    id: Oid::from_bytes(&[id; 20]).expect("id"),
                    flags: (stage << 12) | u16::try_from(name.len()).expect("short name"),
                    flags_extended: 0,
                    path: name.as_bytes().to_vec(),
                })
                .expect("add");
        }
        index.write().expect("write");
    }

    #[test]
    fn a_digest_names_nothing_for_stat_data_and_nothing_known_for_a_moved_entry() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("index");
        write_index(&path, &[("a.txt", 0, 1, 100), ("b.txt", 0, 1, 100)]);
        let before = IndexDigest::read(&path).expect("digest");
        // Another tool's status refreshes the stat data: nothing git lists moved.
        write_index(&path, &[("a.txt", 0, 1, 200), ("b.txt", 0, 1, 200)]);
        let refreshed = IndexDigest::read(&path).expect("digest");
        assert_eq!(
            before.changes(&refreshed),
            IndexChanges {
                paths: Some(Vec::new()),
                conflicts: false,
            }
        );
        // A staged edit moves an entry, which a digest cannot name.
        write_index(&path, &[("a.txt", 0, 2, 200), ("b.txt", 0, 1, 200)]);
        let staged = IndexDigest::read(&path).expect("digest");
        assert_eq!(
            refreshed.changes(&staged),
            IndexChanges {
                paths: None,
                conflicts: false,
            }
        );
    }

    #[test]
    fn a_digest_tells_whether_the_conflicts_moved() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("index");
        write_index(&path, &[("a.txt", 0, 1, 100), ("b.txt", 0, 1, 100)]);
        let merged = IndexDigest::read(&path).expect("digest");
        let conflicted = [
            ("a.txt", 1, 1, 100),
            ("a.txt", 2, 2, 100),
            ("a.txt", 3, 3, 100),
            ("b.txt", 0, 1, 100),
        ];
        write_index(&path, &conflicted);
        let stopped = IndexDigest::read(&path).expect("digest");
        assert!(merged.changes(&stopped).conflicts);
        // Another path staged while the conflict stays: the conflicts did not move.
        let mut staged = conflicted;
        staged[3] = ("b.txt", 0, 2, 100);
        write_index(&path, &staged);
        let later = IndexDigest::read(&path).expect("digest");
        assert_eq!(
            stopped.changes(&later),
            IndexChanges {
                paths: None,
                conflicts: false,
            }
        );
        // A missing file is an empty index, as for a snapshot.
        let missing = IndexDigest::read(&dir.path().join("none")).expect("digest");
        assert_eq!(missing.changes(&missing).paths, Some(Vec::new()));
    }

    #[test]
    fn a_mode_or_a_flag_is_a_change() {
        let before = snapshot(vec![entry(b"a.sh", 0, 1), entry(b"b.txt", 0, 1)]);
        let mut executable = entry(b"a.sh", 0, 1);
        executable.mode = 0o100_755;
        let mut assumed = entry(b"b.txt", 0, 1);
        assumed.flags = ASSUME_UNCHANGED;
        let after = snapshot(vec![executable, assumed]);
        assert_eq!(
            before.changes(&after, usize::MAX).paths,
            Some(vec!["a.sh".to_owned(), "b.txt".to_owned()])
        );
        // Past the limit the paths are unknown.
        assert_eq!(before.changes(&after, 1).paths, None);
    }
}
