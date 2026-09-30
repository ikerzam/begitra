//! Plain serializable domain types shared by the engine, the application and any future CLI.
//!
//! Every type here crosses the IPC boundary as JSON with camelCase fields, so names and shapes
//! are part of the contract that the IPC contract test checks against the TypeScript schemas.
//! Paths inside a repository (`path`, `old_path`) are repository-relative with `/` separators,
//! as git prints them; filesystem paths are [`PathBuf`]s.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// An opened repository.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    /// Root of the working tree that was opened (a linked worktree keeps its own root).
    pub root: PathBuf,
    /// The shared `.git` directory (the common dir for linked worktrees).
    pub common_dir: PathBuf,
    /// Checked-out branch name, or `None` when HEAD is detached.
    ///
    /// An unborn branch (a repository without commits) still reports its name.
    pub current_branch: Option<String>,
    /// Whether HEAD points at a commit rather than a branch.
    pub detached: bool,
    /// Whether this working tree is a linked worktree rather than the main one.
    pub is_linked_worktree: bool,
}

/// Kind of a ref.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefKind {
    /// `refs/heads/*`.
    LocalBranch,
    /// `refs/remotes/*`, excluding the symbolic `HEAD` of a remote.
    RemoteBranch,
    /// `refs/tags/*`; annotated tags are peeled to the commit.
    Tag,
    /// One entry of the stash reflog: `stash@{0}` is the newest.
    Stash,
    /// The repository `HEAD`.
    Head,
}

/// A ref and the commit it points at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    /// Short display name: `main`, `origin/main`, `v1.0`, `stash@{0}` or `HEAD`.
    pub name: String,
    /// Full name: `refs/heads/main`, `refs/remotes/origin/main`, `refs/tags/v1.0`, `refs/stash`
    /// or `HEAD`.
    pub full_name: String,
    /// What kind of ref this is.
    pub kind: RefKind,
    /// Hash of the commit the ref points at (annotated tags and stashes peeled to a commit).
    pub target: String,
    /// Whether HEAD of the opened working tree points at this ref.
    pub is_current: bool,
    /// Short name of the configured upstream (`origin/main`) for local branches that track one.
    pub upstream: Option<String>,
    /// Commits on the branch that are not on its upstream; `None` without an upstream.
    pub ahead: Option<u32>,
    /// Commits on the upstream that are not on the branch; `None` without an upstream.
    pub behind: Option<u32>,
    /// Working tree (main or linked) where a local branch is checked out.
    pub worktree: Option<PathBuf>,
    /// Stash message or annotated tag message, when there is one.
    pub message: Option<String>,
    /// Unix seconds of the committer time of the commit the ref points at, an annotated tag
    /// peeled to its commit, as `git log -1 --format=%ct <ref>` prints it; `None` for a tag of a
    /// tree or a blob.
    pub committed_at: Option<i64>,
}

/// Author or committer identity with its timestamp.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    /// Person name.
    pub name: String,
    /// E-mail address.
    pub email: String,
    /// Seconds since the Unix epoch, UTC.
    pub time: i64,
    /// Time zone offset in minutes east of UTC, as stored in the commit.
    pub offset_minutes: i32,
}

/// A line of the graph leading into a row from the row above.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    /// Lane the line leaves from on the row above.
    pub from_lane: u32,
    /// Lane the line arrives at on this row: the commit's own when it leads to the commit.
    pub to_lane: u32,
    /// Hash of the commit the line leads to.
    pub parent: String,
}

