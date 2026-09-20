//! Working tree status, through git, with libgit2 as the fallback.
//!
//! The status runs `git status --porcelain=v2 -z` (see [`super::status_porcelain`]): git's
//! directory cache makes it eight times faster than libgit2 on a tree of thirty thousand
//! directories, and its output is the reference the tests compare against. libgit2's status,
//! below, is the fallback when git cannot be started: it compares HEAD with the index and
//! the index with the working tree, like `git status`; this module maps its flags to
//! [`StatusEntry`] and sorts the result by path. Known differences of that fallback from
//! `git status --porcelain=v2 --untracked-files=all`:
//!
//! - rename detection runs between HEAD and the index only, as in `git status`: libgit2 could
//!   also pair a tracked file deleted from the working tree with a similar untracked file, which
//!   git reports as a deletion plus an untracked path, so that option stays off;
//! - rename decisions rest on libgit2's line-signature similarity, which can differ from git's
//!   byte-based score by a few points (66% against 80% on a three-line file in the tests), so a
//!   rename close to the 50% threshold can be judged differently;
//! - submodules are single entries and are never entered, as in git; their own state is not
//!   inspected.
//!
//! Ignored directories are expanded file by file when ignored paths are requested, matching
//! `git status --ignored --untracked-files=all`.

use git2::{Status, StatusOptions as Git2StatusOptions, StatusShow};

use super::{status_porcelain, Git2Engine};
use crate::cli::run_git_cancellable;
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{ChangeKind, StatusEntry, StatusOptions};

/// Entries between two cancellation checks.
const CANCEL_EVERY: usize = 200;

/// Reports the working tree status; see [`crate::engine::GitEngine::status`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn list(
    engine: &Git2Engine,
    options: &StatusOptions,
    cancel: &Cancel,
) -> GitResult<Vec<StatusEntry>> {
    cancel.check()?;
    // A HEAD whose commit cannot be read is `repo.corrupt_object` with its hash, as every
    // read reports it; git would only say "bad object HEAD".
    engine.with_repo(super::check_head)?;
    let mut args = vec!["status", "--porcelain=v2", "-z"];
    args.push(if options.include_untracked {
        "--untracked-files=all"
    } else {
        "--untracked-files=no"
    });
    // With `--untracked-files=all`, `traditional` lists the files of an ignored directory
    // one by one, as libgit2's recursion did.
    args.push(if options.include_ignored {
        "--ignored=traditional"
    } else {
        "--ignored=no"
    });
    args.push(if options.renames {
        "--renames"
    } else {
        "--no-renames"
    });
    match run_git_cancellable(&GitEngine::repo(engine).root, &args, cancel) {
        Ok(exit) if exit.status == Some(0) => Ok(status_porcelain::parse(&exit.stdout)),
        Ok(exit) => Err(GitError::Cli {
            command: args.join(" "),
            status: exit.status,
            stderr: exit.stderr,
        }),
        // git could not be started (not installed, not on PATH): libgit2 answers instead.
        Err(GitError::Cli { status: None, .. }) => {
            tracing::warn!("git could not be started; the status falls back to libgit2");
            list_libgit2(engine, options, cancel)
        }
        Err(error) => Err(error),
    }
}

/// The status through libgit2, the fallback when git cannot be started.
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn list_libgit2(
    engine: &Git2Engine,
    options: &StatusOptions,
    cancel: &Cancel,
) -> GitResult<Vec<StatusEntry>> {
    engine.with_repo(|repo| {
        let mut git_options = Git2StatusOptions::new();
        git_options
            .show(StatusShow::IndexAndWorkdir)
            .include_untracked(options.include_untracked)
            .recurse_untracked_dirs(options.include_untracked)
            .include_ignored(options.include_ignored)
            .recurse_ignored_dirs(options.include_ignored)
            .renames_head_to_index(options.renames)
            // `git status` never pairs a deleted tracked file with an untracked one; keeping
            // libgit2's index-to-workdir detection off keeps the path set equal to git's.
            .renames_index_to_workdir(false)
            .sort_case_sensitively(true);
        super::check_head(repo)?;
        let statuses = repo.statuses(Some(&mut git_options))?;
        let index_file = repo.index()?;
        let mut entries = Vec::with_capacity(statuses.len());
        for (index, entry) in statuses.iter().enumerate() {
            if index % CANCEL_EVERY == 0 {
                cancel.check()?;
            }
            if let Some(mut mapped) = map_entry(&entry) {
                // `git add -N` records an intent to add: git shows the path as an unstaged
                // addition (`.A`), while libgit2 reports INDEX_NEW plus WT_MODIFIED.
                if mapped.staged == Some(ChangeKind::Added)
                    && super::index_flag(
                        &index_file,
                        &mapped.path,
                        git2::IndexEntryExtendedFlag::INTENT_TO_ADD,
                    )
                {
                    mapped.staged = None;
                    mapped.unstaged = Some(ChangeKind::Added);
                }
                // A sparse checkout leaves `skip-worktree` files off the disk on purpose:
                // git lists nothing, libgit2 an unstaged deletion.
                if mapped.unstaged == Some(ChangeKind::Deleted)
                    && super::index_flag(
                        &index_file,
                        &mapped.path,
                        git2::IndexEntryExtendedFlag::SKIP_WORKTREE,
                    )
                {
                    if mapped.staged.is_none() {
                        continue;
                    }
                    mapped.unstaged = None;
                }
                entries.push(mapped);
            }
        }
        entries.sort_unstable_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
        Ok(entries)
    })
}

