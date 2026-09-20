//! The review's commands: one file whole (`read_blob`), its token classes (`highlight_file`,
//! cached per repository and blob), its declarations (`file_symbols`), and the marks and notes
//! persisted per repository and target (`list_annotations`, `set_annotation`,
//! `delete_annotation`).

use std::path::{Path, PathBuf};

use git_core::engine::GitEngine;
use git_core::error::GitError;
use git_core::types::{BlobAt, BlobContent};
use repo_index::{Annotation, AnnotationKey, AnnotationKind};
use serde::{Deserialize, Serialize};
use syntax::{Highlight, Symbol};
use tauri::State;

use crate::commands::index::now;
use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// The file at `at` in the repository at `repo`, whole.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn read_blob(
    state: State<'_, AppState>,
    repo: PathBuf,
    at: BlobAt,
    path: String,
    op_id: String,
) -> Result<BlobContent, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |_cancel| {
        worker.open(&repo)?.read_blob(&at, &path)
    })
    .await
}

/// Reads the text of `path` at `at`; a binary file has no text to classify.
fn text_of(
    engine: &dyn GitEngine,
    at: &BlobAt,
    path: &str,
) -> Result<Option<(String, String)>, GitError> {
    let blob = engine.read_blob(at, path)?;
    let key = match at {
        BlobAt::Revision { rev } => format!("{rev}:{path}"),
        BlobAt::WorkingTree => format!("working-tree:{path}:{}", blob.size),
    };
    Ok(blob.text.map(|text| (key, text)))
}

/// The token classes of `path` at `at`; a binary, unknown or oversized file has none. The
/// result is cached per repository for the last files viewed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn highlight_file(
    state: State<'_, AppState>,
    repo: PathBuf,
    at: BlobAt,
    path: String,
    op_id: String,
) -> Result<Highlight, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        let engine = worker.open(&repo)?;
        let root = engine.repo().root.clone();
        let Some((key, text)) = text_of(engine.as_ref(), &at, &path)? else {
            return Ok(Highlight::default());
        };
        if let Some(cached) = worker.cached_highlight(&root, &key) {
            return Ok(cached);
        }
        let result = syntax::highlight(&path, &text, &|| cancel.is_cancelled())
            .map_err(|_| GitError::Cancelled)?;
        worker.cache_highlight(&root, key, result.clone());
        Ok::<_, GitError>(result)
    })
    .await
}

/// The declarations of `path` at `at`; a file of another language has none.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn file_symbols(
    state: State<'_, AppState>,
    repo: PathBuf,
    at: BlobAt,
    path: String,
    op_id: String,
) -> Result<Vec<Symbol>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        let engine = worker.open(&repo)?;
        let Some((_, text)) = text_of(engine.as_ref(), &at, &path)? else {
            return Ok(Vec::new());
        };
        syntax::symbols(&path, &text, &|| cancel.is_cancelled()).map_err(|_| GitError::Cancelled)
    })
    .await
}

/// An annotation as the frontend writes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationWrite {
    /// Repository-relative path of the file.
    pub path: String,
    /// The hunk's key, or empty for the whole file.
    #[serde(default)]
    pub hunk: String,
    pub kind: AnnotationKind,
    /// `1` for a mark, the text of a note; ignored on delete.
    #[serde(default)]
    pub value: String,
}

/// Longest note kept, in characters.
const MAX_NOTE_CHARS: usize = 10_000;

fn validate(write: &AnnotationWrite) -> Result<(), AppError> {
    if write.path.is_empty() {
        return Err(AppError::invalid_argument("path", "empty"));
    }
    if write.value.chars().count() > MAX_NOTE_CHARS {
        return Err(AppError::invalid_argument(
            "value",
            format!("longer than {MAX_NOTE_CHARS} characters"),
        ));
    }
    Ok(())
}

fn normalise(path: &Path) -> PathBuf {
    path.components().collect()
}

/// The marks and notes of `target` in the repository at `repo`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn list_annotations(
    state: State<'_, AppState>,
    repo: PathBuf,
    target: String,
) -> Result<Vec<Annotation>, AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        app.with_index(|index| Ok(index.list_annotations(&normalise(&repo), &target)?))
    })
    .await
    .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Writes or replaces one mark or note.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn set_annotation(
    state: State<'_, AppState>,
    repo: PathBuf,
    target: String,
    annotation: AnnotationWrite,
) -> Result<(), AppError> {
    validate(&annotation)?;
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let repo = normalise(&repo);
        let key = AnnotationKey {
            repo: &repo,
            target: &target,
            path: &annotation.path,
            hunk: &annotation.hunk,
            kind: annotation.kind,
        };
        app.with_index(|index| Ok(index.set_annotation(&key, &annotation.value, now())?))
    })
    .await
    .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Removes one mark or note; returns whether it existed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn delete_annotation(
    state: State<'_, AppState>,
    repo: PathBuf,
    target: String,
    annotation: AnnotationWrite,
) -> Result<bool, AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let repo = normalise(&repo);
        let key = AnnotationKey {
            repo: &repo,
            target: &target,
            path: &annotation.path,
            hunk: &annotation.hunk,
            kind: annotation.kind,
        };
        app.with_index(|index| Ok(index.delete_annotation(&key)?))
    })
    .await
    .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_are_validated() {
        let ok = AnnotationWrite {
            path: "a.rs".to_owned(),
            hunk: String::new(),
            kind: AnnotationKind::Note,
            value: "x".repeat(10_000),
        };
        assert!(validate(&ok).is_ok());
        let long = AnnotationWrite {
            value: "x".repeat(10_001),
            ..ok.clone()
        };
        assert_eq!(
            validate(&long).expect_err("too long").message,
            "Invalid argument value"
        );
        let empty = AnnotationWrite {
            path: String::new(),
            ..ok
        };
        assert!(validate(&empty).is_err());
    }
}
