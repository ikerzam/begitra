//! Diffs with renames, hunks, intra-line spans, flags and the ids of both blobs.
//!
//! libgit2 builds the delta list and the patches; this module maps them to [`ChangeSet`] and
//! adds the intra-line spans and the flags. Known differences from the git CLI:
//!
//! - files are ordered by their new path, where `git diff --name-status` lists a rename;
//!   libgit2 sorts a renamed delta by its old path;
//! - the similarity of a rename or copy is libgit2's line-signature score, read from the file
//!   header libgit2 prints for the patch (the binding does not expose the delta field); git's
//!   byte-based score differs by a few points (90 against 89, 66 against 80 in the tests), so a
//!   rename close to the threshold can be judged differently;
//! - copies are not detected, like `git diff -M` without `-C`: detecting them makes every
//!   modified file a candidate source, which cost more than the whole rest of a large diff;
//! - working tree diffs drop files that only differ by line endings under `text=auto` (git
//!   compares the filtered content; libgit2 reports a modified delta without hunks);
//! - `linguist-generated` is read from the index and the working copy (`.gitattributes` as
//!   checked out), not from the compared commit, and only when some attributes file of the
//!   repository names the attribute at all (each lookup costs a stat per directory level);
//! - an unborn HEAD counts as the empty tree, where `git diff HEAD` fails.

use std::path::Path;

use git2::{
    AttrCheckFlags, AttrValue, Commit, Delta, Diff, DiffDelta, DiffFindOptions, DiffHunk,
    DiffLine as Git2DiffLine, DiffLineType, DiffOptions as Git2DiffOptions, ErrorClass, ErrorCode,
    FileMode, IndexEntryExtendedFlag, ObjectType, Oid, Patch, Repository, Tree,
};

use crate::diff::{hunk_header, line_text, mark_intra_line_spans, parse_similarity};
use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::flags;
use crate::types::{
    ChangeKind, DiffLine, DiffOptions, DiffTarget, FileChange, Hunk, LineKind, WorkingTreeBase,
};

/// A diff ready to be read page by page: the delta list with renames found, the order the
/// files are listed in, and what every page needs to know about the target.
pub(super) struct Prepared<'r> {
    diff: Diff<'r>,
    /// Delta indices in listing order (by the path a file is listed under).
    order: Vec<usize>,
    /// Whether the new side's blobs live in the object store (not for the working tree).
    probe_new_side: bool,
    working_tree: bool,
    /// Whether the old side is the index (the working tree against it).
    against_index: bool,
    /// The index, for the flags git honours and libgit2 does not (working tree and staged
    /// diffs only).
    index_file: Option<git2::Index>,
    /// Whether any attributes file names `linguist-generated`; without one no lookup runs.
    generated_attributes: bool,
}

impl Prepared<'_> {
    /// Files the change set lists (an upper bound for working tree and whitespace diffs).
    pub(super) fn total_files(&self) -> usize {
        self.order.len()
    }
}

/// Builds the delta list of `target` and finds its renames, without reading any patch.
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn prepare<'r>(
    repo: &'r Repository,
    target: &DiffTarget,
    options: &DiffOptions,
    generated_attributes: bool,
) -> GitResult<Prepared<'r>> {
    // Working tree files are not objects, so their ids never resolve in the object store.
    let probe_new_side = !matches!(target, DiffTarget::WorkingTree { .. });
    let working_tree = matches!(target, DiffTarget::WorkingTree { .. });
    let against_index = matches!(
        target,
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index
        }
    );
    let mut diff = build_diff(repo, target, options)?;
    if options.renames {
        let threshold = u16::from(options.similarity.min(100));
        let mut find = DiffFindOptions::new();
        // libgit2 would ignore whitespace in the similarity score; git does not, so a
        // reindented file is an add and a delete for both. Copies are off, as for `-M`.
        find.renames(true)
            .copies(false)
            .rename_threshold(threshold)
            .dont_ignore_whitespace(true);
        let found = diff.find_similar(Some(&mut find));
        found.map_err(|error| blob_error(repo, diff.deltas(), probe_new_side, error))?;
    }
    // Files are listed by the path they are shown under, like `git diff --name-status`;
    // libgit2 sorts a renamed delta by its old path.
    // The paths borrow from the diff, so the order costs one lookup per delta and no copy.
    let listed_paths: Vec<&[u8]> = (0..diff.deltas().len())
        .map(|index| {
            diff.get_delta(index)
                .and_then(|delta| {
                    delta
                        .new_file()
                        .path_bytes()
                        .or_else(|| delta.old_file().path_bytes())
                })
                .unwrap_or_default()
        })
        .collect();
    let mut order: Vec<usize> = (0..listed_paths.len()).collect();
    order.sort_by(|&left, &right| listed_paths.get(left).cmp(&listed_paths.get(right)));
    // The index flags git honours and libgit2 does not: a sparse checkout's absent files
    // (`skip-worktree`) are not deletions, and `git add -N` stages nothing.
    let index_file = if working_tree || matches!(target, DiffTarget::Index) {
        Some(repo.index()?)
    } else {
        None
    };
    Ok(Prepared {
        diff,
        order,
        probe_new_side,
        working_tree,
        against_index,
        index_file,
        generated_attributes,
    })
}