/// One commit of a walk page, with its lane layout.
///
/// Lanes are numbered from zero. Lanes at or beyond [`crate::graph::MAX_LANES`] are not drawn as
/// columns: their edges are omitted and counted in `overflow`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitNode {
    /// Full commit hash.
    pub hash: String,
    /// Parent hashes, first parent first.
    pub parents: Vec<String>,
    /// Author identity and date.
    pub author: Signature,
    /// Committer identity and date.
    pub committer: Signature,
    /// First paragraph of the message, as `git log --format=%s` prints it.
    pub subject: String,
    /// Rest of the message after the subject, without the separating blank line.
    pub body: String,
    /// Short names of the refs pointing at this commit (`main`, `origin/main`, `v1`, `HEAD`).
    pub refs: Vec<String>,
    /// Lane holding this commit's dot.
    pub lane: u32,
    /// Lines leading into this row from the row above, one per lane active there: the ones
    /// that lead to this commit end in its dot, the others go on (`parent` the commit each
    /// leads to).
    pub edges: Vec<Edge>,
    /// Lines into this row left out of `edges` because they touch lanes past the drawn
    /// columns.
    pub overflow: u32,
}

/// One page of a commit walk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// Commits in walk order.
    pub commits: Vec<CommitNode>,
    /// Whether the walk has no more commits after this page.
    pub done: bool,
}

/// Which commits a walk covers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum WalkScope {
    /// Every commit reachable from any ref (branches, remotes, tags, stashes and HEAD).
    All,
    /// Commits reachable from one ref or revision.
    Ref {
        /// Ref name or revision, resolved as `git rev-parse` would.
        name: String,
    },
    /// Commits reachable from `include` and not from `exclude`, as `exclude..include`.
    Range {
        /// Revision whose ancestors are left out.
        exclude: String,
        /// Revision whose ancestors are walked.
        include: String,
    },
}

/// Ordering of a commit walk.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WalkOrder {
    /// The order of `git log --date-order` (which is also what `--topo-order --date-order`
    /// selects): newest commit date first, and never a parent before all of its children have
    /// been shown. Needs the whole history read before the first page can be produced.
    #[default]
    DateTopo,
    /// Newest commit date first, emitted as soon as a commit is discovered, so the first page
    /// does not wait for the whole history. Identical to [`WalkOrder::DateTopo`] whenever every
    /// parent is older than its children; with skewed dates a parent can appear before a child.
    Lazy,
}

/// Options of a commit walk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkOptions {
    /// Commits per page, clamped to `1..=500`.
    pub page_size: u32,
    /// Ordering; see [`WalkOrder`].
    pub order: WalkOrder,
    /// Which commits to keep; `None` keeps every commit of the scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<WalkFilter>,
}

impl Default for WalkOptions {
    fn default() -> Self {
        Self {
            page_size: 500,
            order: WalkOrder::default(),
            filter: None,
        }
    }
}

/// Most commits a count walks before it stops and reports the cap.
pub const COUNT_CAP: u32 = 100_000;

/// How many commits a scope holds, or at least [`COUNT_CAP`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCount {
    /// Commits counted, at most [`COUNT_CAP`].
    pub count: u32,
    /// Whether the count stopped at the cap.
    pub capped: bool,
}

/// What a new worktree checks out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum WorktreeBranch {
    /// A branch created for the worktree from `start` (`git worktree add -b`).
    New {
        /// Name of the branch to create.
        name: String,
        /// The revision the branch starts at.
        start: String,
    },
    /// An existing local branch that no worktree has checked out.
    Existing {
        /// Name of the branch.
        name: String,
    },
    /// A detached checkout of a revision (`git worktree add --detach`).
    Detached {
        /// The revision to check out.
        rev: String,
    },
}

/// A request to add a worktree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAdd {
    /// Absolute path of the folder to create; it must not exist yet.
    pub path: PathBuf,
    /// What the worktree checks out.
    pub branch: WorktreeBranch,
}

/// One page of a change set computed lazily: the files of the page, the running totals over
/// the pages so far (the whole change set's once `done`), and the number of files the change
/// set holds, known before the first page.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSetPage {
    /// Files of this page, in change set order.
    pub files: Vec<FileChange>,
    /// Added lines over the pages so far.
    pub additions: u32,
    /// Removed lines over the pages so far.
    pub deletions: u32,
    /// Files in the whole change set (an upper bound while a working tree or whitespace diff
    /// may still drop unchanged files).
    pub total_files: u32,
    /// Whether the change set has no more files after this page.
    pub done: bool,
}

