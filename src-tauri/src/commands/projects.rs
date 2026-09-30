//! Projects: the unit the app opens. A folder project holds what the scans of its folder find
//! and any member added by hand; a list project holds what was added to it. Every index entry
//! belongs to one, and making, renaming, editing, pinning or deleting a project writes to no
//! repository.

use std::path::{Component, Path, PathBuf, Prefix};

use git_core::engine::Cancel;
use git_core::summary::{describe_head, repository_root};
use repo_index::{Project, ProjectEdit, Upserted};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::index::{found_from_summary, index_summary, normalise, now};
use crate::error::{codes, AppError};
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Longest project name, in characters.
const MAX_NAME_CHARS: usize = 100;

/// Most members of one project: the index's own scale (500 entries).
const MAX_MEMBERS: usize = 500;

/// Longest member path, in characters.
const MAX_PATH_CHARS: usize = 4096;

/// The project to open for a path, and the repository to show in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpen {
    /// Of the projects holding the repository, the one opened last; a list project of one
    /// made for it when none did.
    pub project: Project,
    /// The root of the repository or worktree the path lies in, as git and the index name it.
    pub repository: PathBuf,
}

/// A project name: not blank, bounded, on one line. Returns it trimmed.
fn validate_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid_argument("name", "empty"));
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::invalid_argument(
            "name",
            format!("longer than {MAX_NAME_CHARS} characters"),
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(AppError::invalid_argument("name", "a control character"));
    }
    Ok(trimmed.to_owned())
}

/// Member paths: at most [`MAX_MEMBERS`], each absolute and bounded. Returns them rebuilt
/// from their components as the index's paths are (separators, a trailing separator, `.`),
/// which is all the normalising they get: case, `..`, short names and links stay, so a folder
/// the user picks is added through the entry `refresh_repository` answers for it.
fn validate_members(paths: &[PathBuf]) -> Result<Vec<PathBuf>, AppError> {
    if paths.len() > MAX_MEMBERS {
        return Err(AppError::invalid_argument(
            "paths",
            format!("more than {MAX_MEMBERS} members"),
        ));
    }
    paths
        .iter()
        .map(|path| validate_path("paths", path))
        .collect()
}

/// One absolute, bounded path on one line, rebuilt from its components.
fn validate_path(field: &str, path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::invalid_argument(field, "not an absolute path"));
    }
    let text = path.to_string_lossy();
    if text.chars().count() > MAX_PATH_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("longer than {MAX_PATH_CHARS} characters"),
        ));
    }
    if text.chars().any(char::is_control) {
        return Err(AppError::invalid_argument(field, "a control character"));
    }
    Ok(normalise(path))
}

/// `path` without Windows' verbatim prefix (`\\?\C:\…`, `\\?\UNC\server\share\…`), which
/// `canonicalize` adds and nothing else in the app writes; any other path as it is.
fn without_verbatim(path: &Path) -> PathBuf {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };
    let mut plain = match prefix.kind() {
        Prefix::VerbatimDisk(letter) => PathBuf::from(format!("{}:", char::from(letter))),
        Prefix::VerbatimUNC(server, share) => {
            let mut unc = std::ffi::OsString::from(r"\\");
            unc.push(server);
            unc.push(r"\");
            unc.push(share);
            PathBuf::from(unc)
        }
        _ => return path.to_path_buf(),
    };
    for component in components {
        plain.push(component.as_os_str());
    }
    plain
}

/// A folder as the file system spells it (its case, links and `..` resolved) without the
/// verbatim prefix: the one spelling the index stores for a folder project and the scan walks,
/// so the same folder picked twice finds its project. `index.folder` when it is not a folder
/// on disk.
fn canonical_folder(folder: &Path) -> Result<PathBuf, AppError> {
    let folder = validate_path("folder", folder)?;
    let unreadable = |reason: String| {
        AppError::new(codes::INDEX_FOLDER, "The folder is not on disk")
            .with_detail(format!("{}: {reason}", folder.display()))
    };
    let canonical =
        std::fs::canonicalize(&folder).map_err(|error| unreadable(error.to_string()))?;
    if !canonical.is_dir() {
        return Err(unreadable("not a folder".to_owned()));
    }
    Ok(normalise(&without_verbatim(&canonical)))
}

