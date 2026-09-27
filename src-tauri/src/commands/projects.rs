//! Projects: named, ordered groups of repositories and worktrees kept in the index. Making,
//! renaming, editing or deleting one writes to no repository.

use std::path::{Path, PathBuf};

use repo_index::Project;
use tauri::State;

use crate::commands::index::{normalise, now};
use crate::error::AppError;
use crate::state::AppState;

/// Longest project name, in characters.
const MAX_NAME_CHARS: usize = 100;

/// Most members of one project: the index's own scale (500 entries).
const MAX_MEMBERS: usize = 500;

/// Longest member path, in characters.
const MAX_PATH_CHARS: usize = 4096;

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

/// Member paths: at most [`MAX_MEMBERS`], each absolute and bounded. Returns them normalised
/// as the index's paths are, so a member matches its entry whatever its spelling.
fn validate_members(paths: &[PathBuf]) -> Result<Vec<PathBuf>, AppError> {
    if paths.len() > MAX_MEMBERS {
        return Err(AppError::invalid_argument(
            "paths",
            format!("more than {MAX_MEMBERS} members"),
        ));
    }
    paths.iter().map(|path| validate_member(path)).collect()
}

fn validate_member(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::invalid_argument("paths", "not an absolute path"));
    }
    let text = path.to_string_lossy();
    if text.chars().count() > MAX_PATH_CHARS {
        return Err(AppError::invalid_argument(
            "paths",
            format!("longer than {MAX_PATH_CHARS} characters"),
        ));
    }
    if text.chars().any(char::is_control) {
        return Err(AppError::invalid_argument("paths", "a control character"));
    }
    Ok(normalise(path))
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

/// Makes a project of `paths` in their order.
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

/// Replaces a project's members and their order; `null` when it no longer exists.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(members = paths.len()))]
pub async fn project_set_members(
    state: State<'_, AppState>,
    id: i64,
    paths: Vec<PathBuf>,
) -> Result<Option<Project>, AppError> {
    let paths = validate_members(&paths)?;
    with_index(&state, move |index| {
        Ok(index.set_project_members(id, &paths, now())?)
    })
    .await
}

/// Deletes a project, never a repository; whether it existed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn project_delete(state: State<'_, AppState>, id: i64) -> Result<bool, AppError> {
    with_index(&state, move |index| Ok(index.delete_project(id)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(format!(r"C:\code\{name}"))
        } else {
            PathBuf::from(format!("/code/{name}"))
        }
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
        assert_eq!(
            validate_members(&[spaced.clone(), absolute("año")]).expect("valid"),
            [normalise(&spaced), normalise(&absolute("año"))]
        );
        assert!(validate_members(&[]).expect("empty").is_empty());
        assert!(validate_members(&[PathBuf::from("relative/repo")]).is_err());
        let too_many: Vec<PathBuf> = (0..=MAX_MEMBERS)
            .map(|i| absolute(&format!("repo-{i}")))
            .collect();
        assert!(validate_members(&too_many).is_err());
        assert!(validate_members(&[absolute(&"x".repeat(MAX_PATH_CHARS))]).is_err());
    }
}
