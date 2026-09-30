//! Projects: the unit the app opens. A folder project holds the repositories and worktrees the
//! scans find under its folder (its own members, in path order), then any added by hand; a
//! list project holds only those added to it, in the order given. Members are kept by path.
//!
//! The membership rule lives here: every index entry belongs to at least one project. An entry
//! joins one when it is stored ([`Index::upsert_found`]), and every function that can take a
//! path out of its last project (deleting a project, editing its members, the end of a
//! folder's complete scan) deletes, in the same transaction, the entries it took out that no
//! project names any more, and answers their paths. Only the edits the user makes delete an
//! entry's notes with it; a scan keeps them, since a folder can read as empty for a while (an
//! unmounted drive) and the notes are keyed by path.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::IndexResult;
use crate::index::{path_text, Index};
use crate::types::{FolderScanEnd, Member, MemberOrigin, Project, ProjectEdit, ProjectKind};

/// The columns of a project row, in the order [`project_from_row`] reads them.
const PROJECT_COLUMNS: &str =
    "id, name, folder, pinned, opened_at, last_repository, created_at, updated_at";

/// The members of a project: the folder's own in path order (whatever the case), then those
/// added by hand in their order.
const MEMBER_ORDER: &str = "CASE origin WHEN 'folder' THEN 0 ELSE 1 END,
     CASE origin WHEN 'folder' THEN path END COLLATE NOCASE,
     CASE origin WHEN 'folder' THEN path END, position";

