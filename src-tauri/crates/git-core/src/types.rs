//! Plain serializable domain types shared by the engine, the application and any future CLI.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// An opened repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repo {
    /// Root of the working tree that was opened (a linked worktree keeps its own root).
    pub root: PathBuf,
    /// The shared `.git` directory (the common dir for linked worktrees).
    pub common_dir: PathBuf,
    /// Checked-out branch name, or `None` when HEAD is detached or unborn.
    pub current_branch: Option<String>,
    /// Whether HEAD points at a commit rather than a branch.
    pub detached: bool,
    /// Whether this working tree is a linked worktree rather than the main one.
    pub is_linked_worktree: bool,
}