/// Whether any attributes file git would consult names `linguist-generated`: the
/// `.gitattributes` files in the index, `$GIT_DIR/info/attributes`, and the file named by
/// `core.attributesfile`. Most repositories name it nowhere, and each per-path lookup costs
/// a stat per directory level.
pub(super) fn generated_attributes_present(repo: &Repository) -> bool {
    const NAME: &[u8] = b"linguist-generated";
    let mentions = |bytes: &[u8]| bytes.windows(NAME.len()).any(|window| window == NAME);
    // The handle's index is the copy loaded on first use; `read` reloads it when the file
    // changed since (a `.gitattributes` staged after the repository was opened).
    if let Ok(mut index) = repo.index() {
        let _ = index.read(false);
        for entry in index.iter() {
            let is_attributes = entry.path.rsplit(|&b| b == b'/').next() == Some(b".gitattributes");
            if is_attributes
                && repo
                    .find_blob(entry.id)
                    .is_ok_and(|blob| mentions(blob.content()))
            {
                return true;
            }
        }
    }
    attribute_sources(repo)
        .iter()
        .skip(1)
        .any(|file| std::fs::read(file).is_ok_and(|bytes| mentions(&bytes)))
}

/// The files whose change can alter the attributes verdict: the index (for the tracked
/// `.gitattributes` files), `$GIT_DIR/info/attributes` and the configured
/// `core.attributesfile`, in that order.
pub(super) fn attribute_sources(repo: &Repository) -> Vec<std::path::PathBuf> {
    let mut files = vec![
        repo.path().join("index"),
        repo.path().join("info").join("attributes"),
    ];
    let configured = repo.config().ok().and_then(|config| {
        // git2's `get_path` panics on a value that is not UTF-8 on Windows, where `get_string`
        // refuses it with an error.
        if cfg!(windows) && config.get_string("core.attributesfile").is_err() {
            return None;
        }
        config.get_path("core.attributesfile").ok()
    });
    files.extend(configured);
    files
}

/// The target with every revision resolved to a commit hash and a three-dot range turned
/// into its base against its tip, so a worker on a cold repository handle has no revision
/// to parse and no merge base to walk (a merge base on a cold handle costs two hundred
/// milliseconds on the kernel; on the engine's warm handle, a tenth of that). Unknown
/// revisions and unrelated histories fail here, before any thread starts.
pub(super) fn resolve_target(
    engine: &super::Git2Engine,
    repo: &Repository,
    target: &DiffTarget,
) -> GitResult<DiffTarget> {
    let hash = |rev: &str| super::resolve_commit(repo, rev).map(|oid| oid.to_string());
    Ok(match target {
        DiffTarget::Commit { hash: rev } => DiffTarget::Commit { hash: hash(rev)? },
        DiffTarget::Commits { from, to }
        | DiffTarget::Range {
            from,
            to,
            three_dot: false,
        } => DiffTarget::Commits {
            from: hash(from)?,
            to: hash(to)?,
        },
        DiffTarget::Range {
            from,
            to,
            three_dot: true,
        } => {
            let from_commit = super::resolve_commit(repo, from)?;
            let to_commit = super::resolve_commit(repo, to)?;
            // The engine's merge base, so the comparison, this diff and the files read at the
            // base agree even when two bases tie.
            let base = super::refs::unrelated_as_error(
                engine.merge_base_of(repo, from_commit, to_commit),
                from,
                to,
            )?;
            DiffTarget::Commits {
                from: base.to_string(),
                to: to_commit.to_string(),
            }
        }
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Revision { rev },
        } => DiffTarget::WorkingTree {
            base: WorkingTreeBase::Revision { rev: hash(rev)? },
        },
        other => other.clone(),
    })
}

/// Creates the libgit2 diff for `target`, resolving revisions and trees.
fn build_diff<'r>(
    repo: &'r Repository,
    target: &DiffTarget,
    options: &DiffOptions,
) -> GitResult<Diff<'r>> {
    let mut git_options = Git2DiffOptions::new();
    git_options
        .context_lines(options.context.min(MAX_CONTEXT))
        .include_typechange(true)
        .ignore_whitespace(options.ignore_whitespace);
    let diff = match target {
        DiffTarget::Commit { hash } => {
            let commit = resolve_commit(repo, hash)?;
            let old = parent_tree(repo, &commit)?;
            let new = commit_tree(&commit)?;
            tree_diff(repo, old.as_ref(), &new, &mut git_options)
        }
        DiffTarget::Commits { from, to }
        | DiffTarget::Range {
            from,
            to,
            three_dot: false,
        } => {
            let old = commit_tree(&resolve_commit(repo, from)?)?;
            let new = commit_tree(&resolve_commit(repo, to)?)?;
            tree_diff(repo, Some(&old), &new, &mut git_options)
        }
        DiffTarget::Range {
            from,
            to,
            three_dot: true,
        } => {
            let from_commit = resolve_commit(repo, from)?;
            let to_commit = resolve_commit(repo, to)?;
            let base_id = repo
                .merge_base(from_commit.id(), to_commit.id())
                .map_err(|error| match error.code() {
                    ErrorCode::NotFound => GitError::UnrelatedHistories {
                        a: from.clone(),
                        b: to.clone(),
                    },
                    _ => GitError::from(error),
                })?;
            let base = repo
                .find_commit(base_id)
                .map_err(|error| GitError::object(&base_id.to_string(), error))?;
            let old = commit_tree(&base)?;
            let new = commit_tree(&to_commit)?;
            tree_diff(repo, Some(&old), &new, &mut git_options)
        }
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Head,
        } => {
            let head = head_tree(repo)?;
            repo.diff_tree_to_workdir_with_index(head.as_ref(), Some(&mut git_options))
                .map_err(GitError::from)
        }
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Revision { rev },
        } => {
            let tree = commit_tree(&resolve_commit(repo, rev)?)?;
            repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut git_options))
                .map_err(GitError::from)
        }
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        } => repo
            .diff_index_to_workdir(
                None,
                Some(
                    git_options
                        .include_untracked(true)
                        .recurse_untracked_dirs(true)
                        .show_untracked_content(true),
                ),
            )
            .map_err(GitError::from),
        DiffTarget::Index => {
            let head = head_tree(repo)?;
            repo.diff_tree_to_index(head.as_ref(), None, Some(&mut git_options))
                .map_err(GitError::from)
        }
    };
    diff
}