/// Which side of a delta a path is read from.
#[derive(Clone, Copy)]
enum Side {
    Old,
    New,
}

fn delta_path(delta: &git2::DiffDelta<'_>, side: Side) -> Option<String> {
    let file = match side {
        Side::Old => delta.old_file(),
        Side::New => delta.new_file(),
    };
    file.path_bytes()
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
}

/// Maps one libgit2 entry; `None` for an entry without deltas (unmodified paths, which are
/// not requested).
fn map_entry(entry: &git2::StatusEntry<'_>) -> Option<StatusEntry> {
    let status = entry.status();
    let head_to_index = entry.head_to_index();
    let index_to_workdir = entry.index_to_workdir();
    // The working tree delta carries the current name; the index delta is the fallback for
    // paths that only changed between HEAD and the index.
    let newest = index_to_workdir.as_ref().or(head_to_index.as_ref())?;
    let path = delta_path(newest, Side::New).or_else(|| delta_path(newest, Side::Old))?;
    if status.is_conflicted() {
        return Some(StatusEntry {
            path,
            old_path: None,
            staged: None,
            unstaged: Some(ChangeKind::Unmerged),
            untracked: false,
            ignored: false,
            conflicted: true,
        });
    }
    let staged = staged_kind(status);
    let unstaged = unstaged_kind(status);
    let old_path = if staged == Some(ChangeKind::Renamed) {
        head_to_index
            .as_ref()
            .and_then(|delta| delta_path(delta, Side::Old))
    } else if unstaged == Some(ChangeKind::Renamed) {
        index_to_workdir
            .as_ref()
            .and_then(|delta| delta_path(delta, Side::Old))
    } else {
        None
    };
    Some(StatusEntry {
        path,
        old_path,
        staged,
        unstaged,
        untracked: status.is_wt_new(),
        ignored: status.is_ignored(),
        conflicted: false,
    })
}

/// Change between HEAD and the index. A rename with edits carries both `INDEX_RENAMED` and
/// `INDEX_MODIFIED`; the rename wins, as `R` does in `git status`.
fn staged_kind(status: Status) -> Option<ChangeKind> {
    if status.is_index_renamed() {
        Some(ChangeKind::Renamed)
    } else if status.is_index_new() {
        Some(ChangeKind::Added)
    } else if status.is_index_deleted() {
        Some(ChangeKind::Deleted)
    } else if status.is_index_typechange() {
        Some(ChangeKind::TypeChanged)
    } else if status.is_index_modified() {
        Some(ChangeKind::Modified)
    } else {
        None
    }
}

/// Change between the index and the working tree. `WT_NEW` is reported through `untracked`,
/// not as a kind.
fn unstaged_kind(status: Status) -> Option<ChangeKind> {
    if status.is_wt_renamed() {
        Some(ChangeKind::Renamed)
    } else if status.is_wt_deleted() {
        Some(ChangeKind::Deleted)
    } else if status.is_wt_typechange() {
        Some(ChangeKind::TypeChanged)
    } else if status.is_wt_modified() {
        Some(ChangeKind::Modified)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_wins_over_the_modified_bit() {
        assert_eq!(
            staged_kind(Status::INDEX_RENAMED | Status::INDEX_MODIFIED),
            Some(ChangeKind::Renamed)
        );
        assert_eq!(
            unstaged_kind(Status::WT_RENAMED | Status::WT_MODIFIED),
            Some(ChangeKind::Renamed)
        );
    }

    #[test]
    fn untracked_and_ignored_have_no_kind() {
        assert_eq!(staged_kind(Status::WT_NEW), None);
        assert_eq!(unstaged_kind(Status::WT_NEW), None);
        assert_eq!(unstaged_kind(Status::IGNORED), None);
        assert_eq!(staged_kind(Status::CURRENT), None);
    }

    #[test]
    fn every_index_and_worktree_bit_maps() {
        assert_eq!(staged_kind(Status::INDEX_NEW), Some(ChangeKind::Added));
        assert_eq!(
            staged_kind(Status::INDEX_DELETED),
            Some(ChangeKind::Deleted)
        );
        assert_eq!(
            staged_kind(Status::INDEX_TYPECHANGE),
            Some(ChangeKind::TypeChanged)
        );
        assert_eq!(
            staged_kind(Status::INDEX_MODIFIED),
            Some(ChangeKind::Modified)
        );
        assert_eq!(unstaged_kind(Status::WT_DELETED), Some(ChangeKind::Deleted));
        assert_eq!(
            unstaged_kind(Status::WT_TYPECHANGE),
            Some(ChangeKind::TypeChanged)
        );
        assert_eq!(
            unstaged_kind(Status::WT_MODIFIED),
            Some(ChangeKind::Modified)
        );
    }
}
