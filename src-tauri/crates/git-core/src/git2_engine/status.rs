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
//! - submodules are single entries and are never entered; a submodule whose commit moved or
//!   whose tree is dirty is a modification, as in git (`SC..`, `S.M.`, `S..U`), except that
//!   with untracked files left out git says nothing about a submodule holding only untracked
//!   files while libgit2 still reports it modified.
//!
//! Ignored directories are expanded file by file when ignored paths are requested, matching
//! `git status --ignored --untracked-files=all`.

use std::sync::Once;

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
    // Ignored paths are only found by the untracked scan, so it runs whenever either is
    // wanted; the parser drops the untracked records when they were not. With
    // `--untracked-files=all`, `traditional` lists the files of an ignored directory one by
    // one, as libgit2's recursion did.
    let extra = [
        if options.include_untracked || options.include_ignored {
            "--untracked-files=all"
        } else {
            "--untracked-files=no"
        },
        if options.include_ignored {
            "--ignored=traditional"
        } else {
            "--ignored=no"
        },
        if options.renames {
            "--renames"
        } else {
            "--no-renames"
        },
    ];
    match porcelain(engine, &extra, &[], cancel)? {
        Some(output) => Ok(status_porcelain::parse(&output, options.include_untracked)),
        // git could not be started (not installed, not on PATH): libgit2 answers instead.
        None => {
            static WARNED: Once = Once::new();
            WARNED.call_once(|| {
                tracing::warn!("git could not be started; the status falls back to libgit2");
            });
            list_libgit2(engine, options, cancel)
        }
    }
}

/// The paths git's status names as changed, in the index or in the working tree (untracked
/// files when `untracked`), a rename as both its paths: what a working-tree diff has to read.
/// With `pathspecs`, only at those paths and below them, read literally (a `[` is a
/// character, not a pattern). `None` when git cannot be started, and the diff then walks the
/// whole tree.
#[tracing::instrument(level = "debug", skip_all, fields(untracked = untracked, pathspecs = pathspecs.len()))]
pub(super) fn changed_paths(
    engine: &Git2Engine,
    untracked: bool,
    pathspecs: &[String],
    cancel: &Cancel,
) -> GitResult<Option<Vec<status_porcelain::NamedPath>>> {
    let mut extra = vec![
        if untracked {
            "--untracked-files=all"
        } else {
            "--untracked-files=no"
        },
        "--ignored=no",
        "--no-renames",
    ];
    // Without untracked files git's status also leaves out a submodule whose only change is
    // untracked content, which a diff shows when `diff.ignoreSubmodules` is `none`: the status
    // then names every changed submodule, and libgit2 judges each one by its own rules.
    if !untracked && engine.with_repo(|repo| Ok(diff_shows_untracked_submodules(repo)))? {
        extra.push("--ignore-submodules=none");
    }
    Ok(porcelain(engine, &extra, pathspecs, cancel)?
        .map(|output| status_porcelain::changed_paths(&output)))
}

/// Whether the repository's configuration sets `diff.ignoreSubmodules` to `none`.
fn diff_shows_untracked_submodules(repo: &git2::Repository) -> bool {
    repo.config()
        .and_then(|config| config.get_string("diff.ignoreSubmodules"))
        .is_ok_and(|value| value.trim().eq_ignore_ascii_case("none"))
}

/// `git status --porcelain=v2 -z` with `extra` options, on the engine's repository named
/// outright, restricted to `pathspecs` read literally when there are any; its output, or
/// `None` when git cannot be started.
fn porcelain(
    engine: &Git2Engine,
    extra: &[&str],
    pathspecs: &[String],
    cancel: &Cancel,
) -> GitResult<Option<Vec<u8>>> {
    cancel.check()?;
    // A HEAD whose commit cannot be read is `repo.corrupt_object` with its hash, as every
    // read reports it, on a handle that has not read the commit yet; once libgit2's object
    // cache holds it, git's own error names the corrupt object instead.
    let (git_dir, work_tree) = engine.with_repo(|repo| {
        super::check_head(repo)?;
        Ok((
            repo.path().to_path_buf(),
            repo.workdir().map(std::path::Path::to_path_buf),
        ))
    })?;
    let root = GitEngine::repo(engine).root.clone();
    // The repository is named outright rather than discovered from the folder, so a working
    // tree that lives elsewhere (`core.worktree`) and a linked worktree both resolve.
    let git_dir = format!("--git-dir={}", git_dir.display());
    let work_tree = format!(
        "--work-tree={}",
        work_tree.unwrap_or_else(|| root.clone()).display()
    );
    // `--no-optional-locks`: a status refresh must never take `index.lock` or rewrite the
    // index of the user's repository; it is a read.
    let mut args = vec!["--no-optional-locks", git_dir.as_str(), work_tree.as_str()];
    if !pathspecs.is_empty() {
        args.push("--literal-pathspecs");
    }
    args.extend(["status", "--porcelain=v2", "-z"]);
    args.extend_from_slice(extra);
    if !pathspecs.is_empty() {
        args.push("--");
        args.extend(pathspecs.iter().map(String::as_str));
    }
    match run_git_cancellable(&root, &args, cancel) {
        Ok(exit) if exit.status == Some(0) => {
            // git exits 0 and lists nothing for a folder it could not read (a path over the
            // Windows limit without `core.longpaths`, an unreadable directory): the warning
            // is the only trace of a partial answer.
            if !exit.stderr.trim().is_empty() {
                static WARNED: Once = Once::new();
                if WARNED.is_completed() {
                    tracing::debug!(stderr = %exit.stderr.trim(), "git status warned");
                } else {
                    WARNED.call_once(|| {
                        tracing::warn!(stderr = %exit.stderr.trim(), "git status warned");
                    });
                }
            }
            Ok(Some(exit.stdout))
        }
        Ok(exit) => Err(GitError::Cli {
            command: args.join(" "),
            status: exit.status,
            stderr: exit.stderr,
        }),
        Err(GitError::GitNotStarted { .. }) => Ok(None),
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
            .include_untracked(options.include_untracked || options.include_ignored)
            .recurse_untracked_dirs(options.include_untracked || options.include_ignored)
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
                // The untracked scan ran for the ignored paths only: a purely untracked
                // entry goes, and one that is also a change keeps the change alone.
                if mapped.untracked && !options.include_untracked {
                    if mapped.staged.is_none() && mapped.unstaged.is_none() && !mapped.ignored {
                        continue;
                    }
                    mapped.untracked = false;
                }
                // `git add -N` records an intent to add: git shows the path as an unstaged
                // addition (`.A`), while libgit2 reports INDEX_NEW plus WT_MODIFIED.
                if mapped.staged == Some(ChangeKind::Added)
                    && super::index_flag(
                        &index_file,
                        entry.path_bytes(),
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
                        entry.path_bytes(),
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
