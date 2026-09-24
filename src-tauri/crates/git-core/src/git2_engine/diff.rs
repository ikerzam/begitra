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
//! - working tree renames are scored on the raw working file, where git filters it first:
//!   under `core.autocrlf` a renamed and edited file with CRLF endings is an addition and a
//!   deletion, every `\r` counting against the similarity;
//! - libgit2 runs the line-ending and `ident` filters only (no external driver such as LFS,
//!   no `working-tree-encoding`), skips the CRLF conversion when the index blob holds any CR,
//!   and collapses only the first `$Id$`: such a working file shows its raw or partly
//!   filtered content, and a file the patch does not read (binary by attribute) compares by
//!   its raw bytes, so a `-diff` file with CRLF endings under `core.autocrlf` is listed;
//! - against HEAD or a revision, a staged change to a sparse file absent from the disk is not
//!   listed, since the working-tree half reads the file as deleted and the `skip-worktree` rule
//!   drops the merged delta;
//! - `linguist-generated` is read from the index and the working copy (`.gitattributes` as
//!   checked out), not from the compared commit, and only when some attributes file of the
//!   repository names the attribute at all (each lookup costs a stat per directory level);
//! - an unborn HEAD counts as the empty tree, where `git diff HEAD` fails.

use std::path::Path;
use std::sync::Once;

use git2::{
    AttrCheckFlags, AttrValue, Commit, Delta, Diff, DiffDelta, DiffFindOptions, DiffHunk,
    DiffLine as Git2DiffLine, DiffLineType, DiffOptions as Git2DiffOptions, ErrorClass, ErrorCode,
    FileMode, IndexEntryExtendedFlag, ObjectType, Oid, Patch, Repository, Tree,
};

use crate::diff::{hunk_header, line_text, mark_intra_line_spans, parse_similarity};
use crate::engine::{Cancel, GitEngine};
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
    /// Where the files the working tree left as staged read their patches (see [`IndexSide`]).
    index_side: Option<IndexSide<'r>>,
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

    /// The diff and the delta a file's patch is read from: the index side's for a file the
    /// working tree left as staged, the merged diff's otherwise.
    fn source(&self, index: usize) -> (&Diff<'_>, usize, bool) {
        match &self.index_side {
            Some(side) => match side.deltas.get(index).copied().flatten() {
                Some(at) => (&side.diff, at, true),
                None => (&self.diff, index, false),
            },
            None => (&self.diff, index, false),
        }
    }
}

/// The tree against the index, beside a diff of a tree against the working tree: libgit2
/// reads every new side of a merged diff from the working tree once the working-tree half
/// holds any file, where git reads a file its status finds unchanged from the index (an LFS
/// pointer, a file `assume-unchanged` hides, a submodule holding only untracked files), and
/// libgit2 too when that half is empty and nothing is merged. Such a file reads its patch
/// here, so a diff lists it as git does whichever other paths it holds.
struct IndexSide<'r> {
    diff: Diff<'r>,
    /// Per delta of the merged diff, the same file's delta here when the working-tree half
    /// does not hold it.
    deltas: Vec<Option<usize>>,
}

/// Builds the delta list of `target` and finds its renames, without reading any patch. A
/// working-tree target reads only `paths` when given (see [`working_tree_paths`]). With
/// `only`, the list keeps the files the restriction keeps (see [`Restriction::keeps`]): a
/// restricted diff.
#[tracing::instrument(level = "debug", skip_all, fields(paths = paths.map(<[Vec<u8>]>::len), only = only.map(|only| only.pathspecs.len())))]
pub(super) fn prepare<'r>(
    repo: &'r Repository,
    target: &DiffTarget,
    options: &DiffOptions,
    generated_attributes: bool,
    paths: Option<&[Vec<u8>]>,
    only: Option<&Restriction>,
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
    let pathspecs: Option<Vec<Vec<u8>>> = only.map(|only| {
        only.pathspecs
            .iter()
            .map(|path| path.as_bytes().to_vec())
            .collect()
    });
    let (mut diff, mut staged) = build_diff(repo, target, options, paths, pathspecs.as_deref())?;
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
        if let Some((staged, _)) = staged.as_mut() {
            let found = staged.find_similar(Some(&mut find));
            found.map_err(|error| blob_error(repo, staged.deltas(), true, error))?;
        }
    }
    let index_side = staged.map(|(staged, unstaged)| index_side(&diff, staged, &unstaged));
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
    // A restricted diff keeps what its paths cover, whatever libgit2 read to find it: a
    // fallback that walked the whole tree lists the same files as the list of paths.
    if let Some(only) = only {
        order.retain(|&index| {
            diff.get_delta(index).is_some_and(|delta| {
                [delta.new_file(), delta.old_file()]
                    .iter()
                    .any(|file| file.path_bytes().is_some_and(|path| only.keeps(path)))
            })
        });
    }
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
        index_side,
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

