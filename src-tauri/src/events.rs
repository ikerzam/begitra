//! Events pushed from Rust to the frontend: the `repo:changed`
//! shape, for the filesystem watcher to emit.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

/// Event name of [`RepoChanged`].
pub const REPO_CHANGED: &str = "repo:changed";

/// What changed in a repository.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepoChangeKind {
    /// Branches, tags, remotes or HEAD moved.
    Refs,
    /// The working tree changed.
    Status,
    /// Worktrees were added, removed, locked or pruned.
    Worktrees,
    /// The index changed.
    Index,
}

/// Payload of `repo:changed`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChanged {
    /// Root of the repository that changed.
    pub repo: PathBuf,
    /// Kinds of change, without duplicates.
    pub kinds: Vec<RepoChangeKind>,
    /// Affected repository-relative paths when known, otherwise empty.
    pub paths: Vec<String>,
}

/// Emits `repo:changed` to every window.
pub fn emit_repo_changed(app: &AppHandle, payload: &RepoChanged) -> Result<(), AppError> {
    app.emit(REPO_CHANGED, payload).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_kinds_in_kebab_case() {
        let payload = RepoChanged {
            repo: PathBuf::from("/r"),
            kinds: vec![RepoChangeKind::Refs, RepoChangeKind::Worktrees],
            paths: vec![],
        };
        let json = serde_json::to_string(&payload).expect("json");
        assert_eq!(
            json,
            r#"{"repo":"/r","kinds":["refs","worktrees"],"paths":[]}"#
        );
    }
}
