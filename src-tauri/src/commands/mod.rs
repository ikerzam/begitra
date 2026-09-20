//! Tauri commands, one module per capability. Commands are thin: they resolve the engine,
//! run the engine call through [`crate::ops`] and map errors to [`crate::error::AppError`].

pub mod compare;
pub mod diff;
pub mod external;
pub mod git;
pub mod index;
pub mod repo;
pub mod review;
pub mod scan;
pub mod staging;
pub mod system;
pub mod walk;
pub mod worktrees;
