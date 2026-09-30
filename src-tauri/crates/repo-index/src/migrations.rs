//! Versioned schema migrations. Each migration runs once, in order, inside a transaction.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

/// Failure while migrating the index database.
#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    /// The database refused a statement.
    #[error("index database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Schema version after applying every migration in [`MIGRATIONS`].
pub const CURRENT_VERSION: u32 = 5;

/// One migration: a batch of SQL, or code where the data needs more than SQL.
enum Migration {
    Sql(&'static str),
    Code(fn(&Connection) -> rusqlite::Result<()>),
}

/// Each migration, indexed by version minus one.
const MIGRATIONS: &[Migration] = &[
    // Version 1: repositories, worktrees and review annotations.
    Migration::Sql(
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
    ),
    // Version 2: repositories and worktrees in one table keyed by path, with the summary the
    // scanner refreshes; the empty tables of version 1 go.
    Migration::Sql(
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
    ),
    // Version 3: review state keyed by repository, target, path, hunk and kind, so a mark or
    // a note is one upsert; the review table of version 1 never held a row.
    Migration::Sql(
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
    ),
    // Version 4: the upstream (its name, remote and branch), the operation in progress, the
    // last fetch and the tip's subject of each entry, and projects. A member is a path, not a
    // reference to a row of `repos`: scans and forgets delete rows, and a project keeps its
    // member until the user removes it. Ids never come back (`AUTOINCREMENT`): a stale id
    // (another window, a crash before the settings were written) must not reach another
    // project. The empty scope is a whole repository; a package of a monorepo will be a
    // scope of its own, so it is part of the key.
    Migration::Sql(
        "ALTER TABLE repos ADD COLUMN upstream TEXT;
    ALTER TABLE repos ADD COLUMN upstream_remote TEXT;
    ALTER TABLE repos ADD COLUMN upstream_branch TEXT;
    ALTER TABLE repos ADD COLUMN upstream_push_remote TEXT;
    ALTER TABLE repos ADD COLUMN operation TEXT;
    ALTER TABLE repos ADD COLUMN fetched_at INTEGER;
    ALTER TABLE repos ADD COLUMN last_commit_subject TEXT;
    CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        path TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (project_id, path, scope)
    );",
    ),
    // Version 5: every entry belongs to a project. A project gains its folder (a folder
    // project's, unique; a list project has none), a pin, the time it was last opened and the
    // repository it last showed; a member gains its origin (`folder`: found by the scan of
    // its project's folder; `hand`: added by hand). Code, because a folder project's name is
    // its folder's last component.
    Migration::Code(every_entry_in_a_project),
];

/// Version 5 (see [`MIGRATIONS`]): each scan folder becomes a folder project holding the
/// entries found under it; the projects made by hand stay list projects, pinned when a member
/// was and opened when a member last was, showing that member; an entry no project holds, and
/// a pinned entry no pinned project holds, becomes a list project of one with its pin and its
/// last opening, so no entry, pin or recent is lost.
fn every_entry_in_a_project(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "ALTER TABLE projects ADD COLUMN folder TEXT;
         ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE projects ADD COLUMN opened_at INTEGER;
         ALTER TABLE projects ADD COLUMN last_repository TEXT;
         CREATE UNIQUE INDEX projects_folder ON projects(folder);
         ALTER TABLE project_members ADD COLUMN origin TEXT NOT NULL DEFAULT 'hand';
         CREATE INDEX project_members_path ON project_members(path);
         UPDATE projects SET
           pinned = EXISTS (
             SELECT 1 FROM project_members m JOIN repos r ON r.path = m.path
             WHERE m.project_id = projects.id AND r.pinned = 1),
           opened_at = (
             SELECT MAX(r.last_opened_at) FROM project_members m JOIN repos r ON r.path = m.path
             WHERE m.project_id = projects.id),
           last_repository = (
             SELECT r.path FROM project_members m JOIN repos r ON r.path = m.path
             WHERE m.project_id = projects.id AND r.last_opened_at IS NOT NULL
             ORDER BY r.last_opened_at DESC, m.position LIMIT 1);",
    )?;
    let now = unix_now();
    let roots: Vec<String> = connection
        .prepare(
            "SELECT DISTINCT scan_root FROM repos WHERE scan_root IS NOT NULL ORDER BY scan_root",
        )?
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    for root in roots {
        connection.execute(
            "INSERT INTO projects (name, folder, created_at, updated_at, opened_at, last_repository)
             VALUES (?1, ?2, ?3, ?3,
               (SELECT MAX(last_opened_at) FROM repos WHERE scan_root = ?2),
               (SELECT path FROM repos WHERE scan_root = ?2 AND last_opened_at IS NOT NULL
                ORDER BY last_opened_at DESC, path LIMIT 1))",
            params![folder_name_v5(&root), root, now],
        )?;
        let id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO project_members (project_id, position, path, origin)
             SELECT ?1, 0, path, 'folder' FROM repos WHERE scan_root = ?2",
            params![id, root],
        )?;
    }
    let loose: Vec<(String, String, bool, Option<i64>)> = connection
        .prepare(
            "SELECT path, name, pinned, last_opened_at FROM repos
             WHERE path NOT IN (SELECT path FROM project_members)
                OR (pinned = 1 AND path NOT IN (
                      SELECT m.path FROM project_members m JOIN projects p ON p.id = m.project_id
                      WHERE p.pinned = 1))
             ORDER BY path",
        )?
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<_, _>>()?;
    for (path, name, pinned, opened_at) in loose {
        connection.execute(
            "INSERT INTO projects (name, pinned, opened_at, last_repository, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![name, pinned, opened_at, path, now],
        )?;
        let id = connection.last_insert_rowid();
        connection.execute(
            "INSERT INTO project_members (project_id, position, path, origin)
             VALUES (?1, 0, ?2, 'hand')",
            params![id, path],
        )?;
    }
    Ok(())
}

