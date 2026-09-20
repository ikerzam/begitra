//! Finding repositories under scan folders.
//!
//! A breadth-first walk with `std::fs`: a directory holding a `.git` entry is reported and not
//! entered, names on the skip list and symbolic links to directories are not entered, and the
//! walk stops at the depth limit. A `.git` file is read to tell a linked worktree (owned by the
//! repository whose `.git/worktrees` it points into) from a submodule checkout (pointing into
//! `.git/modules`, skipped) and from a repository with a separate git directory (a main
//! repository).

use std::collections::VecDeque;
use std::fs;
use std::ops::ControlFlow;
use std::path::{Component, Path, PathBuf};

use crate::cancel::Cancel;
use crate::types::{Found, RepoKind, ScanEvent, ScanOptions};

/// Directories read between two progress events.
const PROGRESS_EVERY: u64 = 50;

/// Walks every folder in `folders`, calling `on_event` for each [`ScanEvent`]; the callback
/// returns `Break` to stop the whole scan. A folder that cannot be read yields a
/// `FolderError` and the scan goes on with the next one. Cancellation is checked before
/// every directory.
pub fn scan(
    folders: &[PathBuf],
    options: &ScanOptions,
    cancel: &Cancel,
    mut on_event: impl FnMut(ScanEvent) -> ControlFlow<()>,
) {
    let skip: Vec<String> = options.skip.iter().map(|s| s.to_lowercase()).collect();
    let mut scanned: u64 = 0;
    let mut found_total: u64 = 0;
    for folder in folders {
        if cancel.is_cancelled() {
            return;
        }
        if on_event(ScanEvent::FolderStarted {
            folder: folder.clone(),
        })
        .is_break()
        {
            return;
        }
        let mut found_here: u64 = 0;
        let outcome = walk_folder(
            folder,
            options.max_depth,
            &skip,
            cancel,
            &mut scanned,
            &mut found_total,
            &mut found_here,
            &mut on_event,
        );
        match outcome {
            Walk::Stopped => return,
            Walk::Unreadable(reason) => {
                if on_event(ScanEvent::FolderError {
                    folder: folder.clone(),
                    reason,
                })
                .is_break()
                {
                    return;
                }
            }
            Walk::Done => {
                if on_event(ScanEvent::FolderDone {
                    folder: folder.clone(),
                    found: found_here,
                })
                .is_break()
                {
                    return;
                }
            }
        }
    }
}

/// How the walk of one scan folder ended.
enum Walk {
    Done,
    /// The scan folder itself could not be read.
    Unreadable(String),
    /// Cancelled or stopped by the callback.
    Stopped,
}

#[allow(clippy::too_many_arguments)]
fn walk_folder(
    folder: &Path,
    max_depth: u32,
    skip: &[String],
    cancel: &Cancel,
    scanned: &mut u64,
    found_total: &mut u64,
    found_here: &mut u64,
    on_event: &mut impl FnMut(ScanEvent) -> ControlFlow<()>,
) -> Walk {
    if let Err(error) = fs::read_dir(folder) {
        return Walk::Unreadable(error.to_string());
    }
    let mut queue: VecDeque<(PathBuf, u32)> = VecDeque::new();
    queue.push_back((folder.to_path_buf(), 0));
    while let Some((dir, depth)) = queue.pop_front() {
        if cancel.is_cancelled() {
            return Walk::Stopped;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            // A subfolder that cannot be read (permissions, a vanished folder) is skipped.
            Err(_) => continue,
        };
        *scanned += 1;
        if (*scanned).is_multiple_of(PROGRESS_EVERY)
            && on_event(ScanEvent::Progress {
                folder: folder.to_path_buf(),
                scanned: *scanned,
                found: *found_total,
            })
            .is_break()
        {
            return Walk::Stopped;
        }
        let mut subdirs = Vec::new();
        let mut git_entry: Option<PathBuf> = None;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if name == ".git" {
                git_entry = Some(entry.path());
                continue;
            }
            // `file_type` of a symlink is the link itself, so links are never entered.
            if !file_type.is_dir() {
                continue;
            }
            let lower = name.to_string_lossy().to_lowercase();
            if skip.contains(&lower) {
                continue;
            }
            subdirs.push(entry.path());
        }
        if let Some(git_path) = git_entry {
            if let Some(found) = classify(&dir, &git_path, folder) {
                *found_total += 1;
                *found_here += 1;
                if on_event(ScanEvent::Found(found)).is_break() {
                    return Walk::Stopped;
                }
            }
            // A repository's working tree is not walked, whatever it holds.
            continue;
        }
        if depth < max_depth {
            subdirs.sort_unstable();
            for sub in subdirs {
                queue.push_back((sub, depth + 1));
            }
        }
    }
    Walk::Done
}