/// The staged half of a merged diff, kept for the files the working tree left as staged, with
/// the paths the working-tree half holds.
type StagedHalf<'r> = (Diff<'r>, std::collections::HashSet<Vec<u8>>);

/// Creates the libgit2 diff for `target`, resolving revisions and trees, with its staged half
/// when it merges one with the working tree (see [`IndexSide`]). A restriction (`only`) that
/// libgit2 can match literally limits the sides that read no working tree.
fn build_diff<'r>(
    repo: &'r Repository,
    target: &DiffTarget,
    options: &DiffOptions,
    paths: Option<&[Vec<u8>]>,
    only: Option<&[Vec<u8>]>,
) -> GitResult<(Diff<'r>, Option<StagedHalf<'r>>)> {
    // A requested path may be a folder or a submodule: matched as one.
    let only = only.filter(|only| only.iter().all(|requested| literal(requested, true)));
    let mut git_options = base_options(options);
    let diff = match target {
        DiffTarget::Commit { hash } => {
            let commit = resolve_commit(repo, hash)?;
            let old = parent_tree(repo, &commit)?;
            let new = commit_tree(&commit)?;
            tree_diff(repo, old.as_ref(), &new, &mut git_options).map(|diff| (diff, None))
        }
        DiffTarget::Commits { from, to }
        | DiffTarget::Range {
            from,
            to,
            three_dot: false,
        } => {
            let old = commit_tree(&resolve_commit(repo, from)?)?;
            let new = commit_tree(&resolve_commit(repo, to)?)?;
            tree_diff(repo, Some(&old), &new, &mut git_options).map(|diff| (diff, None))
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
            tree_diff(repo, Some(&old), &new, &mut git_options).map(|diff| (diff, None))
        }
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Head,
        } => {
            let head = head_tree(repo)?;
            // git's status compares HEAD with the index too, so its paths cover both halves.
            tree_to_workdir(repo, head.as_ref(), options, paths, paths)
        }
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Revision { rev },
        } => {
            let tree = commit_tree(&resolve_commit(repo, rev)?)?;
            // Restricted, the tree side reads the requested paths themselves: it needs no
            // working tree and no status.
            let staged = match (only, paths, head_tree(repo)?) {
                (Some(only), _, _) => Some(only.to_vec()),
                (None, Some(paths), Some(head)) => revision_paths(repo, &tree, &head, paths)?,
                _ => None,
            };
            tree_to_workdir(repo, Some(&tree), options, staged.as_deref(), paths)
        }
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        } => {
            // The working tree is read at the paths git's status named, not folder by folder.
            if let Some(paths) = paths {
                limit_to(&mut git_options, paths);
            }
            repo.diff_index_to_workdir(
                None,
                Some(
                    git_options
                        .include_untracked(true)
                        .recurse_untracked_dirs(true)
                        .show_untracked_content(true),
                ),
            )
            .map(|diff| (diff, None))
            .map_err(GitError::from)
        }
        DiffTarget::Index => {
            let head = head_tree(repo)?;
            if let Some(only) = only {
                limit_to(&mut git_options, only);
            }
            repo.diff_tree_to_index(head.as_ref(), None, Some(&mut git_options))
                .map(|diff| (diff, None))
                .map_err(GitError::from)
        }
    };
    diff
}

/// `git diff <tree>`: the tree against the index and the index against the working tree,
/// merged, which is what libgit2's `diff_tree_to_workdir_with_index` does inside, with the
/// index read once for both. Done here so each half takes its own paths, `staged` for the tree
/// against the index and `paths` for the working tree; `None` reads everything. With a
/// working-tree half to merge, the staged half comes along a second time, unmerged, for the
/// files that half does not hold (see [`IndexSide`]).
fn tree_to_workdir<'r>(
    repo: &'r Repository,
    tree: Option<&Tree<'r>>,
    options: &DiffOptions,
    staged: Option<&[Vec<u8>]>,
    paths: Option<&[Vec<u8>]>,
) -> GitResult<(Diff<'r>, Option<StagedHalf<'r>>)> {
    let mut index = repo.index()?;
    // As libgit2 loads it for its own two halves: a failed read keeps the index in memory.
    if let Err(error) = index.read(false) {
        tracing::debug!(%error, "the index could not be read again from disk");
    }
    let mut against_index = base_options(options);
    if let Some(staged) = staged {
        limit_to(&mut against_index, staged);
    }
    let mut diff = repo.diff_tree_to_index(tree, Some(&index), Some(&mut against_index))?;
    let mut working = base_options(options);
    if let Some(paths) = paths {
        limit_to(&mut working, paths);
    }
    let unstaged = repo.diff_index_to_workdir(Some(&index), Some(&mut working))?;
    if unstaged.deltas().len() == 0 {
        // libgit2 merges nothing, and every new side stays the index's.
        return Ok((diff, None));
    }
    let held = unstaged
        .deltas()
        .flat_map(|delta| [delta.old_file().path_bytes(), delta.new_file().path_bytes()])
        .flatten()
        .map(<[u8]>::to_vec)
        .collect();
    let alone = repo.diff_tree_to_index(tree, Some(&index), Some(&mut against_index))?;
    diff.merge(&unstaged)?;
    Ok((diff, Some((alone, held))))
}