/// Resolves a revision as `git rev-parse` would and peels it to a commit: unknown and
/// non-commit revisions are [`GitError::RefNotFound`], unreadable objects
/// [`GitError::CorruptObject`].
fn resolve_commit<'r>(repo: &'r Repository, revision: &str) -> GitResult<Commit<'r>> {
    let oid = super::resolve_commit(repo, revision)?;
    repo.find_commit(oid)
        .map_err(|error| GitError::object(&oid.to_string(), error))
}

/// Most context lines around a change; larger requests are clamped so one request cannot
/// turn every file into a full listing.
const MAX_CONTEXT: u32 = 1_000;

/// Lines of one hunk between two cancellation checks.
const CANCEL_EVERY_LINES: usize = 512;

/// Changed paths above which a tree diff runs unpruned: a pathspec that long costs more than
/// the walk it saves, and such a diff is dominated by its deltas anyway.
const PRUNE_LIMIT: usize = 2_000;

/// A tree-to-tree diff limited to the paths that differ.
///
/// libgit2 walks both trees completely, which costs tens of milliseconds on a tree of fifty
/// thousand files even for a one-line commit. The changed paths are found first by merging
/// the entries of both trees and descending only into subtrees whose ids differ, and the diff
/// is then limited to those paths with a literal pathspec, which libgit2's iterators prune
/// on. A directory present on one side only is listed as `dir/`, which libgit2 expands.
fn tree_diff<'r>(
    repo: &'r Repository,
    old: Option<&Tree<'r>>,
    new: &Tree<'r>,
    git_options: &mut Git2DiffOptions,
) -> GitResult<Diff<'r>> {
    if let Some(old) = old {
        if let Some(paths) = changed_paths(repo, old, new, PRUNE_LIMIT)? {
            git_options.disable_pathspec_match(true);
            if paths.is_empty() {
                // Identical trees: a name of one control byte matches nothing, so libgit2
                // visits no entry at all instead of walking both trees.
                git_options.pathspec(&[1u8][..]);
            }
            for path in paths {
                git_options.pathspec(path);
            }
        }
    }
    repo.diff_tree_to_tree(old, Some(new), Some(git_options))
        .map_err(GitError::from)
}

/// The paths that differ between `old` and `new`, descending only into subtrees whose ids
/// differ; `None` once more than `limit` paths are found, or when a path cannot be given to
/// libgit2 literally. Trees present on one side only, or replacing a blob, are listed as
/// `dir/` so a literal pathspec covers their content; a blob replaced by a tree is listed as
/// both `path` and `path/`. A subtree that cannot be read is [`GitError::CorruptObject`].
fn changed_paths(
    repo: &Repository,
    old: &Tree<'_>,
    new: &Tree<'_>,
    limit: usize,
) -> GitResult<Option<Vec<Vec<u8>>>> {
    let mut found = ChangedPaths {
        paths: Vec::new(),
        pending: Vec::new(),
        limit,
    };
    if !found.merge(b"", old, new) {
        return Ok(None);
    }
    while let Some((prefix, old_id, new_id)) = found.pending.pop() {
        let old_tree = repo
            .find_tree(old_id)
            .map_err(|error| GitError::object(&old_id.to_string(), error))?;
        let new_tree = repo
            .find_tree(new_id)
            .map_err(|error| GitError::object(&new_id.to_string(), error))?;
        if !found.merge(&prefix, &old_tree, &new_tree) {
            return Ok(None);
        }
    }
    Ok(Some(found.paths))
}

/// The changed paths found so far and the differing subtrees still to compare.
struct ChangedPaths {
    paths: Vec<Vec<u8>>,
    /// `(prefix with trailing slash, old subtree, new subtree)`.
    pending: Vec<(Vec<u8>, Oid, Oid)>,
    limit: usize,
}

