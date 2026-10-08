//! "Reveal in Explorer" ("Reveal in Finder", "Open containing folder"): the platform's file
//! manager on a file or folder of a repository the app knows, selected where the platform can.
//! The webview names the item, so it is checked here first, by its spelling before the disk is
//! read: a root the app does not know never reaches the disk (a UNC path would connect to its
//! host with the user's credentials), and neither does a path outside the root.

use std::path::{Component, Path, PathBuf};

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::spelling::normalise;

use crate::error::{codes, AppError};
use crate::state::AppState;

/// Checks that `path` may be revealed as an item of the working tree at `root`:
/// - both absolute, neither climbing with `..` (`ipc.invalid_argument`);
/// - `root` a repository or worktree the app knows, as the app spells it: one it has open, or
///   a project's member, which every entry of the index is (`external.refused`);
/// - `path` under `root` as spelled, or one of `root`'s worktrees as git lists them
///   (`external.refused`);
/// - `path` on disk (`external.not_found`, the path in `detail`);
/// - a path under `root` shown inside it, as the file system resolves both: a link that leads
///   out of the working tree is outside, except on Windows, whose file manager shows the link
///   itself in its folder; a path or a root that does not resolve is outside too
///   (`external.refused`).
///
/// Blocking: it reads the disk, the index and the worktree list.
pub fn check(state: &AppState, root: &Path, path: &Path) -> Result<(), AppError> {
    for (field, value) in [("root", root), ("path", path)] {
        if !value.is_absolute() {
            return Err(AppError::invalid_argument(field, "must be absolute"));
        }
        if value.components().any(|part| part == Component::ParentDir) {
            return Err(AppError::invalid_argument(field, "must not climb with .."));
        }
    }
    if !knows(state, root)? {
        return Err(refused(root));
    }
    let under = normalise(path).starts_with(normalise(root));
    if !under && !is_worktree_of(state, root, path) {
        return Err(refused(path));
    }
    if let Err(error) = std::fs::metadata(path) {
        use std::io::ErrorKind;
        if matches!(
            error.kind(),
            ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::InvalidFilename
        ) {
            return Err(not_found(path));
        }
    }
    if under && !shown_inside(root, path) {
        return Err(refused(path));
    }
    Ok(())
}

/// The error of a reveal the platform failed: `external.not_found` when the item went in the
/// meantime, `external.spawn_failed` with the platform's reason otherwise.
pub fn failure(path: &Path, error: tauri_plugin_opener::Error) -> AppError {
    match error {
        tauri_plugin_opener::Error::Io(io) if io.kind() == std::io::ErrorKind::NotFound => {
            not_found(path)
        }
        error => AppError::new(
            codes::EXTERNAL_SPAWN_FAILED,
            "The file manager could not be opened",
        )
        .with_detail(error.to_string()),
    }
}

fn not_found(path: &Path) -> AppError {
    AppError::new(codes::EXTERNAL_NOT_FOUND, "The path is not on disk")
        .with_detail(path.display().to_string())
}

fn refused(path: &Path) -> AppError {
    AppError::new(
        codes::EXTERNAL_REFUSED,
        "The path is outside the repositories the app knows",
    )
    .with_detail(path.display().to_string())
}

/// Whether the app knows `root` as it spells it: a repository or worktree it has open, or a
/// project's member. Nothing is read from the disk.
fn knows(state: &AppState, root: &Path) -> Result<bool, AppError> {
    let spelled = normalise(root);
    if state.engine_for(root).is_some() || state.engine_for(&spelled).is_some() {
        return Ok(true);
    }
    state.with_index(|index| Ok(index.is_member(&spelled)?))
}

/// Whether `path` is one of the worktrees of the repository at `root`, as git lists them and as
/// spelled. An engine the app has open answers; otherwise one is opened for the question and
/// dropped, so asking keeps nothing open. A repository that does not open, that opens as
/// another one (libgit2 looks upward from a folder that is no longer a repository) or that
/// cannot list its worktrees answers no.
fn is_worktree_of(state: &AppState, root: &Path, path: &Path) -> bool {
    let listed = match state
        .engine_for(root)
        .or_else(|| state.engine_for(&normalise(root)))
    {
        Some(engine) => worktree_paths(&engine, root),
        None => match Git2Engine::open(root) {
            Ok(engine) => worktree_paths(&engine, root),
            Err(_) => return false,
        },
    };
    let target = normalise(path);
    listed.contains(&target)
}