/// Pairs each delta of the merged diff that the working-tree half does not hold with the same
/// file's delta in the staged half, found by its status and both paths; a delta the two diffs
/// pair differently (a rename scored on the working file) keeps the merged diff's patch.
fn index_side<'r>(
    merged: &Diff<'r>,
    staged: Diff<'r>,
    held: &std::collections::HashSet<Vec<u8>>,
) -> IndexSide<'r> {
    let key = |delta: &DiffDelta<'_>| {
        (
            change_kind(delta.status()),
            delta.old_file().path_bytes().map(<[u8]>::to_vec),
            delta.new_file().path_bytes().map(<[u8]>::to_vec),
        )
    };
    let positions: std::collections::HashMap<_, usize> = staged
        .deltas()
        .enumerate()
        .map(|(at, delta)| (key(&delta), at))
        .collect();
    let deltas = merged
        .deltas()
        .map(|delta| {
            let paths = [delta.old_file().path_bytes(), delta.new_file().path_bytes()];
            if paths.iter().flatten().any(|path| held.contains(*path)) {
                return None;
            }
            positions.get(&key(&delta)).copied()
        })
        .collect();
    IndexSide {
        diff: staged,
        deltas,
    }
}

/// The paths where a revision's tree can differ from the index: those git's status names
/// (HEAD against the index) and those where the revision differs from HEAD. `None` when the
/// trees differ in more paths than the list takes or in one libgit2 would not match
/// literally: the tree is then compared with the whole index.
fn revision_paths(
    repo: &Repository,
    tree: &Tree<'_>,
    head: &Tree<'_>,
    paths: &[Vec<u8>],
) -> GitResult<Option<Vec<Vec<u8>>>> {
    let Some(mut differing) = changed_paths(repo, tree, head, STATUS_PATH_LIMIT)? else {
        return Ok(None);
    };
    differing.extend_from_slice(paths);
    Ok(within_limit(differing, STATUS_PATH_LIMIT))
}

