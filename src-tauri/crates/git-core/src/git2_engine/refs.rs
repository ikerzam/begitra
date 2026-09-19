//! Refs listing with ahead/behind counts and worktree markers, and merge base.

use super::{not_implemented, Git2Engine};
use crate::engine::Cancel;
use crate::error::GitResult;
use crate::types::Ref;

/// Lists every ref; see [`crate::engine::GitEngine::refs`].
pub(super) fn list(engine: &Git2Engine, cancel: &Cancel) -> GitResult<Vec<Ref>> {
    let _ = (engine, cancel);
    Err(not_implemented("refs"))
}

/// Merge base of two revisions; see [`crate::engine::GitEngine::merge_base`].
pub(super) fn merge_base(engine: &Git2Engine, a: &str, b: &str) -> GitResult<String> {
    let _ = (engine, a, b);
    Err(not_implemented("merge_base"))
}
