//! The status through git's own scan: `git status --porcelain=v2 -z`, parsed
//! into the same entries libgit2's status produces. git's directory cache makes it eight
//! times faster than libgit2's stat of every entry on a tree of thirty thousand
//! directories, and its output is the reference the status tests compare against.
//!
//! Records of the `-z` porcelain, each NUL-terminated (the fields space-separated, the path
//! last and unquoted):
//!
//! - `1 XY sub mH mI mW hH hI path` — an ordinary change;
//! - `2 XY sub mH mI mW hH hI Xscore path` followed by a second NUL-terminated field, the
//!   original path — a rename or a copy;
//! - `u XY sub m1 m2 m3 mW h1 h2 h3 path` — an unmerged path;
//! - `? path` — untracked; `! path` — ignored.
//!
//! `X` is the change between HEAD and the index, `Y` between the index and the working
//! tree; a submodule is reported by its letters and never entered, as before.

use crate::types::{ChangeKind, StatusEntry};

/// Parses the NUL-separated output of `git status --porcelain=v2 -z`, sorted by path bytes,
/// one entry per path: a file removed from the index but still on disk (`git rm --cached`),
/// which git prints as a deletion and an untracked path, is one entry that is both, as
/// libgit2 reports it. Untracked records are dropped when `include_untracked` is off (the
/// scan then ran for the ignored paths only).
///
/// A record the parser does not understand is skipped rather than failing the status: a
/// future git may add a record type, and the rest of the listing is still right.
pub(super) fn parse(output: &[u8], include_untracked: bool) -> Vec<StatusEntry> {
    let mut records = output
        .split(|&byte| byte == 0)
        .filter(|record| !record.is_empty());
    let mut entries = Vec::with_capacity(output.iter().filter(|&&byte| byte == 0).count());
    while let Some(record) = records.next() {
        let Some((&kind, rest)) = record.split_first() else {
            continue;
        };
        let rest = rest.strip_prefix(b" ").unwrap_or(rest);
        let entry = match kind {
            b'1' => ordinary(rest),
            b'2' => {
                // The original path is the next record of the stream.
                let original = records.next().map(lossy);
                renamed(rest, original)
            }
            b'u' => unmerged(rest),
            b'?' if include_untracked && !rest.is_empty() => Some(StatusEntry {
                path: lossy(rest),
                old_path: None,
                staged: None,
                unstaged: None,
                untracked: true,
                ignored: false,
                conflicted: false,
            }),
            b'!' if !rest.is_empty() => Some(StatusEntry {
                path: lossy(rest),
                old_path: None,
                staged: None,
                unstaged: None,
                untracked: false,
                ignored: true,
                conflicted: false,
            }),
            _ => None,
        };
        if let Some(entry) = entry {
            entries.push(entry);
        }
    }
    entries.sort_by(|a, b| {
        a.path
            .as_bytes()
            .cmp(b.path.as_bytes())
            .then(a.untracked.cmp(&b.untracked))
    });
    merge_same_paths(entries)
}

/// Folds consecutive entries of one path into one: the deletion carries the untracked flag.
fn merge_same_paths(entries: Vec<StatusEntry>) -> Vec<StatusEntry> {
    let mut merged: Vec<StatusEntry> = Vec::with_capacity(entries.len());
    for entry in entries {
        match merged.last_mut() {
            Some(last) if last.path == entry.path => {
                last.untracked |= entry.untracked;
                last.ignored |= entry.ignored;
                last.conflicted |= entry.conflicted;
                last.staged = last.staged.or(entry.staged);
                last.unstaged = last.unstaged.or(entry.unstaged);
                last.old_path = last.old_path.take().or(entry.old_path);
            }
            _ => merged.push(entry),
        }
    }
    merged
}

