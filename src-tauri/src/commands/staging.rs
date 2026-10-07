//! The staging and commit writes through the git CLI. Every argument is checked
//! here before git runs: paths relative to the repository without `..` segments and never
//! option-shaped, a bounded count, a selection with at least one selected line, a message
//! with a subject. No write of this module is registered for cancellation: git removes its
//! `index.lock` on a signal it handles, never when it is killed, so a cancelled `git add`
//! would leave a lock that every later write trips on until the user deletes it by hand,
//! and a commit killed inside a hook can leave the repository for the user to repair. Only
//! the timeout bounds them, and a timeout still kills: after `op.timeout` the interface
//! reloads rather than assuming nothing landed.

use std::path::{Path, PathBuf};
use std::time::Duration;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitResult;
use git_core::git2_engine::patch;
use git_core::types::{
    CommitContext, CommitRequest, IgnoreOutcome, IgnorePlace, IgnoreRule, LineKind, PatchSelection,
    SelectionTarget,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::discards::{Pending, UndoOutcome};
use crate::error::AppError;
use crate::ops::{run_blocking, run_unregistered, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Most paths one call takes.
const MAX_PATHS: usize = 10_000;

/// Most lines a selection carries over its hunks (a 5,000-line hunk is the benchmark).
const MAX_SELECTION_LINES: usize = 200_000;

/// Longest path accepted.
const MAX_PATH_CHARS: usize = 4096;

/// Longest commit message accepted.
const MAX_MESSAGE_CHARS: usize = 100_000;

/// Hooks take minutes here (the full Rust and Vitest suites on this repository), and a
/// `git add` of ten thousand files hashes them all, so the writes get ten minutes.
const WRITE_TIMEOUT: Duration = Duration::from_secs(600);

/// The result of a commit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    /// Full hash of the new HEAD.
    pub hash: String,
}

/// What a discard kept for its Undo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardCopy {
    /// The copy's id for `undo_discard` and `forget_discard`; null when the discard kept no
    /// copy (`keepCopy` false), and for a stage or an unstage.
    pub copy: Option<String>,
    /// git's error when it failed after it changed some of the files: the copy holds those.
    /// A failure that changed nothing is the command's error instead, with no copy.
    pub failure: Option<AppError>,
}

/// Longest copy id accepted: the store numbers its copies.
const MAX_COPY_CHARS: usize = 20;

fn validate_copy(copy: &str) -> Result<(), AppError> {
    if copy.is_empty() || copy.len() > MAX_COPY_CHARS || !copy.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::invalid_argument("copy", "not a copy's id"));
    }
    Ok(())
}

pub(crate) fn validate_paths(field: &str, paths: &[String]) -> Result<(), AppError> {
    if paths.is_empty() {
        return Err(AppError::invalid_argument(field, "empty"));
    }
    if paths.len() > MAX_PATHS {
        return Err(AppError::invalid_argument(
            field,
            format!("more than {MAX_PATHS} paths"),
        ));
    }
    for path in paths {
        validate_path(field, path)?;
    }
    Ok(())
}

/// A path as the status reports it: relative and inside the repository. A leading dash is
/// fine: paths reach git on stdin or after `--`, never as an option.
fn validate_path(field: &str, path: &str) -> Result<(), AppError> {
    if path.is_empty() {
        return Err(AppError::invalid_argument(field, "an empty path"));
    }
    if path.chars().count() > MAX_PATH_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("a path longer than {MAX_PATH_CHARS} characters"),
        ));
    }
    let drive_relative =
        path.len() >= 2 && path.as_bytes()[1] == b':' && path.as_bytes()[0].is_ascii_alphabetic();
    if PathBuf::from(path).is_absolute()
        || drive_relative
        || path.starts_with('/')
        || path.starts_with('\\')
    {
        return Err(AppError::invalid_argument(field, "an absolute path"));
    }
    if path
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment == ".")
    {
        return Err(AppError::invalid_argument(field, "a path with `.` or `..`"));
    }
    if path.contains('\0') {
        return Err(AppError::invalid_argument(field, "a path with a NUL"));
    }
    Ok(())
}

