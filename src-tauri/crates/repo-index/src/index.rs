//! The repository index: one SQLite database with the repositories and worktrees found by the
//! scanner or opened by path, their last summary and recents, and the projects that hold them
//! (`projects.rs`).

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{IndexError, IndexResult};
use crate::migrations;
use crate::projects;
use crate::types::{Found, IndexEntry, Operation, RepoKind, RepoSummary, Upserted, Upstream};

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

    /// Opens the database the app keeps at `path` for a second process beside it (the agent
    /// server): never created (a missing file fails to open) and never migrated, with the
    /// app's settings. Fails with [`IndexError::Version`] when its schema is not this build's,
    /// rather than migrate a file the app reads, or write a schema it does not know.
    pub fn open_existing(path: &Path) -> IndexResult<Self> {
        let connection = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let mut connection = connection;
        connection.set_transaction_behavior(rusqlite::TransactionBehavior::Immediate);
        let index = Self { connection };
        index.check_version()?;
        Ok(index)
    }

    /// Fails with [`IndexError::Version`] unless the schema is this build's: a long-lived
    /// second process checks before each use, since an app of another version may have
    /// migrated the file meanwhile.
    pub fn check_version(&self) -> IndexResult<()> {
        let found: u32 = self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        if found == migrations::CURRENT_VERSION {
            Ok(())
        } else {
            Err(IndexError::Version {
                found,
                expected: migrations::CURRENT_VERSION,
            })
        }
    }

    /// A private in-memory database, for tests and for running without an app data folder.
    pub fn in_memory() -> IndexResult<Self> {
        Self::prepare(Connection::open_in_memory()?)
    }

    pub(crate) fn prepare(mut connection: Connection) -> IndexResult<Self> {
        // A transaction takes the write lock when it begins: one that reads before it writes
        // would otherwise fail at once, without the busy timeout, when a second instance of
        // the app writes in between.
        connection.set_transaction_behavior(rusqlite::TransactionBehavior::Immediate);
        migrations::migrate(&mut connection)?;
        Ok(Self { connection })
    }

    /// The connection, for the sibling modules (annotations).
    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Records a repository or worktree found by the scanner, or opened by path when
    /// `found.scan_root` is empty, keeping its summary, pin and recents when it was known
    /// (`now` is the first-seen time of a new entry), and keeps it in a project: found under a
    /// folder, it becomes one of that folder project's own members (one it held by hand turns
    /// its own); opened by path, it gets a list project of one when no project holds it.
    /// Found under a folder that has no project (removed while the scan ran), it is not
    /// stored.
    pub fn upsert_found(&self, found: &Found, now: i64) -> IndexResult<Upserted> {
        let transaction = self.connection.unchecked_transaction()?;
        let path = path_text(&found.path);
        let (scan_root, folder_project) = if found.scan_root.as_os_str().is_empty() {
            (None, None)
        } else {
            let root = path_text(&found.scan_root);
            let Some(id) = projects::folder_project_id(&transaction, &root)? else {
                return Ok(Upserted::NoFolderProject);
            };
            (Some(root), Some(id))
        };
        transaction.execute(
            "INSERT INTO repos (path, name, kind, parent_path, scan_root, refreshed_at, missing)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT(path) DO UPDATE SET
               name = excluded.name,
               kind = excluded.kind,
               parent_path = excluded.parent_path,
               scan_root = COALESCE(excluded.scan_root, repos.scan_root),
               missing = 0",
            params![
                path,
                found.name,
                kind_text(found.kind),
                found.parent_path.as_deref().map(path_text),
                scan_root,
                now,
            ],
        )?;
        match folder_project {
            Some(id) => projects::add_folder_member(&transaction, id, &path)?,
            None => {
                projects::project_holding(&transaction, &path, &found.name, now)?;
            }
        }
        transaction.commit()?;
        Ok(Upserted::Stored)
    }

    /// Stores a fresh summary of `path`.
    pub fn update_summary(&self, path: &Path, summary: &RepoSummary, now: i64) -> IndexResult<()> {
        self.connection.execute(
            "UPDATE repos SET current_branch = ?2, detached = ?3, dirty = ?4, ahead = ?5,
               behind = ?6, last_commit_at = ?7, refreshed_at = ?8, missing = 0,
               upstream = ?9, operation = ?10, fetched_at = ?11, last_commit_subject = ?12,
               upstream_remote = ?13, upstream_branch = ?14, upstream_push_remote = ?15
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
                summary
                    .upstream
                    .as_ref()
                    .map(|upstream| &upstream.push_remote),
            ],
        )?;
        Ok(())
    }

    /// Every entry, by name (whatever the case), then by path.
    pub fn list(&self) -> IndexResult<Vec<IndexEntry>> {
        let mut statement = self.connection.prepare(
            "SELECT path, name, kind, parent_path, scan_root, current_branch, detached, dirty,
                    ahead, behind, last_commit_at, pinned, last_opened_at, refreshed_at, missing,
                    upstream, operation, fetched_at, last_commit_subject, upstream_remote,
                    upstream_branch, upstream_push_remote
             FROM repos ORDER BY name COLLATE NOCASE ASC, path ASC",
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
                        upstream_branch, upstream_push_remote
                 FROM repos WHERE path = ?1",
                params![path_text(path)],
                entry_from_row,
            )
            .optional()?)
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

    /// The paths of the entries no project holds: none, while the membership rule holds.
    #[cfg(test)]
    pub(crate) fn loose_entries(&self) -> Vec<String> {
        self.connection
            .prepare(
                "SELECT path FROM repos WHERE path NOT IN (
                   SELECT m.path FROM project_members m JOIN projects p ON p.id = m.project_id)",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<Vec<String>, _>>()
            })
            .expect("loose entries")
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
    let upstream_push_remote: Option<String> = row.get(21)?;
    let upstream = match (upstream, upstream_remote, upstream_branch) {
        (Some(name), Some(remote), Some(branch)) => Some(Upstream {
            push_remote: upstream_push_remote.unwrap_or_else(|| remote.clone()),
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

    #[test]
    fn a_second_process_opens_the_file_as_it_is_or_not_at_all() {
        let dir = tempfile::tempdir().expect("temporary folder");
        let missing = dir.path().join("missing.sqlite");
        assert!(Index::open_existing(&missing).is_err());
        assert!(!missing.exists(), "the file was created");

        let path = dir.path().join("index.sqlite");
        drop(Index::open(&path).expect("the app's index"));
        let index = Index::open_existing(&path).expect("this build's schema");
        index.check_version().expect("still this build's");

        // An app of another version migrates the file: the open process notices.
        let other = Connection::open(&path).expect("another connection");
        other
            .pragma_update(None, "user_version", migrations::CURRENT_VERSION + 1)
            .expect("bump");
        let error = index.check_version().expect_err("another schema");
        assert_eq!(error.code(), "index.version");
        assert!(matches!(
            Index::open_existing(&path),
            Err(IndexError::Version { found, expected })
                if found == migrations::CURRENT_VERSION + 1 && expected == migrations::CURRENT_VERSION
        ));
    }

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

    /// An index with the folder project of `/code`, where [`found`] entries are stored.
    fn index_with_code() -> Index {
        let index = Index::in_memory().expect("index");
        index
            .create_folder_project(Path::new("/code"), 1)
            .expect("folder project");
        index
    }

    #[test]
    fn upserting_twice_keeps_one_row_and_its_summary() {
        let index = index_with_code();
        let alpha = found("/code/alpha", RepoKind::Main, None);
        assert_eq!(
            index.upsert_found(&alpha, 1).expect("insert"),
            Upserted::Stored
        );
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
        index.record_open(&alpha.path, 5).expect("open");
        assert_eq!(
            index.upsert_found(&alpha, 3).expect("second insert"),
            Upserted::Stored
        );
        let list = index.list().expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].summary, summary);
        assert_eq!(list[0].last_opened_at, Some(5));
        assert_eq!(list[0].refreshed_at, Some(2));
    }

    #[test]
    fn lists_by_name_with_worktrees_as_entries_of_their_own() {
        let index = index_with_code();
        for entry in [
            found("/code/zeta", RepoKind::Main, None),
            found("/code/alpha", RepoKind::Main, None),
            found("/code/feature", RepoKind::Worktree, Some("/code/alpha")),
        ] {
            assert_eq!(
                index.upsert_found(&entry, 1).expect("insert"),
                Upserted::Stored
            );
        }
        let names: Vec<String> = index
            .list()
            .expect("list")
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["alpha", "feature", "zeta"]);
        let feature = index
            .get(Path::new("/code/feature"))
            .expect("get")
            .expect("feature");
        assert_eq!(feature.kind, RepoKind::Worktree);
        assert_eq!(
            feature.parent_path.as_deref(),
            Some(Path::new("/code/alpha"))
        );
    }

    #[test]
    fn recents_and_missing_folders() {
        let index = index_with_code();
        let alpha = found("/code/alpha", RepoKind::Main, None);
        let beta = found("/code/beta", RepoKind::Main, None);
        assert_eq!(
            index.upsert_found(&alpha, 1).expect("insert"),
            Upserted::Stored
        );
        assert_eq!(
            index.upsert_found(&beta, 1).expect("insert"),
            Upserted::Stored
        );
        index.record_open(&alpha.path, 42).expect("open");
        index.mark_missing(&beta.path, true).expect("missing");
        let entry = index.get(&alpha.path).expect("get").expect("alpha");
        assert_eq!(entry.last_opened_at, Some(42));
        assert!(index.get(&beta.path).expect("get").expect("beta").missing);
        // Found again, it is no longer missing.
        assert_eq!(
            index.upsert_found(&beta, 2).expect("insert"),
            Upserted::Stored
        );
        assert!(!index.get(&beta.path).expect("get").expect("beta").missing);
    }

    #[test]
    fn five_hundred_entries_list_quickly() {
        let index = index_with_code();
        let summary = RepoSummary {
            current_branch: Some("main".to_owned()),
            upstream: Some(Upstream {
                name: "origin/main".to_owned(),
                remote: "origin".to_owned(),
                branch: "main".to_owned(),
                push_remote: "origin".to_owned(),
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
            assert_eq!(
                index.upsert_found(&entry, 1).expect("insert"),
                Upserted::Stored
            );
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
        let index = index_with_code();
        let alpha = found("/code/alpha", RepoKind::Main, None);
        assert_eq!(
            index.upsert_found(&alpha, 1).expect("insert"),
            Upserted::Stored
        );
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
                    push_remote: "mine".to_owned(),
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
        // Version 5 puts every entry in a project: the scan folder's, and a pinned project of
        // one for each pinned entry, which no pinned project held.
        let projects = index.projects().expect("projects");
        assert_eq!(projects.len(), 4);
        let code = projects
            .iter()
            .find(|project| project.name == "code")
            .expect("the folder project");
        assert_eq!(code.folder.as_deref(), Some(Path::new("/code")));
        assert_eq!(code.members.len(), 40);
        assert_eq!(code.opened_at, Some(1_700_000_030));
        assert_eq!(
            code.last_repository.as_deref(),
            Some(Path::new("/code/repo-30"))
        );
        let pinned: Vec<&str> = projects
            .iter()
            .filter(|project| project.pinned)
            .map(|project| project.name.as_str())
            .collect();
        assert_eq!(pinned, ["repo-00", "repo-01", "repo-02"]);
        assert!(index.loose_entries().is_empty());
        let notes = index
            .list_annotations(Path::new("/code/repo-00"), "HEAD")
            .expect("notes");
        assert_eq!(notes.len(), 1);
    }
}
