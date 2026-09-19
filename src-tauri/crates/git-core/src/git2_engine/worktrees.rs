//! Worktree listing.

use super::{not_implemented, Git2Engine};
use crate::engine::Cancel;
use crate::error::GitResult;
use crate::types::Worktree;

/// Lists the worktrees; see [`crate::engine::GitEngine::worktrees`].
pub(super) fn list(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<Worktree>> {
    let _ = (engine, cancel);
    Err(not_implemented("worktrees"))
}