/// What the `.git` entry at `git_path` makes of `dir`; `None` for a submodule checkout.
fn classify(dir: &Path, git_path: &Path, scan_root: &Path) -> Option<Found> {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.to_string_lossy().into_owned());
    let metadata = fs::symlink_metadata(git_path).ok()?;
    if metadata.is_dir() {
        return Some(Found {
            path: dir.to_path_buf(),
            name,
            kind: RepoKind::Main,
            parent_path: None,
            scan_root: scan_root.to_path_buf(),
        });
    }
    if !metadata.is_file() {
        return None;
    }
    let content = fs::read_to_string(git_path).ok()?;
    let gitdir = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))
        .map(str::trim)?;
    let gitdir = normalise(&dir.join(gitdir));
    match owner_of(&gitdir) {
        Owner::Worktree(parent) => Some(Found {
            path: dir.to_path_buf(),
            name,
            kind: RepoKind::Worktree,
            parent_path: Some(parent),
            scan_root: scan_root.to_path_buf(),
        }),
        Owner::Submodule => None,
        Owner::Separate => Some(Found {
            path: dir.to_path_buf(),
            name,
            kind: RepoKind::Main,
            parent_path: None,
            scan_root: scan_root.to_path_buf(),
        }),
    }
}

enum Owner {
    /// `<repo>/.git/worktrees/<name>`: owned by `<repo>`.
    Worktree(PathBuf),
    /// `<repo>/.git/modules/<path>`: a submodule checkout.
    Submodule,
    /// A git directory elsewhere (`git init --separate-git-dir`).
    Separate,
}

fn owner_of(gitdir: &Path) -> Owner {
    let components: Vec<Component<'_>> = gitdir.components().collect();
    for (index, component) in components.iter().enumerate() {
        if component.as_os_str() != ".git" {
            continue;
        }
        match components.get(index + 1).map(|c| c.as_os_str()) {
            Some(next) if next == "worktrees" => {
                let repo: PathBuf = components[..index].iter().collect();
                return Owner::Worktree(repo);
            }
            Some(next) if next == "modules" => return Owner::Submodule,
            _ => {}
        }
    }
    Owner::Separate
}

/// Resolves `.` and `..` components lexically, so a relative `gitdir` yields a clean path.
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitdir_owners_are_told_apart() {
        assert!(matches!(
            owner_of(Path::new("/code/main/.git/worktrees/feature")),
            Owner::Worktree(p) if p == Path::new("/code/main")
        ));
        assert!(matches!(
            owner_of(Path::new("/code/app/.git/modules/libs/sub")),
            Owner::Submodule
        ));
        assert!(matches!(
            owner_of(Path::new("/elsewhere/repo.git")),
            Owner::Separate
        ));
    }

    #[test]
    fn relative_gitdirs_are_normalised() {
        assert_eq!(
            normalise(Path::new(
                "/code/wt/feature/../../main/.git/worktrees/feature"
            )),
            PathBuf::from("/code/main/.git/worktrees/feature")
        );
    }
}
