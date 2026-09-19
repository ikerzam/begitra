//! Error type shared by every engine operation.

use std::path::PathBuf;

/// Failure of an engine operation. Every variant maps to a stable error code that the
/// application surfaces to the UI; see [`GitError::code`].
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// No repository was found at or above the given path.
    #[error("no Git repository found at or above {0}")]
    NotFound(PathBuf),
    /// The path is inside a repository that cannot be read.
    #[error("the repository at {path} could not be opened: {reason}")]
    Invalid {
        /// Path that was opened.
        path: PathBuf,
        /// Underlying reason, as reported by libgit2.
        reason: String,
    },
    /// An object in the object store is missing or corrupt.
    #[error("object {hash} is missing or corrupt: {reason}")]
    CorruptObject {
        /// Hash of the offending object.
        hash: String,
        /// Underlying reason, as reported by libgit2.
        reason: String,
    },
    /// A ref name did not resolve.
    #[error("ref {0} was not found")]
    RefNotFound(String),
    /// Two refs share no history.
    #[error("{a} and {b} have unrelated histories")]
    UnrelatedHistories {
        /// First ref.
        a: String,
        /// Second ref.
        b: String,
    },
    /// The operation was cancelled through its [`crate::engine::Cancel`] handle.
    #[error("operation cancelled")]
    Cancelled,
    /// Any other libgit2 failure.
    #[error("git operation failed: {0}")]
    Git(String),
}

impl GitError {
    /// Stable, dotted error code used across the IPC boundary and in the UI.
    pub fn code(&self) -> &'static str {
        match self {
            GitError::NotFound(_) => "repo.not_found",
            GitError::Invalid { .. } => "repo.invalid",
            GitError::CorruptObject { .. } => "repo.corrupt_object",
            GitError::RefNotFound(_) => "refs.not_found",
            GitError::UnrelatedHistories { .. } => "refs.unrelated_histories",
            GitError::Cancelled => "op.cancelled",
            GitError::Git(_) => "internal",
        }
    }
}

impl From<git2::Error> for GitError {
    fn from(error: git2::Error) -> Self {
        GitError::Git(error.message().to_owned())
    }
}

/// Result alias for engine operations.
pub type GitResult<T> = Result<T, GitError>;