impl ChangedPaths {
    /// Merges the entries of two trees, which git stores in one canonical order (a directory
    /// sorts as `name/`), so each side is read once and no map is built. Returns `false`
    /// when the limit is passed or a path cannot be a literal pathspec.
    fn merge(&mut self, prefix: &[u8], old: &Tree<'_>, new: &Tree<'_>) -> bool {
        use std::cmp::Ordering;
        let mut olds = old.iter().peekable();
        let mut news = new.iter().peekable();
        loop {
            let ok = match (olds.peek(), news.peek()) {
                (None, None) => return true,
                (Some(gone), None) => {
                    let ok = self.push(prefix, gone.name_bytes(), is_tree(gone));
                    olds.next();
                    ok
                }
                (None, Some(added)) => {
                    let ok = self.push(prefix, added.name_bytes(), is_tree(added));
                    news.next();
                    ok
                }
                (Some(before), Some(after)) => match before.cmp(after) {
                    Ordering::Less => {
                        let ok = self.push(prefix, before.name_bytes(), is_tree(before));
                        olds.next();
                        ok
                    }
                    Ordering::Greater => {
                        let ok = self.push(prefix, after.name_bytes(), is_tree(after));
                        news.next();
                        ok
                    }
                    // Same name and the same kind of entry (a blob and a tree of one name
                    // never compare equal, so a typechange lists both forms).
                    Ordering::Equal => {
                        let ok =
                            if before.id() == after.id() && before.filemode() == after.filemode() {
                                true
                            } else if is_tree(before) && is_tree(after) {
                                self.pending.push((
                                    join(prefix, before.name_bytes(), true),
                                    before.id(),
                                    after.id(),
                                ));
                                true
                            } else {
                                self.push(prefix, before.name_bytes(), false)
                            };
                        olds.next();
                        news.next();
                        ok
                    }
                },
            };
            if !ok {
                return false;
            }
        }
    }

    /// Records one changed path; `false` when the limit is passed or the name holds a
    /// backslash, which git2 rewrites to a slash on Windows (the unpruned diff still lists it).
    fn push(&mut self, prefix: &[u8], name: &[u8], directory: bool) -> bool {
        if cfg!(windows) && name.contains(&b'\\') {
            return false;
        }
        self.paths.push(join(prefix, name, directory));
        self.paths.len() <= self.limit
    }
}

fn is_tree(entry: &git2::TreeEntry<'_>) -> bool {
    entry.kind() == Some(ObjectType::Tree)
}

/// `prefix/name`, with a trailing slash for a directory.
fn join(prefix: &[u8], name: &[u8], directory: bool) -> Vec<u8> {
    let mut path = Vec::with_capacity(prefix.len() + name.len() + 1);
    path.extend_from_slice(prefix);
    path.extend_from_slice(name);
    if directory {
        path.push(b'/');
    }
    path
}

fn commit_tree<'r>(commit: &Commit<'r>) -> GitResult<Tree<'r>> {
    commit
        .tree()
        .map_err(|error| GitError::object(&commit.tree_id().to_string(), error))
}

/// Tree of the first parent, or `None` (the empty tree) for a root commit.
fn parent_tree<'r>(repo: &'r Repository, commit: &Commit<'r>) -> GitResult<Option<Tree<'r>>> {
    if commit.parent_count() == 0 {
        return Ok(None);
    }
    let parent_id = commit.parent_id(0)?;
    let parent = repo
        .find_commit(parent_id)
        .map_err(|error| GitError::object(&parent_id.to_string(), error))?;
    commit_tree(&parent).map(Some)
}

/// Tree of HEAD, or `None` (the empty tree) when the branch is unborn.
fn head_tree(repo: &Repository) -> GitResult<Option<Tree<'_>>> {
    match repo.head() {
        // The commit is read by hash rather than peeled through the reference: libgit2
        // reports a peel failure as an invalid reference, which would hide the damaged
        // object behind a generic error.
        Ok(head) => match head.target() {
            Some(oid) => {
                let hash = oid.to_string();
                let commit = repo
                    .find_commit(oid)
                    .map_err(|error| GitError::object(&hash, error))?;
                let tree = commit
                    .tree()
                    .map_err(|error| GitError::object(&commit.tree_id().to_string(), error))?;
                Ok(Some(tree))
            }
            None => head
                .peel_to_tree()
                .map(Some)
                .map_err(|error| GitError::object("HEAD", error)),
        },
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            Ok(None)
        }
        Err(error) => Err(GitError::from(error)),
    }
}

