//! Benchmark tooling for Begira: the synthetic agent repository generator, the fetch of the
//! large real repository, and the report that turns criterion results into budget rows.
//!
//! The repositories live under `bench/repos` at the repository root (or `BEGIRA_BENCH_REPOS`)
//! and are never committed.

pub mod fetch;
pub mod generate;
pub mod report;
pub mod repos;
pub mod tree;

/// Failure of a bench subcommand.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A libgit2 call failed.
    #[error("git: {0}")]
    Git(#[from] git2::Error),
    /// The system git failed.
    #[error("{0}")]
    Cli(#[from] git_core::error::GitError),
    /// A filesystem operation failed.
    #[error("{context}: {source}")]
    Io {
        /// What was being done.
        context: String,
        /// The underlying error.
        #[source]
        source: std::io::Error,
    },
    /// A command-line argument is wrong.
    #[error("{0}")]
    Usage(String),
    /// A results file could not be parsed.
    #[error("{0}")]
    Report(String),
}

impl Error {
    /// Wraps an I/O error with what was being done.
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Error::Io {
            context: context.into(),
            source,
        }
    }
}

/// Result alias for bench operations.
pub type Result<T> = std::result::Result<T, Error>;