/// The libgit2 options every diff of the engine starts from.
fn base_options(options: &DiffOptions) -> Git2DiffOptions {
    let mut git_options = Git2DiffOptions::new();
    git_options
        .context_lines(options.context.min(MAX_CONTEXT))
        .include_typechange(true)
        .ignore_whitespace(options.ignore_whitespace);
    git_options
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

/// Changed paths above which a working-tree diff walks the whole tree rather than the paths
/// git's status names: a guard on the list's memory only, since the list costs less than the
/// walk it replaces at every size measured and nears it only when it names most of the tree,
/// while giving it up adds the whole walk to the status already paid.
const STATUS_PATH_LIMIT: usize = 250_000;

/// The bytes of pathspecs a restricted status takes on its command line; Windows caps a
/// command line at 32,767 characters, the repository's paths included.
const PATHSPEC_BYTES: usize = 16_384;

/// The paths the working-tree side of a diff reads: those git's status names (untracked
/// files for the diff against the index only, the others leaving them out); against HEAD
/// they cover the tree's side too, and a revision adds its own (`revision_paths`). `None`
/// for another target, when git cannot answer (not started, or its status failing on a
/// damaged repository that libgit2 still reads), past [`STATUS_PATH_LIMIT`], or when a path
/// cannot be matched literally (see [`literal`]): the diff then walks the whole working
/// tree, as libgit2 does on its own. An untracked path under a folder that holds a `.git` is
/// that folder instead (see [`repository_above`]). With `only`, git's status runs at those
/// paths alone, which the caller reads as git and libgit2 must (see [`restriction`]).
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn working_tree_paths(
    engine: &super::Git2Engine,
    target: &DiffTarget,
    only: Option<&[String]>,
    cancel: &Cancel,
) -> GitResult<Option<Vec<Vec<u8>>>> {
    let DiffTarget::WorkingTree { base } = target else {
        return Ok(None);
    };
    let pathspecs = match only {
        Some([]) => return Ok(Some(Vec::new())),
        // Past what a command line safely holds, git's status runs over the whole tree and
        // the restriction applies to what it names (see [`prepare`]).
        Some(only) if only.iter().map(|path| path.len() + 1).sum::<usize>() > PATHSPEC_BYTES => &[],
        Some(only) => only,
        None => &[],
    };
    let untracked = matches!(base, WorkingTreeBase::Index);
    let named = match super::status::changed_paths(engine, untracked, pathspecs, cancel) {
        Ok(Some(named)) => named,
        Ok(None) => {
            tracing::debug!("git could not be started: the diff walks the whole working tree");
            return Ok(None);
        }
        Err(GitError::Cancelled) => return Err(GitError::Cancelled),
        Err(error) => {
            // A cancel raised while git failed still cancels: the walk cannot be interrupted.
            cancel.check()?;
            static WARNED: Once = Once::new();
            WARNED.call_once(|| {
                tracing::warn!(%error, "git's status failed; working-tree diffs walk the whole tree");
            });
            tracing::debug!(%error, "git's status failed: the diff walks the whole working tree");
            return Ok(None);
        }
    };
    if named.len() > STATUS_PATH_LIMIT {
        tracing::debug!(
            count = named.len(),
            "more paths than the list takes: the diff walks the whole working tree"
        );
        return Ok(None);
    }
    if let Some(odd) = named
        .iter()
        .find(|named| !literal(&named.path, named.folder))
    {
        tracing::debug!(
            path = %String::from_utf8_lossy(&odd.path),
            "a path libgit2 would not match literally: the diff walks the whole working tree"
        );
        return Ok(None);
    }
    let root = GitEngine::repo(engine).root.clone();
    let mut repositories = std::collections::HashMap::new();
    let mut paths = Vec::with_capacity(named.len());
    for (at, named) in named.into_iter().enumerate() {
        // One stat per new folder: a huge untracked tree takes a while.
        if at % 1024 == 0 {
            cancel.check()?;
        }
        // An untracked file under a folder that holds a `.git` which is no repository (an
        // empty one, a pruned worktree's link): git names the file, libgit2 lists the folder
        // alone, as the whole walk did.
        let above = if named.untracked {
            if super::os_path(&named.path).is_none() {
                tracing::debug!(
                    path = %String::from_utf8_lossy(&named.path),
                    "a path this platform cannot spell: the diff walks the whole working tree"
                );
                return Ok(None);
            }
            repository_above(&root, &named.path, &mut repositories)
        } else {
            None
        };
        match above.and_then(|end| named.path.get(..end)) {
            Some(folder) => {
                let mut folder = folder.to_vec();
                folder.push(b'/');
                if !literal(&folder, true) {
                    tracing::debug!(
                        path = %String::from_utf8_lossy(&folder),
                        "a folder libgit2 would not match literally: the diff walks the whole working tree"
                    );
                    return Ok(None);
                }
                paths.push(folder);
            }
            None => paths.push(named.path),
        }
    }
    Ok(within_limit(paths, STATUS_PATH_LIMIT))
}

/// A restricted diff's paths: those git's status and libgit2 read, and what the result keeps.
pub(super) struct Restriction {
    /// The paths git's status runs at and libgit2 is limited to.
    pub(super) pathspecs: Vec<String>,
    /// The requested paths without a trailing slash: the result keeps what they cover.
    requested: Vec<Vec<u8>>,
    /// Entries read for their own listing alone: the index's spelling of a requested path and
    /// an entry above one that the diff lists under its own name (see [`restriction`]).
    exact: Vec<Vec<u8>>,
}

impl Restriction {
    /// Whether the result keeps a listed path: one a requested path covers, or an entry read
    /// for itself. Not what every pathspec covers: the file turned into a folder, read for its
    /// deletion, would bring the folder's other files along.
    fn keeps(&self, listed: &[u8]) -> bool {
        let bare = listed.strip_suffix(b"/").unwrap_or(listed);
        self.requested
            .iter()
            .any(|requested| covers(requested, listed))
            || self.exact.iter().any(|exact| exact.as_slice() == bare)
    }
}

/// The requested paths as git's status and libgit2 must read them to list what a full diff
/// lists there: without a trailing slash (a folder that became a file lists under its bare
/// name); with the index's own spelling beside one a case-insensitive file system names
/// otherwise (`README.md` on disk for `Readme.md` in the index); with the entry above a path
/// that the diff lists under its own name: a file in the index or in the tree compared with
/// it (HEAD's, or the revision's), which became a folder or a submodule moved away and lists
/// its deletion, and for a working-tree target a file on disk where a folder was; and with a
/// path inside a submodule or an untracked repository replaced by that folder, since git's
/// status names such a folder for the folder itself, where a full status names it, and not
/// for a path inside it (a pathspec inside an untracked nested repository lists nothing at
/// all), and a tree compared with the index finds a submodule only at its own path. The
/// folder covers the path it replaces (see [`covers`]).
pub(super) fn restriction(
    engine: &super::Git2Engine,
    target: &DiffTarget,
    only: &[String],
) -> GitResult<Restriction> {
    let root = GitEngine::repo(engine).root.clone();
    let requested: Vec<String> = only
        .iter()
        .map(|path| path.trim_end_matches('/').to_owned())
        .filter(|path| !path.is_empty())
        .collect();
    let mut submodules: Vec<String> = Vec::new();
    // Folders with nothing tracked below them, which a `.git` makes a repository.
    let mut untracked: Vec<String> = Vec::new();
    let mut exact: Vec<String> = Vec::new();
    // Every folder above a requested path, once.
    let mut folders: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    engine.with_repo(|repo| {
        let mut index = repo.index()?;
        if let Err(error) = index.read(false) {
            tracing::debug!(%error, "the index could not be read again from disk");
        }
        // The tree the diff compares with the index; the working tree against the index has
        // none.
        let tree = match target {
            DiffTarget::WorkingTree {
                base: WorkingTreeBase::Revision { rev },
            } => Some(commit_tree(&resolve_commit(repo, rev)?)?),
            DiffTarget::WorkingTree {
                base: WorkingTreeBase::Head,
            }
            | DiffTarget::Index => head_tree(repo)?,
            _ => None,
        };
        let in_tree = |folder: &str| {
            tree.as_ref().is_some_and(|tree| {
                tree.get_path(Path::new(folder))
                    .is_ok_and(|entry| entry.kind() != Some(ObjectType::Tree))
            })
        };
        // git2's `get_path` panics on what `index_path` refuses (a path starting with `.`).
        let entry = |path: &str| super::index_path(path).and_then(|path| index.get_path(path, 0));
        for path in &requested {
            if let Some(stored) = entry(path).filter(|stored| stored.path != path.as_bytes()) {
                if let Ok(spelling) = String::from_utf8(stored.path) {
                    exact.push(spelling);
                }
            }
            let mut end = 0;
            while let Some(slash) = path.get(end..).and_then(|rest| rest.find('/')) {
                let folder = path.get(..end + slash).unwrap_or_default();
                end += slash + 1;
                if folder.is_empty() || !seen.insert(folder.to_owned()) {
                    continue;
                }
                folders.push(folder.to_owned());
                match entry(folder) {
                    Some(tracked) if tracked.mode == u32::from(FileMode::Commit) => {
                        submodules.push(folder.to_owned());
                    }
                    Some(_) => exact.push(folder.to_owned()),
                    None => {
                        if index.find_prefix(format!("{folder}/")).is_err() {
                            untracked.push(folder.to_owned());
                        }
                        if in_tree(folder) {
                            exact.push(folder.to_owned());
                        }
                    }
                }
            }
        }
        Ok(())
    })?;
    // The stats run once the engine's lock is released.
    if matches!(target, DiffTarget::WorkingTree { .. }) {
        exact.extend(folders.into_iter().filter(|folder| {
            std::fs::symlink_metadata(root.join(folder)).is_ok_and(|metadata| !metadata.is_dir())
        }));
    }
    let mut repositories = submodules;
    repositories.extend(
        untracked
            .into_iter()
            .filter(|folder| root.join(folder).join(".git").exists()),
    );
    let inside = |path: &str| {
        repositories.iter().any(|folder| {
            path.strip_prefix(folder.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
        })
    };
    let mut pathspecs: Vec<String> = requested
        .iter()
        .chain(&exact)
        .filter(|path| !inside(path))
        .cloned()
        .collect();
    // The outermost repository stands for the ones inside it.
    pathspecs.extend(
        repositories
            .iter()
            .filter(|folder| !inside(folder))
            .cloned(),
    );
    pathspecs.sort_unstable();
    pathspecs.dedup();
    Ok(Restriction {
        pathspecs,
        requested: requested.into_iter().map(String::into_bytes).collect(),
        exact: exact.into_iter().map(String::into_bytes).collect(),
    })
}

/// Whether a requested path covers a listed one: the same path, one below it, or an entry
/// above it (a folder entry, a submodule, a file turned into a folder), whose listing a
/// change inside it can move. The frontend applies the same rule to the files it replaces.
pub(super) fn covers(requested: &[u8], listed: &[u8]) -> bool {
    let requested = requested.strip_suffix(b"/").unwrap_or(requested);
    let listed = listed.strip_suffix(b"/").unwrap_or(listed);
    let below = |path: &[u8], folder: &[u8]| {
        path.len() > folder.len()
            && path.starts_with(folder)
            && path.get(folder.len()) == Some(&b'/')
    };
    listed == requested || below(listed, requested) || below(requested, listed)
}

/// Whether libgit2 matches `path` literally under `disable_pathspec_match`, and the rest of
/// the list with it. It skips its pattern match only for files and symbolic links: a folder
/// (`dir/`, whose files match it by prefix) or a submodule is matched again by
/// `git_pathspec__match` against the whole list read as patterns, where a leading `#` is a
/// comment, `*`, `?` and `[` turn off the prefix rule, a trailing space is trimmed, and a
/// leading `!` on any entry, a file's included, makes a negative pattern that leaves out the
/// folder or submodule it names, and a control character ends a pattern or is trimmed from
/// its end; and git2 turns every `\` into `/` on Windows. Such a path makes the diff walk the
/// whole tree instead.
fn literal(path: &[u8], folder: bool) -> bool {
    if path.contains(&b'\\') || path.first() == Some(&b'!') {
        return false;
    }
    if !folder {
        return true;
    }
    let name = path.strip_suffix(b"/").unwrap_or(path);
    name.first() != Some(&b'#')
        && name.last() != Some(&b' ')
        && !name
            .iter()
            .any(|&byte| matches!(byte, b'*' | b'?' | b'[') || byte < 0x20)
}

/// The length of the outermost folder above the untracked `path` (below the root) that holds
/// a `.git`, or `None`: git enters such a folder when that `.git` is no repository and names
/// its files, where libgit2 never enters an untracked folder holding a `.git` and lists the
/// folder alone. A tracked folder holding one is entered by both, and naming it only widens
/// what the diff reads. `seen` keeps the answer per folder.
fn repository_above(
    root: &Path,
    path: &[u8],
    seen: &mut std::collections::HashMap<Vec<u8>, bool>,
) -> Option<usize> {
    let mut end = 0;
    while let Some(slash) = path
        .get(end..)
        .and_then(|rest| rest.iter().position(|&byte| byte == b'/'))
    {
        end += slash;
        let folder = path.get(..end).unwrap_or_default();
        let at = end;
        end += 1;
        if folder.is_empty() || end >= path.len() {
            continue;
        }
        let holds = match seen.get(folder) {
            Some(&holds) => holds,
            None => {
                // libgit2 asks whether the entry exists, following a symbolic link.
                let holds = super::os_path(folder)
                    .is_some_and(|relative| root.join(relative).join(".git").exists());
                seen.insert(folder.to_vec(), holds);
                holds
            }
        };
        if holds {
            return Some(at);
        }
    }
    None
}

/// The paths sorted and without repeats, or `None` past `limit`.
fn within_limit(mut paths: Vec<Vec<u8>>, limit: usize) -> Option<Vec<Vec<u8>>> {
    paths.sort_unstable();
    paths.dedup();
    (paths.len() <= limit).then_some(paths)
}

/// Limits a diff to `paths`, matched literally (no glob, no magic), which libgit2's iterators
/// prune on: a folder no path lies under is never read. No path at all is a name of one
/// control byte, which matches nothing, so libgit2 visits no entry instead of walking
/// everything.
fn limit_to(git_options: &mut Git2DiffOptions, paths: &[Vec<u8>]) {
    git_options.disable_pathspec_match(true);
    if paths.is_empty() {
        git_options.pathspec(&[1u8][..]);
    }
    for path in paths {
        git_options.pathspec(path);
    }
}

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
            limit_to(git_options, &paths);
        }
    }
    repo.diff_tree_to_tree(old, Some(new), Some(git_options))
        .map_err(GitError::from)
}