fn validate_selection(target: SelectionTarget, selection: &PatchSelection) -> Result<(), AppError> {
    validate_path("path", &selection.path)?;
    if selection.hunks.is_empty() {
        return Err(AppError::invalid_argument("hunks", "empty"));
    }
    let lines: usize = selection.hunks.iter().map(|hunk| hunk.lines.len()).sum();
    if lines > MAX_SELECTION_LINES {
        return Err(AppError::invalid_argument(
            "hunks",
            format!("more than {MAX_SELECTION_LINES} lines"),
        ));
    }
    let selected = selection.hunks.iter().any(|hunk| {
        hunk.lines
            .iter()
            .any(|line| line.selected && line.kind != LineKind::Context)
    });
    if !selected {
        return Err(AppError::invalid_argument("hunks", "no selected line"));
    }
    if let Some(reason) = patch::problem(selection, target) {
        return Err(AppError::invalid_argument("hunks", reason));
    }
    Ok(())
}

fn validate_message(message: &str) -> Result<(), AppError> {
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(AppError::invalid_argument(
            "message",
            format!("longer than {MAX_MESSAGE_CHARS} characters"),
        ));
    }
    // git keeps comment lines in a message given on stdin (`--cleanup=whitespace`), so a
    // line is a subject whatever it starts with.
    if !message.lines().any(|line| !line.trim().is_empty()) {
        return Err(AppError::invalid_argument("message", "no subject"));
    }
    Ok(())
}

/// Stages paths (`git add -A` on literal pathspecs).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(paths = paths.len()))]
pub async fn stage_paths(
    state: State<'_, AppState>,
    repo: PathBuf,
    paths: Vec<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_paths("paths", &paths)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.stage_paths(&paths, &cancel)
    })
    .await
}

/// Unstages paths (`git restore --staged` on literal pathspecs).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(paths = paths.len()))]
pub async fn unstage_paths(
    state: State<'_, AppState>,
    repo: PathBuf,
    paths: Vec<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_paths("paths", &paths)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.unstage_paths(&paths, &cancel)
    })
    .await
}

/// Discards the unstaged changes of tracked paths and removes untracked ones; the
/// confirmation happened in the frontend, the consequence stated. With `keep_copy`, the
/// paths are copied first for the discard's Undo (ADR-0020): a copy that cannot be kept
/// refuses the discard before git runs, a discard git refuses before it changed anything keeps
/// no copy, and one git stops part-way keeps the copy of what it changed (see [`sealed`]).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, tracked, untracked), fields(tracked = tracked.len(), untracked = untracked.len()))]
pub async fn discard_paths(
    state: State<'_, AppState>,
    repo: PathBuf,
    tracked: Vec<String>,
    untracked: Vec<String>,
    keep_copy: bool,
    op_id: String,
) -> Result<DiscardCopy, AppError> {
    if tracked.is_empty() && untracked.is_empty() {
        return Err(AppError::invalid_argument("tracked", "empty"));
    }
    if !tracked.is_empty() {
        validate_paths("tracked", &tracked)?;
    }
    if !untracked.is_empty() {
        validate_paths("untracked", &untracked)?;
    }
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        discard_keeping(&app, &repo, &tracked, &untracked, keep_copy, &cancel)
    })
    .await
}

/// [`discard_paths`]' work, off the async runtime.
fn discard_keeping(
    app: &AppState,
    repo: &Path,
    tracked: &[String],
    untracked: &[String],
    keep_copy: bool,
    cancel: &Cancel,
) -> Result<DiscardCopy, AppError> {
    let engine = app.open(repo)?;
    let pending = if keep_copy {
        let paths = tracked.iter().chain(untracked).map(String::as_str);
        Some(app.discards().keep(&engine.repo().root, paths)?)
    } else {
        None
    };
    let ran = engine.discard_paths(tracked, untracked, cancel);
    sealed(app, pending, ran)
}

