//! The review's commands: one file whole (`read_blob`), its token classes (`highlight_file`,
//! cached per repository and blob), its declarations (`file_symbols`), and the marks and notes
//! persisted per repository and target (`list_annotations`, `set_annotation`,
//! `delete_annotation`).

use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

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

/// Reads the text of `path` at `at`; a binary file has no text to classify. The key names
/// the path (the syntax comes from its extension) and the content, never the revision: a
/// branch that moved or a working-tree edit of the same size must not hit the cache.
fn text_of(
    engine: &dyn GitEngine,
    at: &BlobAt,
    path: &str,
) -> Result<Option<(String, String)>, GitError> {
    let blob = engine.read_blob(at, path)?;
    Ok(blob.text.map(|text| {
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        (format!("{path}:{:016x}", hasher.finish()), text)
    }))
}

/// A run of lines the viewer shows, 1-based and inclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// The highlight with only the lines inside `ranges` kept; the others come back empty, so a
/// 50,000-line file whose diff touches two hunks ships two hunks' worth of tokens.
fn slice(highlight: &Highlight, ranges: &[LineRange]) -> Highlight {
    let lines = highlight
        .lines
        .iter()
        .enumerate()
        .map(|(index, tokens)| {
            let number = index as u32 + 1;
            if ranges
                .iter()
                .any(|range| range.start <= number && number <= range.end)
            {
                tokens.clone()
            } else {
                Vec::new()
            }
        })
        .collect();
    Highlight {
        syntax: highlight.syntax.clone(),
        lines,
        complete: highlight.complete,
    }
}

/// The token classes of `path` at `at`; a binary, unknown or oversized file has none. The
/// result is cached per repository for the last files viewed; with `ranges`, only those
/// lines carry tokens.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn highlight_file(
    state: State<'_, AppState>,
    repo: PathBuf,
    at: BlobAt,
    path: String,
    ranges: Option<Vec<LineRange>>,
    op_id: String,
) -> Result<Highlight, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        let engine = worker.open(&repo)?;
        let root = engine.repo().root.clone();
        let Some((key, text)) = text_of(engine.as_ref(), &at, &path)? else {
            return Ok(Highlight::nothing());
        };
        let highlight = match worker.cached_highlight(&root, &key) {
            Some(cached) => cached,
            None => {
                let computed = Arc::new(
                    syntax::highlight(&path, &text, &|| cancel.is_cancelled())
                        .map_err(|_| GitError::Cancelled)?,
                );
                // A highlight cut short by its time budget is not kept: the next request
                // may have the time.
                if computed.complete {
                    worker.cache_highlight(&root, key, Arc::clone(&computed));
                }
                computed
            }
        };
        Ok::<_, GitError>(match ranges {
            Some(ranges) => slice(&highlight, &ranges),
            None => (*highlight).clone(),
        })
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
/// Longest path, hunk key and target kept, in bytes: they form the key of every row.
const MAX_PATH_BYTES: usize = 4_096;
const MAX_KEY_BYTES: usize = 512;

/// Checks a write and normalises it: a mark's value is always `1`.
fn validate(target: &str, write: &mut AnnotationWrite) -> Result<(), AppError> {
    if write.path.is_empty() {
        return Err(AppError::invalid_argument("path", "empty"));
    }
    if write.path.len() > MAX_PATH_BYTES {
        return Err(AppError::invalid_argument(
            "path",
            format!("longer than {MAX_PATH_BYTES} bytes"),
        ));
    }
    if write.hunk.len() > MAX_KEY_BYTES {
        return Err(AppError::invalid_argument(
            "hunk",
            format!("longer than {MAX_KEY_BYTES} bytes"),
        ));
    }
    if target.is_empty() || target.len() > MAX_KEY_BYTES {
        return Err(AppError::invalid_argument(
            "target",
            format!("empty or longer than {MAX_KEY_BYTES} bytes"),
        ));
    }
    match write.kind {
        AnnotationKind::Reviewed => write.value = "1".to_owned(),
        AnnotationKind::Note => {
            if write.value.trim().is_empty() {
                return Err(AppError::invalid_argument("value", "empty note"));
            }
            if write.value.chars().count() > MAX_NOTE_CHARS {
                return Err(AppError::invalid_argument(
                    "value",
                    format!("longer than {MAX_NOTE_CHARS} characters"),
                ));
            }
        }
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
#[tracing::instrument(level = "debug", skip(state, annotation), fields(path = %annotation.path, kind = ?annotation.kind))]
pub async fn set_annotation(
    state: State<'_, AppState>,
    repo: PathBuf,
    target: String,
    mut annotation: AnnotationWrite,
) -> Result<(), AppError> {
    validate(&target, &mut annotation)?;
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
#[tracing::instrument(level = "debug", skip(state, annotation), fields(path = %annotation.path, kind = ?annotation.kind))]
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

    fn check(target: &str, write: &AnnotationWrite) -> Result<AnnotationWrite, AppError> {
        let mut write = write.clone();
        validate(target, &mut write).map(|()| write)
    }

    #[test]
    fn writes_are_validated() {
        let ok = AnnotationWrite {
            path: "a.rs".to_owned(),
            hunk: String::new(),
            kind: AnnotationKind::Note,
            value: "x".repeat(10_000),
        };
        assert!(check("abc", &ok).is_ok());
        let long = AnnotationWrite {
            value: "x".repeat(10_001),
            ..ok.clone()
        };
        assert_eq!(
            check("abc", &long).expect_err("too long").message,
            "Invalid argument value"
        );
        let empty = AnnotationWrite {
            path: String::new(),
            ..ok.clone()
        };
        assert!(check("abc", &empty).is_err());
        let blank = AnnotationWrite {
            value: "  \n".to_owned(),
            ..ok.clone()
        };
        assert!(check("abc", &blank).is_err());
        let long_path = AnnotationWrite {
            path: "p".repeat(4_097),
            ..ok.clone()
        };
        assert!(check("abc", &long_path).is_err());
        let long_hunk = AnnotationWrite {
            hunk: "h".repeat(513),
            ..ok.clone()
        };
        assert!(check("abc", &long_hunk).is_err());
        assert!(check("", &ok).is_err());
        assert!(check(&"t".repeat(513), &ok).is_err());
        let mark = AnnotationWrite {
            kind: AnnotationKind::Reviewed,
            value: "yes".to_owned(),
            ..ok
        };
        assert_eq!(check("abc", &mark).expect("mark").value, "1");
    }

    #[test]
    fn slices_keep_only_the_requested_lines() {
        let token = |start: u32| syntax::Token {
            start,
            end: start + 1,
            class: syntax::TokenClass::Keyword,
        };
        let full = Highlight {
            syntax: Some("Rust".to_owned()),
            lines: vec![
                vec![token(0)],
                vec![token(1)],
                vec![token(2)],
                vec![token(3)],
            ],
            complete: true,
        };
        let sliced = slice(
            &full,
            &[
                LineRange { start: 2, end: 2 },
                LineRange { start: 4, end: 9 },
            ],
        );
        assert_eq!(
            sliced.lines,
            vec![vec![], vec![token(1)], vec![], vec![token(3)]]
        );
        assert_eq!(sliced.syntax.as_deref(), Some("Rust"));
        assert!(sliced.complete);
    }
}
