//! Review state: marks and notes per repository and review target, one row per
//! `(repo, target, path, hunk, kind)` so a write is an upsert and a read is one query. The
//! `kind` column leaves room for other annotations, such as an assistant's findings.

use std::path::Path;

use rusqlite::params;

use crate::error::IndexResult;
use crate::index::Index;
use crate::types::{Annotation, AnnotationKey, AnnotationKind};

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

    /// Writes or replaces one mark or note.
    pub fn set_annotation(
        &self,
        key: &AnnotationKey<'_>,
        value: &str,
        now: i64,
    ) -> IndexResult<()> {
        self.connection().execute(
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

    /// Removes one mark or note; returns whether it existed.
    pub fn delete_annotation(&self, key: &AnnotationKey<'_>) -> IndexResult<bool> {
        let removed = self.connection().execute(
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
}
