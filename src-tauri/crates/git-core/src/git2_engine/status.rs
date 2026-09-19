//! Working tree status.

use super::{not_implemented, Git2Engine};
use crate::engine::Cancel;
use crate::error::GitResult;
use crate::types::{StatusEntry, StatusOptions};

/// Reports the working tree status; see [`crate::engine::GitEngine::status`].
pub(super) fn list(
    engine: &Git2Engine,
    options: &StatusOptions,
    cancel: &Cancel,
) -> GitResult<Vec<StatusEntry>> {
    let _ = (engine, options, cancel);
    Err(not_implemented("status"))
}
