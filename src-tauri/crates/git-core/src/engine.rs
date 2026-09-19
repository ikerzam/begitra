//! The [`GitEngine`] trait and the cancellation handle passed to long operations.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{GitError, GitResult};

/// Cooperative cancellation flag checked by long operations between units of work.
///
/// The Tauri layer bridges its runtime cancellation token to this flag so the engine stays
/// free of any async runtime dependency.
#[derive(Clone, Debug, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    /// A handle that is never cancelled.
    pub fn never() -> Self {
        Self::default()
    }

    /// Requests cancellation; operations observing this handle stop at their next check.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    /// Whether cancellation was requested.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    /// Returns [`GitError::Cancelled`] when cancellation was requested.
    pub fn check(&self) -> GitResult<()> {
        if self.is_cancelled() {
            Err(GitError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Read-only Git operations, implemented once per backend (libgit2 first).
///
/// Operations are added to this trait as they are implemented,
/// each with tests against fixture repositories and the git CLI.
pub trait GitEngine: Send + Sync {
    /// Human-readable backend name, for diagnostics.
    fn backend_name(&self) -> &'static str;
}
