//! Review state: marks, notes and the notes' resolutions per repository and review target,
//! one row per `(repo, target, path, hunk, kind)` so a write is an upsert and a read is one
//! query. A resolution lives on its note's key and belongs to the note's text: the writes
//! that change or delete a note remove it in the same transaction, for the app and the agent
//! server alike. The repository is stored as the caller names it: both name it by the root
//! `git-core` opens, in the spelling the app stores (`git_core::spelling`).
//!
//! The writes that read before they write (a note's old text, whether a note exists) are
//! safe beside another process because every transaction begins `IMMEDIATE`
//! ([`Index::prepare`]): it takes the write lock before the read, waiting for it up to the
//! busy timeout.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::IndexResult;
use crate::index::Index;
use crate::types::{Annotation, AnnotationKey, AnnotationKind, AnnotationTarget, Resolution};

/// Longest note, or reply of a resolution, kept, in characters.
pub const MAX_NOTE_CHARS: usize = 10_000;
/// Longest path kept, in bytes.
pub const MAX_PATH_BYTES: usize = 4_096;
/// Longest hunk key and target kept, in bytes: with the path they key every row.
pub const MAX_KEY_BYTES: usize = 512;

impl Index {
    /// Every mark and note of `target` in the repository at `repo`, by path then hunk.
    pub fn list_annotations(&self, repo: &Path, target: &str) -> IndexResult<Vec<Annotation>> {
        let mut statement = self.connection().prepare(
            "SELECT path, hunk, kind, value, updated_at FROM annotations
             WHERE repo = ?1 AND target = ?2 ORDER BY path, hunk, kind",
        )?;
        let rows = statement.query_map(params![repo.to_string_lossy(), target], |row| {
            let kind: String = row.get(2)?;
            Ok((
                Annotation {
                    path: row.get(0)?,
                    hunk: row.get(1)?,
                    kind: AnnotationKind::Reviewed,
                    value: row.get(3)?,
                    updated_at: row.get(4)?,
                },
                kind,
            ))
        })?;
        let mut annotations = Vec::new();
        for row in rows {
            let (mut annotation, kind) = row?;
            // A kind a newer version wrote is skipped rather than failing the whole list.
            let Some(kind) = AnnotationKind::parse(&kind) else {
                continue;
            };
            annotation.kind = kind;
            annotations.push(annotation);
        }
        Ok(annotations)
    }

    /// Writes or replaces one mark, note or resolution. A note given another text than it
    /// had loses its resolution: it is another note. A resolution should go through
    /// [`Index::resolve_note`], which refuses a file without a note; this writes the row as
    /// asked.
    pub fn set_annotation(
        &self,
        key: &AnnotationKey<'_>,
        value: &str,
        now: i64,
    ) -> IndexResult<()> {
        let transaction = self.connection().unchecked_transaction()?;
        if key.kind == AnnotationKind::Note
            && value_of(&transaction, key)?.as_deref() != Some(value)
        {
            remove(&transaction, &with_kind(key, AnnotationKind::Resolved))?;
        }
        upsert(&transaction, key, value, now)?;
        transaction.commit()?;
        Ok(())
    }

    /// Removes one mark, note or resolution, a note with its resolution; returns whether it
    /// existed.
    pub fn delete_annotation(&self, key: &AnnotationKey<'_>) -> IndexResult<bool> {
        let transaction = self.connection().unchecked_transaction()?;
        let removed = remove(&transaction, key)?;
        if key.kind == AnnotationKind::Note {
            remove(&transaction, &with_kind(key, AnnotationKind::Resolved))?;
        }
        transaction.commit()?;
        Ok(removed)
    }

