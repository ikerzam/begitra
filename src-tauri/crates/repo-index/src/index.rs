//! The repository index: one SQLite database with the repositories and worktrees found by the
//! scanner or opened by path, their last summary, pins and recents.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::IndexResult;
use crate::migrations;
use crate::types::{Found, IndexEntry, Operation, RepoKind, RepoSummary, Upstream};

/// The index database.
pub struct Index {
    connection: Connection,
}

impl Index {
    /// Opens (or creates) the database at `path` and applies pending migrations. The journal
    /// is write-ahead so reads never wait for a write.
    pub fn open(path: &Path) -> IndexResult<Self> {
        let connection = Connection::open(path)?;
        // A second instance of the app waits instead of failing at once.
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Self::prepare(connection)
    }

    /// A private in-memory database, for tests and for running without an app data folder.
    pub fn in_memory() -> IndexResult<Self> {
        Self::prepare(Connection::open_in_memory()?)
    }

    pub(crate) fn prepare(mut connection: Connection) -> IndexResult<Self> {
        migrations::migrate(&mut connection)?;
        Ok(Self { connection })
    }

    /// The connection, for the sibling modules (annotations).
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Records a repository or worktree found by the scanner (or opened by path when
    /// `found.scan_root` is empty), keeping its summary, pin and recents when it was known;
    /// `now` is the first-seen time of a new entry.
    pub fn upsert_found(&self, found: &Found, now: i64) -> IndexResult<()> {
        let scan_root = if found.scan_root.as_os_str().is_empty() {
            None
        } else {
            Some(path_text(&found.scan_root))
        };
        self.connection.execute(
            "INSERT INTO repos (path, name, kind, parent_path, scan_root, refreshed_at, missing)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT(path) DO UPDATE SET
               name = excluded.name,
               kind = excluded.kind,
               parent_path = excluded.parent_path,
               scan_root = COALESCE(excluded.scan_root, repos.scan_root),
               missing = 0",
            params![
                path_text(&found.path),
                found.name,
                kind_text(found.kind),
                found.parent_path.as_deref().map(path_text),
                scan_root,
                now,
            ],
        )?;
        Ok(())
    }

    /// Stores a fresh summary of `path`.
    pub fn update_summary(&self, path: &Path, summary: &RepoSummary, now: i64) -> IndexResult<()> {
        self.connection.execute(
            "UPDATE repos SET current_branch = ?2, detached = ?3, dirty = ?4, ahead = ?5,
               behind = ?6, last_commit_at = ?7, refreshed_at = ?8, missing = 0,
               upstream = ?9, operation = ?10, fetched_at = ?11, last_commit_subject = ?12,
               upstream_remote = ?13, upstream_branch = ?14
             WHERE path = ?1",
            params![
                path_text(path),
                summary.current_branch,
                summary.detached,
                summary.dirty,
                summary.ahead,
                summary.behind,
                summary.last_commit_at,
                now,
                summary.upstream.as_ref().map(|upstream| &upstream.name),
                summary.operation.map(operation_text),
                summary.fetched_at,
                summary.last_commit_subject,
                summary.upstream.as_ref().map(|upstream| &upstream.remote),
                summary.upstream.as_ref().map(|upstream| &upstream.branch),
            ],
        )?;
        Ok(())
    }

    /// Every entry, pinned first, then by name and path.
    pub fn list(&self) -> IndexResult<Vec<IndexEntry>> {
        let mut statement = self.connection.prepare(
            "SELECT path, name, kind, parent_path, scan_root, current_branch, detached, dirty,
                    ahead, behind, last_commit_at, pinned, last_opened_at, refreshed_at, missing,
                    upstream, operation, fetched_at, last_commit_subject, upstream_remote,
                    upstream_branch
             FROM repos ORDER BY pinned DESC, name COLLATE NOCASE ASC, path ASC",
        )?;
        let rows = statement.query_map([], entry_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// One entry by path.
    pub fn get(&self, path: &Path) -> IndexResult<Option<IndexEntry>> {
        Ok(self
            .connection
            .query_row(
                "SELECT path, name, kind, parent_path, scan_root, current_branch, detached, dirty,
                        ahead, behind, last_commit_at, pinned, last_opened_at, refreshed_at, missing,
                        upstream, operation, fetched_at, last_commit_subject, upstream_remote,
                        upstream_branch
                 FROM repos WHERE path = ?1",
                params![path_text(path)],
                entry_from_row,
            )
            .optional()?)
    }

    /// Pins or unpins an entry.
    pub fn set_pinned(&self, path: &Path, pinned: bool) -> IndexResult<()> {
        self.connection.execute(
            "UPDATE repos SET pinned = ?2 WHERE path = ?1",
            params![path_text(path), pinned],
        )?;
        Ok(())
    }

    /// Forgets an entry and, for a main repository, its worktrees.
    pub fn forget(&self, path: &Path) -> IndexResult<()> {
        let text = path_text(path);
        self.connection.execute(
            "DELETE FROM repos WHERE path = ?1 OR parent_path = ?1",
            params![text],
        )?;
        Ok(())
    }

    /// Records that an entry was opened now.
    pub fn record_open(&self, path: &Path, now: i64) -> IndexResult<()> {
        self.connection.execute(
            "UPDATE repos SET last_opened_at = ?2, missing = 0 WHERE path = ?1",
            params![path_text(path), now],
        )?;
        Ok(())
    }

    /// Flags an entry whose folder was not found (or clears the flag).
    pub fn mark_missing(&self, path: &Path, missing: bool) -> IndexResult<()> {
        self.connection.execute(
            "UPDATE repos SET missing = ?2 WHERE path = ?1",
            params![path_text(path), missing],
        )?;
        Ok(())
    }

    /// Drops every entry found under `root` (a removed scan folder); pinned entries and
    /// entries opened by hand stay, without a scan folder.
    pub fn remove_root(&self, root: &Path) -> IndexResult<()> {
        let text = path_text(root);
        self.connection.execute(
            "DELETE FROM repos WHERE scan_root = ?1 AND pinned = 0 AND last_opened_at IS NULL",
            params![text],
        )?;
        // Worktrees whose repository just went (and that were never pinned or opened).
        self.connection.execute(
            "DELETE FROM repos WHERE kind = 'worktree' AND pinned = 0 AND last_opened_at IS NULL
               AND parent_path IS NOT NULL
               AND parent_path NOT IN (SELECT path FROM repos WHERE kind = 'main')",
            [],
        )?;
        self.connection.execute(
            "UPDATE repos SET scan_root = NULL WHERE scan_root = ?1",
            params![text],
        )?;
        Ok(())
    }

    /// The paths under `root` that a scan did not report again: their folders are gone.
    pub fn mark_missing_under_root(
        &self,
        root: &Path,
        seen: &[PathBuf],
        now: i64,
    ) -> IndexResult<Vec<PathBuf>> {
        let mut statement = self
            .connection
            .prepare("SELECT path FROM repos WHERE scan_root = ?1")?;
        let known: Vec<String> = statement
            .query_map(params![path_text(root)], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let seen: std::collections::HashSet<String> = seen.iter().map(|p| path_text(p)).collect();
        let mut gone = Vec::new();
        for path in known {
            if !seen.contains(&path) {
                self.connection.execute(
                    "UPDATE repos SET missing = 1, refreshed_at = ?2 WHERE path = ?1",
                    params![path, now],
                )?;
                gone.push(PathBuf::from(path));
            }
        }
        Ok(gone)
    }
}

pub(crate) fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn operation_text(operation: Operation) -> &'static str {
    match operation {
        Operation::None => "none",
        Operation::Merge => "merge",
        Operation::Rebase => "rebase",
        Operation::CherryPick => "cherry-pick",
        Operation::Revert => "revert",
    }
}

/// The stored operation; a word this version does not know reads as unknown.
fn operation_from_text(text: &str) -> Option<Operation> {
    Some(match text {
        "none" => Operation::None,
        "merge" => Operation::Merge,
        "rebase" => Operation::Rebase,
        "cherry-pick" => Operation::CherryPick,
        "revert" => Operation::Revert,
        _ => return None,
    })
}

fn kind_text(kind: RepoKind) -> &'static str {
    match kind {
        RepoKind::Main => "main",
        RepoKind::Worktree => "worktree",
    }
}

fn entry_from_row(row: &Row<'_>) -> rusqlite::Result<IndexEntry> {
    let kind: String = row.get(2)?;
    let parent: Option<String> = row.get(3)?;
    let root: Option<String> = row.get(4)?;
    let path: String = row.get(0)?;
    let operation: Option<String> = row.get(16)?;
    let upstream: Option<String> = row.get(15)?;
    let upstream_remote: Option<String> = row.get(19)?;
    let upstream_branch: Option<String> = row.get(20)?;
    let upstream = match (upstream, upstream_remote, upstream_branch) {
        (Some(name), Some(remote), Some(branch)) => Some(Upstream {
            name,
            remote,
            branch,
        }),
        _ => None,
    };
    Ok(IndexEntry {
        path: PathBuf::from(path),
        name: row.get(1)?,
        kind: if kind == "worktree" {
            RepoKind::Worktree
        } else {
            RepoKind::Main
        },
        parent_path: parent.map(PathBuf::from),
        scan_root: root.map(PathBuf::from),
        summary: RepoSummary {
            current_branch: row.get(5)?,
            detached: row.get(6)?,
            upstream,
            dirty: row.get(7)?,
            ahead: row.get(8)?,
            behind: row.get(9)?,
            operation: operation.as_deref().and_then(operation_from_text),
            fetched_at: row.get(17)?,
            last_commit_at: row.get(10)?,
            last_commit_subject: row.get(18)?,
        },
        pinned: row.get(11)?,
        last_opened_at: row.get(12)?,
        refreshed_at: row.get(13)?,
        missing: row.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(path: &str, kind: RepoKind, parent: Option<&str>) -> Found {
        Found {
            path: PathBuf::from(path),
            name: Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            kind,
            parent_path: parent.map(PathBuf::from),
            scan_root: PathBuf::from("/code"),
        }
    }

    #[test]
    fn upserting_twice_keeps_one_row_and_its_summary() {
        let index = Index::in_memory().expect("index");
        let alpha = found("/code/alpha", RepoKind::Main, None);
        index.upsert_found(&alpha, 1).expect("insert");
        let summary = RepoSummary {
            current_branch: Some("main".to_owned()),
            ahead: Some(2),
            behind: Some(0),
            last_commit_at: Some(1_700_000_000),
            dirty: Some(true),
            ..RepoSummary::default()
        };
        index
            .update_summary(&alpha.path, &summary, 2)
            .expect("summary");
        index.set_pinned(&alpha.path, true).expect("pin");
        index.upsert_found(&alpha, 3).expect("second insert");
        let list = index.list().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].summary, summary);
        assert!(list[0].pinned);
        assert_eq!(list[0].refreshed_at, Some(2));
    }

    #[test]
    fn lists_pinned_first_then_by_name_and_forgets_worktrees_with_their_repository() {
        let index = Index::in_memory().expect("index");
        index
            .upsert_found(&found("/code/zeta", RepoKind::Main, None), 1)
            .expect("insert");
        index
            .upsert_found(&found("/code/alpha", RepoKind::Main, None), 1)
            .expect("insert");
        index
            .upsert_found(
                &found("/wt/feature", RepoKind::Worktree, Some("/code/alpha")),
                1,
            )
            .expect("insert");
        index
            .set_pinned(Path::new("/code/zeta"), true)
            .expect("pin");
        let names: Vec<String> = index
            .list()
            .expect("list")
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["zeta", "alpha", "feature"]);
        index.forget(Path::new("/code/alpha")).expect("forget");
        let names: Vec<String> = index
            .list()
            .expect("list")
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["zeta"]);
    }

