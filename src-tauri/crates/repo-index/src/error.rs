//! Errors of the index and the scanner, with stable codes for the application boundary.

use std::path::PathBuf;

/// Failure of an index or scanner operation.
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    /// The database refused a statement or could not be opened.
    #[error("index database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The schema could not be migrated.
    #[error(transparent)]
    Migration(#[from] crate::migrations::MigrationError),
    /// A scan folder could not be read.
    #[error("cannot read {path}: {reason}")]
    Folder {
        /// The folder.
        path: PathBuf,
        /// The operating system's reason.
        reason: String,
    },
    /// The scan was cancelled.
    #[error("the scan was cancelled")]
    Cancelled,
}

impl IndexError {
    /// Stable code of the error, for the application's `AppError`.
    pub fn code(&self) -> &'static str {
        match self {
            IndexError::Sqlite(_) | IndexError::Migration(_) => "index.database",
            IndexError::Folder { .. } => "index.folder",
            IndexError::Cancelled => "op.cancelled",
        }
    }
}

/// Result alias for the crate.
pub type IndexResult<T> = Result<T, IndexError>;