/// One endpoint of a comparison: the revision as the caller named it and the commit it
/// resolved to (tags peeled).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    /// The revision as given.
    pub rev: String,
    /// Full hash of the commit it names.
    pub hash: String,
}

/// The merge base of a comparison.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseCommit {
    /// Full hash of the base.
    pub hash: String,
    /// Committer time of the base, unix seconds.
    pub time: i64,
}

/// How two endpoints relate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComparisonRelation {
    /// Both name the same commit.
    Same,
    /// `a` is an ancestor of `b`: merging `b` into `a` moves the pointer.
    FastForward,
    /// `b` is an ancestor of `a`: `a` already holds everything `b` has.
    UpToDate,
    /// Each side has commits of its own since the base.
    Diverged,
}

/// Two revisions side by side: their base, what each has that the other lacks, and how they
/// relate (`git merge-base` and `git rev-list --left-right --count a...b`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    /// The first endpoint (the side a merge would land on).
    pub a: Endpoint,
    /// The second endpoint (the side a merge would bring in).
    pub b: Endpoint,
    /// The merge base.
    pub base: BaseCommit,
    /// Commits reachable from `a` and not from `b`.
    pub only_in_a: u32,
    /// Commits reachable from `b` and not from `a`.
    pub only_in_b: u32,
    /// How the endpoints relate.
    pub relation: ComparisonRelation,
}

/// What merging `b` into `a` would do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MergePreviewKind {
    /// `a` would move to `b` without a merge commit.
    FastForward,
    /// `b` is already part of `a`; nothing to merge.
    UpToDate,
    /// The merge would complete without conflicts.
    Clean,
    /// The merge would stop on the listed files.
    Conflicts,
}

/// The verdict of a merge preview; nothing in the repository the user can see changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// The verdict.
    pub kind: MergePreviewKind,
    /// Repository-relative paths that would conflict, sorted and unique; empty otherwise.
    pub conflicts: Vec<String>,
}

/// Which commits a walk keeps. Every field is optional and they compose with AND; a walk with
/// any field set produces a flat layout (lane 0, no edges), since lines between non-adjacent
/// commits would not be parent edges.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkFilter {
    /// Case-insensitive text found in the subject, the body, the author's name or email, or a
    /// prefix of the hash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Case-insensitive text found in the author's name or email.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Committer time at or after this unix time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
    /// Committer time at or before this unix time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    /// Repository-relative paths (files or directories) the commit must touch; the history is
    /// produced by `git rev-list -- <paths>`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

impl WalkFilter {
    /// Whether any field is set.
    pub fn is_active(&self) -> bool {
        self.text.as_deref().is_some_and(|t| !t.trim().is_empty())
            || self.author.as_deref().is_some_and(|a| !a.trim().is_empty())
            || self.since.is_some()
            || self.until.is_some()
            || !self.paths.is_empty()
    }
}

/// How a path changed, in status and diffs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    /// New path.
    Added,
    /// Content changed.
    Modified,
    /// Path removed.
    Deleted,
    /// Moved from `old_path`; content may also have changed.
    Renamed,
    /// Copied from `old_path`.
    Copied,
    /// File type changed (regular file, symlink, submodule).
    TypeChanged,
    /// Conflicted path of an in-progress merge.
    Unmerged,
}

/// Status of one path of the working tree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    /// Repository-relative path.
    pub path: String,
    /// Previous path of a rename.
    pub old_path: Option<String>,
    /// Change between HEAD and the index, if any.
    pub staged: Option<ChangeKind>,
    /// Change between the index and the working tree, if any.
    pub unstaged: Option<ChangeKind>,
    /// Path is not tracked and not ignored.
    pub untracked: bool,
    /// Path is ignored; only reported when ignored paths are requested.
    pub ignored: bool,
    /// Path has merge conflicts.
    pub conflicted: bool,
}

/// Options of a status scan.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOptions {
    /// Report ignored paths too.
    pub include_ignored: bool,
    /// Report untracked paths (default) or leave them out.
    pub include_untracked: bool,
    /// Detect renames between HEAD, the index and the working tree.
    pub renames: bool,
}

