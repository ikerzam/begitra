//! Paged commit walk with lane layout.

use super::{not_implemented, Git2Engine};
use crate::engine::{Cancel, CommitWalk};
use crate::error::GitResult;
use crate::types::{WalkOptions, WalkScope};

/// Starts a walk; see [`crate::engine::GitEngine::walk`].
pub(super) fn start(
    engine: &Git2Engine,
    scope: &WalkScope,
    options: &WalkOptions,
    cancel: &Cancel,
) -> GitResult<Box<dyn CommitWalk>> {
    let _ = (engine, scope, options, cancel);
    Err(not_implemented("walk"))
}