    /// Resolves the note at `key` (a note's key) with `reply`, replacing a resolution it had.
    /// With `written_at`, the note must still be the one written then: a reply about a text the
    /// user has since changed would resolve a note it does not answer. Nothing is written
    /// unless the outcome is [`Resolution::Resolved`].
    pub fn resolve_note(
        &self,
        key: &AnnotationKey<'_>,
        reply: &str,
        now: i64,
        written_at: Option<i64>,
    ) -> IndexResult<Resolution> {
        let transaction = self.connection().unchecked_transaction()?;
        let note = with_kind(key, AnnotationKind::Note);
        let Some(updated_at) = updated_at_of(&transaction, &note)? else {
            return Ok(Resolution::NoNote);
        };
        if written_at.is_some_and(|written_at| written_at != updated_at) {
            return Ok(Resolution::Changed);
        }
        upsert(
            &transaction,
            &with_kind(key, AnnotationKind::Resolved),
            reply,
            now,
        )?;
        transaction.commit()?;
        Ok(Resolution::Resolved)
    }

    /// Removes the resolution of the note at `key` (a note's key): `None` when there is no
    /// such note, else whether it had a resolution.
    pub fn reopen_note(&self, key: &AnnotationKey<'_>) -> IndexResult<Option<bool>> {
        let transaction = self.connection().unchecked_transaction()?;
        let note = with_kind(key, AnnotationKind::Note);
        if value_of(&transaction, &note)?.is_none() {
            return Ok(None);
        }
        let removed = remove(&transaction, &with_kind(key, AnnotationKind::Resolved))?;
        transaction.commit()?;
        Ok(Some(removed))
    }

