//! The one error type every command returns: `AppError { code, message, detail? }`.
//!
//! `code` is a stable dotted identifier the UI switches on (the full list is [`codes::ALL`],
//! mirrored by the frontend's `errorCodes`), `message` is a readable sentence, and `detail`
//! carries raw output when there is some: git's stderr, libgit2's reason, the argv that failed
//! to spawn.

use std::fmt;
use std::time::Duration;

use git_core::error::GitError;
use serde::{Deserialize, Serialize};

/// Error codes. Engine codes come from [`GitError::code`]; the rest are application-level.
pub mod codes {
    /// No repository at or above the path.
    pub const REPO_NOT_FOUND: &str = "repo.not_found";
    /// A repository was found but cannot be opened.
    pub const REPO_INVALID: &str = "repo.invalid";
    /// An object is missing or corrupt.
    pub const REPO_CORRUPT_OBJECT: &str = "repo.corrupt_object";
    /// A ref or revision did not resolve.
    pub const REFS_NOT_FOUND: &str = "refs.not_found";
    /// Two revisions share no history.
    pub const REFS_UNRELATED_HISTORIES: &str = "refs.unrelated_histories";
    /// HEAD moved since a write was planned on it; nothing changed.
    pub const REFS_HEAD_MOVED: &str = "refs.head_moved";
    /// An operation in progress or conflicts hold HEAD where it is; nothing changed.
    pub const REFS_HEAD_HELD: &str = "refs.head_held";
    /// A blob referenced by a diff is missing.
    pub const DIFF_BLOB_MISSING: &str = "diff.blob_missing";
    /// A file is larger than what the app reads whole.
    pub const BLOB_TOO_LARGE: &str = "blob.too_large";
    /// A working tree file could not be read; `detail` carries the OS reason.
    pub const BLOB_UNREADABLE: &str = "blob.unreadable";
    /// A linked worktree's folder is missing.
    pub const WORKTREE_MISSING_FOLDER: &str = "worktree.missing_folder";
    /// git refused to remove a worktree with uncommitted changes.
    pub const WORKTREE_DIRTY: &str = "worktree.dirty";
    /// The git executable could not be started; `detail` carries the reason.
    pub const GIT_NOT_STARTED: &str = "git.not_started";
    /// The system `git` failed; `detail` carries its stderr.
    pub const GIT_CLI_FAILED: &str = "git.cli_failed";
    /// git refused a switch, a merge, a rebase or a pull over local changes in its way;
    /// `detail` carries its words, which name the files.
    pub const GIT_LOCAL_CHANGES: &str = "git.local_changes";
    /// A stash named by its commit is no longer in the stash list; git did not run.
    pub const STASH_NOT_FOUND: &str = "stash.not_found";
    /// A side was asked for a path that has no conflict; git did not run.
    pub const CONFLICT_NOT_CONFLICTED: &str = "conflict.not_conflicted";
    /// Git no longer holds the sides of a path's conflict, so it cannot be brought back.
    pub const CONFLICT_GONE: &str = "conflict.gone";
    /// A side was asked for a submodule's conflict; git did not run.
    pub const CONFLICT_SUBMODULE: &str = "conflict.submodule";
    /// A conflicted file is not read for its blocks: not a regular file, or too large.
    pub const CONFLICT_UNREADABLE: &str = "conflict.unreadable";
    /// A conflicted file changed on disk since its blocks were read; nothing was written.
    pub const CONFLICT_FILE_CHANGED: &str = "conflict.file_changed";
    /// A conflict block could not be written; the file kept its bytes. `detail` carries why.
    pub const CONFLICT_WRITE_FAILED: &str = "conflict.write_failed";
    /// An ignore rule was asked for a path it cannot be written for (absolute, outside the
    /// working tree, missing, tracked) or that has nothing for the rule; nothing was written.
    pub const IGNORE_INVALID_PATH: &str = "ignore.invalid_path";
    /// The ignore file could not be read or written, or would be written through a link;
    /// `detail` carries the reason.
    pub const IGNORE_WRITE_FAILED: &str = "ignore.write_failed";
    /// The files a discard touches add up to more than a copy holds; nothing was discarded.
    pub const DISCARD_TOO_LARGE: &str = "discard.too_large";
    /// A path a discard touches is a folder or another thing a copy does not hold; nothing
    /// was discarded, and `detail` carries the path.
    pub const DISCARD_NOT_A_FILE: &str = "discard.not_a_file";
    /// A path a discard touches is behind a link or a junction, which can lead outside the
    /// working tree; nothing was discarded, and `detail` carries the path.
    pub const DISCARD_BEHIND_LINK: &str = "discard.behind_link";
    /// The copy before a discard could not be made; nothing was discarded, and `detail`
    /// carries the reason.
    pub const DISCARD_COPY_FAILED: &str = "discard.copy_failed";
    /// The copy an Undo asks for is gone: its toast went, or another discard replaced it.
    pub const DISCARD_COPY_GONE: &str = "discard.copy_gone";
    /// A command argument did not match its type; `detail` names the field.
    pub const IPC_INVALID_ARGUMENT: &str = "ipc.invalid_argument";
    /// The operation was cancelled.
    pub const OP_CANCELLED: &str = "op.cancelled";
    /// The operation exceeded its timeout.
    pub const OP_TIMEOUT: &str = "op.timeout";
    /// A walk id is unknown or was evicted.
    pub const OP_UNKNOWN_WALK: &str = "op.unknown_walk";
    /// The terminal, the editor, the browser or the file manager could not be started;
    /// `detail` carries the argv or the platform's reason.
    pub const EXTERNAL_SPAWN_FAILED: &str = "external.spawn_failed";
    /// The file or folder to open in the terminal or the editor, or to reveal, is not on disk;
    /// `detail` carries its path.
    pub const EXTERNAL_NOT_FOUND: &str = "external.not_found";
    /// A link that is not a forge's `https:` page, or an item outside the repositories the app
    /// knows, was refused; nothing opened, and `detail` carries what was refused.
    pub const EXTERNAL_REFUSED: &str = "external.refused";
    /// The settings file could not be read or written.
    pub const SETTINGS_IO: &str = "settings.io";
    /// The repository index database failed.
    pub const INDEX_DATABASE: &str = "index.database";
    /// A scan folder could not be read.
    pub const INDEX_FOLDER: &str = "index.folder";
    /// The filesystem watcher could not be started; the repository is open without it.
    pub const WATCHER_UNAVAILABLE: &str = "watcher.unavailable";
    /// The update check, download or install failed (raised by the frontend from the
    /// updater plugin's words in `detail`; listed here so the two code lists stay one).
    pub const UPDATER_FAILED: &str = "updater.failed";
    /// Anything else.
    pub const INTERNAL: &str = "internal";

