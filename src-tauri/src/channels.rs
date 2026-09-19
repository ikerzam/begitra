//! Streamed results: ordered page messages followed by exactly one terminal message.
//!
//! A [`Stream`] wraps a [`Sink`] (a Tauri [`Channel`] in the app, a collector in tests) and
//! enforces the protocol: pages carry a sequence number, `done` or `error` ends the stream, and
//! nothing is sent after that. Dropping a stream that was never ended sends an `internal` error
//! so the frontend never waits forever.

use std::marker::PhantomData;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::AppError;

/// One message of a streamed result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamMessage<T> {
    /// One page or progress step; `seq` starts at 0 and increases by one per page.
    Page {
        /// Position of the page in the stream.
        seq: u32,
        /// The page.
        data: T,
    },
    /// The stream ended normally.
    Done,
    /// The stream ended with a failure.
    Error {
        /// What went wrong.
        error: AppError,
    },
}

/// Destination of stream messages.
pub trait Sink<T>: Send {
    /// Delivers one message; `Err` means the receiver is gone.
    fn send(&self, message: StreamMessage<T>) -> Result<(), String>;
}

impl<T> Sink<T> for Channel<StreamMessage<T>>
where
    T: Serialize + Send + 'static,
{
    fn send(&self, message: StreamMessage<T>) -> Result<(), String> {
        Channel::send(self, message).map_err(|error| error.to_string())
    }
}

/// A stream in progress.
pub struct Stream<T, S: Sink<T>> {
    sink: S,
    seq: u32,
    ended: bool,
    _page: PhantomData<fn() -> T>,
}

impl<T, S: Sink<T>> Stream<T, S> {
    /// Starts a stream over `sink`.
    pub fn new(sink: S) -> Self {
        Self {
            sink,
            seq: 0,
            ended: false,
            _page: PhantomData,
        }
    }

    /// Sends one page. Returns `false` when the receiver is gone, so producers can stop early.
    pub fn page(&mut self, data: T) -> bool {
        if self.ended {
            return false;
        }
        let message = StreamMessage::Page {
            seq: self.seq,
            data,
        };
        self.seq += 1;
        self.sink.send(message).is_ok()
    }

    /// Ends the stream normally.
    pub fn done(mut self) {
        self.terminal(StreamMessage::Done);
    }

    /// Ends the stream with `error`.
    pub fn error(mut self, error: AppError) {
        self.terminal(StreamMessage::Error { error });
    }

    /// Number of pages sent so far.
    pub fn pages_sent(&self) -> u32 {
        self.seq
    }

    fn terminal(&mut self, message: StreamMessage<T>) {
        if !self.ended {
            self.ended = true;
            if let Err(reason) = self.sink.send(message) {
                tracing::debug!(reason, "stream receiver is gone");
            }
        }
    }
}

impl<T, S: Sink<T>> Drop for Stream<T, S> {
    fn drop(&mut self) {
        if !self.ended {
            self.terminal(StreamMessage::Error {
                error: AppError::internal("The stream ended without a terminal message"),
            });
        }
    }
}

#[cfg(test)]
pub(crate) mod testing {
    //! A sink that collects messages, for tests of streaming commands.

    use std::sync::{Arc, Mutex};

    use super::{Sink, StreamMessage};

    /// Collects every message sent through it.
    #[derive(Clone, Debug)]
    pub struct Collector<T>(pub Arc<Mutex<Vec<StreamMessage<T>>>>);

    impl<T> Default for Collector<T> {
        fn default() -> Self {
            Self(Arc::default())
        }
    }

    impl<T> Collector<T> {
        /// Everything received so far.
        pub fn messages(&self) -> Vec<StreamMessage<T>>
        where
            T: Clone,
        {
            self.0.lock().map(|m| m.clone()).unwrap_or_default()
        }
    }

    impl<T: Send> Sink<T> for Collector<T> {
        fn send(&self, message: StreamMessage<T>) -> Result<(), String> {
            self.0
                .lock()
                .map_err(|_| "poisoned".to_owned())
                .map(|mut messages| messages.push(message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::Collector;
    use super::*;
    use crate::error::codes;

    #[test]
    fn pages_are_numbered_and_followed_by_done() {
        let collector = Collector::<u32>::default();
        let mut stream = Stream::new(collector.clone());
        assert!(stream.page(10));
        assert!(stream.page(20));
        assert!(stream.page(30));
        assert_eq!(stream.pages_sent(), 3);
        stream.done();
        assert_eq!(
            collector.messages(),
            vec![
                StreamMessage::Page { seq: 0, data: 10 },
                StreamMessage::Page { seq: 1, data: 20 },
                StreamMessage::Page { seq: 2, data: 30 },
                StreamMessage::Done,
            ]
        );
    }

    #[test]
    fn error_is_terminal() {
        let collector = Collector::<u32>::default();
        let mut stream = Stream::new(collector.clone());
        stream.page(1);
        stream.error(AppError::cancelled());
        let messages = collector.messages();
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[1],
            StreamMessage::Error {
                error: AppError::cancelled()
            }
        );
    }

    #[test]
    fn dropping_an_unfinished_stream_sends_an_internal_error() {
        let collector = Collector::<u32>::default();
        {
            let mut stream = Stream::new(collector.clone());
            stream.page(1);
        }
        let messages = collector.messages();
        assert_eq!(messages.len(), 2);
        match &messages[1] {
            StreamMessage::Error { error } => assert_eq!(error.code, codes::INTERNAL),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn serialises_with_a_kind_tag() {
        let page: StreamMessage<u32> = StreamMessage::Page { seq: 2, data: 7 };
        assert_eq!(
            serde_json::to_string(&page).expect("json"),
            r#"{"kind":"page","seq":2,"data":7}"#
        );
        let done: StreamMessage<u32> = StreamMessage::Done;
        assert_eq!(
            serde_json::to_string(&done).expect("json"),
            r#"{"kind":"done"}"#
        );
        let error: StreamMessage<u32> = StreamMessage::Error {
            error: AppError::cancelled(),
        };
        assert!(serde_json::to_string(&error)
            .expect("json")
            .starts_with(r#"{"kind":"error","error":{"code":"op.cancelled""#));
    }
}