impl Default for StatusOptions {
    fn default() -> Self {
        Self {
            include_ignored: false,
            include_untracked: true,
            renames: true,
        }
    }
}

/// What to compare in a diff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DiffTarget {
    /// One commit against its first parent (the empty tree for a root commit).
    Commit {
        /// Commit hash or revision.
        hash: String,
    },
    /// The tree of `to` against the tree of `from`, like `git diff from to`.
    Commits {
        /// Base revision.
        from: String,
        /// Compared revision.
        to: String,
    },
    /// A range: `from..to` compares the two trees, `from...to` compares `to` with the merge
    /// base of both, like `git diff from...to`.
    Range {
        /// Base revision.
        from: String,
        /// Compared revision.
        to: String,
        /// Use three-dot semantics.
        three_dot: bool,
    },
    /// The working tree against HEAD (`git diff HEAD`) or against the index (`git diff`).
    WorkingTree {
        /// What the working tree is compared with.
        base: WorkingTreeBase,
    },
    /// The index against HEAD (`git diff --cached`).
    Index,
}

/// Base of a working tree diff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkingTreeBase {
    /// Compare with the HEAD commit.
    Head,
    /// Compare with the index; untracked files (outside `.gitignore`) count as added.
    Index,
    /// Compare with any revision, like `git diff <rev>`.
    Revision {
        /// Revision the working tree is compared with.
        rev: String,
    },
}

/// Where a file is read from for [`crate::engine::GitEngine::read_blob`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum BlobAt {
    /// The file as checked out in the working tree.
    WorkingTree,
    /// The file at a revision.
    Revision {
        /// Revision holding the file.
        rev: String,
    },
    /// The file as staged: the index entry at stage 0, which a conflicted path lacks.
    Index,
    /// The file at the merge base of two revisions: the old side of `a...b`.
    MergeBase {
        /// One end of the three-dot range.
        a: String,
        /// The other end.
        b: String,
    },
}

/// One file read whole: text (lossy UTF-8) or bytes (base64) by libgit2's binary heuristic.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobContent {
    /// Size in bytes.
    pub size: u64,
    /// A NUL in the first 8,000 bytes.
    pub is_binary: bool,
    /// The text of a text file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The bytes of a binary file, base64.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<String>,
}

/// Options of a diff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    /// Detect renames and copies.
    pub renames: bool,
    /// Similarity threshold for renames, in percent.
    pub similarity: u8,
    /// Context lines around each change.
    pub context: u32,
    /// Compute intra-line change spans for paired removed and added lines.
    pub intra_line: bool,
    /// Ignore every whitespace change, like `git diff -w`.
    #[serde(default)]
    pub ignore_whitespace: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            renames: true,
            similarity: 50,
            context: 3,
            intra_line: true,
            ignore_whitespace: false,
        }
    }
}

/// Result of a diff: every changed file with its hunks and flags.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    /// Changed files, in the order git lists them.
    pub files: Vec<FileChange>,
    /// Added lines over every file.
    pub additions: u32,
    /// Removed lines over every file.
    pub deletions: u32,
}

