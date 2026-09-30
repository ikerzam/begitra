//! The repository index: listing, recents and one-off refreshes. Pins, forgetting and scan
//! folders belong to projects (`commands::projects`): every entry lives in one.

use std::path::{Component, Path, PathBuf, Prefix};
use std::time::{SystemTime, UNIX_EPOCH};

use git_core::engine::Cancel;
use git_core::summary::{describe, describe_head, RepoSummary};
use git_core::types::OperationState;
use repo_index::{Found, IndexEntry, Operation, RepoKind, Upserted};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Unix seconds now.
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Rebuilds a path from its components so spellings compare equal.
pub fn normalise(path: &Path) -> PathBuf {
    path.components().collect()
}

/// Windows' device names: a component named so, with or without an extension, reaches a file
/// only through the verbatim prefix.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Whether a path without the verbatim prefix still names what the prefix named: shorter than
/// `MAX_PATH`, with no component ending in a dot or a space and none a device name.
fn plain_spelling_holds(plain: &Path) -> bool {
    if plain.to_string_lossy().encode_utf16().count() >= 260 {
        return false;
    }
    plain.components().all(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            let stem = name.split('.').next().unwrap_or_default();
            !name.ends_with('.')
                && !name.ends_with(' ')
                && !RESERVED_NAMES
                    .iter()
                    .any(|reserved| stem.eq_ignore_ascii_case(reserved))
        }
        _ => true,
    })
}

/// `path` without Windows' verbatim prefix (`\\?\C:\…`, `\\?\UNC\server\share\…`),
/// which `canonicalize` adds and nothing else in the app writes, unless the plain spelling
/// would name something else ([`plain_spelling_holds`]); any other path as it is.
pub fn without_verbatim(path: &Path) -> PathBuf {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };
    let mut plain = match prefix.kind() {
        Prefix::VerbatimDisk(letter) => PathBuf::from(format!("{}:", char::from(letter))),
        Prefix::VerbatimUNC(server, share) => {
            let mut unc = std::ffi::OsString::from(r"\\");
            unc.push(server);
            unc.push(r"\");
            unc.push(share);
            PathBuf::from(unc)
        }
        _ => return path.to_path_buf(),
    };
    for component in components {
        plain.push(component.as_os_str());
    }
    if plain_spelling_holds(&plain) {
        plain
    } else {
        path.to_path_buf()
    }
}

/// `path` as the file system spells it: its case, links, junctions, mapped and substituted
/// drives and `..` resolved, without the verbatim prefix, rebuilt from its components. The
/// app stores every folder project's folder and every repository it opens by path in this
/// spelling, so a folder or repository reached two ways is one entry; a path that cannot be
/// resolved (gone, or a drive that refuses) stays as given. It reads the disk: call it outside
/// the index's lock.
pub fn canonical(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(resolved) => normalise(&without_verbatim(&resolved)),
        Err(_) => normalise(path),
    }
}
/// The index entry a summary describes, with no scan folder (opened by path).
pub fn found_from_summary(summary: &RepoSummary) -> Found {
    Found {
        path: normalise(&summary.root),
        name: summary.name.clone(),
        kind: if summary.is_linked_worktree {
            RepoKind::Worktree
        } else {
            RepoKind::Main
        },
        parent_path: summary.main_root.as_deref().map(normalise),
        scan_root: PathBuf::new(),
    }
}

/// The index's own summary shape from the engine's.
pub fn index_summary(summary: &RepoSummary) -> repo_index::RepoSummary {
    repo_index::RepoSummary {
        current_branch: summary.current_branch.clone(),
        detached: summary.detached,
        upstream: summary
            .upstream
            .as_ref()
            .map(|upstream| repo_index::Upstream {
                name: upstream.name.clone(),
                remote: upstream.remote.clone(),
                branch: upstream.branch.clone(),
                push_remote: upstream.push_remote.clone(),
            }),
        ahead: summary.ahead,
        behind: summary.behind,
        operation: Some(index_operation(summary.operation)),
        fetched_at: summary.fetched_at,
        last_commit_at: summary.last_commit_at,
        last_commit_subject: summary.last_commit_subject.clone(),
        dirty: summary.dirty,
    }
}

