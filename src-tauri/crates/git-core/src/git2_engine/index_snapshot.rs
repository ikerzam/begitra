//! A snapshot of the index entries, and the paths two snapshots differ in: what an `index`
//! change moved, so the working-tree lists read only those paths. A rewrite that refreshes
//! stat data (another tool running `git status`) changes no entry and names nothing.

use std::cmp::Ordering;
use std::path::Path;

use git2::{Index, IndexEntryExtendedFlag, IndexEntryFlag, Oid};

use crate::error::{GitError, GitResult};

/// The entries of an index as git's status reads them, sorted by path and stage.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IndexSnapshot {
    entries: Vec<Entry>,
}

/// One entry: what makes git list it differently, not its stat data.
#[derive(Clone, Debug, PartialEq, Eq)]
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

impl IndexSnapshot {
    /// Reads the index file at `path` without taking its lock; a missing file is an empty
    /// index. Fails on an index libgit2 cannot read (a split or sparse index).
    pub fn read(path: &Path) -> GitResult<Self> {
        let index = Index::open(path).map_err(GitError::from)?;
        let mut entries: Vec<Entry> = Vec::with_capacity(index.len());
        entries.extend(index.iter().map(|entry| {
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
        }));
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