/// One changed file of a diff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// How the file changed.
    pub status: ChangeKind,
    /// Path on the compared side (the new path of a rename).
    pub path: String,
    /// Previous path of a rename or copy.
    pub old_path: Option<String>,
    /// Id of the old side's blob, hex; `None` when the file has no old side.
    pub old_id: Option<String>,
    /// Id of the new side, hex; `None` when the file has no new side. A working tree's side
    /// is git's id of what the patch read (the blob `git add` would write, the commit checked
    /// out in a submodule), or the index's for a staged file clean on disk; a side the patch
    /// does not read (binary by attribute, over libgit2's 512 MiB, a type change, a conflict,
    /// a folder) is hashed from its bytes on disk up to 64 MiB and named
    /// `stat:<size>:<modified ns>` above it or for a folder; `None` when the file could not be
    /// read (changed while it was read, locked). It identifies the content a review mark was
    /// given for.
    pub new_id: Option<String>,
    /// Similarity of a rename or copy, in percent.
    pub similarity: Option<u8>,
    /// Added lines.
    pub additions: u32,
    /// Removed lines.
    pub deletions: u32,
    /// Hunks; empty for binary files.
    pub hunks: Vec<Hunk>,
    /// Either side is binary.
    pub is_binary: bool,
    /// Over 5,000 changed lines or 1 MB on either side.
    pub is_large: bool,
    /// Marked `linguist-generated` in `.gitattributes`, or a lockfile or minified file.
    pub is_generated: bool,
    /// A test file by path convention.
    pub is_test: bool,
    /// A line of the file holds bytes that are not UTF-8: the text shows replacement
    /// characters, and only the whole file can be staged, unstaged or discarded.
    pub is_lossy: bool,
}

/// A hunk of a text diff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// First line of the hunk on the old side, 1-based.
    pub old_start: u32,
    /// Number of old-side lines in the hunk.
    pub old_lines: u32,
    /// First line of the hunk on the new side, 1-based.
    pub new_start: u32,
    /// Number of new-side lines in the hunk.
    pub new_lines: u32,
    /// The `@@ ... @@` header, including the function context git found.
    pub header: String,
    /// Lines of the hunk, in order.
    pub lines: Vec<DiffLine>,
}

/// Kind of a diff line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LineKind {
    /// Present on both sides.
    Context,
    /// Present on the new side only.
    Added,
    /// Present on the old side only.
    Removed,
}

/// A byte range of a line that changed, for intra-line emphasis.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    /// Byte offset of the first changed byte.
    pub start: u32,
    /// Byte offset just past the last changed byte.
    pub end: u32,
}

/// One line of a hunk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// Context, added or removed.
    pub kind: LineKind,
    /// Line number on the old side; `None` for added lines.
    pub old_number: Option<u32>,
    /// Line number on the new side; `None` for removed lines.
    pub new_number: Option<u32>,
    /// Line content without the trailing newline.
    pub text: String,
    /// Changed byte ranges within the line, when the line is half of a modified pair.
    pub spans: Vec<Span>,
    /// The line has no newline at end of file.
    pub no_newline: bool,
}

/// The git executable the CLI runs, as found by detection or confirmed by a probe.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDetection {
    /// The executable: an absolute path, or `git` when PATH resolves it.
    pub path: PathBuf,
    /// The first line of `git --version`, e.g. `git version 2.54.0.windows.1`.
    pub version: String,
}

/// A working tree of the repository, main or linked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Path of the working tree.
    pub path: PathBuf,
    /// Name git gave the linked worktree; `None` for the main one.
    pub name: Option<String>,
    /// Hash of the checked-out commit; `None` when the branch is unborn.
    pub head: Option<String>,
    /// Checked-out branch; `None` when detached.
    pub branch: Option<String>,
    /// Whether HEAD is detached.
    pub detached: bool,
    /// Whether this is the main working tree.
    pub is_main: bool,
    /// Whether the worktree is locked.
    pub locked: bool,
    /// Lock reason, when one was given.
    pub lock_reason: Option<String>,
    /// Whether `git worktree prune` would remove it (its folder is missing).
    pub prunable: bool,
}

/// What a selection of changed lines is applied to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SelectionTarget {
    /// Apply the selected lines of an unstaged diff to the index (`git apply --cached`).
    Stage,
    /// Take the selected lines of a staged diff out of the index (`git apply --cached -R`).
    Unstage,
    /// Undo the selected lines of an unstaged diff in the working tree (`git apply -R`).
    Discard,
}

/// One line of a hunk as the viewer holds it, with the selection flag on changed lines.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedLine {
    /// Context, added or removed.
    pub kind: LineKind,
    /// Line content without the trailing newline.
    pub text: String,
    /// The line has no newline at end of file.
    pub no_newline: bool,
    /// Whether an added or removed line is part of the selection; ignored on context lines.
    pub selected: bool,
}