/// The index's word for the engine's operation in progress.
fn index_operation(operation: OperationState) -> Operation {
    match operation {
        OperationState::None => Operation::None,
        OperationState::Merge => Operation::Merge,
        OperationState::Rebase => Operation::Rebase,
        OperationState::CherryPick => Operation::CherryPick,
        OperationState::Revert => Operation::Revert,
    }
}

/// An entry for `summary` that the index does not hold: what a description answers for a
/// repository no project names yet.
fn described_entry(found: &Found, summary: &RepoSummary, dirty: bool) -> IndexEntry {
    let mut stored = index_summary(summary);
    if !dirty {
        stored.dirty = None;
    }
    IndexEntry {
        path: found.path.clone(),
        name: found.name.clone(),
        kind: found.kind,
        parent_path: found.parent_path.clone(),
        scan_root: None,
        summary: stored,
        pinned: false,
        last_opened_at: None,
        refreshed_at: None,
        missing: false,
    }
}

/// Describes `path` and stores the result: the summary of a known entry, under the spelling
/// the index holds (as given, else [`canonical`]), and an unknown one when some project names
/// its path (it joins no project of one). A repository no project names is described without
/// being stored, under its canonical spelling, so the "Add repository…" probe of a dialog that
/// is then cancelled leaves nothing behind and the member it adds is spelled as scans and
/// opens spell it. Returns the entry.
pub fn refresh_entry(
    state: &AppState,
    path: &Path,
    dirty: bool,
    cancel: &Cancel,
) -> Result<IndexEntry, AppError> {
    let described = if dirty {
        describe(path, cancel)
    } else {
        describe_head(path, cancel)
    };
    let summary = match described {
        Ok(summary) => summary,
        Err(error) => {
            let code = error.code();
            if code == crate::error::codes::REPO_NOT_FOUND {
                state.with_index(|index| Ok(index.mark_missing(&normalise(path), true)?))?;
            }
            return Err(AppError::from(error));
        }
    };
    let found = found_from_summary(&summary);
    let spelled = canonical(&found.path);
    let stamp = now();
    state.with_index(|index| {
        let path = if index.get(&found.path)?.is_some() {
            found.path.clone()
        } else if index.get(&spelled)?.is_some() {
            spelled.clone()
        } else {
            let named = if index.is_member(&spelled)? {
                Some(spelled.clone())
            } else if index.is_member(&found.path)? {
                Some(found.path.clone())
            } else {
                None
            };
            let Some(path) = named else {
                let probe = Found {
                    name: file_name_of(&spelled).unwrap_or_else(|| found.name.clone()),
                    path: spelled.clone(),
                    ..found.clone()
                };
                return Ok(described_entry(&probe, &summary, dirty));
            };
            // Opened by path, so it cannot miss a folder project: stored in its project.
            let stored = Found {
                path: path.clone(),
                ..found.clone()
            };
            let Upserted::Stored = index.upsert_found(&stored, stamp)? else {
                return Err(AppError::internal(
                    "a repository opened by path was not stored",
                ));
            };
            path
        };
        let mut stored = index_summary(&summary);
        if !dirty {
            // Without a status the stored flag stays what it was.
            stored.dirty = index.get(&path)?.and_then(|entry| entry.summary.dirty);
        }
        index.update_summary(&path, &stored, stamp)?;
        index
            .get(&path)?
            .ok_or_else(|| AppError::internal("the refreshed entry vanished"))
    })
}

/// The last component of `path`, as a repository's name.
pub fn file_name_of(path: &Path) -> Option<String> {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

/// Every indexed repository and worktree.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn list_repositories(state: State<'_, AppState>) -> Result<Vec<IndexEntry>, AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || app.with_index(|index| Ok(index.list()?)))
        .await
        .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Records that `path` was opened now (the recents order).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn record_repository_open(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<(), AppError> {
    let app = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        app.with_index(|index| Ok(index.record_open(&normalise(&path), now())?))
    })
    .await
    .map_err(|join| AppError::internal(format!("index task failed: {join}")))?
}

