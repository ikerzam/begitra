//! Diffs as a stream of file pages, so large change sets reach the UI progressively.

use std::path::PathBuf;

use git_core::engine::GitEngine;
use git_core::error::GitError;
use git_core::types::{ChangeSet, DiffOptions, DiffTarget, FileChange};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::channels::{Sink, Stream, StreamMessage};
use crate::error::AppError;
use crate::ops::{run_stream, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Files per streamed page.
pub const FILES_PER_PAGE: usize = 200;

/// One streamed page of a diff. Totals are repeated on every page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPage {
    /// Added lines over the whole change set.
    pub additions: u32,
    /// Removed lines over the whole change set.
    pub deletions: u32,
    /// Number of files in the whole change set.
    pub total_files: u32,
    /// Files of this page, in change set order.
    pub files: Vec<FileChange>,
}

/// Splits a change set into pages of [`FILES_PER_PAGE`] files; an empty change set yields one
/// empty page so the receiver still gets the totals.
pub fn pages(change_set: ChangeSet) -> Vec<DiffPage> {
    let total_files = u32::try_from(change_set.files.len()).unwrap_or(u32::MAX);
    let (additions, deletions) = (change_set.additions, change_set.deletions);
    if change_set.files.is_empty() {
        return vec![DiffPage {
            additions,
            deletions,
            total_files,
            files: Vec::new(),
        }];
    }
    let mut files = change_set.files;
    let mut result = Vec::with_capacity(files.len().div_ceil(FILES_PER_PAGE));
    while !files.is_empty() {
        let rest = files.split_off(files.len().min(FILES_PER_PAGE));
        result.push(DiffPage {
            additions,
            deletions,
            total_files,
            files,
        });
        files = rest;
    }
    result
}

/// Streams the pages of `change_set` into `stream`.
pub fn send_pages<S: Sink<DiffPage>>(stream: &mut Stream<DiffPage, S>, change_set: ChangeSet) {
    for page in pages(change_set) {
        if !stream.page(page) {
            break;
        }
    }
}

/// Computes the diff described by `target` and streams its files in pages.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, on_page))]
pub async fn diff(
    state: State<'_, AppState>,
    repo: PathBuf,
    target: DiffTarget,
    options: DiffOptions,
    op_id: String,
    on_page: Channel<StreamMessage<DiffPage>>,
) -> Result<(), AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_stream(
        app.ops(),
        &op_id,
        DEFAULT_TIMEOUT,
        on_page,
        move |cancel, stream| {
            let change_set = worker.open(&repo)?.diff(&target, &options, &cancel)?;
            send_pages(stream, change_set);
            Ok::<_, GitError>(())
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use git_core::types::ChangeKind;

    use super::*;

    fn file(n: usize) -> FileChange {
        FileChange {
            status: ChangeKind::Modified,
            path: format!("f{n}.rs"),
            old_path: None,
            similarity: None,
            additions: 1,
            deletions: 0,
            hunks: vec![],
            is_binary: false,
            is_large: false,
            is_generated: false,
            is_test: false,
        }
    }

    #[test]
    fn splits_into_pages_of_200_with_totals_on_each() {
        let change_set = ChangeSet {
            files: (0..450).map(file).collect(),
            additions: 450,
            deletions: 0,
        };
        let pages = pages(change_set);
        assert_eq!(
            pages.iter().map(|p| p.files.len()).collect::<Vec<_>>(),
            vec![200, 200, 50]
        );
        assert!(pages
            .iter()
            .all(|p| p.total_files == 450 && p.additions == 450));
        assert_eq!(pages[2].files[0].path, "f400.rs");
    }

    #[test]
    fn an_empty_change_set_is_one_empty_page() {
        let pages = pages(ChangeSet {
            files: vec![],
            additions: 0,
            deletions: 0,
        });
        assert_eq!(pages.len(), 1);
        assert!(pages[0].files.is_empty());
    }
}
