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

/// A branch's upstream as its configuration names it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    /// The tracking ref's short name (`origin/main`).
    pub name: String,
    /// The remote a pull fetches from and a push sends to (`.` for a local upstream).
    pub remote: String,
    /// The upstream's branch on that remote.
    pub branch: String,
    /// The remote `git push` sends the branch to (a push remote or `remote.pushDefault`, else
    /// the upstream's remote).
    pub push_remote: String,
}

/// The operation a working tree is in the middle of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Operation {
    /// Nothing in progress.
    None,
    /// A merge stopped on conflicts.
    Merge,
    /// A rebase.
    Rebase,
    /// A cherry-pick.
    CherryPick,
    /// A revert.
    Revert,
}

/// The state of a repository as `git-core` describes it for the index.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    /// Current branch, `None` when HEAD is detached or unborn.
    pub current_branch: Option<String>,
    /// Whether HEAD is detached.
    pub detached: bool,
    /// The branch's upstream; `None` without one.
    pub upstream: Option<Upstream>,
    /// Commits ahead of the upstream, `None` without an upstream.
    pub ahead: Option<u32>,
    /// Commits behind the upstream, `None` without an upstream.
    pub behind: Option<u32>,
    /// The operation in progress; `None` until a summary has read it (an entry an older
    /// version stored).
    pub operation: Option<Operation>,
    /// When the working tree last fetched, unix seconds; `None` before any fetch or until a
    /// summary has read it.
    pub fetched_at: Option<i64>,
    /// Committer time of the tip, unix seconds.
    pub last_commit_at: Option<i64>,
    /// The tip's subject; `None` when unborn or until a summary has read it.
    pub last_commit_subject: Option<String>,
    /// Whether the working tree has changes; `None` when status did not finish in time.
    pub dirty: Option<bool>,
}

/// How a project holds its members.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectKind {
    /// The repositories and worktrees the scans find under its folder, then any added by hand.
    Folder,
    /// The repositories and worktrees added to it, in the order given.
    List,
}

/// How a member joined its project.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemberOrigin {
    /// Found by a scan of the project's folder; the scans keep it.
    Folder,
    /// Added by hand; only an edit of the project removes it.
    Hand,
}

/// One repository or worktree of a project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// Working tree root; it need not have an index entry.
    pub path: PathBuf,
    /// Found by the scan of the project's folder or added by hand.
    pub origin: MemberOrigin,
}

/// A named group of repositories and worktrees: the unit the app opens. Every index entry
/// belongs to at least one project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Stable id.
    pub id: i64,
    /// Its name: the folder's for a folder project until renamed.
    pub name: String,
    /// A folder project or a list project.
    pub kind: ProjectKind,
    /// A folder project's folder; `None` for a list project.
    pub folder: Option<PathBuf>,
    /// The folder's own members in path order, then the ones added by hand in their order.
    pub members: Vec<Member>,
    /// Pinned to the top of Home.
    pub pinned: bool,
    /// Last time it was opened, unix seconds.
    pub opened_at: Option<i64>,
    /// The repository it showed last.
    pub last_repository: Option<PathBuf>,
    /// Creation time, unix seconds.
    pub created_at: i64,
    /// Time of the last rename or change of members by hand, unix seconds.
    pub updated_at: i64,
}

/// A project after an edit, with the repositories and worktrees the edit took out of the
/// index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEdit {
    /// The project as stored.
    pub project: Project,
    /// Paths that belong to no project any more: they left the index with their notes.
    pub removed: Vec<PathBuf>,
}

/// What the end of a complete scan of a folder changed in its folder project.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderScanEnd {
    /// The folder's own members the scan did not find and whose `.git` is gone: they left
    /// the folder project, and those another project holds are flagged missing.
    pub left: Vec<PathBuf>,
    /// Of those, the ones no other project holds: they left the index, their notes kept.
    pub removed: Vec<PathBuf>,
    /// The folder's own members, all read as gone by a scan that found none of them (an
    /// unmounted drive reads as an empty folder): kept, flagged missing.
    pub held: Vec<PathBuf>,
}

/// What [`crate::Index::upsert_found`] did.
#[must_use]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Upserted {
    /// The entry is stored and belongs to a project.
    Stored,
    /// Found under a folder that has no project (removed while the scan ran): nothing stored.
    NoFolderProject,
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
    /// The folder whose scan found it last, which may belong to no project any more; `None`
    /// when only opened by path. Membership is the projects', never this field's.
    pub scan_root: Option<PathBuf>,
    /// The last summary.
    pub summary: RepoSummary,
    /// The pin an index of version 4 held, read only: pins belong to projects.
    pub pinned: bool,
    /// Last time it was opened, unix seconds.
    pub last_opened_at: Option<i64>,
    /// Last time the summary was refreshed, unix seconds.
    pub refreshed_at: Option<i64>,
    /// The folder was not found the last time it was looked for.
    pub missing: bool,
}
