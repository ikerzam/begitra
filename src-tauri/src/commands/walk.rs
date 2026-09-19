//! The paged commit walk as a stream: `walk_commits` starts a walk and streams up to
//! `max_pages` pages, keeping the handle for `walk_continue`; `close_walk` drops it.

use std::path::PathBuf;

use git_core::engine::{Cancel, CommitWalk, GitEngine};
use git_core::error::GitResult;
use git_core::types::{CommitNode, WalkOptions, WalkScope};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::channels::{Sink, Stream, StreamMessage};
use crate::error::AppError;
use crate::ops::{run_stream, DEFAULT_TIMEOUT};
use crate::state::{AppState, WALK_IDLE_LIMIT};

/// One streamed page of a walk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkPage {
    /// Handle to continue the walk with `walk_continue`.
    pub walk_id: String,
    /// Index of the page within the walk, from 0.
    pub index: u32,
    /// Commits of the page.
    pub commits: Vec<CommitNode>,
    /// Whether the walk is exhausted after this page.
    pub done: bool,
}

/// Where a pump stopped.
#[derive(Debug, PartialEq, Eq)]
pub struct PumpOutcome {
    /// Index of the next page.
    pub next_index: u32,
    /// The walk is exhausted (or the receiver went away) and the handle can be dropped.
    pub finished: bool,
}

/// Streams up to `max_pages` pages of `walk`, then one more `next_page` after a `done` page
/// to surface an error the engine parked behind a partial page.
pub fn pump<S: Sink<WalkPage>>(
    stream: &mut Stream<WalkPage, S>,
    walk: &mut dyn CommitWalk,
    walk_id: &str,
    first_index: u32,
    max_pages: u32,
    cancel: &Cancel,
) -> GitResult<PumpOutcome> {
    let mut index = first_index;
    for _ in 0..max_pages.max(1) {
        let page = walk.next_page(cancel)?;
        let done = page.done;
        let delivered = stream.page(WalkPage {
            walk_id: walk_id.to_owned(),
            index,
            commits: page.commits,
            done,
        });
        index += 1;
        if done {
            walk.next_page(cancel)?;
            return Ok(PumpOutcome {
                next_index: index,
                finished: true,
            });
        }
        if !delivered {
            return Ok(PumpOutcome {
                next_index: index,
                finished: true,
            });
        }
    }
    Ok(PumpOutcome {
        next_index: index,
        finished: false,
    })
}

/// Starts a walk over `scope` and streams up to `max_pages` pages; the handle stays open for
/// `walk_continue` until the walk is exhausted, closed, or idle for five minutes.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, on_page))]
pub async fn walk_commits(
    state: State<'_, AppState>,
    repo: PathBuf,
    scope: WalkScope,
    options: WalkOptions,
    max_pages: u32,
    op_id: String,
    on_page: Channel<StreamMessage<WalkPage>>,
) -> Result<(), AppError> {
    let app = state.inner().clone();
    app.evict_idle_walks(WALK_IDLE_LIMIT);
    let worker = app.clone();
    let timeout = DEFAULT_TIMEOUT * max_pages.clamp(1, 64);
    run_stream(
        app.ops(),
        &op_id,
        timeout,
        on_page,
        move |cancel, stream| {
            let engine = worker.open(&repo)?;
            let root = engine.repo().root.clone();
            let mut walk = engine.walk(&scope, &options, &cancel)?;
            let walk_id = worker.new_walk_id();
            let outcome = pump(stream, walk.as_mut(), &walk_id, 0, max_pages, &cancel)?;
            if !outcome.finished {
                worker.store_walk(&walk_id, root, walk);
            }
            Ok(())
        },
    )
    .await
}