    /// Every code, in the order of the frontend's `errorCodes` (`src/ipc/schemas.ts`); the
    /// contract test compares the two lists through the `app-errors` fixture.
    pub const ALL: [&str; 42] = [
        REPO_NOT_FOUND,
        REPO_INVALID,
        REPO_CORRUPT_OBJECT,
        REFS_NOT_FOUND,
        REFS_UNRELATED_HISTORIES,
        REFS_HEAD_MOVED,
        REFS_HEAD_HELD,
        DIFF_BLOB_MISSING,
        BLOB_TOO_LARGE,
        BLOB_UNREADABLE,
        WORKTREE_MISSING_FOLDER,
        WORKTREE_DIRTY,
        GIT_NOT_STARTED,
        GIT_CLI_FAILED,
        GIT_LOCAL_CHANGES,
        STASH_NOT_FOUND,
        CONFLICT_NOT_CONFLICTED,
        CONFLICT_GONE,
        CONFLICT_SUBMODULE,
        CONFLICT_UNREADABLE,
        CONFLICT_FILE_CHANGED,
        CONFLICT_WRITE_FAILED,
        IGNORE_INVALID_PATH,
        IGNORE_WRITE_FAILED,
        DISCARD_TOO_LARGE,
        DISCARD_NOT_A_FILE,
        DISCARD_BEHIND_LINK,
        DISCARD_COPY_FAILED,
        DISCARD_COPY_GONE,
        IPC_INVALID_ARGUMENT,
        OP_CANCELLED,
        OP_TIMEOUT,
        OP_UNKNOWN_WALK,
        EXTERNAL_SPAWN_FAILED,
        EXTERNAL_NOT_FOUND,
        EXTERNAL_REFUSED,
        SETTINGS_IO,
        INDEX_DATABASE,
        INDEX_FOLDER,
        WATCHER_UNAVAILABLE,
        UPDATER_FAILED,
        INTERNAL,
    ];
}