/// The files of one page: the `FileChange`s of the deltas at positions `range` of the
/// listing order, with the lines they add and remove.
///
/// With a working tree target, a modified text file without hunks and without a mode change
/// is left out: libgit2 lists working tree files whose stat data changed although their
/// filtered content did not (line endings under `text=auto`), where `git diff` shows nothing.
pub(super) fn collect_range(
    repo: &Repository,
    prepared: &Prepared<'_>,
    options: &DiffOptions,
    range: std::ops::Range<usize>,
    cancel: &Cancel,
) -> GitResult<(Vec<FileChange>, u32, u32)> {
    let diff = &prepared.diff;
    let probe_new_side = prepared.probe_new_side;
    let working_tree = prepared.working_tree;
    let index_file = &prepared.index_file;
    let mut files = Vec::with_capacity(range.len());
    let mut additions: u32 = 0;
    let mut deletions: u32 = 0;
    for &index in prepared.order.get(range).unwrap_or(&[]) {
        cancel.check()?;
        let Some(delta) = diff.get_delta(index) else {
            continue;
        };
        let Some(mut status) = change_kind(delta.status()) else {
            continue;
        };
        // The index side's placeholder of `git add -N` (always the empty blob, so only such
        // entries are looked up): against the index the file is an addition, and in the
        // staged view nothing of it is staged.
        let mut intent_to_add = false;
        let mut staged_placeholder = false;
        if let Some(index_file) = index_file {
            // Paths as bytes: git2's `path()` panics on a name that is not UTF-8 on Windows.
            let flagged = |file: git2::DiffFile<'_>, flag| {
                file.path_bytes()
                    .is_some_and(|path| super::index_flag(index_file, path, flag))
            };
            let placeholder = |file: git2::DiffFile<'_>| {
                is_empty_blob(file.id()) && flagged(file, IndexEntryExtendedFlag::INTENT_TO_ADD)
            };
            if working_tree {
                if status == ChangeKind::Deleted
                    && flagged(delta.old_file(), IndexEntryExtendedFlag::SKIP_WORKTREE)
                {
                    continue;
                }
                // Against HEAD or a revision, libgit2's merged diff already has git's status.
                if prepared.against_index
                    && status == ChangeKind::Modified
                    && placeholder(delta.old_file())
                {
                    status = ChangeKind::Added;
                    intent_to_add = true;
                }
            } else if placeholder(delta.new_file()) {
                // `git diff --cached`: a new path is not staged, a path HEAD has is a deletion,
                // and a rename onto the placeholder (from an empty file) is its source's.
                match status {
                    ChangeKind::Added => continue,
                    ChangeKind::Deleted | ChangeKind::Unmerged => {}
                    _ => {
                        status = ChangeKind::Deleted;
                        staged_placeholder = true;
                    }
                }
            }
        }
        let mut unreadable = false;
        let patch = match Patch::from_diff(diff, index) {
            Ok(patch) => patch,
            // A working file the patch cannot read (changed while it was read, locked, or of
            // 4 GiB and more, whose size libgit2 keeps in 32 bits) is listed without lines
            // rather than failing the page, unless the old side's blob is what failed.
            Err(error)
                if working_tree
                    && status != ChangeKind::Deleted
                    && matches!(error.class(), ErrorClass::Filesystem | ErrorClass::Os) =>
            {
                if let Some(blob) =
                    locate_unreadable_blob(repo, diff.get_delta(index).into_iter(), false)
                {
                    return Err(blob);
                }
                tracing::debug!(%error, "listing a working file its patch could not read");
                unreadable = true;
                None
            }
            Err(error) => {
                return Err(blob_error(
                    repo,
                    diff.get_delta(index).into_iter(),
                    probe_new_side,
                    error,
                ))
            }
        };
        let generated = prepared.generated_attributes;
        let mut file = match patch {
            Some(mut patch) => file_change(repo, &mut patch, status, options, generated, cancel)?,
            None => {
                let meta = FileMeta::of(&delta, status);
                assemble(repo, status, meta, None, 0, 0, Vec::new(), generated, false)
            }
        };
        // A modified delta without hunks is a file `git diff` would not list: a working tree
        // file whose filtered content is unchanged, or a whitespace-only change under `-w`.
        if (working_tree || options.ignore_whitespace)
            && status == ChangeKind::Modified
            && !file.is_binary
            && !unreadable
            && file.hunks.is_empty()
            && delta.old_file().mode() == delta.new_file().mode()
        {
            continue;
        }
        if unreadable {
            unreadable_side(repo, &delta.new_file(), &mut file);
        } else if working_tree && status != ChangeKind::Deleted && file.new_id.is_none() {
            // The patch gave the id of what it read; a side it does not read has none yet.
            file.new_id = working_id(repo, &delta.new_file());
        }
        // A working file whose id ends up the old side's is no change for git either (a file
        // the patch does not read, rewritten with the same bytes); a submodule keeps its
        // commit when only its own files changed, which git lists as dirty.
        if working_tree
            && status == ChangeKind::Modified
            && file.old_id.is_some()
            && file.old_id == file.new_id
            && delta.old_file().mode() == delta.new_file().mode()
            && delta.new_file().mode() != FileMode::Commit
        {
            continue;
        }
        // The index's empty blob of `git add -N` is a placeholder, not an old side.
        if intent_to_add {
            file.old_id = None;
        }
        // Nor a new one: the staged view lists the old side's path as deleted.
        if staged_placeholder {
            file.path = delta
                .old_file()
                .path_bytes()
                .map(path_string)
                .unwrap_or_default();
            file.old_path = None;
            file.new_id = None;
        }
        additions = additions.saturating_add(file.additions);
        deletions = deletions.saturating_add(file.deletions);
        files.push(file);
    }
    Ok((files, additions, deletions))
}