impl Index {
    /// Every project with its members, by name (whatever the case), then by id.
    pub fn projects(&self) -> IndexResult<Vec<Project>> {
        let connection = self.connection();
        let mut statement = connection.prepare(&format!(
            "SELECT {PROJECT_COLUMNS} FROM projects ORDER BY name COLLATE NOCASE ASC, id ASC"
        ))?;
        let mut projects: Vec<Project> = statement
            .query_map([], project_from_row)?
            .collect::<Result<_, _>>()?;
        let slots: std::collections::HashMap<i64, usize> = projects
            .iter()
            .enumerate()
            .map(|(slot, project)| (project.id, slot))
            .collect();
        let mut statement = connection.prepare(&format!(
            "SELECT project_id, path, origin FROM project_members ORDER BY project_id, {MEMBER_ORDER}"
        ))?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, member_from_row(row, 1)?))
        })?;
        for row in rows {
            let (id, member) = row?;
            if let Some(project) = slots.get(&id).and_then(|&slot| projects.get_mut(slot)) {
                project.members.push(member);
            }
        }
        Ok(projects)
    }

    /// Makes a list project of `paths` in their order (a repeated path keeps its first place).
    pub fn create_project(&self, name: &str, paths: &[PathBuf], now: i64) -> IndexResult<Project> {
        let transaction = self.connection().unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO projects (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
            params![name, now],
        )?;
        let id = transaction.last_insert_rowid();
        insert_hand_members(&transaction, id, paths, &HashSet::new())?;
        let project = read_project(&transaction, id)?;
        transaction.commit()?;
        project.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows.into())
    }

    /// The folder project of `folder`, made (named after the folder) when there is none. The
    /// folder is compared as stored, so it must be spelled as the scan spells the folders it
    /// walks (the app canonicalises it).
    pub fn create_folder_project(&self, folder: &Path, now: i64) -> IndexResult<Project> {
        let transaction = self.connection().unchecked_transaction()?;
        let text = path_text(folder);
        let id = match folder_project_id(&transaction, &text)? {
            Some(id) => id,
            None => {
                transaction.execute(
                    "INSERT INTO projects (name, folder, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)",
                    params![folder_name(&text), text, now],
                )?;
                transaction.last_insert_rowid()
            }
        };
        let project = read_project(&transaction, id)?;
        transaction.commit()?;
        project.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows.into())
    }

    /// The folder project of `folder` as stored, making none: a folder spelled another way is
    /// another folder here, so the app looks up the spelling it was given before its canonical
    /// one (an index of version 4 kept its scan folders as the user spelled them).
    pub fn folder_project(&self, folder: &Path) -> IndexResult<Option<Project>> {
        let connection = self.connection();
        let Some(id) = folder_project_id(connection, &path_text(folder))? else {
            return Ok(None);
        };
        Ok(read_project(connection, id)?)
    }

    /// Renames a project; `None` when there is no such project.
    pub fn rename_project(&self, id: i64, name: &str, now: i64) -> IndexResult<Option<Project>> {
        let changed = self.connection().execute(
            "UPDATE projects SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(read_project(self.connection(), id)?)
    }

    /// Replaces the members a project holds by hand and their order (a repeated path keeps its
    /// first place); a folder project's own members stay, and a path among them stays its
    /// folder's. Answers the project and the entries the edit left in no project, which leave
    /// the index with their notes; `None` when there is no such project.
    pub fn set_project_members(
        &self,
        id: i64,
        paths: &[PathBuf],
        now: i64,
    ) -> IndexResult<Option<ProjectEdit>> {
        let transaction = self.connection().unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE projects SET updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let before = member_paths(&transaction, id, Some("hand"))?;
        transaction.execute(
            "DELETE FROM project_members WHERE project_id = ?1 AND origin = 'hand'",
            params![id],
        )?;
        let own: HashSet<String> = member_paths(&transaction, id, Some("folder"))?
            .into_iter()
            .collect();
        insert_hand_members(&transaction, id, paths, &own)?;
        let removed = drop_unreferenced(&transaction, &before, true)?;
        clear_stale_last_repository(&transaction)?;
        let project = read_project(&transaction, id)?;
        transaction.commit()?;
        Ok(project.map(|project| ProjectEdit { project, removed }))
    }

    /// Deletes a project and its members, never a repository's folder; answers the entries it
    /// left in no project, which leave the index with their notes, or `None` when there is no
    /// such project. The members go in the same transaction rather than through the foreign
    /// key's cascade, which an in-memory index runs without.
    pub fn delete_project(&self, id: i64) -> IndexResult<Option<Vec<PathBuf>>> {
        let transaction = self.connection().unchecked_transaction()?;
        let before = member_paths(&transaction, id, None)?;
        transaction.execute(
            "DELETE FROM project_members WHERE project_id = ?1",
            params![id],
        )?;
        let deleted = transaction.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        if deleted == 0 {
            return Ok(None);
        }
        let removed = drop_unreferenced(&transaction, &before, true)?;
        transaction.commit()?;
        Ok(Some(removed))
    }

    /// Pins or unpins a project; whether it exists.
    pub fn set_project_pinned(&self, id: i64, pinned: bool) -> IndexResult<bool> {
        let changed = self.connection().execute(
            "UPDATE projects SET pinned = ?2 WHERE id = ?1",
            params![id, pinned],
        )?;
        Ok(changed > 0)
    }

    /// Records that a project was opened now showing `repository`, which becomes its last
    /// repository and is recorded as opened now when the project holds it; with `None`, or a
    /// path it does not hold, the last repository stays. Whether the project exists.
    pub fn record_project_open(
        &self,
        id: i64,
        repository: Option<&Path>,
        now: i64,
    ) -> IndexResult<bool> {
        let transaction = self.connection().unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE projects SET opened_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        if changed > 0 {
            if let Some(path) = repository.map(path_text) {
                let held = transaction.execute(
                    "UPDATE projects SET last_repository = ?2
                     WHERE id = ?1 AND EXISTS (
                       SELECT 1 FROM project_members WHERE project_id = ?1 AND path = ?2)",
                    params![id, path],
                )?;
                if held > 0 {
                    transaction.execute(
                        "UPDATE repos SET last_opened_at = ?2, missing = 0 WHERE path = ?1",
                        params![path, now],
                    )?;
                }
            }
        }
        transaction.commit()?;
        Ok(changed > 0)
    }

    /// The project to open for the entry at `path`: of the projects holding it, the one opened
    /// last, or a list project of one made now when none does; `None` without an entry.
    pub fn project_for_entry(&self, path: &Path, now: i64) -> IndexResult<Option<Project>> {
        let transaction = self.connection().unchecked_transaction()?;
        let text = path_text(path);
        let name: Option<String> = transaction
            .query_row(
                "SELECT name FROM repos WHERE path = ?1",
                params![text],
                |row| row.get(0),
            )
            .optional()?;
        let Some(name) = name else {
            return Ok(None);
        };
        let id = project_holding(&transaction, &text, &name, now)?;
        let project = read_project(&transaction, id)?;
        transaction.commit()?;
        Ok(project)
    }

    /// Whether some project names `path` as a member, with an entry or not: a path no project
    /// names is not stored when it is only described (the "Add repository…" probe).
    pub fn is_member(&self, path: &Path) -> IndexResult<bool> {
        Ok(self.connection().query_row(
            "SELECT EXISTS (
               SELECT 1 FROM project_members m JOIN projects p ON p.id = m.project_id
               WHERE m.path = ?1)",
            params![path_text(path)],
            |row| row.get(0),
        )?)
    }

    /// The folder project's own members of `folder`, in path order; none without a project.
    /// The end of a scan checks, outside the index, which of those it did not find are gone
    /// from disk.
    pub fn folder_members(&self, folder: &Path) -> IndexResult<Vec<PathBuf>> {
        let connection = self.connection();
        let Some(id) = folder_project_id(connection, &path_text(folder))? else {
            return Ok(Vec::new());
        };
        Ok(member_paths(connection, id, Some("folder"))?
            .into_iter()
            .map(PathBuf::from)
            .collect())
    }

    /// Ends a complete scan of `folder`: of the folder project's own members the scan did not
    /// find, those in `gone` (their `.git` is not on disk) leave the project, flagged missing
    /// when another project holds them, and leave the index when none does, their notes kept;
    /// those in `present` (hidden by an unreadable folder, a lowered depth or a new skip name)
    /// stay, no longer flagged missing. When the scan found none of the folder's own members
    /// and every one of them reads as gone (an unmounted drive reads as an empty folder), they
    /// stay, flagged missing (`held`). A folder without a project changes nothing.
    pub fn complete_folder_scan(
        &self,
        folder: &Path,
        gone: &[PathBuf],
        present: &[PathBuf],
        now: i64,
    ) -> IndexResult<FolderScanEnd> {
        let transaction = self.connection().unchecked_transaction()?;
        let Some(id) = folder_project_id(&transaction, &path_text(folder))? else {
            return Ok(FolderScanEnd::default());
        };
        let own: HashSet<String> = member_paths(&transaction, id, Some("folder"))?
            .into_iter()
            .collect();
        let mut gone: Vec<String> = gone
            .iter()
            .map(|path| path_text(path))
            .filter(|path| own.contains(path))
            .collect();
        gone.sort();
        gone.dedup();
        for path in present.iter().map(|path| path_text(path)) {
            if own.contains(&path) {
                transaction.execute(
                    "UPDATE repos SET missing = 0 WHERE path = ?1",
                    params![path],
                )?;
            }
        }
        let mut flag = transaction
            .prepare_cached("UPDATE repos SET missing = 1, refreshed_at = ?2 WHERE path = ?1")?;
        if !own.is_empty() && gone.len() == own.len() {
            for path in &gone {
                flag.execute(params![path, now])?;
            }
            drop(flag);
            transaction.commit()?;
            return Ok(FolderScanEnd {
                held: gone.into_iter().map(PathBuf::from).collect(),
                ..FolderScanEnd::default()
            });
        }
        let mut leave = transaction
            .prepare_cached("DELETE FROM project_members WHERE project_id = ?1 AND path = ?2")?;
        for path in &gone {
            leave.execute(params![id, path])?;
            flag.execute(params![path, now])?;
        }
        drop((flag, leave));
        let removed = drop_unreferenced(&transaction, &gone, false)?;
        clear_stale_last_repository(&transaction)?;
        transaction.commit()?;
        Ok(FolderScanEnd {
            left: gone.into_iter().map(PathBuf::from).collect(),
            removed,
            held: Vec::new(),
        })
    }
}

/// The id of the folder project of `folder` (its path as stored).
pub(crate) fn folder_project_id(
    connection: &Connection,
    folder: &str,
) -> rusqlite::Result<Option<i64>> {
    connection
        .query_row(
            "SELECT id FROM projects WHERE folder = ?1",
            params![folder],
            |row| row.get(0),
        )
        .optional()
}

