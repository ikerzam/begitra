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
    /// A ref name or revision did not resolve.
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
    /// A blob referenced by a diff is missing from the object store.
    #[error("blob {0} is missing")]
    BlobMissing(String),
    /// A linked worktree's folder is missing from disk.
    #[error("the worktree folder {0} is missing")]
    WorktreeMissingFolder(PathBuf),
    /// The system `git` failed or could not be started.
    #[error("git {command} failed: {stderr}")]
    Cli {
        /// The arguments that were passed, joined by spaces, for diagnostics.
        command: String,
        /// Exit status, or `None` when the process could not be started or was killed.
        status: Option<i32>,
        /// Standard error output, verbatim.
        stderr: String,
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
            GitError::BlobMissing(_) => "diff.blob_missing",
            GitError::WorktreeMissingFolder(_) => "worktree.missing_folder",
            GitError::Cli { .. } => "git.cli_failed",
            GitError::Cancelled => "op.cancelled",
            GitError::Git(_) => "internal",
        }
    }

    /// Every code an engine error can carry, for the tests that keep the IPC list in sync.
    pub const CODES: [&'static str; 10] = [
        "repo.not_found",
        "repo.invalid",
        "repo.corrupt_object",
        "refs.not_found",
        "refs.unrelated_histories",
        "diff.blob_missing",
        "worktree.missing_folder",
        "git.cli_failed",
        "op.cancelled",
        "internal",
    ];

    /// Maps a libgit2 failure while reading the object `hash` to [`GitError::CorruptObject`]
    /// when libgit2 reports the object as missing, invalid or unreadable, and to
    /// [`GitError::Git`] otherwise.
    pub fn object(hash: &str, error: git2::Error) -> Self {
        use git2::{ErrorClass, ErrorCode};
        // `Peel` and `InvalidSpec` mean the object is of the wrong type (a tag on a tree, a
        // blob where a commit is expected), not that it cannot be read.
        let wrong_type = matches!(error.code(), ErrorCode::Peel | ErrorCode::InvalidSpec);
        let corrupt = !wrong_type
            && (matches!(
                error.code(),
                ErrorCode::NotFound | ErrorCode::Invalid | ErrorCode::Ambiguous
            ) || matches!(
                error.class(),
                ErrorClass::Odb | ErrorClass::Object | ErrorClass::Zlib
            ));
        if corrupt {
            GitError::CorruptObject {
                hash: hash.to_owned(),
                reason: error.message().to_owned(),
            }
        } else {
            GitError::Git(error.message().to_owned())
        }
    }

    /// Maps a libgit2 failure while resolving `revision` to [`GitError::RefNotFound`] when it
    /// did not resolve, and to [`GitError::Git`] otherwise.
    pub fn revision(revision: &str, error: git2::Error) -> Self {
        use git2::ErrorCode;
        match error.code() {
            ErrorCode::NotFound
            | ErrorCode::InvalidSpec
            | ErrorCode::Ambiguous
            | ErrorCode::Peel => GitError::RefNotFound(revision.to_owned()),
            _ => GitError::Git(error.message().to_owned()),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_has_a_listed_code() {
        let errors = [
            GitError::NotFound(PathBuf::from("x")),
            GitError::Invalid {
                path: PathBuf::from("x"),
                reason: String::new(),
            },
            GitError::CorruptObject {
                hash: String::new(),
                reason: String::new(),
            },
            GitError::RefNotFound(String::new()),
            GitError::UnrelatedHistories {
                a: String::new(),
                b: String::new(),
            },
            GitError::BlobMissing(String::new()),
            GitError::WorktreeMissingFolder(PathBuf::from("x")),
            GitError::Cli {
                command: String::new(),
                status: None,
                stderr: String::new(),
            },
            GitError::Cancelled,
            GitError::Git(String::new()),
        ];
        let mut seen: Vec<&str> = errors.iter().map(GitError::code).collect();
        seen.sort_unstable();
        let mut listed = GitError::CODES.to_vec();
        listed.sort_unstable();
        assert_eq!(seen, listed);
    }
}
