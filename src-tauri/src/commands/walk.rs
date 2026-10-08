//! The paged commit walk as a stream: `walk_commits` starts a walk and streams up to
//! `max_pages` pages, keeping the handle for `walk_continue`; `close_walk` drops it.

use std::path::PathBuf;
use std::time::Duration;

use git_core::engine::{Cancel, CommitWalk, GitEngine};
use git_core::error::{GitError, GitResult};
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

/// Longest text or author filter, in characters.
const MAX_FILTER_TEXT: usize = 200;

/// Most paths of a path filter.
const MAX_FILTER_PATHS: usize = 20;

/// Most names of a scope of several refs (a pattern's branches); past it the graph walks the
/// first ones in the branch order.
const MAX_SCOPE_NAMES: usize = 2_000;

/// Longest name of a scope of several refs, in bytes: libgit2's own limit on a ref name.
const MAX_SCOPE_NAME_BYTES: usize = 1_024;

/// Rejects a scope of several refs the frontend should never send: too many names, or a name
/// that is no full ref name (outside `refs/` and not `HEAD`, overlong, with a control
/// character), which could name a revision that searches the history or fail the whole scope.
pub(crate) fn validate_scope(scope: &WalkScope) -> Result<(), AppError> {
    let WalkScope::Refs { names } = scope else {
        return Ok(());
    };
    if names.len() > MAX_SCOPE_NAMES {
        return Err(AppError::invalid_argument(
            "names",
            format!("more than {MAX_SCOPE_NAMES} names"),
        ));
    }
    let full_name = |name: &String| {
        (name == "HEAD" || name.starts_with("refs/"))
            && name.len() <= MAX_SCOPE_NAME_BYTES
            && !name.chars().any(char::is_control)
    };
    if !names.iter().all(full_name) {
        return Err(AppError::invalid_argument(
            "names",
            "a name that is no full ref name",
        ));
    }
    Ok(())
}

/// Rejects filters the frontend should never send: overlong text, a code search that is empty or
/// holds a control character other than tab (no argument carries a NUL, and no line of code holds
/// a line break), too many paths, a path that escapes the repository or an inverted date range.
fn validate_filter(options: &WalkOptions) -> Result<(), AppError> {
    let Some(filter) = &options.filter else {
        return Ok(());
    };
    for (field, value) in [("text", &filter.text), ("author", &filter.author)] {
        if value
            .as_ref()
            .is_some_and(|v| v.chars().count() > MAX_FILTER_TEXT)
        {
            return Err(AppError::invalid_argument(
                field,
                format!("longer than {MAX_FILTER_TEXT} characters"),
            ));
        }
    }
    if let Some(content) = &filter.content {
        let length = content.text.chars().count();
        if length == 0 || length > MAX_FILTER_TEXT {
            return Err(AppError::invalid_argument(
                "content",
                format!("not 1 to {MAX_FILTER_TEXT} characters"),
            ));
        }
        if content.text.chars().any(|c| c.is_control() && c != '\t') {
            return Err(AppError::invalid_argument("content", "a control character"));
        }
    }
    if filter.paths.len() > MAX_FILTER_PATHS {
        return Err(AppError::invalid_argument(
            "paths",
            format!("more than {MAX_FILTER_PATHS} paths"),
        ));
    }
    for path in &filter.paths {
        // `Component::Prefix` exists on Windows only, so `C:/x` is an ordinary relative path
        // to a Unix build: the drive letter is refused by hand, as the staging paths refuse it.
        let drive_relative = path.len() >= 2
            && path.as_bytes()[1] == b':'
            && path.as_bytes()[0].is_ascii_alphabetic();
        let escapes = path.is_empty()
            || path.starts_with('/')
            || path.starts_with('\\')
            || path.starts_with('-')
            || drive_relative
            || std::path::Path::new(path).components().any(|c| {
                matches!(
                    c,
                    std::path::Component::ParentDir | std::path::Component::Prefix(_)
                )
            });
        if escapes {
            return Err(AppError::invalid_argument(
                "paths",
                format!("{path:?} is not a repository-relative path"),
            ));
        }
    }
    if let (Some(since), Some(until)) = (filter.since, filter.until) {
        if since > until {
            return Err(AppError::invalid_argument("since", "later than until"));
        }
    }
    Ok(())
}

/// Most pages one call streams; the timeout grows with the pages.
const MAX_PAGES_PER_CALL: u32 = 64;