/// Makes `path` one of the folder project `id`'s own members; a member it holds by hand
/// becomes one.
pub(crate) fn add_folder_member(
    connection: &Connection,
    id: i64,
    path: &str,
) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO project_members (project_id, position, path, origin)
         VALUES (?1, 0, ?2, 'folder')
         ON CONFLICT (project_id, path, scope) DO UPDATE SET origin = 'folder'",
        params![id, path],
    )?;
    Ok(())
}

/// The project holding the entry at `path` that was opened last (then the oldest), or a list
/// project of one named `name`, made now, when none holds it.
pub(crate) fn project_holding(
    connection: &Connection,
    path: &str,
    name: &str,
    now: i64,
) -> rusqlite::Result<i64> {
    let held: Option<i64> = connection
        .query_row(
            "SELECT p.id FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.path = ?1
             ORDER BY p.opened_at IS NULL, p.opened_at DESC, p.id ASC LIMIT 1",
            params![path],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = held {
        return Ok(id);
    }
    connection.execute(
        "INSERT INTO projects (name, last_repository, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        params![name, path, now],
    )?;
    let id = connection.last_insert_rowid();
    connection.execute(
        "INSERT INTO project_members (project_id, position, path, origin)
         VALUES (?1, 0, ?2, 'hand')",
        params![id, path],
    )?;
    Ok(id)
}

/// Deletes, among `candidates`, the entries no project names any more, with their notes when
/// `forget_notes`, and answers their paths in order. Only the paths an operation took out are
/// candidates: an entry loose for another reason (an index a 0.4 build wrote) is not taken
/// with an unrelated edit.
pub(crate) fn drop_unreferenced(
    connection: &Connection,
    candidates: &[String],
    forget_notes: bool,
) -> rusqlite::Result<Vec<PathBuf>> {
    let mut named = connection.prepare_cached(
        "SELECT EXISTS (SELECT 1 FROM project_members m JOIN projects p ON p.id = m.project_id
                        WHERE m.path = ?1)",
    )?;
    let mut delete = connection.prepare_cached("DELETE FROM repos WHERE path = ?1")?;
    let mut forget = connection.prepare_cached("DELETE FROM annotations WHERE repo = ?1")?;
    let mut sorted: Vec<&String> = candidates.iter().collect();
    sorted.sort();
    sorted.dedup();
    let mut removed = Vec::new();
    for path in sorted {
        if named.query_row(params![path], |row| row.get::<_, bool>(0))? {
            continue;
        }
        if delete.execute(params![path])? > 0 {
            if forget_notes {
                forget.execute(params![path])?;
            }
            removed.push(PathBuf::from(path));
        }
    }
    Ok(removed)
}

/// Forgets the last repository of the projects that no longer hold it.
fn clear_stale_last_repository(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute(
        "UPDATE projects SET last_repository = NULL
         WHERE last_repository IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM project_members m
           WHERE m.project_id = projects.id AND m.path = projects.last_repository)",
        [],
    )?;
    Ok(())
}

/// A folder project's name: the folder's last component, or the whole path for a root.
pub(crate) fn folder_name(folder: &str) -> String {
    Path::new(folder)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| folder.to_owned())
}

/// The paths of project `id`'s members of `origin` (every one with `None`), by path.
fn member_paths(
    connection: &Connection,
    id: i64,
    origin: Option<&str>,
) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare_cached(
        "SELECT path FROM project_members WHERE project_id = ?1 AND (?2 IS NULL OR origin = ?2)
         ORDER BY path",
    )?;
    let paths = statement
        .query_map(params![id, origin], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(paths)
}

