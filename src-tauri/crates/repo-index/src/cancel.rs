//! A shared cancellation flag, checked between directories by the scanner.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Cancellation flag shared between a scan and its caller. Cloning shares the flag.
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    /// A flag that is not set.
    pub fn new() -> Self {
        Self::default()
    }

    /// A flag that is never set, for callers without a cancel path.
    pub fn never() -> Self {
        Self::default()
    }

    /// Sets the flag; every holder sees it on the next check.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether the flag is set.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
