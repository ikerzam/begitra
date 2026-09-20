//! Operation registry: every long call has an `opId` chosen by the frontend, a cancellation
//! flag bridged to the engine's [`Cancel`], and a timeout.
//!
//! Engine calls are synchronous libgit2 work, so they run in `spawn_blocking`; cancellation is
//! cooperative (the engine checks the flag between commits, files and hunks) and a timeout
//! flips the same flag so the blocking thread winds down instead of running on.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use git_core::engine::Cancel;

use crate::channels::{Sink, Stream};
use crate::error::{codes, AppError};

/// Timeout applied to every operation unless the command chooses another.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Cancellation flags of the operations in flight, by `opId`.
#[derive(Debug, Default)]
pub struct Operations {
    active: Mutex<HashMap<String, Cancel>>,
}

impl Operations {
    /// Registers `op_id` and returns its fresh cancellation handle; an operation registered
    /// again under the same id replaces the previous handle.
    pub fn start(&self, op_id: &str) -> Cancel {
        let cancel = Cancel::new();
        if let Ok(mut active) = self.active.lock() {
            active.insert(op_id.to_owned(), cancel.clone());
        }
        cancel
    }

    /// Requests cancellation of `op_id`; returns whether the operation was known.
    pub fn cancel(&self, op_id: &str) -> bool {
        match self.active.lock() {
            Ok(active) => match active.get(op_id) {
                Some(cancel) => {
                    cancel.cancel();
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    /// Forgets `op_id` once its work has ended.
    pub fn finish(&self, op_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(op_id);
        }
    }

    /// Number of operations in flight.
    pub fn active_count(&self) -> usize {
        self.active.lock().map(|active| active.len()).unwrap_or(0)
    }
}

/// Runs blocking engine work for `op_id` under `timeout`, off the async runtime.
///
/// The closure receives the operation's [`Cancel`] handle. A timeout cancels the handle and
/// returns `op.timeout`; a cancellation observed by the engine returns `op.cancelled`.
pub async fn run_blocking<T, E, F>(
    ops: &Operations,
    op_id: &str,
    timeout: Duration,
    work: F,
) -> Result<T, AppError>
where
    T: Send + 'static,
    E: Into<AppError> + Send + 'static,
    F: FnOnce(Cancel) -> Result<T, E> + Send + 'static,
{
    let cancel = ops.start(op_id);
    let worker = cancel.clone();
    let task = tokio::task::spawn_blocking(move || work(worker));
    let result = match tokio::time::timeout(timeout, task).await {
        Ok(Ok(result)) => result.map_err(Into::into),
        Ok(Err(join)) => Err(AppError::internal(format!("engine task failed: {join}"))),
        Err(_elapsed) => {
            cancel.cancel();
            Err(AppError::timeout(op_id, timeout))
        }
    };
    ops.finish(op_id);
    result
}

/// Runs blocking work that streams pages into `sink`, under `timeout`.
///
/// Only the blocking thread sends messages, so pages and the terminal message stay ordered:
/// when `work` returns `Ok` the stream ends with `done`; when the engine reports cancellation
/// the terminal error is `op.timeout` if the timeout caused it and `op.cancelled` otherwise;
/// any other engine error becomes the terminal error. The returned result mirrors the terminal
/// message except on timeout, where it is `op.timeout` while the thread is still winding down.
pub async fn run_stream<T, S, E, F>(
    ops: &Operations,
    op_id: &str,
    timeout: Duration,
    sink: S,
    work: F,
) -> Result<(), AppError>
where
    T: Send + 'static,
    S: Sink<T> + 'static,
    E: Into<AppError> + Send + 'static,
    F: FnOnce(Cancel, &mut Stream<T, S>) -> Result<(), E> + Send + 'static,
{
    let cancel = ops.start(op_id);
    let reason: Arc<Mutex<Option<AppError>>> = Arc::default();
    let worker_cancel = cancel.clone();
    let worker_reason = Arc::clone(&reason);
    let task = tokio::task::spawn_blocking(move || {
        let mut stream = Stream::new(sink);
        match work(worker_cancel, &mut stream).map_err(Into::into) {
            Ok(()) => {
                stream.done();
                Ok(())
            }
            Err(error) if error.code == codes::OP_CANCELLED => {
                // A timeout cancelled the work: the terminal error names the timeout;
                // otherwise the one cancellation message, whatever the source said.
                let error = worker_reason
                    .lock()
                    .ok()
                    .and_then(|reason| reason.clone())
                    .unwrap_or_else(AppError::cancelled);
                stream.error(error.clone());
                Err(error)
            }
            Err(error) => {
                stream.error(error.clone());
                Err(error)
            }
        }
    });
    let result = match tokio::time::timeout(timeout, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(join)) => Err(AppError::internal(format!("engine task failed: {join}"))),
        Err(_elapsed) => {
            let error = AppError::timeout(op_id, timeout);
            if let Ok(mut slot) = reason.lock() {
                *slot = Some(error.clone());
            }
            cancel.cancel();
            Err(error)
        }
    };
    ops.finish(op_id);
    result
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Instant;

    use git_core::error::GitError;

    use super::*;
    use crate::channels::testing::Collector;
    use crate::channels::StreamMessage;
    use crate::error::codes;

    /// A fake engine call that checks its cancellation flag every millisecond for `total`.
    fn slow(total: Duration) -> impl FnOnce(Cancel) -> Result<u32, GitError> + Send + 'static {
        move |cancel: Cancel| {
            let start = Instant::now();
            let mut ticks = 0;
            while start.elapsed() < total {
                cancel.check()?;
                std::thread::sleep(Duration::from_millis(1));
                ticks += 1;
            }
            Ok(ticks)
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancels_a_slow_operation_within_100_ms() {
        let ops = Arc::new(Operations::default());
        let canceller = Arc::clone(&ops);
        let cancelled_at = Arc::new(Mutex::new(None));
        let stamp = Arc::clone(&cancelled_at);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(canceller.cancel("op-1"));
            if let Ok(mut at) = stamp.lock() {
                *at = Some(Instant::now());
            }
        });

        let result =
            run_blocking(&ops, "op-1", DEFAULT_TIMEOUT, slow(Duration::from_secs(5))).await;
        let returned = Instant::now();

        let error = result.expect_err("must be cancelled");
        assert_eq!(error.code, codes::OP_CANCELLED);
        let at = cancelled_at
            .lock()
            .ok()
            .and_then(|at| *at)
            .expect("cancel happened");
        assert!(
            returned.duration_since(at) < Duration::from_millis(100),
            "took {:?} after the cancel",
            returned.duration_since(at)
        );
        assert_eq!(ops.active_count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn times_out_and_stops_the_work() {
        let ops = Operations::default();
        let observed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&observed);
        let work = move |cancel: Cancel| -> Result<(), GitError> {
            loop {
                if cancel.is_cancelled() {
                    flag.store(true, Ordering::SeqCst);
                    return Err(GitError::Cancelled);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        };

        let started = Instant::now();
        let error = run_blocking(&ops, "op-2", Duration::from_millis(30), work)
            .await
            .expect_err("must time out");
        assert_eq!(error.code, codes::OP_TIMEOUT);
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(ops.active_count(), 0);

        // The blocking thread observes the flag flipped by the timeout and winds down.
        let deadline = Instant::now() + Duration::from_millis(500);
        while !observed.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(observed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn returns_the_result_and_forgets_the_operation() {
        let ops = Operations::default();
        let value = run_blocking(&ops, "op-3", DEFAULT_TIMEOUT, |_cancel| {
            Ok::<_, GitError>(41 + 1)
        })
        .await
        .expect("succeeds");
        assert_eq!(value, 42);
        assert!(!ops.cancel("op-3"));
        assert_eq!(ops.active_count(), 0);
    }

    #[tokio::test]
    async fn maps_engine_errors() {
        let ops = Operations::default();
        let error = run_blocking(&ops, "op-4", DEFAULT_TIMEOUT, |_cancel| {
            Err::<(), _>(GitError::RefNotFound("nope".to_owned()))
        })
        .await
        .expect_err("fails");
        assert_eq!(error.code, codes::REFS_NOT_FOUND);
    }

    #[tokio::test]
    async fn streams_pages_then_done() {
        let ops = Operations::default();
        let collector = Collector::<u32>::default();
        let result = run_stream(
            &ops,
            "op-5",
            DEFAULT_TIMEOUT,
            collector.clone(),
            |_cancel, stream| {
                for page in 1..=3 {
                    stream.page(page);
                }
                Ok::<_, GitError>(())
            },
        )
        .await;
        assert!(result.is_ok());
        assert_eq!(
            collector.messages(),
            vec![
                StreamMessage::Page { seq: 0, data: 1 },
                StreamMessage::Page { seq: 1, data: 2 },
                StreamMessage::Page { seq: 2, data: 3 },
                StreamMessage::Done,
            ]
        );
    }

    #[tokio::test]
    async fn streams_end_with_the_engine_error() {
        let ops = Operations::default();
        let collector = Collector::<u32>::default();
        let result = run_stream(
            &ops,
            "op-6",
            DEFAULT_TIMEOUT,
            collector.clone(),
            |_cancel, stream| {
                stream.page(1);
                stream.page(2);
                Err(GitError::CorruptObject {
                    hash: "abc".to_owned(),
                    reason: "truncated".to_owned(),
                })
            },
        )
        .await;
        assert_eq!(result.expect_err("fails").code, codes::REPO_CORRUPT_OBJECT);
        let messages = collector.messages();
        assert_eq!(messages.len(), 3);
        match &messages[2] {
            StreamMessage::Error { error } => {
                assert_eq!(error.code, codes::REPO_CORRUPT_OBJECT);
                assert!(error.message.contains("abc"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_stream_ends_with_op_cancelled_and_no_more_pages() {
        let ops = Arc::new(Operations::default());
        let collector = Collector::<u32>::default();
        let canceller = Arc::clone(&ops);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            canceller.cancel("op-7");
        });
        let result = run_stream(
            &ops,
            "op-7",
            DEFAULT_TIMEOUT,
            collector.clone(),
            |cancel, stream| -> Result<(), GitError> {
                stream.page(1);
                loop {
                    cancel.check()?;
                    std::thread::sleep(Duration::from_millis(1));
                }
            },
        )
        .await;
        assert_eq!(result.expect_err("cancelled").code, codes::OP_CANCELLED);
        let messages = collector.messages();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[1],
            StreamMessage::Error {
                error: AppError::cancelled()
            }
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_timed_out_stream_ends_with_op_timeout() {
        let ops = Operations::default();
        let collector = Collector::<u32>::default();
        let result = run_stream(
            &ops,
            "op-8",
            Duration::from_millis(30),
            collector.clone(),
            |cancel, stream| -> Result<(), GitError> {
                stream.page(1);
                loop {
                    cancel.check()?;
                    std::thread::sleep(Duration::from_millis(1));
                }
            },
        )
        .await;
        assert_eq!(result.expect_err("timed out").code, codes::OP_TIMEOUT);
        let deadline = Instant::now() + Duration::from_millis(500);
        while collector.messages().len() < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let messages = collector.messages();
        assert_eq!(messages.len(), 2);
        match &messages[1] {
            StreamMessage::Error { error } => assert_eq!(error.code, codes::OP_TIMEOUT),
            other => panic!("unexpected {other:?}"),
        }
    }
}
