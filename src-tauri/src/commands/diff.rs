//! Diffs as a stream of file pages, so large change sets reach the UI progressively: the
//! engine lists the files first and reads the hunks of each page when the page is asked for.

use std::path::PathBuf;

use git_core::engine::{Cancel, DiffWalk, GitEngine};
use git_core::error::GitError;
use git_core::types::{ChangeSetPage, DiffOptions, DiffTarget, FileChange};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::channels::{Sink, Stream, StreamMessage};
use crate::error::AppError;
use crate::ops::{run_stream, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Files per streamed page.
pub const FILES_PER_PAGE: usize = 200;

/// One streamed page of a diff. The totals are the running sums over the pages so far (the
/// whole change set's on the last page); `total_files` is known from the first page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPage {
    /// Added lines over the pages so far.
    pub additions: u32,
    /// Removed lines over the pages so far.
    pub deletions: u32,
    /// Upper bound on the files of the whole change set: what the listing counted before
    /// the pages dropped the files git would not show (a sparse checkout's absent files, a
    /// whitespace-only change under `-w`). The files of the last page are the true total.
    pub total_files: u32,
    /// Files of this page, in change set order.
    pub files: Vec<FileChange>,
}

impl From<ChangeSetPage> for DiffPage {
    fn from(page: ChangeSetPage) -> Self {
        Self {
            additions: page.additions,
            deletions: page.deletions,
            total_files: page.total_files,
            files: page.files,
        }
    }
}

/// Streams the pages of `walk` as the engine reads them; an empty change set still sends one
/// page so the receiver gets the totals.
pub fn stream_pages<S: Sink<DiffPage>>(
    stream: &mut Stream<DiffPage, S>,
    walk: &mut dyn DiffWalk,
    cancel: &Cancel,
) -> Result<(), GitError> {
    loop {
        let page = walk.next_page(cancel)?;
        let done = page.done;
        if !stream.page(DiffPage::from(page)) || done {
            return Ok(());
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
            let engine = worker.open(&repo)?;
            let mut walk = engine.diff_pages(&target, &options, FILES_PER_PAGE, &cancel)?;
            stream_pages(stream, walk.as_mut(), &cancel)
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use git_core::types::ChangeKind;

    use super::*;
    use crate::channels::testing::Collector;

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
            is_lossy: false,
        }
    }

    /// A walk of `count` files, `per_page` at a time, with one added line per file.
    struct FakeWalk {
        count: usize,
        per_page: usize,
        next: usize,
    }

    impl DiffWalk for FakeWalk {
        fn next_page(&mut self, _cancel: &Cancel) -> Result<ChangeSetPage, GitError> {
            let end = (self.next + self.per_page).min(self.count);
            let files: Vec<FileChange> = (self.next..end).map(file).collect();
            self.next = end;
            Ok(ChangeSetPage {
                files,
                additions: u32::try_from(end).unwrap_or(u32::MAX),
                deletions: 0,
                total_files: u32::try_from(self.count).unwrap_or(u32::MAX),
                done: end >= self.count,
            })
        }
    }

    fn streamed(walk: &mut FakeWalk) -> Vec<DiffPage> {
        let collector = Collector::<DiffPage>::default();
        let mut stream = Stream::new(collector.clone());
        stream_pages(&mut stream, walk, &Cancel::never()).expect("stream");
        stream.done();
        collector
            .messages()
            .into_iter()
            .filter_map(|message| match message {
                StreamMessage::Page { data, .. } => Some(data),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn streams_the_engine_pages_with_running_totals() {
        let pages = streamed(&mut FakeWalk {
            count: 450,
            per_page: 200,
            next: 0,
        });
        assert_eq!(
            pages.iter().map(|p| p.files.len()).collect::<Vec<_>>(),
            vec![200, 200, 50]
        );
        assert_eq!(
            pages.iter().map(|p| p.additions).collect::<Vec<_>>(),
            vec![200, 400, 450]
        );
        assert!(pages.iter().all(|p| p.total_files == 450));
        assert_eq!(pages[2].files[0].path, "f400.rs");
    }

    #[test]
    fn an_empty_change_set_is_one_empty_page() {
        let pages = streamed(&mut FakeWalk {
            count: 0,
            per_page: 200,
            next: 0,
        });
        assert_eq!(pages.len(), 1);
        assert!(pages[0].files.is_empty());
        assert_eq!(pages[0].total_files, 0);
    }
}