/// The first of `count` space-separated fields of a record (the `XY` state) and the path
/// that follows them (the path itself may contain spaces).
fn fields(record: &[u8], count: usize) -> Option<(&[u8], &[u8])> {
    let mut first: Option<&[u8]> = None;
    let mut rest = record;
    for _ in 0..count {
        let end = rest.iter().position(|&byte| byte == b' ')?;
        if first.is_none() {
            first = Some(&rest[..end]);
        }
        rest = rest.get(end + 1..)?;
    }
    if rest.is_empty() {
        return None;
    }
    Some((first?, rest))
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The kinds `X` and `Y` name; `.` is no change on that side.
fn kinds(xy: &[u8]) -> (Option<ChangeKind>, Option<ChangeKind>) {
    let kind = |letter: Option<&u8>| match letter {
        Some(b'M') => Some(ChangeKind::Modified),
        Some(b'A') => Some(ChangeKind::Added),
        Some(b'D') => Some(ChangeKind::Deleted),
        Some(b'R') => Some(ChangeKind::Renamed),
        Some(b'C') => Some(ChangeKind::Copied),
        Some(b'T') => Some(ChangeKind::TypeChanged),
        _ => None,
    };
    (kind(xy.first()), kind(xy.get(1)))
}

fn ordinary(rest: &[u8]) -> Option<StatusEntry> {
    let (xy, path) = fields(rest, 7)?;
    let (staged, unstaged) = kinds(xy);
    Some(StatusEntry {
        path: lossy(path),
        old_path: None,
        staged,
        unstaged,
        untracked: false,
        ignored: false,
        conflicted: false,
    })
}

fn renamed(rest: &[u8], original: Option<String>) -> Option<StatusEntry> {
    let (xy, path) = fields(rest, 8)?;
    let (staged, unstaged) = kinds(xy);
    Some(StatusEntry {
        path: lossy(path),
        old_path: original,
        staged,
        unstaged,
        untracked: false,
        ignored: false,
        conflicted: false,
    })
}

/// An unmerged path: one entry flagged `conflicted` with the unstaged kind `Unmerged`, as
/// libgit2's conflicted entries were mapped.
fn unmerged(rest: &[u8]) -> Option<StatusEntry> {
    let (_, path) = fields(rest, 9)?;
    Some(StatusEntry {
        path: lossy(path),
        old_path: None,
        staged: None,
        unstaged: Some(ChangeKind::Unmerged),
        untracked: false,
        ignored: false,
        conflicted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> StatusEntry {
        StatusEntry {
            path: path.to_owned(),
            old_path: None,
            staged: None,
            unstaged: None,
            untracked: false,
            ignored: false,
            conflicted: false,
        }
    }

    #[test]
    fn parses_every_record_kind_and_sorts_by_path() {
        let output = concat!(
            "1 .M N... 100644 100644 100644 e69de29 e69de29 src/lib.rs\0",
            "1 A. N... 000000 100644 100644 0000000 e69de29 staged.txt\0",
            "2 R. N... 100644 100644 100644 e69de29 e69de29 R100 new name.txt\0old name.txt\0",
            "2 RM N... 100644 100644 100644 e69de29 abcdef0 R80 moved.rs\0src/moved.rs\0",
            "u UU N... 100644 100644 100644 100644 e69de29 e69de29 e69de29 conflict.txt\0",
            "? untracked ünïcode.txt\0",
            "! build/out.o\0",
            "1 .D N... 100644 100644 000000 e69de29 e69de29 gone.txt\0",
            "1 MM S.M. 160000 160000 160000 e69de29 e69de29 sub\0",
            "2 C. N... 100644 100644 100644 e69de29 e69de29 C90 copy.txt\0src/lib.rs\0",
            "1 D. N... 100644 000000 100644 e69de29 0000000 cached.txt\0",
            "? cached.txt\0",
        );
        let parsed = parse(output.as_bytes(), true);
        let paths: Vec<&str> = parsed.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "build/out.o",
                "cached.txt",
                "conflict.txt",
                "copy.txt",
                "gone.txt",
                "moved.rs",
                "new name.txt",
                "src/lib.rs",
                "staged.txt",
                "sub",
                "untracked ünïcode.txt",
            ]
        );
        let by_path = |path: &str| parsed.iter().find(|e| e.path == path).expect(path).clone();
        assert_eq!(
            by_path("src/lib.rs"),
            StatusEntry {
                unstaged: Some(ChangeKind::Modified),
                ..entry("src/lib.rs")
            }
        );
        assert_eq!(
            by_path("staged.txt"),
            StatusEntry {
                staged: Some(ChangeKind::Added),
                ..entry("staged.txt")
            }
        );
        assert_eq!(
            by_path("new name.txt"),
            StatusEntry {
                old_path: Some("old name.txt".to_owned()),
                staged: Some(ChangeKind::Renamed),
                ..entry("new name.txt")
            }
        );
        assert_eq!(
            by_path("moved.rs"),
            StatusEntry {
                old_path: Some("src/moved.rs".to_owned()),
                staged: Some(ChangeKind::Renamed),
                unstaged: Some(ChangeKind::Modified),
                ..entry("moved.rs")
            }
        );
        assert_eq!(
            by_path("conflict.txt"),
            StatusEntry {
                unstaged: Some(ChangeKind::Unmerged),
                conflicted: true,
                ..entry("conflict.txt")
            }
        );
        assert_eq!(
            by_path("untracked ünïcode.txt"),
            StatusEntry {
                untracked: true,
                ..entry("untracked ünïcode.txt")
            }
        );
        assert_eq!(
            by_path("build/out.o"),
            StatusEntry {
                ignored: true,
                ..entry("build/out.o")
            }
        );
        assert_eq!(
            by_path("gone.txt"),
            StatusEntry {
                unstaged: Some(ChangeKind::Deleted),
                ..entry("gone.txt")
            }
        );
        assert_eq!(
            by_path("sub"),
            StatusEntry {
                staged: Some(ChangeKind::Modified),
                unstaged: Some(ChangeKind::Modified),
                ..entry("sub")
            }
        );
        assert_eq!(
            by_path("copy.txt"),
            StatusEntry {
                old_path: Some("src/lib.rs".to_owned()),
                staged: Some(ChangeKind::Copied),
                ..entry("copy.txt")
            }
        );
        // `git rm --cached`: the deletion and the untracked path are one entry, as libgit2's.
        assert_eq!(
            by_path("cached.txt"),
            StatusEntry {
                staged: Some(ChangeKind::Deleted),
                untracked: true,
                ..entry("cached.txt")
            }
        );
        assert_eq!(parsed.iter().filter(|e| e.path == "cached.txt").count(), 1);
    }

    #[test]
    fn drops_untracked_records_when_they_were_not_asked_for_and_keeps_bytes_lossy() {
        let output = b"? scratch.txt\0! build/out.o\0? \xff\xfe.bin\0";
        let without = parse(output, false);
        assert_eq!(without.len(), 1);
        assert!(without[0].ignored);
        let with = parse(output, true);
        assert_eq!(with.len(), 3);
        assert!(with
            .iter()
            .any(|e| e.path == "\u{fffd}\u{fffd}.bin" && e.untracked));
    }

    #[test]
    fn skips_what_it_does_not_understand_and_empty_output() {
        assert!(parse(b"", true).is_empty());
        assert!(parse(b"\0\0", true).is_empty());
        let parsed = parse(b"# branch.oid abc\0z something new\0? kept.txt\0", true);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].path, "kept.txt");
        // A truncated record yields nothing rather than a panic; an empty path neither.
        assert!(parse(b"1 .M N...\0", true).is_empty());
        assert!(parse(b"?\0! \0", true).is_empty());
        assert!(
            parse(
                b"2 R. N... 100644 100644 100644 e69de29 e69de29 R100 lone\0",
                true
            )
            .len()
                == 1
        );
    }
}