/// One hunk of a selection: the ranges the diff reported and every line of the hunk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedHunk {
    /// First line of the hunk on the old side, 1-based (0 for an added file).
    pub old_start: u32,
    /// Number of old-side lines in the hunk as diffed.
    pub old_lines: u32,
    /// First line of the hunk on the new side, 1-based (0 for a deleted file).
    pub new_start: u32,
    /// Number of new-side lines in the hunk as diffed.
    pub new_lines: u32,
    /// Lines of the hunk, in order.
    pub lines: Vec<SelectedLine>,
}

/// A selection of hunks and lines of one file, to stage, unstage or discard.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSelection {
    /// Path on the new side of the diff the selection was taken from.
    pub path: String,
    /// How the file changed in that diff; an added or deleted file selected whole is
    /// created or deleted, a partial selection edits the file in place.
    pub status: ChangeKind,
    /// The file's `is_lossy`: its text is not its bytes, so a partial selection is refused.
    pub lossy: bool,
    /// The hunks, in the diff's order; a hunk without a selected line is left out.
    pub hunks: Vec<SelectedHunk>,
}

/// A commit request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    /// The whole message: the subject, a blank line, the body.
    pub message: String,
    /// Replace the last commit (`--amend`).
    pub amend: bool,
    /// Add a `Signed-off-by` trailer (`--signoff`).
    pub signoff: bool,
}

/// What the commit box needs before a commit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitContext {
    /// `Name <email>` git will record as the author.
    pub author: String,
    /// The text of the `commit.template` file, when one is configured and readable.
    pub template: Option<String>,
    /// The full message of HEAD, for an amend; `None` on an unborn branch.
    pub head_message: Option<String>,
    /// HEAD names no commit yet.
    pub unborn: bool,
    /// The operation the commit would conclude (a merge, a cherry-pick, a revert); `none`
    /// otherwise.
    pub operation: OperationState,
    /// The message git prepared for that operation (`MERGE_MSG`, `SQUASH_MSG`), when any.
    pub prepared_message: Option<String>,
}

/// What `switch` checks out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum SwitchTarget {
    /// A local branch, by name.
    Branch {
        /// Branch name.
        name: String,
    },
    /// A detached HEAD at a revision.
    Detached {
        /// The revision.
        rev: String,
    },
}

/// How a merge may complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MergeMode {
    /// A fast-forward when possible, a merge commit otherwise (git's default).
    Default,
    /// Only a fast-forward; refused otherwise (`--ff-only`).
    FfOnly,
    /// Always a merge commit (`--no-ff`).
    NoFf,
}

/// What a reset moves besides HEAD.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResetMode {
    /// HEAD only; the index and the working tree keep the changes (`--soft`).
    Soft,
    /// HEAD and the index; the working tree keeps the changes (`--mixed`).
    Mixed,
    /// HEAD, the index and the working tree (`--hard`).
    Hard,
}

/// How an operation that may stop on conflicts ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutcomeKind {
    /// HEAD moved forward without a new commit.
    FastForward,
    /// A merge commit was made.
    Merged,
    /// The operation completed (a rebase, a pick, a revert, a stash apply, a sequencer step).
    Done,
    /// Nothing to do.
    UpToDate,
    /// The operation stopped on conflicts and stays in progress.
    Conflicts,
}

/// The kind of a conflicted path, from the `u` record of `git status --porcelain=v2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictKind {
    /// `UU`: both sides modified.
    BothModified,
    /// `AA`: both sides added.
    BothAdded,
    /// `DD`: both sides deleted.
    BothDeleted,
    /// `DU`: deleted by us, modified by them.
    DeletedByUs,
    /// `UD`: modified by us, deleted by them.
    DeletedByThem,
    /// `AU`: added by us.
    AddedByUs,
    /// `UA`: added by them.
    AddedByThem,
}

/// A conflicted path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    /// Repository-relative path.
    pub path: String,
    /// What each side did.
    pub kind: ConflictKind,
}