/// The worktrees `engine` lists, spelled alike, when it is the repository at `root`.
fn worktree_paths(engine: &Git2Engine, root: &Path) -> Vec<PathBuf> {
    if normalise(&engine.repo().root) != normalise(root) {
        return Vec::new();
    }
    engine
        .worktrees(&Cancel::never())
        .map(|worktrees| {
            worktrees
                .iter()
                .map(|worktree| normalise(&worktree.path))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the item at `path`, where the platform's file manager shows it, lies inside `root`
/// as the file system resolves both; no when either does not resolve.
fn shown_inside(root: &Path, path: &Path) -> bool {
    matches!(
        (shown_at(path), std::fs::canonicalize(root)),
        (Ok(item), Ok(root)) if item.starts_with(&root)
    )
}

/// Where Windows' file manager shows `path`, resolved: a link (a symbolic link or a junction)
/// itself, in its folder, since the opener does not follow it.
#[cfg(windows)]
fn shown_at(path: &Path) -> std::io::Result<PathBuf> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
            return Ok(std::fs::canonicalize(parent)?.join(name));
        }
    }
    std::fs::canonicalize(path)
}

/// Where the platform's file manager shows `path`, resolved: a link's target, since the opener
/// resolves the path first.
#[cfg(not(windows))]
fn shown_at(path: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path)
}

#[cfg(test)]
mod tests {
    use git_core::spelling::canonical;

    use super::*;

