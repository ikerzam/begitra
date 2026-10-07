//! Headless Git engine for Begitra.
//!
//! Everything the UI can do with a repository goes through the [`engine::GitEngine`] trait so
//! that a CLI or an agent can drive the same operations. The crate has no Tauri dependency,
//! never panics on repository content, and returns plain serializable data.
//!
//! Modules:
//! - [`types`]: the domain types that cross the IPC boundary.
//! - [`engine`]: the [`engine::GitEngine`] trait, the paged [`engine::CommitWalk`] and
//!   [`engine::Cancel`].
//! - [`error`]: [`error::GitError`] with its stable codes.
//! - [`git2_engine`]: the libgit2 implementation.
//! - [`graph`]: incremental lane layout for the commit graph.
//! - [`diff`] and [`flags`]: hunk assembly, intra-line spans and the file flag heuristics.
//! - [`cli`]: the argv runner for the system `git`.
//! - [`providers`]: the seam for assistant integrations.

#![warn(missing_docs)]
#![forbid(unsafe_code)]

pub mod cli;
pub mod diff;
pub mod engine;
pub mod error;
pub mod flags;
pub mod git2_engine;
pub mod graph;
pub mod providers;
pub mod spelling;
pub mod summary;
pub mod types;
