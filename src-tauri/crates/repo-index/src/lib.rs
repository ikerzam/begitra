//! SQLite-backed index for Begitra: discovered repositories and worktrees, the projects that
//! hold them (every entry belongs to at least one), review state and caches, plus the scanner
//! that finds repositories under the folders of folder projects.
//!
//! The crate knows nothing of git objects: the scanner only looks for `.git` entries on disk,
//! and the summaries stored in the index are computed by `git-core` and handed in.

#![warn(missing_docs)]
#![forbid(unsafe_code)]

pub mod annotations;
pub mod cancel;
pub mod error;
pub mod index;
pub mod migrations;
pub mod projects;
pub mod scanner;
pub mod types;

pub use cancel::Cancel;
pub use error::{IndexError, IndexResult};
pub use index::Index;
pub use types::{
    Annotation, AnnotationKey, AnnotationKind, AnnotationTarget, FolderScanEnd, Found, IndexEntry,
    Member, MemberOrigin, Operation, Project, ProjectEdit, ProjectKind, RepoKind, RepoSummary,
    Resolution, ScanEvent, ScanOptions, Upserted, Upstream,
};