    fn git(cwd: &Path, args: &[&str]) {
        let output = git_core::cli::command(cwd, args)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// A repository with one commit holding `src/tiles.ts`, at `dir/name`, spelled as the app
    /// stores what it opens.
    fn repository(dir: &Path, name: &str) -> PathBuf {
        let root = dir.join(name);
        std::fs::create_dir_all(root.join("src")).expect("mkdir");
        std::fs::write(root.join("src").join("tiles.ts"), "export {};\n").expect("write");
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "t@x"]);
        git(&root, &["config", "user.name", "t"]);
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "init"]);
        canonical(&root)
    }

    /// A linked worktree of `root` at `dir/name` on a new branch, as git spells it.
    fn worktree(root: &Path, dir: &Path, name: &str) -> PathBuf {
        let path = canonical(dir).join(name);
        let target = path.to_str().expect("a UTF-8 temp dir");
        git(root, &["worktree", "add", "-q", "-b", name, target]);
        path
    }

    /// A link at `link` to the folder `target`: a junction on Windows (no privilege needed), a
    /// symbolic link elsewhere.
    fn link_folder(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .expect("mklink runs")
                .status;
            assert!(status.success(), "mklink failed");
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(target, link).expect("symlink");
    }

    fn code(result: Result<(), AppError>) -> String {
        result.expect_err("refused").code
    }

    /// A project of one holding `root`, as opening a repository makes it.
    fn member(state: &AppState, root: &Path) {
        state
            .with_index(|index| Ok(index.create_project("Geo", &[root.to_path_buf()], 1)?))
            .expect("project");
    }

    #[test]
    fn reveals_items_of_an_open_repository_and_its_worktrees() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = repository(dir.path(), "portal");
        let fix = worktree(&root, dir.path(), "portal-fix");
        let state = AppState::default();
        state.open(&root).expect("open");
        check(&state, &root, &root).expect("the repository itself");
        check(&state, &root, &root.join("src").join("tiles.ts")).expect("a file");
        check(&state, &root, &root.join("src")).expect("a folder");
        check(&state, &root, &fix).expect("a worktree of it");
        // A file inside the worktree is the worktree's, not the repository's.
        assert_eq!(
            code(check(&state, &root, &fix.join("src").join("tiles.ts"))),
            codes::EXTERNAL_REFUSED
        );
        // The root spelled with another separator and a trailing one is the same root.
        let respelled = PathBuf::from(format!("{}/", root.display()).replace('\\', "/"));
        check(&state, &respelled, &root.join("src")).expect("respelled root");
    }

    #[test]
    fn reveals_a_file_deeper_than_the_old_path_limit() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = repository(dir.path(), "portal");
        let mut deep = root.clone();
        while deep.as_os_str().len() < 300 {
            deep.push("a-folder-with-a-long-name");
        }
        std::fs::create_dir_all(&deep).expect("deep folders");
        let file = deep.join("tiles.ts");
        std::fs::write(&file, "export {};\n").expect("write");
        let state = AppState::default();
        state.open(&root).expect("open");
        check(&state, &root, &file).expect("a file past 260 characters");
    }

    #[test]
    fn asks_a_member_that_is_not_open_and_keeps_nothing_open() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = repository(dir.path(), "tiles");
        let fix = worktree(&root, dir.path(), "tiles-fix");
        let other = repository(dir.path(), "other");
        let state = AppState::default();
        assert_eq!(code(check(&state, &root, &root)), codes::EXTERNAL_REFUSED);
        member(&state, &root);
        check(&state, &root, &root).expect("a member");
        check(&state, &root, &fix).expect("a worktree of a member");
        assert_eq!(
            code(check(&state, &root, &other)),
            codes::EXTERNAL_REFUSED,
            "a path outside the member, after its worktrees were asked"
        );
        assert_eq!(state.open_count(), 0, "the checks keep no engine open");
    }

    #[test]
    fn a_root_that_is_no_repository_lists_no_worktree_of_the_one_around_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let outer = repository(dir.path(), "outer");
        let fix = worktree(&outer, dir.path(), "outer-fix");
        // A member whose repository went: libgit2 would open the one around its folder.
        let inner = outer.join("inner");
        std::fs::create_dir_all(&inner).expect("mkdir");
        let state = AppState::default();
        member(&state, &inner);
        assert_eq!(code(check(&state, &inner, &fix)), codes::EXTERNAL_REFUSED);
        assert_eq!(state.open_count(), 0);
    }

    #[test]
    fn refuses_what_lies_outside() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = repository(dir.path(), "portal");
        let other = repository(dir.path(), "other");
        let state = AppState::default();
        state.open(&root).expect("open");
        // A repository the app does not know, and an item outside the known one, missing or
        // not: a path outside is refused before the disk is read.
        assert_eq!(code(check(&state, &other, &other)), codes::EXTERNAL_REFUSED);
        assert_eq!(
            code(check(&state, &root, &other.join("src"))),
            codes::EXTERNAL_REFUSED
        );
        assert_eq!(
            code(check(&state, &root, &dir.path().join("no-such-file"))),
            codes::EXTERNAL_REFUSED
        );
        assert_eq!(
            code(check(&state, &root, dir.path())),
            codes::EXTERNAL_REFUSED
        );
        // Paths that are relative or climb.
        assert_eq!(
            code(check(&state, &root, Path::new("src/tiles.ts"))),
            codes::IPC_INVALID_ARGUMENT
        );
        let climbing = root.join("src").join("..").join("..").join("other");
        assert_eq!(
            code(check(&state, &root, &climbing)),
            codes::IPC_INVALID_ARGUMENT
        );
    }

    #[test]
    fn a_link_out_of_the_working_tree_is_outside_where_the_target_shows() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = repository(dir.path(), "portal");
        let other = repository(dir.path(), "other");
        let state = AppState::default();
        state.open(&root).expect("open");
        let link = root.join("elsewhere");
        link_folder(&other, &link);
        // Below the link, the file manager shows the target's items: outside everywhere.
        assert_eq!(
            code(check(&state, &root, &link.join("src"))),
            codes::EXTERNAL_REFUSED
        );
        // The link itself: Windows' file manager selects it in its folder, the others follow it.
        if cfg!(windows) {
            check(&state, &root, &link).expect("the link in its folder");
        } else {
            assert_eq!(code(check(&state, &root, &link)), codes::EXTERNAL_REFUSED);
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_unknown_share_is_refused_by_its_spelling() {
        let state = AppState::default();
        let share = Path::new(r"\\begitra-no-such-host\share\portal");
        let error = check(&state, share, &share.join("src")).expect_err("refused");
        assert_eq!(error.code, codes::EXTERNAL_REFUSED);
    }

    #[test]
    fn a_path_not_on_disk_says_so() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = repository(dir.path(), "portal");
        let state = AppState::default();
        state.open(&root).expect("open");
        let gone = root.join("src").join("gone.ts");
        let error = check(&state, &root, &gone).expect_err("not on disk");
        assert_eq!(error.code, codes::EXTERNAL_NOT_FOUND);
        assert!(error.detail.expect("detail").contains("gone.ts"));
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "path doesn't exist");
        assert_eq!(
            failure(&gone, tauri_plugin_opener::Error::Io(io)).code,
            codes::EXTERNAL_NOT_FOUND
        );
        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let error = failure(&gone, tauri_plugin_opener::Error::Io(denied));
        assert_eq!(error.code, codes::EXTERNAL_SPAWN_FAILED);
        assert_eq!(error.detail.as_deref(), Some("denied"));
    }
}