    #[test]
    fn recents_missing_and_removed_roots() {
        let index = Index::in_memory().expect("index");
        let alpha = found("/code/alpha", RepoKind::Main, None);
        let beta = found("/code/beta", RepoKind::Main, None);
        index.upsert_found(&alpha, 1).expect("insert");
        index.upsert_found(&beta, 1).expect("insert");
        index.record_open(&alpha.path, 42).expect("open");
        index.mark_missing(&beta.path, true).expect("missing");
        let entry = index.get(&alpha.path).expect("get").expect("alpha");
        assert_eq!(entry.last_opened_at, Some(42));
        assert!(index.get(&beta.path).expect("get").expect("beta").missing);
        // A scan that no longer reports beta flags it; alpha was reported.
        let gone = index
            .mark_missing_under_root(Path::new("/code"), std::slice::from_ref(&alpha.path), 50)
            .expect("mark");
        assert_eq!(gone, std::slice::from_ref(&beta.path));
        // Removing the root drops beta (never opened, not pinned) and keeps alpha without a root.
        index.remove_root(Path::new("/code")).expect("remove root");
        let list = index.list().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "alpha");
        assert!(list[0].scan_root.is_none());
    }

    #[test]
    fn five_hundred_entries_list_quickly() {
        let index = Index::in_memory().expect("index");
        let summary = RepoSummary {
            current_branch: Some("main".to_owned()),
            upstream: Some(Upstream {
                name: "origin/main".to_owned(),
                remote: "origin".to_owned(),
                branch: "main".to_owned(),
            }),
            ahead: Some(1),
            behind: Some(0),
            operation: Some(Operation::None),
            fetched_at: Some(1_700_000_000),
            last_commit_at: Some(1_700_000_000),
            dirty: Some(false),
            ..RepoSummary::default()
        };
        for i in 0..500 {
            let entry = found(&format!("/code/repo-{i:03}"), RepoKind::Main, None);
            index.upsert_found(&entry, 1).expect("insert");
            index
                .update_summary(&entry.path, &summary, 2)
                .expect("summary");
        }
        let started = std::time::Instant::now();
        let list = index.list().expect("list");
        let elapsed = started.elapsed();
        assert_eq!(list.len(), 500);
        assert_eq!(list[0].summary, summary);
        assert!(
            elapsed < std::time::Duration::from_millis(50),
            "{elapsed:?}"
        );
    }

    #[test]
    fn a_summary_keeps_the_upstream_the_operation_and_the_last_fetch() {
        let index = Index::in_memory().expect("index");
        let alpha = found("/code/alpha", RepoKind::Main, None);
        index.upsert_found(&alpha, 1).expect("insert");
        let fresh = index.get(&alpha.path).expect("get").expect("alpha");
        assert_eq!(fresh.summary.upstream, None);
        assert_eq!(
            fresh.summary.operation, None,
            "unknown until a summary reads it"
        );
        assert_eq!(fresh.summary.fetched_at, None);
        for operation in [
            Operation::Merge,
            Operation::Rebase,
            Operation::CherryPick,
            Operation::Revert,
            Operation::None,
        ] {
            let summary = RepoSummary {
                current_branch: Some("develop".to_owned()),
                upstream: Some(Upstream {
                    name: "my/fork/develop".to_owned(),
                    remote: "my/fork".to_owned(),
                    branch: "develop".to_owned(),
                }),
                operation: Some(operation),
                fetched_at: Some(1_700_000_100),
                last_commit_subject: Some("feat(tiles): cache décodé".to_owned()),
                ..RepoSummary::default()
            };
            index
                .update_summary(&alpha.path, &summary, 2)
                .expect("summary");
            assert_eq!(
                index.get(&alpha.path).expect("get").expect("alpha").summary,
                summary
            );
            assert_eq!(index.list().expect("list")[0].summary, summary);
        }
    }

    #[test]
    fn an_index_of_version_3_keeps_its_rows_pins_recents_and_notes() {
        let mut connection = Connection::open_in_memory().expect("database");
        migrations::migrate_to(&mut connection, 3).expect("version 3");
        for i in 0..40 {
            connection
                .execute(
                    "INSERT INTO repos (path, name, kind, scan_root, current_branch, dirty, ahead,
                       behind, last_commit_at, pinned, last_opened_at, refreshed_at)
                     VALUES (?1, ?2, 'main', '/code', 'main', 0, 1, 2, 1700000000, ?3, ?4, 5)",
                    params![
                        format!("/code/repo-{i:02}"),
                        format!("repo-{i:02}"),
                        i < 3,
                        (i % 10 == 0).then_some(1_700_000_000 + i64::from(i)),
                    ],
                )
                .expect("row");
        }
        connection
            .execute(
                "INSERT INTO annotations (repo, target, path, hunk, kind, value, updated_at)
                 VALUES ('/code/repo-00', 'HEAD', 'src/lib.rs', '', 'note', 'check', 9)",
                [],
            )
            .expect("note");

        let index = Index::prepare(connection).expect("migrated");
        let version: u32 = index
            .connection()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, migrations::CURRENT_VERSION);
        let list = index.list().expect("list");
        assert_eq!(list.len(), 40);
        assert_eq!(list.iter().filter(|entry| entry.pinned).count(), 3);
        assert_eq!(
            list.iter()
                .filter(|entry| entry.last_opened_at.is_some())
                .count(),
            4
        );
        let first = index
            .get(Path::new("/code/repo-00"))
            .expect("get")
            .expect("repo-00");
        assert!(first.pinned);
        assert_eq!(first.last_opened_at, Some(1_700_000_000));
        assert_eq!(
            first.summary,
            RepoSummary {
                current_branch: Some("main".to_owned()),
                dirty: Some(false),
                ahead: Some(1),
                behind: Some(2),
                last_commit_at: Some(1_700_000_000),
                ..RepoSummary::default()
            }
        );
        assert!(index.projects().expect("projects").is_empty());
        let notes = index
            .list_annotations(Path::new("/code/repo-00"), "HEAD")
            .expect("notes");
        assert_eq!(notes.len(), 1);
    }
}
