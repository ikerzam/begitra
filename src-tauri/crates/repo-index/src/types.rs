//! Plain data of the scanner and the index, serialisable for the application boundary.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// What an annotation records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnnotationKind {
    /// The file (or the hunk) was marked reviewed; the value is `1`.
    Reviewed,
    /// A note on the file; the value is its text.
    Note,
}

impl AnnotationKind {
    /// The column value.
    pub fn as_str(self) -> &'static str {
        match self {
            AnnotationKind::Reviewed => "reviewed",
            AnnotationKind::Note => "note",
        }
    }

    /// Parses the column value.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "reviewed" => Some(AnnotationKind::Reviewed),
            "note" => Some(AnnotationKind::Note),
            _ => None,
        }
    }
}

/// One mark or note of a review target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    /// Repository-relative path of the file.
    pub path: String,
    /// The hunk's key, or empty for the whole file.
    pub hunk: String,
    /// A mark or a note.
    pub kind: AnnotationKind,
    /// `1` for a mark, the text of a note.
    pub value: String,
    /// Unix time of the last write.
    pub updated_at: i64,
}

/// What one annotation is keyed by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnnotationKey<'a> {
    /// Working tree root of the repository.
    pub repo: &'a std::path::Path,
    /// Stable key of the review target.
    pub target: &'a str,
    /// Repository-relative path of the file.
    pub path: &'a str,
    /// The hunk's key, or empty for the whole file.
    pub hunk: &'a str,
    /// A mark or a note.
    pub kind: AnnotationKind,
}

/// What a found `.git` entry is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepoKind {
    /// A repository with its own `.git` directory (or a `.git` file pointing elsewhere).
    Main,
    /// A linked worktree: a `.git` file pointing inside another repository's `.git/worktrees`.
    Worktree,
}

/// A repository or worktree found by the scanner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Working tree root.
    pub path: PathBuf,
    /// Folder name, shown as the repository name.
    pub name: String,
    /// Main repository or linked worktree.
    pub kind: RepoKind,
    /// For a worktree, the working tree root of the repository that owns it.
    pub parent_path: Option<PathBuf>,
    /// The scan folder it was found under.
    pub scan_root: PathBuf,
}

/// Options of a scan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    /// Folder names never entered (compared case-insensitively).
    pub skip: Vec<String>,
    /// Depth below a scan folder at which the walk stops (the folder itself is depth 0).
    pub max_depth: u32,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            skip: DEFAULT_SKIP.iter().map(|s| (*s).to_owned()).collect(),
            max_depth: 2,
        }
    }
}

/// Folder names skipped by default: build outputs, caches, tool folders.
pub const DEFAULT_SKIP: [&str; 17] = [
    "node_modules",
    ".cache",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".turbo",
    ".yarn",
    ".pnpm-store",
    ".gradle",
    ".idea",
    ".vscode",
];

/// One event of a running scan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ScanEvent {
    /// A scan folder started.
    FolderStarted {
        /// The folder.
        folder: PathBuf,
    },
    /// Running counts, sent every few directories.
    Progress {
        /// The folder being walked.
        folder: PathBuf,
        /// Directories read so far, over every folder.
        scanned: u64,
        /// Repositories and worktrees found so far.
        found: u64,
    },
    /// A repository or worktree.
    Found(Found),
    /// A scan folder finished.
    FolderDone {
        /// The folder.
        folder: PathBuf,
        /// Repositories and worktrees found under it.
        found: u64,
    },
    /// A scan folder could not be read at all; the scan goes on with the others.
    FolderError {
        /// The folder.
        folder: PathBuf,
        /// The operating system's reason.
        reason: String,
    },
}

/// The state of a repository as `git-core` describes it for the index.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    /// Current branch, `None` when HEAD is detached or unborn.
    pub current_branch: Option<String>,
    /// Whether HEAD is detached.
    pub detached: bool,
    /// Commits ahead of the upstream, `None` without an upstream.
    pub ahead: Option<u32>,
    /// Commits behind the upstream, `None` without an upstream.
    pub behind: Option<u32>,
    /// Committer time of the tip, unix seconds.
    pub last_commit_at: Option<i64>,
    /// Whether the working tree has changes; `None` when status did not finish in time.
    pub dirty: Option<bool>,
}

/// One row of the index, as the home screen lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    /// Working tree root.
    pub path: PathBuf,
    /// Repository name (the folder name).
    pub name: String,
    /// Main repository or linked worktree.
    pub kind: RepoKind,
    /// For a worktree, the root of the repository that owns it.
    pub parent_path: Option<PathBuf>,
    /// The scan folder it was found under; `None` when opened by path.
    pub scan_root: Option<PathBuf>,
    /// The last summary.
    pub summary: RepoSummary,
    /// Pinned to the top of the list.
    pub pinned: bool,
    /// Last time it was opened, unix seconds.
    pub last_opened_at: Option<i64>,
    /// Last time the summary was refreshed, unix seconds.
    pub refreshed_at: Option<i64>,
    /// The folder was not found the last time it was looked for.
    pub missing: bool,
}