/// One project with its members.
fn read_project(connection: &Connection, id: i64) -> rusqlite::Result<Option<Project>> {
    let Some(mut project) = connection
        .query_row(
            &format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?1"),
            params![id],
            project_from_row,
        )
        .optional()?
    else {
        return Ok(None);
    };
    let mut statement = connection.prepare(&format!(
        "SELECT path, origin FROM project_members WHERE project_id = ?1 ORDER BY {MEMBER_ORDER}"
    ))?;
    project.members = statement
        .query_map(params![id], |row| member_from_row(row, 0))?
        .collect::<Result<_, _>>()?;
    Ok(Some(project))
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    let folder: Option<String> = row.get(2)?;
    let last_repository: Option<String> = row.get(5)?;
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: if folder.is_some() {
            ProjectKind::Folder
        } else {
            ProjectKind::List
        },
        folder: folder.map(PathBuf::from),
        members: Vec::new(),
        pinned: row.get(3)?,
        opened_at: row.get(4)?,
        last_repository: last_repository.map(PathBuf::from),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// A member from its path and origin columns, starting at `first`.
fn member_from_row(row: &Row<'_>, first: usize) -> rusqlite::Result<Member> {
    let path: String = row.get(first)?;
    let origin = match row.get_ref(first + 1)?.as_str()? {
        "folder" => MemberOrigin::Folder,
        _ => MemberOrigin::Hand,
    };
    Ok(Member {
        path: PathBuf::from(path),
        origin,
    })
}

/// Inserts `paths` as the members project `id` holds by hand, in order, a repeated path once
/// and a path among `own` (the folder's own members) skipped.
fn insert_hand_members(
    connection: &Connection,
    id: i64,
    paths: &[PathBuf],
    own: &HashSet<String>,
) -> rusqlite::Result<()> {
    let mut statement = connection.prepare_cached(
        "INSERT INTO project_members (project_id, position, path, origin)
         VALUES (?1, ?2, ?3, 'hand')",
    )?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut position: i64 = 0;
    for path in paths {
        let text = path_text(path);
        if own.contains(&text) || seen.contains(&text) {
            continue;
        }
        statement.execute(params![id, position, text])?;
        seen.insert(text);
        position += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use crate::index::Index;
    use crate::types::{
        AnnotationKey, AnnotationKind, FolderScanEnd, Found, MemberOrigin, Project, ProjectKind,
        RepoKind, Upserted,
    };

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| PathBuf::from(format!("/code/{name}")))
            .collect()
    }

    /// The member paths of a project, in order.
    fn member_paths(project: &Project) -> Vec<String> {
        project
            .members
            .iter()
            .map(|member| member.path.to_string_lossy().into_owned())
            .collect()
    }

    fn project(index: &Index, id: i64) -> Project {
        index
            .projects()
            .expect("projects")
            .into_iter()
            .find(|project| project.id == id)
            .unwrap_or_else(|| panic!("no project {id}"))
    }

    fn named(index: &Index, name: &str) -> Project {
        index
            .projects()
            .expect("projects")
            .into_iter()
            .find(|project| project.name == name)
            .unwrap_or_else(|| panic!("no project {name}"))
    }

    /// A repository found under `root`, or opened on its own when `root` is empty.
    fn found(path: &str, root: &str) -> Found {
        Found {
            path: PathBuf::from(path),
            name: Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            kind: RepoKind::Main,
            parent_path: None,
            scan_root: PathBuf::from(root),
        }
    }

    /// Stores `found` and checks that it was.
    fn store(index: &Index, found: &Found, now: i64) {
        assert_eq!(
            index.upsert_found(found, now).expect("upsert"),
            Upserted::Stored,
            "{:?}",
            found.path
        );
    }

    fn note(index: &Index, repo: &str) {
        index
            .set_annotation(
                &AnnotationKey {
                    repo: Path::new(repo),
                    target: "HEAD",
                    path: "src/lib.rs",
                    hunk: "",
                    kind: AnnotationKind::Note,
                },
                "check",
                9,
            )
            .expect("note");
    }

    fn notes(index: &Index, repo: &str) -> usize {
        index
            .list_annotations(Path::new(repo), "HEAD")
            .expect("notes")
            .len()
    }

    #[test]
    fn a_project_keeps_its_name_and_its_members_in_order() {
        let index = Index::in_memory().expect("index");
        let geo = index
            .create_project("geo", &paths(&["web", "api", "tiles"]), 10)
            .expect("create");
        assert_eq!(geo.name, "geo");
        assert_eq!((geo.kind, geo.folder.as_deref()), (ProjectKind::List, None));
        assert_eq!(
            member_paths(&geo),
            ["/code/web", "/code/api", "/code/tiles"]
        );
        assert!(geo.members.iter().all(|m| m.origin == MemberOrigin::Hand));
        assert_eq!((geo.created_at, geo.updated_at), (10, 10));
        assert_eq!(
            (geo.pinned, geo.opened_at, geo.last_repository.as_deref()),
            (false, None, None)
        );
        let other = index
            .create_project("Agents", &paths(&["api"]), 11)
            .expect("create");
        assert_ne!(other.id, geo.id);
        // By name, whatever the case, then by id.
        let names: Vec<String> = index
            .projects()
            .expect("projects")
            .into_iter()
            .map(|project| project.name)
            .collect();
        assert_eq!(names, ["Agents", "geo"]);

        let renamed = index
            .rename_project(geo.id, "geoportal", 20)
            .expect("rename")
            .expect("exists");
        assert_eq!(renamed.name, "geoportal");
        assert_eq!((renamed.created_at, renamed.updated_at), (10, 20));
        assert_eq!(
            member_paths(&renamed),
            ["/code/web", "/code/api", "/code/tiles"]
        );

        // A new order replaces the old one; a repeated path keeps its first place.
        let edit = index
            .set_project_members(geo.id, &paths(&["tiles", "web", "tiles"]), 30)
            .expect("members")
            .expect("exists");
        assert_eq!(member_paths(&edit.project), ["/code/tiles", "/code/web"]);
        assert_eq!(edit.project.updated_at, 30);
        assert!(edit.removed.is_empty(), "no member had an index entry");
        assert_eq!(
            member_paths(&project(&index, geo.id)),
            ["/code/tiles", "/code/web"]
        );
        assert_eq!(member_paths(&project(&index, other.id)), ["/code/api"]);
    }

    #[test]
    fn a_member_without_an_entry_stays_and_a_deleted_project_leaves_nothing() {
        let index = Index::in_memory().expect("index");
        let geo = index
            .create_project("geo", &paths(&["web", "api"]), 10)
            .expect("create");
        assert!(index.list().expect("list").is_empty());
        assert_eq!(
            index.delete_project(geo.id).expect("delete"),
            Some(Vec::new())
        );
        assert!(index.projects().expect("projects").is_empty());
        let rows: i64 = index
            .connection()
            .query_row("SELECT COUNT(*) FROM project_members", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 0);
        assert_eq!(index.delete_project(geo.id).expect("delete again"), None);
        assert_eq!(index.rename_project(geo.id, "x", 40).expect("rename"), None);
        assert_eq!(
            index
                .set_project_members(geo.id, &paths(&["web"]), 40)
                .expect("members"),
            None
        );
        // Without foreign keys, the check of the project is all that keeps members of a
        // project that is gone out of the table.
        let rows: i64 = index
            .connection()
            .query_row("SELECT COUNT(*) FROM project_members", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 0);
    }

    #[test]
    fn an_id_is_never_given_again_after_its_project_is_deleted() {
        let index = Index::in_memory().expect("index");
        let first = index.create_project("first", &[], 1).expect("create");
        let second = index.create_project("second", &[], 2).expect("create");
        assert!(index.delete_project(second.id).expect("delete").is_some());
        let third = index.create_project("third", &[], 3).expect("create");
        assert!(third.id > second.id, "{} after {}", third.id, second.id);
        assert_ne!(third.id, first.id);
    }

    #[test]
    fn a_file_index_keeps_its_projects_with_foreign_keys_on() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("index.db");
        let geo = {
            let index = Index::open(&file).expect("open");
            index
                .create_project("geo", &paths(&["web", "api"]), 10)
                .expect("create")
        };
        let index = Index::open(&file).expect("reopen");
        let foreign_keys: i64 = index
            .connection()
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("pragma");
        assert_eq!(foreign_keys, 1);
        assert_eq!(index.projects().expect("projects"), vec![geo.clone()]);
        assert!(index.delete_project(geo.id).expect("delete").is_some());
        assert!(index.projects().expect("projects").is_empty());
    }

    #[test]
    fn an_empty_project_and_paths_with_spaces_and_unicode() {
        let index = Index::in_memory().expect("index");
        let odd = [
            PathBuf::from("/code/my repo"),
            PathBuf::from("/code/año/ñandú"),
        ];
        let empty = index.create_project("empty", &[], 1).expect("create");
        assert!(empty.members.is_empty());
        let edit = index
            .set_project_members(empty.id, &odd, 2)
            .expect("members")
            .expect("exists");
        assert_eq!(
            member_paths(&edit.project),
            ["/code/my repo", "/code/año/ñandú"]
        );
    }

    #[test]
    fn an_entry_opened_on_its_own_gets_a_project_of_one() {
        let index = Index::in_memory().expect("index");
        store(&index, &found("/tmp/tiles-spike", ""), 5);
        let spike = named(&index, "tiles-spike");
        assert_eq!(spike.kind, ProjectKind::List);
        assert_eq!(member_paths(&spike), ["/tmp/tiles-spike"]);
        assert_eq!(
            spike.last_repository.as_deref(),
            Some(Path::new("/tmp/tiles-spike"))
        );
        // Opening it again makes no second project.
        store(&index, &found("/tmp/tiles-spike", ""), 6);
        assert_eq!(index.projects().expect("projects").len(), 1);
        // A repository a project already names joins no project of one.
        let geo = index
            .create_project("Geoportal", &[PathBuf::from("/tmp/web")], 7)
            .expect("create");
        store(&index, &found("/tmp/web", ""), 8);
        assert_eq!(index.projects().expect("projects").len(), 2);
        assert_eq!(member_paths(&project(&index, geo.id)), ["/tmp/web"]);
        assert!(index.loose_entries().is_empty());
    }

    #[test]
    fn a_path_is_a_member_when_some_project_names_it_entry_or_not() {
        let index = Index::in_memory().expect("index");
        assert!(!index.is_member(Path::new("/tmp/web")).expect("member"));
        // Named by a project before any entry exists for it.
        index
            .create_project("Geoportal", &[PathBuf::from("/tmp/web")], 1)
            .expect("create");
        assert!(index.is_member(Path::new("/tmp/web")).expect("member"));
        // A folder project's own member, found by its scan.
        index
            .create_folder_project(Path::new("/code"), 2)
            .expect("folder project");
        store(&index, &found("/code/tiles", "/code"), 3);
        assert!(index.is_member(Path::new("/code/tiles")).expect("member"));
        assert!(!index.is_member(Path::new("/code/other")).expect("member"));
    }

    #[test]
    fn a_folder_project_is_found_by_its_folder_without_making_one() {
        let index = Index::in_memory().expect("index");
        assert!(index
            .folder_project(Path::new("/code"))
            .expect("lookup")
            .is_none());
        assert!(index.projects().expect("projects").is_empty());
        let made = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("folder project");
        let found = index
            .folder_project(Path::new("/code"))
            .expect("lookup")
            .expect("found");
        assert_eq!(found.id, made.id);
        // Spelled otherwise, it is another folder to the index.
        assert!(index
            .folder_project(Path::new("/Code"))
            .expect("lookup")
            .is_none());
    }

    #[test]
    fn a_found_entry_joins_its_folder_project() {
        let index = Index::in_memory().expect("index");
        let code = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("folder project");
        // Added by hand before a scan found it.
        index
            .set_project_members(
                code.id,
                &[PathBuf::from("/code/web"), PathBuf::from("/tmp/spike")],
                2,
            )
            .expect("members")
            .expect("exists");
        for path in ["/code/web", "/code/api"] {
            store(&index, &found(path, "/code"), 3);
        }
        let code = project(&index, code.id);
        let members: Vec<(String, MemberOrigin)> = code
            .members
            .iter()
            .map(|m| (m.path.to_string_lossy().into_owned(), m.origin))
            .collect();
        assert_eq!(
            members,
            [
                ("/code/api".to_owned(), MemberOrigin::Folder),
                ("/code/web".to_owned(), MemberOrigin::Folder),
                ("/tmp/spike".to_owned(), MemberOrigin::Hand),
            ]
        );
        assert_eq!(
            index.projects().expect("projects").len(),
            1,
            "no project of one"
        );
        assert_eq!(
            index
                .get(Path::new("/code/api"))
                .expect("get")
                .expect("api")
                .scan_root
                .as_deref(),
            Some(Path::new("/code"))
        );
    }

    #[test]
    fn a_folder_without_a_project_stores_nothing() {
        let index = Index::in_memory().expect("index");
        assert_eq!(
            index
                .upsert_found(&found("/gone/api", "/gone"), 1)
                .expect("upsert"),
            Upserted::NoFolderProject
        );
        assert!(index.list().expect("list").is_empty());
        assert!(index.projects().expect("projects").is_empty());
    }

    #[test]
    fn nested_folder_projects_both_hold_an_entry() {
        let index = Index::in_memory().expect("index");
        let code = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("code");
        let geo = index
            .create_folder_project(Path::new("/code/geo"), 1)
            .expect("geo");
        assert_eq!((code.name.as_str(), geo.name.as_str()), ("code", "geo"));
        store(&index, &found("/code/api", "/code"), 2);
        store(&index, &found("/code/geo/web", "/code"), 2);
        store(&index, &found("/code/geo/web", "/code/geo"), 3);
        assert_eq!(
            member_paths(&project(&index, code.id)),
            ["/code/api", "/code/geo/web"]
        );
        assert_eq!(member_paths(&project(&index, geo.id)), ["/code/geo/web"]);
        assert_eq!(index.list().expect("list").len(), 2);
        // The scan of either folder may drop it; the other keeps it in the index.
        let end = index
            .complete_folder_scan(
                Path::new("/code"),
                &[PathBuf::from("/code/geo/web")],
                &[],
                4,
            )
            .expect("end");
        assert_eq!(end.left, [PathBuf::from("/code/geo/web")]);
        assert!(end.removed.is_empty());
        assert_eq!(member_paths(&project(&index, code.id)), ["/code/api"]);
        assert_eq!(member_paths(&project(&index, geo.id)), ["/code/geo/web"]);
    }

    #[test]
    fn a_complete_scan_drops_the_members_it_did_not_find() {
        let index = Index::in_memory().expect("index");
        let code = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("code");
        for path in ["/code/a", "/code/b", "/code/c", "/code/d"] {
            store(&index, &found(path, "/code"), 2);
        }
        let geo = index
            .create_project("Geoportal", &[PathBuf::from("/code/d")], 3)
            .expect("create");
        note(&index, "/code/b");
        index
            .mark_missing(Path::new("/code/c"), true)
            .expect("missing");
        // `a` was found again; `c` was not, but its `.git` is still there (a lowered depth, an
        // unreadable folder); `b` and `d` are gone from disk.
        assert_eq!(
            index.folder_members(Path::new("/code")).expect("members"),
            ["/code/a", "/code/b", "/code/c", "/code/d"].map(PathBuf::from)
        );
        let end = index
            .complete_folder_scan(
                Path::new("/code"),
                &[PathBuf::from("/code/b"), PathBuf::from("/code/d")],
                &[PathBuf::from("/code/c")],
                10,
            )
            .expect("end");
        assert_eq!(
            end.left,
            [PathBuf::from("/code/b"), PathBuf::from("/code/d")]
        );
        assert_eq!(end.removed, [PathBuf::from("/code/b")]);
        assert!(end.held.is_empty());
        assert_eq!(
            member_paths(&project(&index, code.id)),
            ["/code/a", "/code/c"]
        );
        assert_eq!(member_paths(&project(&index, geo.id)), ["/code/d"]);
        assert!(index.get(Path::new("/code/b")).expect("get").is_none());
        assert_eq!(
            notes(&index, "/code/b"),
            1,
            "a scan keeps the notes, keyed by path"
        );
        let d = index.get(Path::new("/code/d")).expect("get").expect("d");
        assert!(d.missing, "gone from disk, kept by Geoportal");
        assert!(
            !index
                .get(Path::new("/code/c"))
                .expect("get")
                .expect("c")
                .missing
        );
        assert!(index.loose_entries().is_empty());
        // A folder without a project changes nothing.
        let nothing = index
            .complete_folder_scan(Path::new("/elsewhere"), &[], &[], 11)
            .expect("end");
        assert_eq!(nothing, FolderScanEnd::default());
        assert!(index
            .folder_members(Path::new("/elsewhere"))
            .expect("members")
            .is_empty());
    }

    #[test]
    fn deleting_a_project_drops_the_entries_no_other_project_holds() {
        let index = Index::in_memory().expect("index");
        for path in ["/tmp/spike", "/tmp/tiles"] {
            store(&index, &found(path, ""), 1);
        }
        let tiles = index
            .create_project(
                "Tiles",
                &[PathBuf::from("/tmp/spike"), PathBuf::from("/tmp/tiles")],
                2,
            )
            .expect("create");
        note(&index, "/tmp/spike");
        // The project of one goes; Tiles still holds the repository.
        let spike = named(&index, "spike");
        assert_eq!(
            index.delete_project(spike.id).expect("delete"),
            Some(Vec::new())
        );
        assert!(index.get(Path::new("/tmp/spike")).expect("get").is_some());
        // Tiles goes: `spike` belongs to no project any more, `tiles` still has its own.
        assert_eq!(
            index.delete_project(tiles.id).expect("delete"),
            Some(vec![PathBuf::from("/tmp/spike")])
        );
        assert!(index.get(Path::new("/tmp/spike")).expect("get").is_none());
        assert_eq!(notes(&index, "/tmp/spike"), 0);
        assert!(index.get(Path::new("/tmp/tiles")).expect("get").is_some());
        assert!(index.loose_entries().is_empty());
    }

    #[test]
    fn a_repository_in_two_projects_survives_the_deletion_of_one() {
        let index = Index::in_memory().expect("index");
        let code = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("code");
        store(&index, &found("/code/api", "/code"), 2);
        let geo = index
            .create_project("Geoportal", &[PathBuf::from("/code/api")], 3)
            .expect("create");
        assert_eq!(
            index.delete_project(geo.id).expect("delete"),
            Some(Vec::new())
        );
        assert_eq!(member_paths(&project(&index, code.id)), ["/code/api"]);
        assert!(index.get(Path::new("/code/api")).expect("get").is_some());
    }

    #[test]
    fn editing_a_folder_project_keeps_its_own_members() {
        let index = Index::in_memory().expect("index");
        let code = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("code");
        for path in ["/code/web", "/code/api"] {
            store(&index, &found(path, "/code"), 2);
        }
        store(&index, &found("/tmp/spike", ""), 3);
        // The folder's own `web` given again stays the folder's; `spike` joins by hand.
        let edit = index
            .set_project_members(
                code.id,
                &[PathBuf::from("/tmp/spike"), PathBuf::from("/code/web")],
                4,
            )
            .expect("members")
            .expect("exists");
        assert_eq!(
            member_paths(&edit.project),
            ["/code/api", "/code/web", "/tmp/spike"]
        );
        assert_eq!(edit.project.members[2].origin, MemberOrigin::Hand);
        // Its project of one goes; `code` holds it by hand.
        let spike = named(&index, "spike");
        assert_eq!(
            index.delete_project(spike.id).expect("delete"),
            Some(Vec::new())
        );
        // An empty list of hand members removes `spike`, which leaves the index; the folder's
        // own members cannot be removed by an edit.
        let edit = index
            .set_project_members(code.id, &[], 5)
            .expect("members")
            .expect("exists");
        assert_eq!(member_paths(&edit.project), ["/code/api", "/code/web"]);
        assert_eq!(edit.removed, [PathBuf::from("/tmp/spike")]);
        assert!(index.loose_entries().is_empty());
    }

    #[test]
    fn a_folder_project_is_one_per_folder() {
        let index = Index::in_memory().expect("index");
        let geo = index
            .create_folder_project(Path::new("/code/geo"), 1)
            .expect("geo");
        assert_eq!(geo.name, "geo");
        assert_eq!(geo.kind, ProjectKind::Folder);
        assert_eq!(geo.folder.as_deref(), Some(Path::new("/code/geo")));
        let again = index
            .create_folder_project(Path::new("/code/geo"), 2)
            .expect("again");
        assert_eq!(again, geo);
        let renamed = index
            .rename_project(geo.id, "Geo tiles", 3)
            .expect("rename")
            .expect("exists");
        assert_eq!(renamed.folder.as_deref(), Some(Path::new("/code/geo")));
        assert_eq!(
            index
                .create_folder_project(Path::new("/code/geo"), 4)
                .expect("found")
                .id,
            geo.id
        );
        assert_eq!(index.projects().expect("projects").len(), 1);
    }

    #[test]
    fn the_project_for_an_entry_is_the_one_opened_last() {
        let index = Index::in_memory().expect("index");
        let code = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("code");
        store(&index, &found("/code/api", "/code"), 2);
        let geo = index
            .create_project("Geoportal", &[PathBuf::from("/code/api")], 3)
            .expect("create");
        assert!(index.record_project_open(code.id, None, 50).expect("open"));
        assert!(index
            .record_project_open(geo.id, Some(Path::new("/code/api")), 100)
            .expect("open"));
        let chosen = index
            .project_for_entry(Path::new("/code/api"), 110)
            .expect("project")
            .expect("one");
        assert_eq!(chosen.id, geo.id);
        assert!(index.record_project_open(code.id, None, 120).expect("open"));
        assert_eq!(
            index
                .project_for_entry(Path::new("/code/api"), 130)
                .expect("project")
                .map(|p| p.id),
            Some(code.id)
        );
        // No entry, no project.
        assert_eq!(
            index
                .project_for_entry(Path::new("/nowhere"), 140)
                .expect("project"),
            None
        );
        // An entry no project holds (an index written by hand) gets its project of one.
        index
            .connection()
            .execute(
                "INSERT INTO repos (path, name, kind) VALUES ('/tmp/raw', 'raw', 'main')",
                [],
            )
            .expect("raw row");
        let raw = index
            .project_for_entry(Path::new("/tmp/raw"), 150)
            .expect("project")
            .expect("made");
        assert_eq!((raw.name.as_str(), raw.kind), ("raw", ProjectKind::List));
        assert_eq!(member_paths(&raw), ["/tmp/raw"]);
        assert!(index.loose_entries().is_empty());
    }

    #[test]
    fn pins_and_openings_are_recorded() {
        let index = Index::in_memory().expect("index");
        store(&index, &found("/tmp/spike", ""), 1);
        index
            .mark_missing(Path::new("/tmp/spike"), true)
            .expect("missing");
        let spike = named(&index, "spike");
        assert!(index.set_project_pinned(spike.id, true).expect("pin"));
        assert!(index
            .record_project_open(spike.id, Some(Path::new("/tmp/spike")), 77)
            .expect("open"));
        let spike = project(&index, spike.id);
        assert!(spike.pinned);
        assert_eq!(spike.opened_at, Some(77));
        assert_eq!(
            spike.last_repository.as_deref(),
            Some(Path::new("/tmp/spike"))
        );
        let entry = index
            .get(Path::new("/tmp/spike"))
            .expect("get")
            .expect("entry");
        assert_eq!(entry.last_opened_at, Some(77));
        assert!(!entry.missing, "an open finds it");
        // An opening without a repository keeps the last one.
        assert!(index.record_project_open(spike.id, None, 80).expect("open"));
        assert_eq!(
            project(&index, spike.id).last_repository.as_deref(),
            Some(Path::new("/tmp/spike"))
        );
        assert!(!index.set_project_pinned(999, true).expect("pin"));
        assert!(!index.record_project_open(999, None, 81).expect("open"));
    }

    /// A small deterministic generator for the property test (xorshift64).
    struct Random(u64);

    impl Random {
        fn below(&mut self, bound: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % bound as u64) as usize
        }
    }

    /// The paths of every entry, sorted.
    fn entries(index: &Index) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = index
            .list()
            .expect("list")
            .into_iter()
            .map(|entry| entry.path)
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn random_operations_leave_no_entry_outside_a_project() {
        const FOLDERS: [&str; 3] = ["/code", "/code/geo", "/wt"];
        const LOOSE: [&str; 4] = ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d"];
        // Four repositories per folder; those under `/code/geo` lie under `/code` too.
        let repos: Vec<String> = FOLDERS
            .iter()
            .flat_map(|folder| (0..4).map(move |i| format!("{folder}/r{i}")))
            .collect();
        let under = |path: &str| -> Vec<&'static str> {
            FOLDERS
                .iter()
                .copied()
                .filter(|folder| path.starts_with(&format!("{folder}/")))
                .collect()
        };
        let all_paths: Vec<String> = repos
            .iter()
            .cloned()
            .chain(LOOSE.iter().map(|path| (*path).to_owned()))
            .collect();
        for seed in [1_u64, 42, 20_260_929] {
            let index = Index::in_memory().expect("index");
            let mut random = Random(seed);
            for step in 0..400 {
                let ids: Vec<i64> = index
                    .projects()
                    .expect("projects")
                    .into_iter()
                    .map(|project| project.id)
                    .collect();
                let now = i64::from(step);
                let before = entries(&index);
                // What the step took out of the index; `None` when it may only add.
                let mut removed: Option<Vec<PathBuf>> = None;
                match random.below(9) {
                    0 => {
                        let folder = FOLDERS[random.below(FOLDERS.len())];
                        index
                            .create_folder_project(Path::new(folder), now)
                            .expect("folder");
                    }
                    1 | 2 => {
                        let path = &repos[random.below(repos.len())];
                        let folders = under(path);
                        let folder = folders[random.below(folders.len())];
                        let _ = index
                            .upsert_found(&found(path, folder), now)
                            .expect("found");
                    }
                    3 => {
                        let path = LOOSE[random.below(LOOSE.len())];
                        store(&index, &found(path, ""), now);
                    }
                    4 => {
                        let chosen: Vec<PathBuf> = all_paths
                            .iter()
                            .filter(|_| random.below(4) == 0)
                            .map(PathBuf::from)
                            .collect();
                        index.create_project("p", &chosen, now).expect("create");
                    }
                    5 if !ids.is_empty() => {
                        let id = ids[random.below(ids.len())];
                        let chosen: Vec<PathBuf> = all_paths
                            .iter()
                            .filter(|_| random.below(4) == 0)
                            .map(PathBuf::from)
                            .collect();
                        let edit = index
                            .set_project_members(id, &chosen, now)
                            .expect("members")
                            .expect("exists");
                        removed = Some(edit.removed);
                    }
                    6 if !ids.is_empty() => {
                        let id = ids[random.below(ids.len())];
                        removed = Some(index.delete_project(id).expect("delete").expect("exists"));
                    }
                    7 => {
                        let folder = FOLDERS[random.below(FOLDERS.len())];
                        let own = index.folder_members(Path::new(folder)).expect("members");
                        let (mut gone, mut present) = (Vec::new(), Vec::new());
                        for path in own {
                            match random.below(3) {
                                0 => gone.push(path),
                                1 => present.push(path),
                                _ => {}
                            }
                        }
                        let end = index
                            .complete_folder_scan(Path::new(folder), &gone, &present, now)
                            .expect("end");
                        removed = Some(end.removed);
                    }
                    8 => {
                        let path = &all_paths[random.below(all_paths.len())];
                        if let Some(project) = index
                            .project_for_entry(Path::new(path), now)
                            .expect("project")
                        {
                            assert!(
                                project.members.iter().any(|m| m.path == Path::new(path)),
                                "{path}"
                            );
                        }
                    }
                    _ => {}
                }
                let after = entries(&index);
                match removed {
                    Some(mut removed) => {
                        removed.sort();
                        let taken: Vec<PathBuf> = before
                            .iter()
                            .filter(|path| !after.contains(path))
                            .cloned()
                            .collect();
                        assert_eq!(taken, removed, "seed {seed}, step {step}");
                    }
                    None => {
                        assert!(
                            before.iter().all(|path| after.contains(path)),
                            "seed {seed}, step {step}: an entry went"
                        );
                    }
                }
                assert!(
                    index.loose_entries().is_empty(),
                    "seed {seed}, step {step}: {:?}",
                    index.loose_entries()
                );
            }
        }
    }

    #[test]
    fn an_empty_scan_holds_the_folders_members() {
        let index = Index::in_memory().expect("index");
        let code = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("code");
        for path in ["/code/a", "/code/b"] {
            store(&index, &found(path, "/code"), 2);
        }
        note(&index, "/code/a");
        // An unmounted drive reads as an empty folder: every own member reads as gone.
        let end = index
            .complete_folder_scan(
                Path::new("/code"),
                &[PathBuf::from("/code/a"), PathBuf::from("/code/b")],
                &[],
                3,
            )
            .expect("end");
        assert_eq!(
            end.held,
            [PathBuf::from("/code/a"), PathBuf::from("/code/b")]
        );
        assert!(end.left.is_empty() && end.removed.is_empty());
        assert_eq!(
            member_paths(&project(&index, code.id)),
            ["/code/a", "/code/b"]
        );
        assert!(
            index
                .get(Path::new("/code/a"))
                .expect("get")
                .expect("a")
                .missing
        );
        assert_eq!(notes(&index, "/code/a"), 1);
    }

    #[test]
    fn an_edit_takes_out_only_what_it_left_behind() {
        let index = Index::in_memory().expect("index");
        store(&index, &found("/tmp/spike", ""), 1);
        // A row an older build left without a project.
        index
            .connection()
            .execute(
                "INSERT INTO repos (path, name, kind) VALUES ('/tmp/raw', 'raw', 'main')",
                [],
            )
            .expect("raw row");
        let other = index.create_project("other", &[], 2).expect("create");
        assert_eq!(
            index.delete_project(other.id).expect("delete"),
            Some(Vec::new())
        );
        assert!(index.get(Path::new("/tmp/raw")).expect("get").is_some());
        let spike = named(&index, "spike");
        assert_eq!(
            index.delete_project(spike.id).expect("delete"),
            Some(vec![PathBuf::from("/tmp/spike")])
        );
        assert!(index.get(Path::new("/tmp/raw")).expect("get").is_some());
    }

    #[test]
    fn the_last_repository_follows_the_members() {
        let index = Index::in_memory().expect("index");
        let geo = index
            .create_project("geo", &paths(&["web", "api"]), 1)
            .expect("create");
        assert!(index
            .record_project_open(geo.id, Some(Path::new("/code/web")), 2)
            .expect("open"));
        assert_eq!(
            project(&index, geo.id).last_repository.as_deref(),
            Some(Path::new("/code/web"))
        );
        // A path the project does not hold does not become its last repository.
        assert!(index
            .record_project_open(geo.id, Some(Path::new("/elsewhere")), 3)
            .expect("open"));
        assert_eq!(
            project(&index, geo.id).last_repository.as_deref(),
            Some(Path::new("/code/web"))
        );
        // Removing it from the project forgets it.
        index
            .set_project_members(geo.id, &paths(&["api"]), 4)
            .expect("members")
            .expect("exists");
        assert_eq!(project(&index, geo.id).last_repository, None);
    }

    #[test]
    fn a_folders_own_members_sort_by_path_whatever_the_case() {
        let index = Index::in_memory().expect("index");
        let code = index
            .create_folder_project(Path::new("/code"), 1)
            .expect("code");
        for path in ["/code/Zeta", "/code/alpha", "/code/beta"] {
            store(&index, &found(path, "/code"), 2);
        }
        assert_eq!(
            member_paths(&project(&index, code.id)),
            ["/code/alpha", "/code/beta", "/code/Zeta"]
        );
    }

    #[test]
    fn five_hundred_entries_and_fifty_projects_list_quickly() {
        let index = Index::in_memory().expect("index");
        index
            .create_folder_project(Path::new("/code"), 1)
            .expect("code");
        for i in 0..500 {
            store(&index, &found(&format!("/code/repo-{i:03}"), "/code"), 1);
        }
        for p in 0..49 {
            let members: Vec<PathBuf> = (0..10)
                .map(|m| PathBuf::from(format!("/code/repo-{:03}", (p * 10 + m) % 500)))
                .collect();
            index
                .create_project(&format!("p{p}"), &members, 2)
                .expect("create");
        }
        let started = std::time::Instant::now();
        let entries = index.list().expect("list");
        let projects = index.projects().expect("projects");
        let elapsed = started.elapsed();
        assert_eq!((entries.len(), projects.len()), (500, 50));
        assert!(
            elapsed < std::time::Duration::from_millis(50),
            "{elapsed:?}"
        );
    }
}