/// The folder project of `folder`, made when there is none.
fn create_folder_project(state: &AppState, folder: &Path) -> Result<Project, AppError> {
    let folder = canonical_folder(folder)?;
    state.with_index(|index| Ok(index.create_folder_project(&folder, now())?))
}

/// The project to open for `path` and the repository to show: the repository or worktree
/// `path` is the root of, or lies inside, is described from HEAD (no status) and stored,
/// joining a list project of one when no project holds it, so it is never loose between two
/// calls; `repo.not_found` when `path` is in no repository.
fn open_path(state: &AppState, path: &Path, cancel: &Cancel) -> Result<ProjectOpen, AppError> {
    let root = repository_root(path).map_err(AppError::from)?;
    let summary = describe_head(&root, cancel).map_err(AppError::from)?;
    let found = found_from_summary(&summary);
    let stamp = now();
    state.with_index(|index| {
        // Opened by path, so it cannot miss a folder project.
        let upserted = index.upsert_found(&found, stamp)?;
        debug_assert_eq!(upserted, Upserted::Stored);
        let mut stored = index_summary(&summary);
        // Without a status the stored flag stays what it was.
        stored.dirty = index
            .get(&found.path)?
            .and_then(|entry| entry.summary.dirty);
        index.update_summary(&found.path, &stored, stamp)?;
        let project = index
            .project_for_entry(&found.path, stamp)?
            .ok_or_else(|| AppError::internal("the opened entry vanished"))?;
        Ok(ProjectOpen {
            project,
            repository: found.path.clone(),
        })
    })
}

/// Runs an index call on the blocking pool.
async fn with_index<T: Send + 'static>(
    state: &State<'_, AppState>,
    work: impl FnOnce(&repo_index::Index) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || app.with_index(work))
        .await
        .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Every project with its members in order, by name.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn projects(state: State<'_, AppState>) -> Result<Vec<Project>, AppError> {
    with_index(&state, |index| Ok(index.projects()?)).await
}

/// Makes a list project of `paths` in their order.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(members = paths.len()))]
pub async fn project_create(
    state: State<'_, AppState>,
    name: String,
    paths: Vec<PathBuf>,
) -> Result<Project, AppError> {
    let name = validate_name(&name)?;
    let paths = validate_members(&paths)?;
    with_index(&state, move |index| {
        Ok(index.create_project(&name, &paths, now())?)
    })
    .await
}

/// The folder project of `folder` (found, or made and named after the folder); the frontend
/// scans it next. `index.folder` when `folder` is not a folder on disk.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn project_create_folder(
    state: State<'_, AppState>,
    folder: PathBuf,
) -> Result<Project, AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || create_folder_project(&app, &folder))
        .await
        .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// The project to open for `path` and the repository to show in it; `repo.not_found` when
/// `path` is in no repository (a folder of repositories goes to `project_create_folder`).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn project_for_path(
    state: State<'_, AppState>,
    path: PathBuf,
    op_id: String,
) -> Result<ProjectOpen, AppError> {
    let path = validate_path("path", &path)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        open_path(&worker, &path, &cancel)
    })
    .await
}

/// Renames a project; `null` when it no longer exists.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn project_rename(
    state: State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<Option<Project>, AppError> {
    let name = validate_name(&name)?;
    with_index(&state, move |index| {
        Ok(index.rename_project(id, &name, now())?)
    })
    .await
}