/// What a discard answers once git ran: the copy sealed for its Undo. When git failed after it
/// changed some of the files (a file another program holds, the timeout), the copy of what it
/// changed comes with git's error; a failure that changed nothing is the error alone.
fn sealed(
    app: &AppState,
    pending: Option<Pending>,
    ran: GitResult<()>,
) -> Result<DiscardCopy, AppError> {
    match (ran, pending) {
        (Ok(()), pending) => Ok(DiscardCopy {
            copy: pending.map(|pending| app.discards().seal(pending)),
            failure: None,
        }),
        (Err(error), Some(pending)) => match app.discards().seal_changed(pending) {
            Some(copy) => Ok(DiscardCopy {
                copy: Some(copy),
                failure: Some(error.into()),
            }),
            None => Err(error.into()),
        },
        (Err(error), None) => Err(error.into()),
    }
}

/// Writes back what the discard kept as `copy` (see [`crate::discards::Discards::undo`]):
/// each path that still holds what the discard left. A write of files: the write timeout
/// bounds it, and nothing cancels it.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn undo_discard(
    state: State<'_, AppState>,
    repo: PathBuf,
    copy: String,
    op_id: String,
) -> Result<UndoOutcome, AppError> {
    validate_copy(&copy)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |_cancel| {
        let root = app.open(&repo)?.repo().root.clone();
        app.discards().undo(&copy, &root)
    })
    .await
}

/// Removes the copy a discard kept, when its toast goes; a copy already gone is fine.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn forget_discard(
    state: State<'_, AppState>,
    copy: String,
    op_id: String,
) -> Result<(), AppError> {
    validate_copy(&copy)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |_cancel| {
        app.discards().forget(&copy);
        Ok::<_, AppError>(())
    })
    .await
}

/// Writes an ignore rule for an untracked path, one line appended to `.gitignore` or to
/// `info/exclude` (ADR-0020); the dialog named the line and the file before the user
/// confirmed. Two short reads of git and one write: the default timeout bounds them.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state), fields(rule = ?rule, place = ?place))]
pub async fn ignore_path(
    state: State<'_, AppState>,
    repo: PathBuf,
    path: String,
    rule: IgnoreRule,
    place: IgnorePlace,
    op_id: String,
) -> Result<IgnoreOutcome, AppError> {
    validate_path("path", &path)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.ignore_path(&path, rule, place, &cancel)
    })
    .await
}

/// Applies a selection of hunks and lines: to the index, reversed to the index, or
/// reversed to the working tree. `target` travels beside the selection so that the
/// largest payload of these commands is parsed once. A discard with `keep_copy` copies the
/// file first, as [`discard_paths`] does.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, selection), fields(path = %selection.path, target = ?target))]
pub async fn apply_selection(
    state: State<'_, AppState>,
    repo: PathBuf,
    target: SelectionTarget,
    selection: PatchSelection,
    keep_copy: bool,
    op_id: String,
) -> Result<DiscardCopy, AppError> {
    validate_selection(target, &selection)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        apply_keeping(&app, &repo, target, &selection, keep_copy, &cancel)
    })
    .await
}

/// [`apply_selection`]'s work, off the async runtime.
fn apply_keeping(
    app: &AppState,
    repo: &Path,
    target: SelectionTarget,
    selection: &PatchSelection,
    keep_copy: bool,
    cancel: &Cancel,
) -> Result<DiscardCopy, AppError> {
    let engine = app.open(repo)?;
    let pending = if keep_copy && target == SelectionTarget::Discard {
        let path = selection.path.as_str();
        Some(app.discards().keep(&engine.repo().root, [path])?)
    } else {
        None
    };
    let ran = engine.apply_selection(selection, target, cancel);
    sealed(app, pending, ran)
}