/// Reads the hunks and lines of one patch into a [`FileChange`].
fn file_change(
    repo: &Repository,
    patch: &mut Patch<'_>,
    status: ChangeKind,
    options: &DiffOptions,
    generated_attributes: bool,
    cancel: &Cancel,
) -> GitResult<FileChange> {
    let meta = FileMeta::of(&patch.delta(), status);
    let similarity = if matches!(status, ChangeKind::Renamed | ChangeKind::Copied) {
        header_similarity(patch)
    } else {
        None
    };
    // Whether the file is large is known from the line counts before any line is read, so
    // the intra-line pass (the costly part) is skipped for files the viewer collapses anyway.
    let (_, stat_additions, stat_deletions) = patch.line_stats()?;
    let changed = u32::try_from(stat_additions.saturating_add(stat_deletions)).unwrap_or(u32::MAX);
    let large = flags::is_large(changed, meta.old_size, meta.new_size);
    let hunk_count = patch.num_hunks();
    let mut hunks = Vec::with_capacity(hunk_count);
    let mut additions: u32 = 0;
    let mut deletions: u32 = 0;
    // A line that is not UTF-8 reaches the interface with replacement characters; the
    // file is flagged so that only whole-file writes are offered for it.
    let mut lossy = false;
    for hunk_index in 0..hunk_count {
        cancel.check()?;
        let (hunk, line_count) = patch.hunk(hunk_index)?;
        let mut lines: Vec<DiffLine> = Vec::with_capacity(line_count);
        for line_index in 0..line_count {
            if line_index % CANCEL_EVERY_LINES == 0 {
                cancel.check()?;
            }
            let line = patch.line_in_hunk(hunk_index, line_index)?;
            let kind = match line.origin_value() {
                DiffLineType::Context => LineKind::Context,
                DiffLineType::Addition => {
                    additions = additions.saturating_add(1);
                    LineKind::Added
                }
                DiffLineType::Deletion => {
                    deletions = deletions.saturating_add(1);
                    LineKind::Removed
                }
                DiffLineType::ContextEOFNL | DiffLineType::AddEOFNL | DiffLineType::DeleteEOFNL => {
                    // libgit2 emits the "\ No newline at end of file" marker as its own line
                    // right after the line it applies to.
                    if let Some(last) = lines.last_mut() {
                        last.no_newline = true;
                    }
                    continue;
                }
                DiffLineType::FileHeader | DiffLineType::HunkHeader | DiffLineType::Binary => {
                    continue;
                }
            };
            lossy |= std::str::from_utf8(line.content()).is_err();
            lines.push(DiffLine {
                kind,
                old_number: line.old_lineno(),
                new_number: line.new_lineno(),
                text: line_text(line.content()),
                spans: Vec::new(),
                no_newline: false,
            });
        }
        if options.intra_line && !large {
            mark_intra_line_spans(&mut lines);
        }
        hunks.push(Hunk {
            old_start: hunk.old_start(),
            old_lines: hunk.old_lines(),
            new_start: hunk.new_start(),
            new_lines: hunk.new_lines(),
            header: hunk_header(hunk.header()),
            lines,
        });
    }
    Ok(assemble(
        repo,
        status,
        meta,
        similarity,
        additions,
        deletions,
        hunks,
        generated_attributes,
        lossy,
    ))
}

/// What a delta says about a file before its patch is read.
struct FileMeta {
    path: String,
    old_path: Option<String>,
    old_size: u64,
    new_size: u64,
    is_binary: bool,
    old_id: Option<String>,
    new_id: Option<String>,
}

/// The blob id of one side of a delta, when the side exists and libgit2 knows its id (always
/// for a tree or the index; for the working tree once the patch read the file).
fn known_id(file: &git2::DiffFile<'_>) -> Option<String> {
    let id = file.id();
    (file.exists() && file.is_valid_id() && !id.is_zero()).then(|| id.to_string())
}

/// Whether `id` is the empty blob, the placeholder `git add -N` records in the index.
fn is_empty_blob(id: Oid) -> bool {
    static EMPTY: std::sync::OnceLock<Option<Oid>> = std::sync::OnceLock::new();
    *EMPTY.get_or_init(|| Oid::hash_object(ObjectType::Blob, &[]).ok()) == Some(id)
}

/// Largest working file hashed when the patch did not read it (about 100 ms of hashing); a
/// larger one is named by its size and time, so no page reads a huge file whole.
const HASH_LIMIT: u64 = 64 << 20;

/// The id of a working tree side libgit2 has none for once the patch was read, which changes
/// exactly when that side does (what a review mark compares). A side the patch reads already
/// has libgit2's: git's blob id of the bytes the hunks come from, after the clean filters.
///
/// Here: the commit checked out in a submodule the patch did not look up, and for a side the
/// patch does not read (binary by attribute, larger than libgit2 reads, a type change, a
/// conflict, a folder such as an untracked nested repository) the blob of its bytes on disk
/// up to [`HASH_LIMIT`], and above it or for a folder `stat:<size>:<modified, in ns>`. The file
/// is named by the delta's own path, not the lossy one the change set shows. `None` when the
/// side cannot be read at all (gone since the listing).
fn working_id(repo: &Repository, file: &git2::DiffFile<'_>) -> Option<String> {
    let id = file.id();
    if file.mode() == git2::FileMode::Commit {
        // A submodule the patch did not look up: its HEAD was read without marking the id.
        return (!id.is_zero()).then(|| id.to_string());
    }
    let path = workdir_path(repo, file)?;
    unread_id(&path, file.mode() == git2::FileMode::Link, HASH_LIMIT)
}