/// Error returned by every command and carried by the terminal message of every stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    /// Stable dotted code from [`codes`].
    pub code: String,
    /// Readable sentence for the interface.
    pub message: String,
    /// Raw output when there is some (git stderr, libgit2 reason, argv).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    /// An error with a code and a message and no detail.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            detail: None,
        }
    }

    /// Attaches raw detail.
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// `internal` with a message.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(codes::INTERNAL, message)
    }

    /// `op.timeout` for an operation that exceeded `timeout`.
    pub fn timeout(operation: &str, timeout: Duration) -> Self {
        Self::new(
            codes::OP_TIMEOUT,
            format!(
                "{operation} took longer than {} s and was stopped",
                timeout.as_secs_f64()
            ),
        )
    }

    /// `op.cancelled`.
    pub fn cancelled() -> Self {
        Self::new(codes::OP_CANCELLED, "The operation was cancelled")
    }

    /// `ipc.invalid_argument` naming the offending field.
    pub fn invalid_argument(field: &str, reason: impl Into<String>) -> Self {
        Self::new(
            codes::IPC_INVALID_ARGUMENT,
            format!("Invalid argument {field}"),
        )
        .with_detail(reason)
    }

    /// `op.unknown_walk`.
    pub fn unknown_walk(walk_id: &str) -> Self {
        Self::new(
            codes::OP_UNKNOWN_WALK,
            format!("Walk {walk_id} is not open any more"),
        )
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

impl std::error::Error for AppError {}

impl From<GitError> for AppError {
    fn from(error: GitError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
            detail: error.detail().map(str::to_owned),
        }
    }
}

impl From<repo_index::IndexError> for AppError {
    fn from(error: repo_index::IndexError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
            detail: None,
        }
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        Self::internal(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn every_engine_code_is_in_the_application_list() {
        for code in GitError::CODES {
            assert!(codes::ALL.contains(&code), "{code} missing from codes::ALL");
        }
    }

    #[test]
    fn engine_errors_map_to_their_code_message_and_detail() {
        let error = AppError::from(GitError::Cli {
            command: "status".to_owned(),
            status: Some(128),
            stderr: "fatal: not a git repository".to_owned(),
        });
        assert_eq!(error.code, codes::GIT_CLI_FAILED);
        assert!(error.message.contains("git status failed"));
        assert_eq!(error.detail.as_deref(), Some("fatal: not a git repository"));

        let error = AppError::from(GitError::NotFound(PathBuf::from("/tmp/x")));
        assert_eq!(error.code, codes::REPO_NOT_FOUND);
        assert!(error.message.contains("/tmp/x"));
        assert_eq!(error.detail, None);

        let error = AppError::from(GitError::CorruptObject {
            hash: "abc".to_owned(),
            reason: "zlib".to_owned(),
        });
        assert_eq!(error.code, codes::REPO_CORRUPT_OBJECT);
        assert_eq!(error.detail.as_deref(), Some("zlib"));
    }

    #[test]
    fn application_codes_have_constructors() {
        assert_eq!(AppError::cancelled().code, codes::OP_CANCELLED);
        assert_eq!(
            AppError::timeout("walk", Duration::from_secs(30)).code,
            codes::OP_TIMEOUT
        );
        assert_eq!(
            AppError::invalid_argument("path", "expected a string").code,
            codes::IPC_INVALID_ARGUMENT
        );
        assert_eq!(AppError::unknown_walk("w1").code, codes::OP_UNKNOWN_WALK);
        assert_eq!(AppError::internal("x").code, codes::INTERNAL);
    }

    #[test]
    fn serialises_without_detail_when_absent() {
        let json = serde_json::to_string(&AppError::cancelled()).expect("json");
        assert_eq!(
            json,
            r#"{"code":"op.cancelled","message":"The operation was cancelled"}"#
        );
        let json =
            serde_json::to_string(&AppError::internal("x").with_detail("raw")).expect("json");
        assert!(json.ends_with(r#""detail":"raw"}"#));
    }

    #[test]
    fn codes_are_unique_and_dotted() {
        let mut sorted = codes::ALL.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), codes::ALL.len());
        assert!(codes::ALL
            .iter()
            .all(|code| code.contains('.') || *code == "internal"));
    }
}