/// Describes one repository again and returns its updated entry; without `dirty`, reads HEAD,
/// the upstream counts and the tip and keeps the stored dirty flag, with no status of the
/// working tree.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn refresh_repository(
    state: State<'_, AppState>,
    path: PathBuf,
    dirty: bool,
    op_id: String,
) -> Result<IndexEntry, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        refresh_entry(&worker, &path, dirty, &cancel)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) {
        let output = git_core::cli::command(root, args)
            .output()
            .expect("git runs");
        assert!(output.status.success(), "git {args:?} failed");
    }

    /// A repository with one commit at `root`.
    fn repository(root: &Path) {
        std::fs::create_dir_all(root).expect("mkdir");
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@x"]);
        git(root, &["config", "user.name", "t"]);
        git(root, &["commit", "-q", "--allow-empty", "-m", "init"]);
    }

    /// The root git and the index name for `root`.
    fn described_root(root: &Path) -> PathBuf {
        let summary = describe_head(root, &Cancel::never()).expect("describe");
        normalise(&summary.root)
    }

    #[cfg(windows)]
    #[test]
    fn the_verbatim_prefix_goes_unless_the_plain_spelling_names_something_else() {
        assert_eq!(
            without_verbatim(Path::new(r"\\?\C:\Code\geo portal")),
            PathBuf::from(r"C:\Code\geo portal")
        );
        assert_eq!(
            without_verbatim(Path::new(r"\\?\UNC\nas\share\code")),
            PathBuf::from(r"\\nas\share\code")
        );
        assert_eq!(
            without_verbatim(Path::new(r"C:\Code")),
            PathBuf::from(r"C:\Code")
        );
        // Only the prefix reaches these: a device name, a trailing dot or space, a long path.
        for kept in [
            r"\\?\C:\Code\con",
            r"\\?\C:\Code\aux.txt",
            r"\\?\C:\Code\dots.",
            r"\\?\C:\Code\space ",
        ] {
            assert_eq!(without_verbatim(Path::new(kept)), PathBuf::from(kept));
        }
        let long = format!(r"\\?\C:\{}", "x".repeat(300));
        assert_eq!(without_verbatim(Path::new(&long)), PathBuf::from(&long));
    }

    #[test]
    fn a_repository_no_project_names_is_described_not_stored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("probe");
        repository(&root);
        let state = AppState::default();
        let cancel = Cancel::never();
        let entry = refresh_entry(&state, &root, false, &cancel).expect("describe");
        assert_eq!(entry.name, "probe");
        assert_eq!(entry.summary.current_branch.as_deref(), Some("main"));
        let listed = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert!(listed.is_empty(), "the probe stored {listed:?}");
        let projects = state
            .with_index(|index| Ok(index.projects()?))
            .expect("projects");
        assert!(projects.is_empty());
        // Once a project names it, a refresh stores it in that project and makes none.
        let path = described_root(&root);
        state
            .with_index(|index| {
                Ok(index.create_project("Tiles", std::slice::from_ref(&path), 1)?)
            })
            .expect("create");
        refresh_entry(&state, &root, false, &cancel).expect("refresh");
        let listed = state.with_index(|index| Ok(index.list()?)).expect("list");
        assert_eq!(listed.len(), 1);
        let projects = state
            .with_index(|index| Ok(index.projects()?))
            .expect("projects");
        assert_eq!(projects.len(), 1);
    }

    #[test]
    fn a_refresh_without_the_dirty_flag_keeps_the_stored_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("repo");
        repository(&root);
        std::fs::write(root.join("dirty.txt"), b"x").expect("write");
        let state = AppState::default();
        let cancel = Cancel::never();
        // A project names it, so the refresh stores it.
        let path = described_root(&root);
        state
            .with_index(|index| Ok(index.create_project("Repo", &[path], 1)?))
            .expect("create");
        let entry = refresh_entry(&state, &root, true, &cancel).expect("refresh");
        assert_eq!(entry.summary.dirty, Some(true));
        git(&root, &["switch", "-q", "-c", "other"]);
        std::fs::remove_file(root.join("dirty.txt")).expect("clean");
        // Without the flag the branch moves and the stored flag stays, stale by design.
        let entry = refresh_entry(&state, &root, false, &cancel).expect("refresh");
        assert_eq!(entry.summary.current_branch.as_deref(), Some("other"));
        assert_eq!(entry.summary.dirty, Some(true));
        let entry = refresh_entry(&state, &root, true, &cancel).expect("refresh");
        assert_eq!(entry.summary.dirty, Some(false));
    }
}