/// A working file whose patch failed: at 4 GiB and more (which libgit2 cannot read) a binary
/// file named by its size and time; otherwise (changed while it was read, locked) no id, until
/// the reload the change brings.
fn unreadable_side(repo: &Repository, side: &git2::DiffFile<'_>, file: &mut FileChange) {
    file.new_id = None;
    let Some(path) = workdir_path(repo, side) else {
        return;
    };
    let huge =
        std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.len() > u64::from(u32::MAX));
    if huge {
        file.is_binary = true;
        file.is_large = true;
        file.new_id = unread_id(&path, false, HASH_LIMIT);
    }
}

/// The working tree file of a delta side, named by its own bytes.
fn workdir_path(repo: &Repository, file: &git2::DiffFile<'_>) -> Option<std::path::PathBuf> {
    Some(repo.workdir()?.join(super::os_path(file.path_bytes()?)?))
}

/// The id of a working tree side the patch did not read, hashing at most `limit` bytes.
fn unread_id(path: &Path, link: bool, limit: u64) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let hashed = if link && metadata.file_type().is_symlink() {
        std::fs::read_link(path).ok().and_then(|target| {
            git2::Oid::hash_object(git2::ObjectType::Blob, &link_text(&target)).ok()
        })
    } else if metadata.is_file() && metadata.len() <= limit {
        // Without `core.symlinks` a link is checked out as a file holding its text.
        git2::Oid::hash_file(git2::ObjectType::Blob, path).ok()
    } else {
        None
    };
    hashed
        .map(|id| id.to_string())
        .or_else(|| stat_token(&metadata))
}

/// A side's size and modification time, for one that is not hashed; `None` without a time,
/// which alone would let a same-size rewrite keep the token.
fn stat_token(metadata: &std::fs::Metadata) -> Option<String> {
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!("stat:{}:{}", metadata.len(), modified.as_nanos()))
}

/// A link's target as git stores it: its bytes, with `/` separators.
#[cfg(unix)]
fn link_text(target: &std::path::Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    target.as_os_str().as_bytes().to_vec()
}

/// A link's target as git stores it: its bytes, with `/` separators.
#[cfg(not(unix))]
fn link_text(target: &std::path::Path) -> Vec<u8> {
    target.to_string_lossy().replace('\\', "/").into_bytes()
}

impl FileMeta {
    fn of(delta: &DiffDelta<'_>, status: ChangeKind) -> Self {
        let new_file = delta.new_file();
        let old_file = delta.old_file();
        let path = new_file
            .path_bytes()
            .or_else(|| old_file.path_bytes())
            .map(path_string)
            .unwrap_or_default();
        let old_path = match status {
            ChangeKind::Renamed | ChangeKind::Copied => old_file.path_bytes().map(path_string),
            _ => None,
        };
        Self {
            path,
            old_path,
            old_size: old_file.size(),
            new_size: new_file.size(),
            is_binary: delta.flags().is_binary(),
            old_id: known_id(&old_file),
            new_id: known_id(&new_file),
        }
    }
}

/// Completes a [`FileChange`] with the counts and the flags.
#[allow(clippy::too_many_arguments)]
fn assemble(
    repo: &Repository,
    status: ChangeKind,
    meta: FileMeta,
    similarity: Option<u8>,
    additions: u32,
    deletions: u32,
    hunks: Vec<Hunk>,
    generated_attributes: bool,
    is_lossy: bool,
) -> FileChange {
    let is_large = flags::is_large(
        additions.saturating_add(deletions),
        meta.old_size,
        meta.new_size,
    );
    let is_generated = generated_attributes
        .then(|| attribute_generated(repo, &meta.path))
        .flatten()
        .unwrap_or_else(|| flags::is_generated_by_name(&meta.path));
    let is_test = flags::is_test(&meta.path);
    FileChange {
        status,
        path: meta.path,
        old_path: meta.old_path,
        old_id: meta.old_id,
        new_id: meta.new_id,
        similarity,
        additions,
        deletions,
        hunks,
        is_binary: meta.is_binary,
        is_large,
        is_generated,
        is_test,
        is_lossy,
    }
}

fn path_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Maps a libgit2 delta status; `None` for deltas a diff never lists as changes.
fn change_kind(delta: Delta) -> Option<ChangeKind> {
    match delta {
        Delta::Added | Delta::Untracked => Some(ChangeKind::Added),
        Delta::Deleted => Some(ChangeKind::Deleted),
        Delta::Modified => Some(ChangeKind::Modified),
        Delta::Renamed => Some(ChangeKind::Renamed),
        Delta::Copied => Some(ChangeKind::Copied),
        Delta::Typechange => Some(ChangeKind::TypeChanged),
        Delta::Conflicted => Some(ChangeKind::Unmerged),
        Delta::Unmodified | Delta::Ignored | Delta::Unreadable => None,
    }
}