/// The result of an operation that may stop on conflicts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// How it ended.
    pub kind: OutcomeKind,
    /// HEAD after the operation, when it moved.
    pub hash: Option<String>,
    /// The conflicted paths when it stopped on conflicts.
    pub conflicts: Vec<Conflict>,
}

/// The operation a repository is in the middle of.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OperationState {
    /// Nothing in progress.
    #[default]
    None,
    /// A merge stopped on conflicts (`MERGE_HEAD`).
    Merge,
    /// A rebase in progress.
    Rebase,
    /// A cherry-pick in progress.
    CherryPick,
    /// A revert in progress.
    Revert,
}

/// What to do with the operation in progress.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SequencerAction {
    /// Go on once the conflicts are resolved.
    Continue,
    /// Drop the current commit and go on (rebase, cherry-pick, revert).
    Skip,
    /// Abandon the operation and return to the state before it.
    Abort,
}

/// A remote with its URLs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    /// Remote name.
    pub name: String,
    /// URL fetched from.
    pub fetch_url: String,
    /// URL pushed to (the fetch URL unless configured apart).
    pub push_url: String,
    /// Unix seconds of the last fetch that wrote `FETCH_HEAD` naming this remote's URL;
    /// `None` when the file is missing or names other remotes only (git keeps no other record).
    #[serde(default)]
    pub fetched_at: Option<i64>,
}

/// Whether a fetch, pull or push may ask the user to sign in. git itself never asks on a
/// terminal ([`crate::cli::WRITE_ENV`]); this is about the windows of credential helpers and
/// askpass programs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Prompts {
    /// Git Credential Manager's window and the user's askpass programs may ask, as they do
    /// for the user's own git.
    #[default]
    Allowed,
    /// Nothing asks: a remote that needs a sign-in fails with git's words, so an operation
    /// over many repositories never opens a window for each ([`crate::cli::NO_PROMPT_ENV`]).
    Never,
}

/// A pull request: `git pull [--rebase | --ff-only] [remote [branch]]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    /// Remote to pull from; the branch's upstream remote when `None`.
    pub remote: Option<String>,
    /// Remote branch to pull; the upstream branch when `None`.
    pub branch: Option<String>,
    /// Rebase the local commits on top instead of merging.
    pub rebase: bool,
    /// Move the branch only as a fast-forward (`git merge --ff-only`), whatever `pull.ff`
    /// and `merge.ff` say: a bulk pull never makes a merge commit. Refused with `rebase`.
    #[serde(default)]
    pub ff_only: bool,
}

/// A push request: `git push [--delete] [--set-upstream] [--force-with-lease] [remote [ref]]`,
/// the ref named in full; a branch or a tag needs a remote.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    /// Remote to push to; the upstream remote when `None`.
    pub remote: Option<String>,
    /// Local branch to push (the current branch when `None`), or the branch to delete on the
    /// remote with `delete`.
    pub branch: Option<String>,
    /// A tag to push alone (`refs/tags/<tag>`), in place of a branch.
    #[serde(default)]
    pub tag: Option<String>,
    /// Delete the branch or the tag on the remote (`--delete`, by its full ref name); a branch's
    /// delete always carries a lease on its remote-tracking ref.
    #[serde(default)]
    pub delete: bool,
    /// Record the remote branch as the upstream (`-u`); a branch's push only.
    pub set_upstream: bool,
    /// Overwrite the remote branch only if it is where the tracking ref says
    /// (`--force-with-lease`); a branch's push only.
    pub force_with_lease: bool,
}

/// What a fetch or a push reported: the ref lines git printed, one per updated ref.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkResult {
    /// git's summary lines (`   a1b2c3d..e4f5a6b  main -> main`, `* [new branch] …`).
    pub summary: Vec<String>,
}

/// A stash push request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashPush {
    /// The stash message; git's default ("WIP on <branch>: …") when `None`.
    pub message: Option<String>,
    /// Stash untracked files too (`--include-untracked`).
    pub include_untracked: bool,
    /// Stash these paths only; everything when empty.
    pub paths: Vec<String>,
}
