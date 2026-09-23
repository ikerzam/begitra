//! Versioned schema migrations. Each migration runs once, in order, inside a transaction.

use rusqlite::Connection;

/// Failure while migrating the index database.
#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    /// The database refused a statement.
    #[error("index database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Schema version after applying every migration in [`MIGRATIONS`].
pub const CURRENT_VERSION: u32 = 3;

/// SQL for each migration, indexed by version minus one.
const MIGRATIONS: &[&str] = &[
    // Version 1: repositories, worktrees and review annotations.
    "CREATE TABLE repos (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        current_branch TEXT,
        dirty INTEGER NOT NULL DEFAULT 0,
        ahead INTEGER NOT NULL DEFAULT 0,
        behind INTEGER NOT NULL DEFAULT 0,
        last_commit_at INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER
    );
    CREATE TABLE worktrees (
        id INTEGER PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        path TEXT NOT NULL UNIQUE,
        branch TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        prunable INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE review_annotations (
        id INTEGER PRIMARY KEY,
        repo_path TEXT NOT NULL,
        target TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hunk_id TEXT,
        annotation_kind TEXT NOT NULL,
        body TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX review_annotations_target ON review_annotations(repo_path, target);",
    // Version 2: repositories and worktrees in one table keyed by path, with the summary the
    // scanner refreshes; the empty tables of version 1 go.
    "DROP TABLE worktrees;
    DROP TABLE repos;
    CREATE TABLE repos (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent_path TEXT,
        scan_root TEXT,
        current_branch TEXT,
        detached INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER,
        ahead INTEGER,
        behind INTEGER,
        last_commit_at INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER,
        refreshed_at INTEGER,
        missing INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX repos_parent ON repos(parent_path);
    CREATE INDEX repos_root ON repos(scan_root);",
    // Version 3: review state keyed by repository, target, path, hunk and kind, so a mark or
    // a note is one upsert; the review table of version 1 never held a row.
    "DROP TABLE review_annotations;
    CREATE TABLE annotations (
        repo TEXT NOT NULL,
        target TEXT NOT NULL,
        path TEXT NOT NULL,
        hunk TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo, target, path, hunk, kind)
    );",
];

/// Applies every pending migration and returns the resulting schema version.
pub fn migrate(connection: &mut Connection) -> Result<u32, MigrationError> {
    let mut version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    while (version as usize) < MIGRATIONS.len() {
        let transaction = connection.transaction()?;
        transaction.execute_batch(MIGRATIONS[version as usize])?;
        version += 1;
        transaction.pragma_update(None, "user_version", version)?;
        transaction.commit()?;
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_an_empty_database_to_the_current_version() {
        let mut connection = Connection::open_in_memory().expect("in-memory database");
        let version = migrate(&mut connection).expect("migration succeeds");
        assert_eq!(version, CURRENT_VERSION);

        let tables: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("query prepared")
            .query_map([], |row| row.get(0))
            .expect("query runs")
            .collect::<Result<_, _>>()
            .expect("rows read");
        assert_eq!(tables, vec!["annotations", "repos"]);
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let mut connection = Connection::open_in_memory().expect("in-memory database");
        migrate(&mut connection).expect("first migration");
        let version = migrate(&mut connection).expect("second migration");
        assert_eq!(version, CURRENT_VERSION);
    }
}