/// Replaces the members a project holds by hand and their order; answers the project and the
/// repositories the edit left in no project (they leave the index with their notes), or
/// `null` when the project no longer exists.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(members = paths.len()))]
pub async fn project_set_members(
    state: State<'_, AppState>,
    id: i64,
    paths: Vec<PathBuf>,
) -> Result<Option<ProjectEdit>, AppError> {
    let paths = validate_members(&paths)?;
    with_index(&state, move |index| {
        Ok(index.set_project_members(id, &paths, now())?)
    })
    .await
}

/// Deletes a project, never a repository's folder; answers the repositories that belonged to
/// no other project (they left the index with their notes), or `null` when it no longer
/// existed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn project_delete(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<Vec<PathBuf>>, AppError> {
    with_index(&state, move |index| Ok(index.delete_project(id)?)).await
}

/// Pins or unpins a project to the top of Home; whether it exists.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn project_set_pinned(
    state: State<'_, AppState>,
    id: i64,
    pinned: bool,
) -> Result<bool, AppError> {
    with_index(&state, move |index| {
        Ok(index.set_project_pinned(id, pinned)?)
    })
    .await
}

/// Records that a project was opened now showing `repository` (its last repository, and the
/// repository's last opening); whether the project exists.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn project_record_open(
    state: State<'_, AppState>,
    id: i64,
    repository: Option<PathBuf>,
) -> Result<bool, AppError> {
    let repository = repository
        .map(|path| validate_path("repository", &path))
        .transpose()?;
    with_index(&state, move |index| {
        Ok(index.record_project_open(id, repository.as_deref(), now())?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use repo_index::ProjectKind;

    fn absolute(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\code\{name}"))
        } else {
            PathBuf::from(format!("/code/{name}"))
        }
    }

    fn git(root: &Path, args: &[&str]) {
        let output = git_core::cli::command(root, args)
            .output()
            .expect("git runs");
        assert!(output.status.success(), "git {args:?} failed");
    }

    /// A repository with one commit and a subfolder at `root`.
    fn repository(root: &Path) {
        std::fs::create_dir_all(root.join("src")).expect("mkdir");
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@x"]);
        git(root, &["config", "user.name", "t"]);
        git(root, &["commit", "-q", "--allow-empty", "-m", "init"]);
    }

    #[test]
    fn names_are_trimmed_bounded_and_on_one_line() {
        assert_eq!(validate_name("  geo  ").expect("valid"), "geo");
        assert_eq!(
            validate_name("Geoportal · agentes").expect("unicode"),
            "Geoportal · agentes"
        );
        for bad in ["", "   ", "two\nlines", "tab\tinside"] {
            let error = validate_name(bad).expect_err(bad);
            assert_eq!(error.code, "ipc.invalid_argument");
        }
        assert!(validate_name(&"x".repeat(MAX_NAME_CHARS)).is_ok());
        assert!(validate_name(&"x".repeat(MAX_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn members_are_absolute_bounded_and_normalised() {
        let spaced = absolute("my repo");
        let respelled = if cfg!(windows) {
            PathBuf::from(r"C:/code/./my repo/")
        } else {
            PathBuf::from("/code/./my repo/")
        };
        assert_eq!(
            validate_members(&[respelled, absolute("año")]).expect("valid"),
            [spaced, absolute("año")]
        );
        assert!(validate_members(&[]).expect("empty").is_empty());
        assert!(validate_members(&[PathBuf::from("relative/repo")]).is_err());
        let too_many: Vec<PathBuf> = (0..=MAX_MEMBERS)
            .map(|i| absolute(&format!("repo-{i}")))
            .collect();
        assert!(validate_members(&too_many).is_err());
        assert!(validate_members(&[absolute(&"x".repeat(MAX_PATH_CHARS))]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn the_verbatim_prefix_goes_and_the_rest_stays() {
        assert_eq!(
            without_verbatim(Path::new(r"\\?\C:\Code\geo portal")),
            PathBuf::from(r"C:\Code\geo portal")
        );
        assert_eq!(
            without_verbatim(Path::new(r"\\?\UNC\nas\share\code")),
            PathBuf::from(r"\\nas\share\code")
        );
        assert_eq!(
            without_verbatim(Path::new(r"C:\Code")),
            PathBuf::from(r"C:\Code")
        );
    }

    #[test]
    fn a_path_opens_its_repository_in_a_project_of_one_then_in_the_one_opened_last() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("geoportal");
        repository(&root);
        let state = AppState::default();
        let cancel = Cancel::never();
        // A folder inside the repository opens the repository.
        let opened = open_path(&state, &root.join("src"), &cancel).expect("open");
        assert_eq!(opened.project.kind, ProjectKind::List);
        assert_eq!(opened.project.name, "geoportal");
        assert_eq!(opened.project.members.len(), 1);
        assert_eq!(opened.project.members[0].path, opened.repository);
        assert!(opened.repository.ends_with("geoportal"));
        // Opening it again answers the same project and makes no other.
        let again = open_path(&state, &root, &cancel).expect("open again");
        assert_eq!(again.project.id, opened.project.id);
        // Once another project that holds it was opened last, that one opens.
        let other =
            state
                .with_index(|index| {
                    Ok(index.create_project(
                        "Maps",
                        std::slice::from_ref(&opened.repository),
                        now(),
                    )?)
                })
                .expect("create");
        state
            .with_index(|index| Ok(index.record_project_open(other.id, None, now() + 60)?))
            .expect("record");
        let last = open_path(&state, &root, &cancel).expect("open the last one");
        assert_eq!(last.project.id, other.id);
        let projects = state
            .with_index(|index| Ok(index.projects()?))
            .expect("projects");
        assert_eq!(projects.len(), 2);
    }

    #[test]
    fn a_folder_in_no_repository_is_not_found_and_stores_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let folder = dir.path().join("notes");
        std::fs::create_dir_all(&folder).expect("mkdir");
        let state = AppState::default();
        let error = open_path(&state, &folder, &Cancel::never()).expect_err("no repository");
        assert_eq!(error.code, codes::REPO_NOT_FOUND);
        let listed = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert!(listed.is_empty());
        let projects = state
            .with_index(|index| Ok(index.projects()?))
            .expect("projects");
        assert!(projects.is_empty());
    }

    #[test]
    fn a_folder_project_is_made_once_whatever_the_spelling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let code = dir.path().join("code");
        std::fs::create_dir_all(code.join("geo")).expect("mkdir");
        let state = AppState::default();
        let made = create_folder_project(&state, &code).expect("made");
        assert_eq!(made.kind, ProjectKind::Folder);
        assert_eq!(made.name, "code");
        let folder = made.folder.clone().expect("a folder");
        assert!(!folder.to_string_lossy().starts_with(r"\\?\"), "{folder:?}");
        // The same folder through `..` finds the same project.
        let respelled = code.join("geo").join("..");
        let found = create_folder_project(&state, &respelled).expect("found");
        assert_eq!(found.id, made.id);
        assert_eq!(found.folder, made.folder);
        let projects = state
            .with_index(|index| Ok(index.projects()?))
            .expect("projects");
        assert_eq!(projects.len(), 1);
    }

    #[test]
    fn a_folder_that_is_not_on_disk_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = AppState::default();
        let error = create_folder_project(&state, &dir.path().join("gone")).expect_err("missing");
        assert_eq!(error.code, codes::INDEX_FOLDER);
        let file = dir.path().join("notes.txt");
        std::fs::write(&file, b"x").expect("write");
        let error = create_folder_project(&state, &file).expect_err("a file");
        assert_eq!(error.code, codes::INDEX_FOLDER);
        let error =
            create_folder_project(&state, Path::new("relative/code")).expect_err("relative");
        assert_eq!(error.code, codes::IPC_INVALID_ARGUMENT);
    }
}