/// Continues a walk started by `walk_commits` for up to `max_pages` more pages.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, on_page))]
pub async fn walk_continue(
    state: State<'_, AppState>,
    walk_id: String,
    next_index: u32,
    max_pages: u32,
    op_id: String,
    on_page: Channel<StreamMessage<WalkPage>>,
) -> Result<(), AppError> {
    let app = state.inner().clone();
    let (_repo, mut walk) = app.take_walk(&walk_id)?;
    let timeout = DEFAULT_TIMEOUT * max_pages.clamp(1, 64);
    let id = walk_id.clone();
    let holder = app.clone();
    run_stream(
        app.ops(),
        &op_id,
        timeout,
        on_page,
        move |cancel, stream| {
            let result = pump(stream, walk.as_mut(), &id, next_index, max_pages, &cancel);
            match &result {
                Ok(outcome) if !outcome.finished => holder.put_walk(&id, walk),
                _ => {
                    // The entry is reserved while in use; drop the handle and the entry here,
                    // on the blocking thread.
                    drop(walk);
                    drop(holder.drop_walk(&id));
                }
            }
            result.map(|_| ())
        },
    )
    .await
}

/// Drops a walk handle off the async runtime; returns whether it existed.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn close_walk(state: State<'_, AppState>, walk_id: String) -> Result<bool, AppError> {
    let Some(walk) = state.drop_walk(&walk_id) else {
        return Ok(false);
    };
    tokio::task::spawn_blocking(move || drop(walk))
        .await
        .map_err(|join| AppError::internal(format!("close task failed: {join}")))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use git_core::error::GitError;
    use git_core::types::{Page, Signature};

    use super::*;
    use crate::channels::testing::Collector;
    use crate::error::codes;
    use crate::ops::Operations;

    fn node(n: u32) -> CommitNode {
        let who = Signature {
            name: "a".to_owned(),
            email: "a@x".to_owned(),
            time: 0,
            offset_minutes: 0,
        };
        CommitNode {
            hash: format!("{n:040x}"),
            parents: vec![],
            author: who.clone(),
            committer: who,
            subject: format!("c{n}"),
            body: String::new(),
            refs: vec![],
            lane: 0,
            edges: vec![],
            overflow: 0,
        }
    }

    /// A walk over `total` commits in pages of `page_size`, optionally failing at `fail_at`.
    struct FakeWalk {
        total: u32,
        page_size: u32,
        emitted: u32,
        fail_at_page: Option<u32>,
        pages_served: u32,
        parked_error: Option<GitError>,
    }

    impl FakeWalk {
        fn new(total: u32, page_size: u32) -> Self {
            Self {
                total,
                page_size,
                emitted: 0,
                fail_at_page: None,
                pages_served: 0,
                parked_error: None,
            }
        }
    }

    impl CommitWalk for FakeWalk {
        fn next_page(&mut self, cancel: &Cancel) -> GitResult<Page> {
            cancel.check()?;
            if let Some(error) = self.parked_error.take() {
                return Err(error);
            }
            if self.fail_at_page == Some(self.pages_served) {
                // Corrupt object mid-page: partial page, done, error parked for the next call.
                self.parked_error = Some(GitError::CorruptObject {
                    hash: "deadbeef".to_owned(),
                    reason: "truncated".to_owned(),
                });
                self.pages_served += 1;
                return Ok(Page {
                    commits: vec![node(self.emitted)],
                    done: true,
                });
            }
            let remaining = self.total - self.emitted;
            let count = remaining.min(self.page_size);
            let commits = (0..count).map(|i| node(self.emitted + i)).collect();
            self.emitted += count;
            self.pages_served += 1;
            Ok(Page {
                commits,
                done: self.emitted >= self.total,
            })
        }
    }

    #[tokio::test]
    async fn streams_three_pages_of_at_most_500_then_done() {
        let ops = Operations::default();
        let collector = Collector::<WalkPage>::default();
        let result = run_stream(
            &ops,
            "w",
            DEFAULT_TIMEOUT,
            collector.clone(),
            |cancel, stream| {
                let mut walk = FakeWalk::new(1_200, 500);
                let outcome = pump(stream, &mut walk, "walk-1", 0, 10, &cancel)?;
                assert!(outcome.finished);
                assert_eq!(outcome.next_index, 3);
                Ok(())
            },
        )
        .await;
        assert!(result.is_ok());
        let messages = collector.messages();
        assert_eq!(messages.len(), 4);
        let sizes: Vec<(u32, usize, bool)> = messages
            .iter()
            .filter_map(|m| match m {
                StreamMessage::Page { seq, data } => Some((*seq, data.commits.len(), data.done)),
                _ => None,
            })
            .collect();
        assert_eq!(
            sizes,
            vec![(0, 500, false), (1, 500, false), (2, 200, true)]
        );
        assert_eq!(messages[3], StreamMessage::Done);
    }

    #[tokio::test]
    async fn a_corrupt_object_after_two_pages_ends_with_the_error_as_third_message() {
        let ops = Operations::default();
        let collector = Collector::<WalkPage>::default();
        let result = run_stream(
            &ops,
            "w",
            DEFAULT_TIMEOUT,
            collector.clone(),
            |cancel, stream| {
                let mut walk = FakeWalk::new(5_000, 500);
                walk.fail_at_page = Some(2);
                pump(stream, &mut walk, "walk-2", 0, 10, &cancel).map(|_| ())
            },
        )
        .await;
        assert_eq!(result.expect_err("fails").code, codes::REPO_CORRUPT_OBJECT);
        let messages = collector.messages();
        // Two full pages, the partial page with the commits read so far, then the error.
        assert_eq!(messages.len(), 4);
        match &messages[2] {
            StreamMessage::Page { data, .. } => {
                assert_eq!(data.commits.len(), 1);
                assert!(data.done);
            }
            other => panic!("unexpected {other:?}"),
        }
        match &messages[3] {
            StreamMessage::Error { error } => {
                assert_eq!(error.code, codes::REPO_CORRUPT_OBJECT);
                assert!(error.message.contains("deadbeef"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn stops_after_max_pages_and_reports_where_to_continue() {
        let ops = Operations::default();
        let collector = Collector::<WalkPage>::default();
        let result = run_stream(
            &ops,
            "w",
            DEFAULT_TIMEOUT,
            collector.clone(),
            |cancel, stream| {
                let mut walk = FakeWalk::new(1_200, 500);
                let outcome = pump(stream, &mut walk, "walk-3", 0, 2, &cancel)?;
                assert_eq!(
                    outcome,
                    PumpOutcome {
                        next_index: 2,
                        finished: false
                    }
                );
                let outcome = pump(stream, &mut walk, "walk-3", 2, 2, &cancel)?;
                assert_eq!(
                    outcome,
                    PumpOutcome {
                        next_index: 3,
                        finished: true
                    }
                );
                Ok(())
            },
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(collector.messages().len(), 4);
    }

    #[tokio::test]
    async fn walk_ids_and_indexes_are_on_every_page() {
        let ops = Operations::default();
        let collector = Collector::<WalkPage>::default();
        run_stream(
            &ops,
            "w",
            DEFAULT_TIMEOUT,
            collector.clone(),
            |cancel, stream| {
                let mut walk = FakeWalk::new(3, 1);
                pump(stream, &mut walk, "walk-9", 4, 10, &cancel).map(|_| ())
            },
        )
        .await
        .expect("ok");
        let indexes: Vec<(String, u32)> = collector
            .messages()
            .iter()
            .filter_map(|m| match m {
                StreamMessage::Page { data, .. } => Some((data.walk_id.clone(), data.index)),
                _ => None,
            })
            .collect();
        assert_eq!(
            indexes,
            vec![
                ("walk-9".to_owned(), 4),
                ("walk-9".to_owned(), 5),
                ("walk-9".to_owned(), 6)
            ]
        );
    }
}
