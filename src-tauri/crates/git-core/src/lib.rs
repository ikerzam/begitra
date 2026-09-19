//! Headless Git engine for Begira.
//!
//! Everything the UI can do with a repository goes through the [`engine::GitEngine`] trait so
//! that a CLI or an agent can drive the same operations. The crate has no Tauri dependency,
//! never panics on repository content, and returns plain serializable data.

#![warn(missing_docs)]
#![forbid(unsafe_code)]

pub mod engine;
pub mod error;
pub mod providers;
pub mod types;
