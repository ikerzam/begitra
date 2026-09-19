//! Diffs with renames, hunks, intra-line spans and flags.

use super::{not_implemented, Git2Engine};
use crate::engine::Cancel;
use crate::error::GitResult;
use crate::types::{ChangeSet, DiffOptions, DiffTarget};

/// Computes a diff; see [`crate::engine::GitEngine::diff`].
pub(super) fn compute(
    engine: &Git2Engine,
    target: &DiffTarget,
    options: &DiffOptions,
    cancel: &Cancel,
) -> GitResult<ChangeSet> {
    let _ = (engine, target, options, cancel);
    Err(not_implemented("diff"))
}
