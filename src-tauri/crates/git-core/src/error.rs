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
    /// HEAD is no longer the commit an operation was planned on (a commit, a checkout or a
    /// reset moved it since), and the operation changed nothing.
    #[error("HEAD moved: {}, not at {expected}", where_head_is(.actual))]
    HeadMoved {
        /// The commit the operation expected HEAD at.
        expected: String,
        /// Where HEAD is; empty when it names no commit.
        actual: String,
    },
    /// An operation in progress or conflicts in the index hold HEAD where it is, as git's soft
    /// reset reads them (and a bisect or a stopped `git am` too); nothing moved.
    #[error("HEAD is held: {0}")]
    HeadHeld(String),
    /// A blob referenced by a diff is missing from the object store.
    #[error("blob {0} is missing")]
    BlobMissing(String),
    /// A file is larger than what the app reads whole.
    #[error("the file is {size} bytes, over the {limit}-byte limit")]
    BlobTooLarge {
        /// Size of the file in bytes.
        size: u64,
        /// The limit in bytes.
        limit: u64,
    },
    /// A working tree file exists but could not be read (a lock, permissions).
    #[error("could not read {path}: {reason}")]
    BlobUnreadable {
        /// Repository-relative path of the file.
        path: String,
        /// The operating system's reason.
        reason: String,
    },
    /// A linked worktree's folder is missing from disk.
    #[error("the worktree folder {0} is missing")]
    WorktreeMissingFolder(PathBuf),
    /// git refused to remove a worktree with uncommitted changes; `--force` would.
    #[error("the worktree {0} has uncommitted changes")]
    WorktreeDirty(PathBuf),
    /// The git executable could not be started at all (not installed, not on PATH, not
    /// runnable, or silent past the probe's deadline); nothing ran.
    #[error("git could not be started ({command}): {reason}")]
    GitNotStarted {
        /// The arguments that were going to be passed, joined by spaces.
        command: String,
        /// The OS error or the deadline.
        reason: String,
    },
    /// The system `git` failed.
    #[error("git {command} failed: {stderr}")]
    Cli {
        /// The arguments that were passed, joined by spaces, for diagnostics.
        command: String,
        /// Exit status, or `None` when the process could not be started or was killed.
        status: Option<i32>,
        /// Standard error output, verbatim.
        stderr: String,
    },
    /// The stash named by this commit is no longer in the stash list: it was applied or
    /// dropped, or its entry deleted from the stash's reflog, since the list was read.
    #[error("stash {0} is no longer in the stash list")]
    StashNotFound(String),
    /// A side was asked for a path that has no conflict: it has no sides, and a version written
    /// over it would take its edits.
    #[error("{0} has no conflict to take a side of")]
    NotConflicted(String),
    /// Git holds no sides of a path's conflict to bring back: no resolve-undo record names it
    /// (it never conflicted, or the next stop, a reset or another merge dropped the record), or
    /// no operation is in progress (git's commit keeps the record of the stop it ended).
    #[error("the conflict of {0} cannot be brought back: git no longer holds its sides")]
    ConflictGone(String),
    /// A side was asked for a submodule's conflict: its side is a commit to check out inside the
    /// submodule, a repository of its own that these writes leave alone, and a side that
    /// deleted it would delete its folder, untracked files included.
    #[error("{0} is a submodule: check out the commit wanted inside it, then mark it resolved")]
    SubmoduleConflict(String),
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
            GitError::HeadMoved { .. } => "refs.head_moved",
            GitError::HeadHeld(_) => "refs.head_held",
            GitError::BlobMissing(_) => "diff.blob_missing",
            GitError::BlobTooLarge { .. } => "blob.too_large",
            GitError::BlobUnreadable { .. } => "blob.unreadable",
            GitError::WorktreeMissingFolder(_) => "worktree.missing_folder",
            GitError::WorktreeDirty(_) => "worktree.dirty",
            GitError::GitNotStarted { .. } => "git.not_started",
            GitError::Cli { .. } => "git.cli_failed",
            GitError::StashNotFound(_) => "stash.not_found",
            GitError::NotConflicted(_) => "conflict.not_conflicted",
            GitError::ConflictGone(_) => "conflict.gone",
            GitError::SubmoduleConflict(_) => "conflict.submodule",
            GitError::Cancelled => "op.cancelled",
            GitError::Git(_) => "internal",
        }
    }

    /// The raw text behind the message, when there is some: libgit2's reason, git's stderr,
    /// the OS's reason; what the app shows behind "Show git output" and the CLI puts in
    /// `detail`.
    pub fn detail(&self) -> Option<&str> {
        match self {
            GitError::Invalid { reason, .. }
            | GitError::CorruptObject { reason, .. }
            | GitError::GitNotStarted { reason, .. }
            | GitError::BlobUnreadable { reason, .. } => Some(reason),
            GitError::Cli { stderr, .. } => Some(stderr),
            _ => None,
        }
    }

    /// Every code an engine error can carry, for the tests that keep the IPC list in sync.
    pub const CODES: [&'static str; 20] = [
        "repo.not_found",
        "repo.invalid",
        "repo.corrupt_object",
        "refs.not_found",
        "refs.unrelated_histories",
        "refs.head_moved",
        "refs.head_held",
        "diff.blob_missing",
        "blob.too_large",
        "blob.unreadable",
        "worktree.missing_folder",
        "worktree.dirty",
        "git.not_started",
        "git.cli_failed",
        "stash.not_found",
        "conflict.not_conflicted",
        "conflict.gone",
        "conflict.submodule",
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

/// Where HEAD is, for [`GitError::HeadMoved`]'s sentence.
fn where_head_is(actual: &str) -> String {
    if actual.is_empty() {
        "it names no commit".to_owned()
    } else {
        format!("it is at {actual}")
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
            GitError::HeadMoved {
                expected: String::new(),
                actual: String::new(),
            },
            GitError::HeadHeld(String::new()),
            GitError::BlobMissing(String::new()),
            GitError::BlobTooLarge { size: 0, limit: 0 },
            GitError::BlobUnreadable {
                path: String::new(),
                reason: String::new(),
            },
            GitError::WorktreeMissingFolder(PathBuf::from("x")),
            GitError::WorktreeDirty(PathBuf::from("x")),
            GitError::GitNotStarted {
                command: String::new(),
                reason: String::new(),
            },
            GitError::Cli {
                command: String::new(),
                status: None,
                stderr: String::new(),
            },
            GitError::StashNotFound(String::new()),
            GitError::NotConflicted(String::new()),
            GitError::ConflictGone(String::new()),
            GitError::SubmoduleConflict(String::new()),
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