/// A folder project's name as version 5 gives it: the folder's last component, or the whole
/// path for a root. A copy, not `projects::folder_name`, so a later change of that rule never
/// changes what this migration wrote.
fn folder_name_v5(folder: &str) -> String {
    std::path::Path::new(folder)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_owned())
}

/// Unix seconds now: the creation time of the projects a migration makes.
fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Applies every pending migration and returns the resulting schema version.
pub fn migrate(connection: &mut Connection) -> Result<u32, MigrationError> {
    migrate_to(connection, CURRENT_VERSION)
}

/// Applies the pending migrations up to `target` (an index of an older version, for the
/// upgrade tests) and returns the resulting schema version.
pub(crate) fn migrate_to(connection: &mut Connection, target: u32) -> Result<u32, MigrationError> {
    let mut version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let target = (target as usize).min(MIGRATIONS.len());
    while (version as usize) < target {
        let transaction = connection.transaction()?;
        match &MIGRATIONS[version as usize] {
            Migration::Sql(sql) => transaction.execute_batch(sql)?,
            Migration::Code(run) => run(&transaction)?,
        }
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
        assert_eq!(
            tables,
            vec![
                "annotations",
                "project_members",
                "projects",
                "repos",
                "sqlite_sequence"
            ]
        );
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let mut connection = Connection::open_in_memory().expect("in-memory database");
        migrate(&mut connection).expect("first migration");
        let version = migrate(&mut connection).expect("second migration");
        assert_eq!(version, CURRENT_VERSION);
    }

    /// An index of version 4: the scan folders `/code` and `/code/geo` (nested) with 40
    /// entries found under them (`/code/repo-02` pinned, `/code/repo-05` opened), two
    /// repositories and a worktree opened on their own (`/tmp/spike` pinned), and the project
    /// "Geoportal" of a pinned repository, an opened one and a path the index does not hold.
    fn version_4_index() -> Connection {
        let mut connection = Connection::open_in_memory().expect("database");
        migrate_to(&mut connection, 4).expect("version 4");
        let insert = |path: &str,
                      kind: &str,
                      parent: Option<&str>,
                      root: Option<&str>,
                      pinned: bool,
                      opened: Option<i64>| {
            let name = path.rsplit('/').next().unwrap_or(path);
            connection
                .execute(
                    "INSERT INTO repos (path, name, kind, parent_path, scan_root, pinned,
                       last_opened_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![path, name, kind, parent, root, pinned, opened],
                )
                .expect("row");
        };
        for i in 0..30 {
            let path = format!("/code/repo-{i:02}");
            insert(
                &path,
                "main",
                None,
                Some("/code"),
                i == 1 || i == 2,
                (i == 5).then_some(50),
            );
        }
        for i in 0..10 {
            let path = format!("/code/geo/g-{i}");
            insert(
                &path,
                "main",
                None,
                Some("/code/geo"),
                false,
                (i == 0).then_some(300),
            );
        }
        insert("/tmp/spike", "main", None, None, true, Some(100));
        insert("/tmp/other", "main", None, None, false, Some(200));
        insert(
            "/wt/feature",
            "worktree",
            Some("/code/repo-00"),
            None,
            false,
            Some(150),
        );
        connection
            .execute(
                "INSERT INTO projects (id, name, created_at, updated_at) VALUES (7, 'Geoportal', 10, 20)",
                [],
            )
            .expect("project");
        for (position, path) in ["/code/repo-01", "/code/geo/g-0", "/elsewhere/not-indexed"]
            .iter()
            .enumerate()
        {
            connection
                .execute(
                    "INSERT INTO project_members (project_id, position, path) VALUES (7, ?1, ?2)",
                    params![position as i64, path],
                )
                .expect("member");
        }
        connection
            .execute(
                "INSERT INTO annotations (repo, target, path, hunk, kind, value, updated_at)
                 VALUES ('/tmp/spike', 'HEAD', 'src/lib.rs', '', 'note', 'check', 9)",
                [],
            )
            .expect("note");
        connection
    }

    fn member_paths(project: &crate::types::Project) -> Vec<String> {
        project
            .members
            .iter()
            .map(|member| member.path.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn an_index_of_version_4_puts_every_entry_in_a_project() {
        use std::path::Path;

        use crate::index::Index;
        use crate::types::{MemberOrigin, ProjectKind};

        let index = Index::prepare(version_4_index()).expect("migrated");
        let version: u32 = index
            .connection()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, 5);
        assert_eq!(index.list().expect("list").len(), 43);
        let projects = index.projects().expect("projects");
        let named = |name: &str| {
            projects
                .iter()
                .find(|project| project.name == name)
                .unwrap_or_else(|| panic!("no project {name}"))
        };
        // A folder project per scan folder, its entries as the folder's own members in path
        // order, opened when one of them last was.
        let code = named("code");
        assert_eq!(code.kind, ProjectKind::Folder);
        assert_eq!(code.folder.as_deref(), Some(Path::new("/code")));
        assert_eq!(code.members.len(), 30);
        assert_eq!(code.members[0].path, Path::new("/code/repo-00"));
        assert!(code
            .members
            .iter()
            .all(|m| m.origin == MemberOrigin::Folder));
        assert_eq!(code.opened_at, Some(50));
        assert_eq!(
            code.last_repository.as_deref(),
            Some(Path::new("/code/repo-05"))
        );
        assert!(!code.pinned);
        let geo = named("geo");
        assert_eq!(geo.folder.as_deref(), Some(Path::new("/code/geo")));
        assert_eq!(geo.members.len(), 10);
        assert_eq!(geo.opened_at, Some(300));
        // The project made by hand stays a list project with its members in order, pinned for
        // its pinned member and opened when a member last was.
        let geoportal = named("Geoportal");
        assert_eq!((geoportal.id, geoportal.kind), (7, ProjectKind::List));
        assert_eq!(
            member_paths(geoportal),
            ["/code/repo-01", "/code/geo/g-0", "/elsewhere/not-indexed"]
        );
        assert!(geoportal
            .members
            .iter()
            .all(|m| m.origin == MemberOrigin::Hand));
        assert!(geoportal.pinned);
        assert_eq!(geoportal.opened_at, Some(300));
        assert_eq!(
            geoportal.last_repository.as_deref(),
            Some(Path::new("/code/geo/g-0"))
        );
        // A list project of one for each entry opened on its own and for the pinned entry no
        // pinned project held; `/code/repo-01`'s pin is Geoportal's.
        for (name, path, pinned, opened) in [
            ("spike", "/tmp/spike", true, Some(100)),
            ("other", "/tmp/other", false, Some(200)),
            ("feature", "/wt/feature", false, Some(150)),
            ("repo-02", "/code/repo-02", true, None),
        ] {
            let project = named(name);
            assert_eq!(project.kind, ProjectKind::List, "{name}");
            assert_eq!(member_paths(project), [path], "{name}");
            assert_eq!(
                (project.pinned, project.opened_at),
                (pinned, opened),
                "{name}"
            );
            assert_eq!(
                project.last_repository.as_deref(),
                Some(Path::new(path)),
                "{name}"
            );
        }
        assert_eq!(projects.len(), 7);
        // Every entry is in a project and keeps its pin, its last opening and its notes.
        assert!(index.loose_entries().is_empty());
        let spike = index
            .get(Path::new("/tmp/spike"))
            .expect("get")
            .expect("spike");
        assert!(spike.pinned);
        assert_eq!(spike.last_opened_at, Some(100));
        assert_eq!(
            index
                .list_annotations(Path::new("/tmp/spike"), "HEAD")
                .expect("notes")
                .len(),
            1
        );
    }
}
