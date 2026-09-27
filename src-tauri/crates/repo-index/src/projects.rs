//! Projects: named, ordered groups of repositories and worktrees, kept by path.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::IndexResult;
use crate::index::{path_text, Index};
use crate::types::Project;

impl Index {
    /// Every project with its members in order, by name (whatever the case), then by id.
    pub fn projects(&self) -> IndexResult<Vec<Project>> {
        let connection = self.connection();
        let mut statement = connection.prepare(
            "SELECT id, name, created_at, updated_at FROM projects
             ORDER BY name COLLATE NOCASE ASC, id ASC",
        )?;
        let mut projects: Vec<Project> = statement
            .query_map([], project_from_row)?
            .collect::<Result<_, _>>()?;
        let slots: HashMap<i64, usize> = projects
            .iter()
            .enumerate()
            .map(|(slot, project)| (project.id, slot))
            .collect();
        let mut statement = connection.prepare(
            "SELECT project_id, path FROM project_members ORDER BY project_id, position",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, path) = row?;
            if let Some(project) = slots.get(&id).and_then(|&slot| projects.get_mut(slot)) {
                project.members.push(PathBuf::from(path));
            }
        }
        Ok(projects)
    }

    /// Makes a project of `paths` in their order (a repeated path keeps its first place).
    pub fn create_project(&self, name: &str, paths: &[PathBuf], now: i64) -> IndexResult<Project> {
        let transaction = self.connection().unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO projects (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
            params![name, now],
        )?;
        let id = transaction.last_insert_rowid();
        let members = insert_members(&transaction, id, paths)?;
        transaction.commit()?;
        Ok(Project {
            id,
            name: name.to_owned(),
            members,
            created_at: now,
            updated_at: now,
        })
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
        self.project(id)
    }

    /// Replaces a project's members and their order (a repeated path keeps its first place);
    /// `None` when there is no such project.
    pub fn set_project_members(
        &self,
        id: i64,
        paths: &[PathBuf],
        now: i64,
    ) -> IndexResult<Option<Project>> {
        let transaction = self.connection().unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE projects SET updated_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        transaction.execute(
            "DELETE FROM project_members WHERE project_id = ?1",
            params![id],
        )?;
        insert_members(&transaction, id, paths)?;
        transaction.commit()?;
        self.project(id)
    }

    /// Deletes a project and its members, never a repository; whether it existed. The members
    /// go in the same transaction rather than through the foreign key's cascade, which an
    /// in-memory index runs without.
    pub fn delete_project(&self, id: i64) -> IndexResult<bool> {
        let transaction = self.connection().unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM project_members WHERE project_id = ?1",
            params![id],
        )?;
        let deleted = transaction.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        transaction.commit()?;
        Ok(deleted > 0)
    }

    /// One project with its members.
    fn project(&self, id: i64) -> IndexResult<Option<Project>> {
        let connection = self.connection();
        let Some(mut project) = connection
            .query_row(
                "SELECT id, name, created_at, updated_at FROM projects WHERE id = ?1",
                params![id],
                project_from_row,
            )
            .optional()?
        else {
            return Ok(None);
        };
        let mut statement = connection
            .prepare("SELECT path FROM project_members WHERE project_id = ?1 ORDER BY position")?;
        project.members = statement
            .query_map(params![id], |row| row.get::<_, String>(0))?
            .map(|path| path.map(PathBuf::from))
            .collect::<Result<_, _>>()?;
        Ok(Some(project))
    }
}

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        members: Vec::new(),
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

/// Inserts `paths` as the members of project `id` in order, a repeated path once; returns
/// the members as stored.
fn insert_members(
    connection: &Connection,
    id: i64,
    paths: &[PathBuf],
) -> IndexResult<Vec<PathBuf>> {
    let mut statement = connection
        .prepare("INSERT INTO project_members (project_id, position, path) VALUES (?1, ?2, ?3)")?;
    let mut seen = HashSet::new();
    let mut members = Vec::new();
    for path in paths {
        let text = path_text(path);
        if !seen.insert(text.clone()) {
            continue;
        }
        let position = i64::try_from(members.len()).unwrap_or(i64::MAX);
        statement.execute(params![id, position, text])?;
        members.push(PathBuf::from(text));
    }
    Ok(members)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use crate::index::Index;
    use crate::types::{Found, RepoKind};

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| PathBuf::from(format!("/code/{name}")))
            .collect()
    }

    fn members(index: &Index, id: i64) -> Vec<PathBuf> {
        index
            .projects()
            .expect("projects")
            .into_iter()
            .find(|project| project.id == id)
            .map(|project| project.members)
            .unwrap_or_default()
    }

    #[test]
    fn a_project_keeps_its_name_and_its_members_in_order() {
        let index = Index::in_memory().expect("index");
        let geo = index
            .create_project("geo", &paths(&["web", "api", "tiles"]), 10)
            .expect("create");
        assert_eq!(geo.name, "geo");
        assert_eq!(geo.members, paths(&["web", "api", "tiles"]));
        assert_eq!((geo.created_at, geo.updated_at), (10, 10));
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
        assert_eq!(renamed.members, paths(&["web", "api", "tiles"]));

        // A new order replaces the old one; a repeated path keeps its first place.
        let reordered = index
            .set_project_members(geo.id, &paths(&["tiles", "web", "tiles"]), 30)
            .expect("members")
            .expect("exists");
        assert_eq!(reordered.members, paths(&["tiles", "web"]));
        assert_eq!(reordered.updated_at, 30);
        assert_eq!(members(&index, geo.id), paths(&["tiles", "web"]));
        assert_eq!(members(&index, other.id), paths(&["api"]));
    }

    #[test]
    fn a_member_outlives_its_index_row_and_a_deleted_project_leaves_nothing() {
        let index = Index::in_memory().expect("index");
        for name in ["web", "api"] {
            index
                .upsert_found(
                    &Found {
                        path: PathBuf::from(format!("/code/{name}")),
                        name: name.to_owned(),
                        kind: RepoKind::Main,
                        parent_path: None,
                        scan_root: PathBuf::from("/code"),
                    },
                    1,
                )
                .expect("insert");
        }
        let geo = index
            .create_project("geo", &paths(&["web", "api"]), 10)
            .expect("create");
        index.forget(Path::new("/code/web")).expect("forget");
        index.remove_root(Path::new("/code")).expect("remove root");
        assert!(index.list().expect("list").is_empty());
        assert_eq!(members(&index, geo.id), paths(&["web", "api"]));

        assert!(index.delete_project(geo.id).expect("delete"));
        assert!(index.projects().expect("projects").is_empty());
        let rows: i64 = index
            .connection()
            .query_row("SELECT COUNT(*) FROM project_members", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 0);
        assert!(!index.delete_project(geo.id).expect("delete again"));
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
        assert!(index.delete_project(second.id).expect("delete"));
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
        assert!(index.delete_project(geo.id).expect("delete"));
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
        let set = index
            .set_project_members(empty.id, &odd, 2)
            .expect("members")
            .expect("exists");
        assert_eq!(set.members, odd);
    }
}
