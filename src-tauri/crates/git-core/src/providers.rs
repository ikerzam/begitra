//! Seam for future assistant integrations. No implementation ships in v0.

use crate::error::GitResult;

/// A change set summary produced by an assistant provider.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    /// Plain-text summary of the change set.
    pub text: String,
}

/// An assistant that can summarize and review change sets.
///
/// Kept in `git-core` so the future headless CLI and MCP bridge share it with the app.
pub trait AssistantProvider: Send + Sync {
    /// Summarizes a change set given its structured description.
    fn summarize(&self, change_set_json: &str) -> GitResult<Summary>;
}