    /// The review targets of the repository at `repo` that hold annotations, with their
    /// counts, the one written last first (then by key).
    pub fn annotation_targets(&self, repo: &Path) -> IndexResult<Vec<AnnotationTarget>> {
        let mut statement = self.connection().prepare(
            "SELECT target,
                    SUM(kind = 'reviewed' AND hunk = ''),
                    SUM(kind = 'reviewed' AND hunk <> ''),
                    SUM(kind = 'note'),
                    SUM(kind = 'resolved'),
                    MAX(updated_at)
             FROM annotations WHERE repo = ?1
             GROUP BY target ORDER BY MAX(updated_at) DESC, target",
        )?;
        let rows = statement.query_map(params![repo.to_string_lossy()], |row| {
            Ok(AnnotationTarget {
                target: row.get(0)?,
                files_reviewed: row.get(1)?,
                hunks_reviewed: row.get(2)?,
                notes: row.get(3)?,
                resolved: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }
}

/// `key` with another kind.
fn with_kind<'a>(key: &AnnotationKey<'a>, kind: AnnotationKind) -> AnnotationKey<'a> {
    AnnotationKey { kind, ..*key }
}

/// The value stored at `key`, if any.
fn value_of(connection: &Connection, key: &AnnotationKey<'_>) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT value FROM annotations
             WHERE repo = ?1 AND target = ?2 AND path = ?3 AND hunk = ?4 AND kind = ?5",
            params![
                key.repo.to_string_lossy(),
                key.target,
                key.path,
                key.hunk,
                key.kind.as_str()
            ],
            |row| row.get(0),
        )
        .optional()
}

/// When the row at `key` was written, if there is one.
fn updated_at_of(
    connection: &Connection,
    key: &AnnotationKey<'_>,
) -> rusqlite::Result<Option<i64>> {
    connection
        .query_row(
            "SELECT updated_at FROM annotations
             WHERE repo = ?1 AND target = ?2 AND path = ?3 AND hunk = ?4 AND kind = ?5",
            params![
                key.repo.to_string_lossy(),
                key.target,
                key.path,
                key.hunk,
                key.kind.as_str()
            ],
            |row| row.get(0),
        )
        .optional()
}

fn upsert(
    connection: &Connection,
    key: &AnnotationKey<'_>,
    value: &str,
    now: i64,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO annotations (repo, target, path, hunk, kind, value, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (repo, target, path, hunk, kind)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![
            key.repo.to_string_lossy(),
            key.target,
            key.path,
            key.hunk,
            key.kind.as_str(),
            value,
            now
        ],
    )?;
    Ok(())
}

/// Deletes the row at `key`; whether there was one.
fn remove(connection: &Connection, key: &AnnotationKey<'_>) -> rusqlite::Result<bool> {
    let removed = connection.execute(
        "DELETE FROM annotations
         WHERE repo = ?1 AND target = ?2 AND path = ?3 AND hunk = ?4 AND kind = ?5",
        params![
            key.repo.to_string_lossy(),
            key.target,
            key.path,
            key.hunk,
            key.kind.as_str()
        ],
    )?;
    Ok(removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        Index::in_memory().expect("in-memory index")
    }

    fn key<'a>(
        target: &'a str,
        path: &'a str,
        hunk: &'a str,
        kind: AnnotationKind,
    ) -> AnnotationKey<'a> {
        AnnotationKey {
            repo: Path::new("/r"),
            target,
            path,
            hunk,
            kind,
        }
    }

    #[test]
    fn set_twice_keeps_one_row_and_lists_per_target() {
        let index = index();
        let repo = Path::new("/r");
        let file = key("abc", "src/a.ts", "", AnnotationKind::Reviewed);
        index.set_annotation(&file, "1", 10).expect("set");
        index.set_annotation(&file, "1", 20).expect("set again");
        index
            .set_annotation(
                &key(
                    "abc",
                    "src/a.ts",
                    "@@ -1,2 +1,3 @@",
                    AnnotationKind::Reviewed,
                ),
                "1",
                30,
            )
            .expect("hunk");
        index
            .set_annotation(
                &key("abc", "src/a.ts", "", AnnotationKind::Note),
                "check this",
                40,
            )
            .expect("note");
        index
            .set_annotation(
                &key("def", "src/a.ts", "", AnnotationKind::Reviewed),
                "1",
                50,
            )
            .expect("other target");
        index
            .set_annotation(
                &AnnotationKey {
                    repo: Path::new("/other"),
                    ..file
                },
                "1",
                60,
            )
            .expect("other repository");
        let listed = index.list_annotations(repo, "abc").expect("list");
        assert_eq!(listed.len(), 3);
        assert_eq!(
            listed
                .iter()
                .map(|a| (a.hunk.as_str(), a.kind, a.value.as_str(), a.updated_at))
                .collect::<Vec<_>>(),
            vec![
                ("", AnnotationKind::Note, "check this", 40),
                ("", AnnotationKind::Reviewed, "1", 20),
                ("@@ -1,2 +1,3 @@", AnnotationKind::Reviewed, "1", 30),
            ]
        );
        assert_eq!(index.list_annotations(repo, "def").expect("list").len(), 1);
        assert!(index
            .list_annotations(repo, "zzz")
            .expect("list")
            .is_empty());
    }

    #[test]
    fn a_note_replaces_its_text_and_delete_reports_whether_it_existed() {
        let index = index();
        let repo = Path::new("/r");
        let note = key("abc", "a.rs", "", AnnotationKind::Note);
        index.set_annotation(&note, "first", 1).expect("set");
        index.set_annotation(&note, "second", 2).expect("replace");
        let listed = index.list_annotations(repo, "abc").expect("list");
        assert_eq!(listed[0].value, "second");
        assert!(index.delete_annotation(&note).expect("delete"));
        assert!(!index.delete_annotation(&note).expect("delete again"));
        assert!(index
            .list_annotations(repo, "abc")
            .expect("list")
            .is_empty());
    }

    fn kinds(index: &Index, target: &str) -> Vec<(String, AnnotationKind, String)> {
        index
            .list_annotations(Path::new("/r"), target)
            .expect("list")
            .into_iter()
            .map(|a| (a.path, a.kind, a.value))
            .collect()
    }

    #[test]
    fn a_resolution_belongs_to_its_note() {
        let index = index();
        let note = key("abc", "a.rs", "", AnnotationKind::Note);
        index.set_annotation(&note, "fix this", 1).expect("note");
        assert_eq!(
            index
                .resolve_note(&note, "fixed", 2, Some(1))
                .expect("resolve"),
            Resolution::Resolved
        );
        assert_eq!(
            kinds(&index, "abc"),
            vec![
                (
                    "a.rs".to_owned(),
                    AnnotationKind::Note,
                    "fix this".to_owned()
                ),
                (
                    "a.rs".to_owned(),
                    AnnotationKind::Resolved,
                    "fixed".to_owned()
                ),
            ]
        );
        // The same text written again is the same note: the resolution stays.
        index
            .set_annotation(&note, "fix this", 3)
            .expect("same note");
        assert_eq!(kinds(&index, "abc").len(), 2);
        // Another text is another note: the resolution goes with the old one.
        index
            .set_annotation(&note, "fix that", 4)
            .expect("new note");
        assert_eq!(
            kinds(&index, "abc"),
            vec![(
                "a.rs".to_owned(),
                AnnotationKind::Note,
                "fix that".to_owned()
            )]
        );
        // A reply about the text written at 1 does not resolve the one written at 4.
        assert_eq!(
            index
                .resolve_note(&note, "fixed", 5, Some(1))
                .expect("stale"),
            Resolution::Changed
        );
        assert_eq!(kinds(&index, "abc").len(), 1);
        assert_eq!(
            index
                .resolve_note(&note, "", 5, None)
                .expect("resolve again"),
            Resolution::Resolved
        );
        assert_eq!(index.reopen_note(&note).expect("reopen"), Some(true));
        assert_eq!(index.reopen_note(&note).expect("reopen again"), Some(false));
        assert_eq!(kinds(&index, "abc").len(), 1);
        assert_eq!(
            index
                .resolve_note(&note, "done", 6, None)
                .expect("resolve once more"),
            Resolution::Resolved
        );
        // Deleting the note deletes its resolution.
        assert!(index.delete_annotation(&note).expect("delete"));
        assert!(kinds(&index, "abc").is_empty());
    }

    #[test]
    fn a_file_without_a_note_cannot_be_resolved_or_reopened() {
        let index = index();
        let note = key("abc", "b.rs", "", AnnotationKind::Note);
        assert_eq!(
            index
                .resolve_note(&note, "fixed", 1, None)
                .expect("resolve"),
            Resolution::NoNote
        );
        assert_eq!(index.reopen_note(&note).expect("reopen"), None);
        assert!(kinds(&index, "abc").is_empty());
    }

    #[test]
    fn targets_with_their_counts_the_newest_first() {
        let index = index();
        let set = |target: &str, path: &str, hunk: &str, kind: AnnotationKind, at: i64| {
            index
                .set_annotation(&key(target, path, hunk, kind), "1", at)
                .expect("set");
        };
        set("abc", "a.rs", "", AnnotationKind::Reviewed, 10);
        set("abc", "a.rs", "@@ -1 +1 @@", AnnotationKind::Reviewed, 20);
        set("abc", "b.rs", "", AnnotationKind::Note, 30);
        assert_eq!(
            index
                .resolve_note(
                    &key("abc", "b.rs", "", AnnotationKind::Note),
                    "ok",
                    40,
                    None
                )
                .expect("resolve"),
            Resolution::Resolved
        );
        set("def", "c.rs", "", AnnotationKind::Note, 50);
        index
            .set_annotation(
                &AnnotationKey {
                    repo: Path::new("/other"),
                    ..key("zzz", "d.rs", "", AnnotationKind::Note)
                },
                "elsewhere",
                60,
            )
            .expect("other repository");
        let targets = index.annotation_targets(Path::new("/r")).expect("targets");
        assert_eq!(
            targets,
            vec![
                AnnotationTarget {
                    target: "def".to_owned(),
                    files_reviewed: 0,
                    hunks_reviewed: 0,
                    notes: 1,
                    resolved: 0,
                    updated_at: 50,
                },
                AnnotationTarget {
                    target: "abc".to_owned(),
                    files_reviewed: 1,
                    hunks_reviewed: 1,
                    notes: 1,
                    resolved: 1,
                    updated_at: 40,
                },
            ]
        );
        assert!(index
            .annotation_targets(Path::new("/nowhere"))
            .expect("none")
            .is_empty());
    }
}