/// The pages one call streams and the timeout they get.
fn pages_and_timeout(max_pages: u32) -> (u32, Duration) {
    let pages = max_pages.clamp(1, MAX_PAGES_PER_CALL);
    (pages, DEFAULT_TIMEOUT * pages)
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
#[tracing::instrument(
    level = "debug",
    skip(state, scope, options, on_page),
    fields(
        scope = scope.kind(),
        names = scope.name_count(),
        filtered = options.filter.is_some(),
    )
)]
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
    let worker = app.clone();
    let (max_pages, timeout) = pages_and_timeout(max_pages);
    validate_scope(&scope)?;
    validate_filter(&options)?;
    run_stream(
        app.ops(),
        &op_id,
        timeout,
        on_page,
        move |cancel, stream| {
            // Idle handles are dropped here, on the blocking thread, never on the runtime.
            drop(worker.evict_idle_walks(WALK_IDLE_LIMIT));
            let engine = worker.open(&repo)?;
            let root = engine.repo().root.clone();
            let mut walk = engine.walk(&scope, &options, &cancel)?;
            let walk_id = worker.new_walk_id();
            let outcome = pump(stream, walk.as_mut(), &walk_id, 0, max_pages, &cancel)?;
            if !outcome.finished {
                worker.store_walk(&walk_id, root, walk);
            }
            Ok::<_, GitError>(())
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
    let (max_pages, timeout) = pages_and_timeout(max_pages);
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
                Ok::<_, GitError>(())
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
                Ok::<_, GitError>(())
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

    fn with_filter(filter: git_core::types::WalkFilter) -> WalkOptions {
        WalkOptions {
            filter: Some(filter),
            ..WalkOptions::default()
        }
    }

    #[test]
    fn a_scope_of_several_refs_is_validated_before_the_walk_starts() {
        let names = |count: usize| WalkScope::Refs {
            names: (0..count)
                .map(|n| format!("refs/heads/claude/{n}"))
                .collect(),
        };
        assert!(validate_scope(&WalkScope::All).is_ok());
        assert!(validate_scope(&names(0)).is_ok());
        assert!(validate_scope(&names(2_000)).is_ok());
        let error = validate_scope(&names(2_001)).expect_err("too many");
        assert_eq!(error.code, codes::IPC_INVALID_ARGUMENT);
        assert_eq!(error.message, "Invalid argument names");
        let with = |name: String| WalkScope::Refs {
            names: vec!["refs/heads/main".to_owned(), name],
        };
        assert!(validate_scope(&with("HEAD".to_owned())).is_ok());
        assert!(validate_scope(&with(format!("refs/heads/{}", "x".repeat(1_013)))).is_ok());
        for name in [
            String::new(),
            "main".to_owned(),
            ":/m1".to_owned(),
            "--all".to_owned(),
            "refs/heads/a\0b".to_owned(),
            "refs/heads/a\nb".to_owned(),
            format!("refs/heads/{}", "x".repeat(1_014)),
        ] {
            let error = validate_scope(&with(name.clone())).expect_err(&name);
            assert_eq!(error.code, codes::IPC_INVALID_ARGUMENT);
            // The message never carries the name, which may be long.
            assert!(!error.message.contains("xxxx"));
        }
    }

    #[test]
    fn filters_are_validated_before_the_walk_starts() {
        use git_core::types::{ContentFilter, WalkFilter};
        assert!(validate_filter(&WalkOptions::default()).is_ok());
        let ok = with_filter(WalkFilter {
            text: Some("é".repeat(200)),
            author: Some("a".repeat(200)),
            since: Some(1),
            until: Some(1),
            paths: vec![
                "apps/api".to_owned(),
                "a[1].txt".to_owned(),
                ":!x".to_owned(),
            ],
            content: Some(ContentFilter {
                text: format!("{}\t-S", "é".repeat(197)),
                lines: true,
            }),
        });
        assert!(
            validate_filter(&ok).is_ok(),
            "lengths count characters; paths are literal; a tab and a dash are code"
        );
        for text in [
            String::new(),
            "x".repeat(201),
            "a\nb".to_owned(),
            "a\rb".to_owned(),
            "a\0b".to_owned(),
            "a\u{7f}b".to_owned(),
        ] {
            let bad = with_filter(WalkFilter {
                content: Some(ContentFilter {
                    text: text.clone(),
                    lines: false,
                }),
                ..WalkFilter::default()
            });
            let error = validate_filter(&bad).expect_err(&text);
            assert_eq!(error.message, "Invalid argument content", "{text:?}");
        }
        let too_long = with_filter(WalkFilter {
            text: Some("x".repeat(201)),
            ..WalkFilter::default()
        });
        let error = validate_filter(&too_long).expect_err("too long");
        assert_eq!(error.code, codes::IPC_INVALID_ARGUMENT);
        assert_eq!(error.message, "Invalid argument text");
        for path in [
            "",
            "/etc/passwd",
            r"\\server\share",
            "-",
            "..",
            "a/../b",
            "C:/x",
        ] {
            let bad = with_filter(WalkFilter {
                paths: vec![path.to_owned()],
                ..WalkFilter::default()
            });
            let error = validate_filter(&bad).expect_err(path);
            assert_eq!(error.message, "Invalid argument paths", "{path:?}");
        }
        let many = with_filter(WalkFilter {
            paths: (0..21).map(|i| format!("p{i}")).collect(),
            ..WalkFilter::default()
        });
        assert!(validate_filter(&many).is_err());
        let inverted = with_filter(WalkFilter {
            since: Some(2),
            until: Some(1),
            ..WalkFilter::default()
        });
        assert_eq!(
            validate_filter(&inverted).expect_err("inverted").message,
            "Invalid argument since"
        );
    }
}