/// The paths that differ between `old` and `new`, descending only into subtrees whose ids
/// differ; `None` once more than `limit` paths are found, or when a path cannot be given to
/// libgit2 literally. Trees present on one side only, or replacing a blob, are listed as
/// `dir/` so a literal pathspec covers their content, unless libgit2 would read `dir/` as a
/// pattern: their entries are then listed one by one (see [`ChangedPaths::one_side`]). A
/// blob replaced by a tree is listed as both `path` and `path/`. A subtree that cannot be
/// read is [`GitError::CorruptObject`].
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
    if !found.merge(b"", Some(old), Some(new)) {
        return Ok(None);
    }
    let subtree = |id: Oid| {
        repo.find_tree(id)
            .map_err(|error| GitError::object(&id.to_string(), error))
    };
    while let Some((prefix, old_id, new_id)) = found.pending.pop() {
        let old_tree = old_id.map(subtree).transpose()?;
        let new_tree = new_id.map(subtree).transpose()?;
        if !found.merge(&prefix, old_tree.as_ref(), new_tree.as_ref()) {
            return Ok(None);
        }
    }
    Ok(Some(found.paths))
}

/// The changed paths found so far and the subtrees still to compare.
struct ChangedPaths {
    paths: Vec<Vec<u8>>,
    /// `(prefix with trailing slash, old subtree, new subtree)`, a side `None` for a tree
    /// present on the other side only.
    pending: Vec<(Vec<u8>, Option<Oid>, Option<Oid>)>,
    limit: usize,
}