/// Commits the index; only the timeout bounds it, like every write here.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, request), fields(amend = request.amend, signoff = request.signoff))]
pub async fn commit(
    state: State<'_, AppState>,
    repo: PathBuf,
    request: CommitRequest,
    op_id: String,
) -> Result<CommitResult, AppError> {
    validate_message(&request.message)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        let hash = app.open(&repo)?.commit(&request, &cancel)?;
        Ok::<_, AppError>(CommitResult { hash })
    })
    .await
}

/// The author, the template, whether HEAD is unborn, HEAD's commit with its parents and its
/// message, and the operations in progress.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn commit_context(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<CommitContext, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.commit_context(&cancel)
    })
    .await
}

#[cfg(test)]
mod tests {
    use git_core::types::{ChangeKind, SelectedHunk, SelectedLine};

    use super::*;

    fn code(result: Result<(), AppError>) -> String {
        result.expect_err("refused").code
    }

    #[test]
    fn paths_are_validated() {
        assert!(validate_paths("paths", &["src/lib.rs".to_owned()]).is_ok());
        assert!(validate_paths("paths", &["dir with space/ünïcödé.txt".to_owned()]).is_ok());
        assert_eq!(code(validate_paths("paths", &[])), "ipc.invalid_argument");
        assert!(validate_paths("paths", &["-leading-dash.txt".to_owned()]).is_ok());
        for bad in [
            "../outside.txt",
            "a/../../b",
            "/etc/passwd",
            "C:\\x",
            "C:x",
            "",
            "nul\0",
        ] {
            assert_eq!(
                code(validate_paths("paths", &[bad.to_owned()])),
                "ipc.invalid_argument",
                "{bad:?}"
            );
        }
        let too_many: Vec<String> = (0..=MAX_PATHS).map(|i| format!("f{i}")).collect();
        assert_eq!(
            code(validate_paths("paths", &too_many)),
            "ipc.invalid_argument"
        );
    }

    #[test]
    fn selections_need_a_selected_line() {
        let line = |selected: bool| SelectedLine {
            kind: LineKind::Added,
            text: "x".to_owned(),
            no_newline: false,
            selected,
        };
        let request = |lines: Vec<SelectedLine>| PatchSelection {
            path: "a.txt".to_owned(),
            status: ChangeKind::Modified,
            lossy: false,
            hunks: vec![SelectedHunk {
                old_start: 1,
                old_lines: 0,
                new_start: 1,
                new_lines: 1,
                lines,
            }],
        };
        let stage = SelectionTarget::Stage;
        assert!(validate_selection(stage, &request(vec![line(true)])).is_ok());
        assert_eq!(
            code(validate_selection(stage, &request(vec![line(false)]))),
            "ipc.invalid_argument"
        );
        let mut empty = request(vec![line(true)]);
        empty.hunks.clear();
        assert_eq!(
            code(validate_selection(stage, &empty)),
            "ipc.invalid_argument"
        );
        // Half of an end-of-file change: the marker would join two lines.
        let mut removed = line(false);
        removed.kind = LineKind::Removed;
        removed.no_newline = true;
        let mut half = request(vec![removed, line(false), line(true)]);
        half.hunks[0].lines[2].no_newline = true;
        let refused = validate_selection(stage, &half).expect_err("refused");
        assert_eq!(refused.code, "ipc.invalid_argument");
        assert!(refused
            .detail
            .unwrap_or_default()
            .contains("select the last line"));
    }

