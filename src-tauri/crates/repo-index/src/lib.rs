//! SQLite-backed index for Begira: discovered repositories and worktrees, review state and
//! caches. The crate holds the schema and its migrations.

#![warn(missing_docs)]
#![forbid(unsafe_code)]

pub mod migrations;