impl ChangedPaths {
    /// Merges the entries of two trees, which git stores in one canonical order (a directory
    /// sorts as `name/`), so each side is read once and no map is built; a missing side has
    /// no entries. Returns `false` when the limit is passed or a path cannot be a literal
    /// pathspec.
    fn merge(&mut self, prefix: &[u8], old: Option<&Tree<'_>>, new: Option<&Tree<'_>>) -> bool {
        use std::cmp::Ordering;
        let mut olds = old.into_iter().flat_map(|tree| tree.iter()).peekable();
        let mut news = new.into_iter().flat_map(|tree| tree.iter()).peekable();
        loop {
            let ok = match (olds.peek(), news.peek()) {
                (None, None) => return true,
                (Some(gone), None) => {
                    let ok = self.one_side(prefix, gone, true);
                    olds.next();
                    ok
                }
                (None, Some(added)) => {
                    let ok = self.one_side(prefix, added, false);
                    news.next();
                    ok
                }
                (Some(before), Some(after)) => match before.cmp(after) {
                    Ordering::Less => {
                        let ok = self.one_side(prefix, before, true);
                        olds.next();
                        ok
                    }
                    Ordering::Greater => {
                        let ok = self.one_side(prefix, after, false);
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
                                    Some(before.id()),
                                    Some(after.id()),
                                ));
                                true
                            } else {
                                self.push(prefix, before, false)
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

    /// An entry present on one side only (`old_side` for the old tree), recorded as its path,
    /// a tree as `dir/`, which libgit2 expands. A tree whose `dir/` libgit2 would read as a
    /// pattern (`app/[locale]/`) is queued against nothing instead, so its entries are
    /// recorded one by one: a file is filtered by the iterators' literal list and never
    /// reaches the pattern match, which a folder or a submodule does.
    fn one_side(&mut self, prefix: &[u8], entry: &git2::TreeEntry<'_>, old_side: bool) -> bool {
        if is_tree(entry) {
            let path = join(prefix, entry.name_bytes(), true);
            if !literal(&path, true) {
                let id = Some(entry.id());
                self.pending.push(if old_side {
                    (path, id, None)
                } else {
                    (path, None, id)
                });
                return true;
            }
        }
        self.push(prefix, entry, is_tree(entry))
    }

    /// Records `entry` under `prefix` (as `dir/` when `directory`); `false` when the limit is
    /// passed or libgit2 would not match the path literally (see [`literal`]), a submodule
    /// counting as a folder: the unpruned diff still lists it.
    fn push(&mut self, prefix: &[u8], entry: &git2::TreeEntry<'_>, directory: bool) -> bool {
        let path = join(prefix, entry.name_bytes(), directory);
        let folder = directory || entry.kind() == Some(ObjectType::Commit);
        if !literal(&path, folder) {
            return false;
        }
        self.paths.push(path);
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
    let working_tree = prepared.working_tree;
    let index_file = &prepared.index_file;
    let mut files = Vec::with_capacity(range.len());
    let mut additions: u32 = 0;
    let mut deletions: u32 = 0;
    for &index in prepared.order.get(range).unwrap_or(&[]) {
        cancel.check()?;
        // A file the working tree left as staged reads its patch from the index side.
        let (diff, index, from_index) = prepared.source(index);
        let probe_new_side = prepared.probe_new_side || from_index;
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
                    && !from_index
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
    fn a_requested_path_covers_itself_what_is_below_and_the_entries_above() {
        assert!(covers(b"src/a.rs", b"src/a.rs"));
        assert!(covers(b"src", b"src/a.rs"));
        assert!(covers(b"src/", b"src/a.rs"));
        assert!(covers(b"nested/x.txt", b"nested/"), "a folder entry above");
        assert!(covers(b"sub/s.txt", b"sub"), "a submodule above");
        assert!(!covers(b"docs", b"docs2/b.txt"));
        assert!(!covers(b"docs2", b"docs/a.txt"));
        assert!(!covers(b"src/a.rs", b"src/a.rs.bak"));
        assert!(!covers(b"src/a", b"src/ab/c.rs"));
    }

    #[test]
    fn a_path_libgit2_reads_as_a_pattern_is_not_literal() {
        assert!(
            literal(b"#notes.md", false),
            "a file skips the pattern match"
        );
        assert!(literal(b"lib[v2]/a.txt", false));
        assert!(literal(b"plain/", true));
        assert!(literal(b"a/!b.txt", false), "only a leading `!` negates");
        assert!(
            !literal(b"!notes.md", false),
            "a negative pattern leaves out the folder or submodule it names"
        );
        for folder in [
            &b"#hash/"[..],
            b"lib[v2]/",
            b"star*/",
            b"what?",
            b"trailing /",
        ] {
            assert!(
                !literal(folder, true),
                "{}",
                String::from_utf8_lossy(folder)
            );
        }
        assert!(
            !literal(b"a\\b.txt", false),
            "git2 turns a backslash into a slash on Windows"
        );
        assert!(!literal(b"tab\t", true), "a control character is trimmed");
        assert!(!literal(b"new\nline/", true), "or ends the pattern");
    }

    /// A tree of `entries` (`path`, id, mode) written to `repo`'s object store.
    fn tree_of(repo: &Repository, entries: &[(&str, Oid, i32)]) -> Oid {
        let mut builder = repo.treebuilder(None).expect("tree builder");
        let mut folders: std::collections::BTreeMap<&str, Vec<(&str, Oid, i32)>> =
            std::collections::BTreeMap::new();
        for &(path, id, mode) in entries {
            match path.split_once('/') {
                Some((folder, rest)) => folders.entry(folder).or_default().push((rest, id, mode)),
                None => {
                    builder.insert(path, id, mode).expect("insert");
                }
            }
        }
        for (folder, inner) in folders {
            builder
                .insert(folder, tree_of(repo, &inner), 0o040_000)
                .expect("insert folder");
        }
        builder.write().expect("write tree")
    }

    #[test]
    fn a_folder_named_like_a_pattern_is_pruned_file_by_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = Repository::init(dir.path()).expect("init");
        let blob = repo.blob(b"x\n").expect("blob");
        let file = 0o100_644;
        let tree =
            |entries: &[(&str, Oid, i32)]| repo.find_tree(tree_of(&repo, entries)).expect("tree");
        // The paths come in the order the subtrees are read.
        let changed = |old: &Tree<'_>, new: &Tree<'_>| {
            changed_paths(&repo, old, new, 10)
                .expect("paths")
                .map(|mut paths| {
                    paths.sort_unstable();
                    paths
                })
        };
        let old = tree(&[("app/layout.tsx", blob, file)]);
        // `app/[locale]/` as a pathspec would be a pattern: its files are listed instead.
        let new = tree(&[
            ("app/layout.tsx", blob, file),
            ("app/[locale]/page.tsx", blob, file),
            ("app/[locale]/about/page.tsx", blob, file),
        ]);
        assert_eq!(
            changed(&old, &new),
            Some(vec![
                b"app/[locale]/about/page.tsx".to_vec(),
                b"app/[locale]/page.tsx".to_vec(),
            ])
        );
        assert_eq!(
            changed(&new, &old),
            Some(vec![
                b"app/[locale]/about/page.tsx".to_vec(),
                b"app/[locale]/page.tsx".to_vec(),
            ]),
            "a folder removed is listed the same way"
        );
        // A plain folder stays one entry.
        let plain = tree(&[
            ("app/layout.tsx", blob, file),
            ("app/en/page.tsx", blob, file),
        ]);
        assert_eq!(changed(&old, &plain), Some(vec![b"app/en/".to_vec()]));
        // A submodule below such a folder goes through the pattern match: no pruning.
        let commit = Oid::from_str("0123456789abcdef0123456789abcdef01234567").expect("id");
        let with_submodule = tree(&[
            ("app/layout.tsx", blob, file),
            ("app/[locale]/vendor", commit, 0o160_000),
        ]);
        assert_eq!(changed(&old, &with_submodule), None);
    }

    #[test]
    fn the_status_path_list_is_sorted_once_and_given_up_past_its_limit() {
        let paths = |names: &[&str]| names.iter().map(|name| name.as_bytes().to_vec()).collect();
        assert_eq!(
            within_limit(paths(&["b", "a", "b"]), 2),
            Some(paths(&["a", "b"])),
            "a path named twice (a status record and a tree path) counts once"
        );
        assert_eq!(within_limit(paths(&["a", "b", "c"]), 2), None);
        assert_eq!(within_limit(Vec::new(), 2), Some(Vec::new()));
    }

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