    #[test]
    fn copies_are_named_by_number() {
        assert!(validate_copy("12").is_ok());
        for bad in ["", "abc", "1/2", "../1", &"1".repeat(MAX_COPY_CHARS + 1)] {
            assert_eq!(code(validate_copy(bad)), "ipc.invalid_argument", "{bad:?}");
        }
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let output = git_core::cli::command(root, args)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// A repository with `files` committed, and a state whose copies live beside it.
    fn committed(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf, AppState) {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).expect("working tree");
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "t@x"]);
        git(&root, &["config", "user.name", "t"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        for (path, text) in files {
            std::fs::write(root.join(path), text).expect("file");
        }
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-q", "-m", "init"]);
        let state = AppState::default();
        state
            .discards()
            .open(&dir.path().join("discards"))
            .expect("copies' folder");
        (dir, root, state)
    }

    fn strings(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| (*path).to_owned()).collect()
    }

    fn read(root: &Path, path: &str) -> Option<String> {
        std::fs::read_to_string(root.join(path)).ok()
    }

    /// The copies kept in the session folders under `dir/discards`.
    fn copies(dir: &Path) -> usize {
        std::fs::read_dir(dir.join("discards"))
            .expect("copies' folder")
            .flatten()
            .map(|session| {
                std::fs::read_dir(session.path())
                    .expect("session folder")
                    .flatten()
                    .filter(|entry| entry.path().is_dir())
                    .count()
            })
            .sum()
    }

    fn engine_root(state: &AppState, root: &Path) -> PathBuf {
        state.open(root).expect("open").repo().root.clone()
    }

    #[test]
    fn a_discard_through_git_comes_back_on_undo() {
        let (dir, root, state) =
            committed(&[("tracked.txt", "committed\n"), ("gone.txt", "committed\n")]);
        std::fs::write(root.join("tracked.txt"), "edited\n").expect("edit");
        std::fs::remove_file(root.join("gone.txt")).expect("delete");
        std::fs::write(root.join("new.txt"), "untracked\n").expect("new file");
        let before = git(&root, &["status", "--porcelain"]);

        let copy = discard_keeping(
            &state,
            &root,
            &strings(&["tracked.txt", "gone.txt"]),
            &strings(&["new.txt"]),
            true,
            &Cancel::never(),
        )
        .expect("discarded")
        .copy
        .expect("a copy");
        assert_eq!(git(&root, &["status", "--porcelain"]), "");
        assert_eq!(read(&root, "new.txt"), None);
        assert_eq!(copies(dir.path()), 1);

        let outcome = state
            .discards()
            .undo(&copy, &engine_root(&state, &root))
            .expect("undone");
        assert_eq!(outcome.restored, ["tracked.txt", "gone.txt", "new.txt"]);
        assert_eq!(git(&root, &["status", "--porcelain"]), before);
        assert_eq!(read(&root, "tracked.txt").as_deref(), Some("edited\n"));
        assert_eq!(read(&root, "new.txt").as_deref(), Some("untracked\n"));
        assert_eq!(copies(dir.path()), 0);
    }

    #[test]
    fn a_discarded_hunk_comes_back_on_undo() {
        let (_dir, root, state) = committed(&[("a.txt", "one\n")]);
        std::fs::write(root.join("a.txt"), "one\ntwo\n").expect("edit");
        let line = |kind: LineKind, text: &str| SelectedLine {
            kind,
            text: text.to_owned(),
            no_newline: false,
            selected: kind != LineKind::Context,
        };
        let selection = PatchSelection {
            path: "a.txt".to_owned(),
            status: ChangeKind::Modified,
            lossy: false,
            hunks: vec![SelectedHunk {
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 2,
                lines: vec![line(LineKind::Context, "one"), line(LineKind::Added, "two")],
            }],
        };
        let discard = SelectionTarget::Discard;
        let copy = apply_keeping(&state, &root, discard, &selection, true, &Cancel::never())
            .expect("discarded")
            .copy
            .expect("a copy");
        assert_eq!(read(&root, "a.txt").as_deref(), Some("one\n"));

        let outcome = state
            .discards()
            .undo(&copy, &engine_root(&state, &root))
            .expect("undone");
        assert_eq!(outcome.restored, ["a.txt"]);
        assert_eq!(read(&root, "a.txt").as_deref(), Some("one\ntwo\n"));

        // A stage keeps no copy, whatever it is asked.
        let stage = SelectionTarget::Stage;
        let staged = apply_keeping(&state, &root, stage, &selection, true, &Cancel::never())
            .expect("staged");
        assert_eq!(staged.copy, None);
    }

    /// git stops part-way on a file another program holds without sharing it: the file it
    /// restored before comes back with Undo, beside git's error.
    #[cfg(windows)]
    #[test]
    fn a_discard_git_stops_part_way_keeps_its_copy() {
        use std::os::windows::fs::OpenOptionsExt;

        let (_dir, root, state) = committed(&[
            (
                "a.txt",
                "committed
",
            ),
            (
                "b.txt",
                "committed
",
            ),
        ]);
        std::fs::write(
            root.join("a.txt"),
            "edited a
",
        )
        .expect("edit");
        std::fs::write(
            root.join("b.txt"),
            "edited b
",
        )
        .expect("edit");
        let engine = state.open(&root).expect("open");
        let paths = strings(&["a.txt", "b.txt"]);
        let pending = state
            .discards()
            .keep(&engine.repo().root, paths.iter().map(String::as_str))
            .expect("kept");
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(root.join("b.txt"))
            .expect("held");
        let ran = engine.discard_paths(&paths, &[], &Cancel::never());
        drop(held);
        let discarded = sealed(&state, Some(pending), ran).expect("answered");

        assert_eq!(
            discarded.failure.expect("git's error").code,
            "git.cli_failed"
        );
        assert_eq!(
            read(&root, "a.txt").as_deref(),
            Some(
                "committed
"
            )
        );
        let copy = discarded.copy.expect("a copy");
        let outcome = state
            .discards()
            .undo(&copy, &engine_root(&state, &root))
            .expect("undone");
        assert_eq!(outcome.restored, ["a.txt"]);
        assert_eq!(
            read(&root, "a.txt").as_deref(),
            Some(
                "edited a
"
            )
        );
        assert_eq!(
            read(&root, "b.txt").as_deref(),
            Some(
                "edited b
"
            )
        );
    }

    #[test]
    fn a_refused_discard_keeps_nothing() {
        let (dir, root, state) = committed(&[("a.txt", "one\n")]);
        // git refuses a path it does not know: the copy goes with the refusal.
        let error = discard_keeping(
            &state,
            &root,
            &strings(&["missing.txt"]),
            &[],
            true,
            &Cancel::never(),
        )
        .expect_err("refused by git");
        assert!(!error.code.starts_with("discard."), "{error:?}");
        assert_eq!(copies(dir.path()), 0);

        // A folder has no copy: git never runs, and the folder stays.
        std::fs::create_dir_all(root.join("nested").join("sub")).expect("nested");
        std::fs::write(root.join("nested").join("sub").join("f.txt"), "x").expect("file");
        let error = discard_keeping(
            &state,
            &root,
            &[],
            &strings(&["nested/"]),
            true,
            &Cancel::never(),
        )
        .expect_err("no copy");
        assert_eq!(error.code, "discard.not_a_file");
        assert!(root.join("nested").join("sub").join("f.txt").exists());
        assert_eq!(copies(dir.path()), 0);

        // Without a copy asked for, git discards and nothing is kept.
        std::fs::write(root.join("a.txt"), "edited\n").expect("edit");
        let discarded = discard_keeping(
            &state,
            &root,
            &strings(&["a.txt"]),
            &[],
            false,
            &Cancel::never(),
        )
        .expect("discarded");
        assert_eq!(discarded.copy, None);
        assert_eq!(read(&root, "a.txt").as_deref(), Some("one\n"));
        assert_eq!(copies(dir.path()), 0);
    }

    #[test]
    fn messages_need_a_subject() {
        assert!(validate_message("feat: x\n\nbody\n").is_ok());
        assert!(validate_message("\n\n  subject after blanks").is_ok());
        assert_eq!(code(validate_message("")), "ipc.invalid_argument");
        assert_eq!(code(validate_message("  \n\n \n")), "ipc.invalid_argument");
        assert!(validate_message("#123 fix the thing\n").is_ok());
        assert_eq!(
            code(validate_message(&"x".repeat(MAX_MESSAGE_CHARS + 1))),
            "ipc.invalid_argument"
        );
    }
}