/// Similarity of a rename or copy, from the `similarity index NN%` line of the patch header.
///
/// libgit2 prints the header of an already generated patch first and on its own, so the print
/// is stopped from the first callback and costs one small formatting pass.
fn header_similarity(patch: &mut Patch<'_>) -> Option<u8> {
    let mut similarity = None;
    let mut callback = |_: DiffDelta<'_>, _: Option<DiffHunk<'_>>, line: Git2DiffLine<'_>| {
        if line.origin_value() == DiffLineType::FileHeader {
            similarity = parse_similarity(line.content());
        }
        false
    };
    // Stopping the print from the callback surfaces as a `User` error, which is expected.
    let _ = patch.print(&mut callback);
    similarity
}

/// The `linguist-generated` attribute for a path, read from the index and then the working
/// copy: `Some(true)` when set, `Some(false)` when explicitly unset, `None` when unspecified.
fn attribute_generated(repo: &Repository, path: &str) -> Option<bool> {
    let value = repo
        .get_attr_bytes(
            Path::new(path),
            "linguist-generated",
            AttrCheckFlags::INDEX_THEN_FILE,
        )
        .ok()?;
    match AttrValue::from_bytes(value) {
        AttrValue::True => Some(true),
        AttrValue::False => Some(false),
        AttrValue::String(text) if text.eq_ignore_ascii_case("true") => Some(true),
        AttrValue::String(text) if text.eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}

/// Maps a failure while reading file content: a blob missing from the object store is
/// [`GitError::BlobMissing`], an unreadable one is [`GitError::CorruptObject`], anything else
/// keeps libgit2's message.
fn blob_error<'a>(
    repo: &Repository,
    deltas: impl Iterator<Item = DiffDelta<'a>>,
    probe_new_side: bool,
    error: git2::Error,
) -> GitError {
    if error.code() == ErrorCode::NotFound {
        if let Some(hash) = hash_in_message(error.message()) {
            return GitError::BlobMissing(hash);
        }
    }
    locate_unreadable_blob(repo, deltas, probe_new_side).unwrap_or_else(|| GitError::from(error))
}

/// The object id libgit2 quotes in "object not found - no match for id (...)".
pub(super) fn hash_in_message(message: &str) -> Option<String> {
    let start = message.find('(')? + 1;
    let rest = message.get(start..)?;
    let candidate = rest.get(..rest.find(')')?)?;
    let is_hash = candidate.len() >= 40 && candidate.bytes().all(|byte| byte.is_ascii_hexdigit());
    is_hash.then(|| candidate.to_owned())
}

/// Probes the object headers of every file of `deltas` to name the one that cannot be read.
fn locate_unreadable_blob<'a>(
    repo: &Repository,
    deltas: impl Iterator<Item = DiffDelta<'a>>,
    probe_new_side: bool,
) -> Option<GitError> {
    let odb = repo.odb().ok()?;
    for delta in deltas {
        let sides = if probe_new_side {
            vec![delta.old_file(), delta.new_file()]
        } else {
            vec![delta.old_file()]
        };
        for file in sides {
            let id = file.id();
            if id.is_zero() || !file.exists() || file.mode() == FileMode::Commit {
                continue;
            }
            if let Err(error) = odb.read_header(id) {
                let hash = id.to_string();
                return Some(if error.code() == ErrorCode::NotFound {
                    GitError::BlobMissing(hash)
                } else {
                    GitError::object(&hash, error)
                });
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_read_from_the_not_found_message() {
        let hash = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            hash_in_message(&format!("object not found - no match for id ({hash})")).as_deref(),
            Some(hash)
        );
        assert_eq!(hash_in_message("object not found (short)"), None);
        assert_eq!(hash_in_message("no parentheses"), None);
    }

    #[test]
    fn delta_status_maps_to_change_kinds() {
        assert_eq!(change_kind(Delta::Added), Some(ChangeKind::Added));
        assert_eq!(change_kind(Delta::Renamed), Some(ChangeKind::Renamed));
        assert_eq!(
            change_kind(Delta::Typechange),
            Some(ChangeKind::TypeChanged)
        );
        assert_eq!(change_kind(Delta::Unmodified), None);
    }

    #[test]
    fn an_unread_side_is_hashed_up_to_the_limit_and_named_by_size_and_time_above() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("data.bin");
        std::fs::write(&path, [7_u8; 16]).expect("write");
        let blob = git2::Oid::hash_object(git2::ObjectType::Blob, &[7_u8; 16]).expect("hash");
        assert_eq!(unread_id(&path, false, 16), Some(blob.to_string()));

        let over = unread_id(&path, false, 15).expect("token");
        assert!(over.starts_with("stat:16:"), "{over}");
        std::fs::write(&path, [7_u8; 17]).expect("rewrite");
        let grown = unread_id(&path, false, 15).expect("token");
        assert!(grown.starts_with("stat:17:"), "{grown}");

        // A folder (an untracked nested repository) has a token too; a missing file none.
        let folder = unread_id(dir.path(), false, 16).expect("token");
        assert!(folder.starts_with("stat:"), "{folder}");
        assert_eq!(unread_id(&dir.path().join("gone"), false, 16), None);
    }
}
