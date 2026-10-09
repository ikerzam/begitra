//! The branch, tag, upstream and history writes through the git CLI, and the
//! sequencer that finishes or abandons an operation stopped on conflicts. Every name and
//! revision is checked here before git runs: short, never option-shaped, no control
//! characters, and branch and tag names in the shape `git check-ref-format --branch`
//! accepts, never starting with `+` (a forced refspec on a fetch or push line). Like the
//! staging writes, none is registered for cancellation (a killed git leaves `index.lock` or
//! half an operation behind); the timeout alone bounds them, ten minutes for the ones that
//! run hooks, sign or rewrite a working tree.

use std::path::PathBuf;
use std::time::Duration;

use git_core::engine::GitEngine;
use git_core::types::{
    BlockResolution, BlockResolved, BlockUndo, Conflict, ConflictText, FastForward, MainForward,
    MergeMode, OperationSides, OperationState, Outcome, ResetMode, SequencerAction, Side,
    SwitchTarget, CONFLICT_FILE_MAX_BYTES,
};
use tauri::State;

use crate::error::AppError;
use crate::ops::{run_blocking, run_unregistered, DEFAULT_TIMEOUT};
use crate::state::AppState;

use super::staging::validate_paths;

/// Longest name, revision or message accepted.
const MAX_TEXT_CHARS: usize = 200;

/// Longest tag message accepted.
const MAX_MESSAGE_CHARS: usize = 10_000;

/// Most revisions one cherry-pick or revert takes.
const MAX_REVS: usize = 100;

/// A merge, a rebase, a reset of a large tree or a sequencer step can run hooks and check
/// out thousands of files: ten minutes, as the other writes.
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(600);

/// A revision as the user typed or picked it: non-empty, short, never option-shaped, no
/// control characters. git resolves it; a wrong one is git's message.
pub(crate) fn validate_rev(field: &str, value: &str) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::invalid_argument(field, "empty"));
    }
    if value.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("longer than {MAX_TEXT_CHARS} characters"),
        ));
    }
    if value.starts_with('-') {
        return Err(AppError::invalid_argument(field, "starts with a dash"));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::invalid_argument(field, "a control character"));
    }
    Ok(())
}

/// A commit named by its full hash, lowercase, as the refs listing and the commit context
/// give it: what a write compares HEAD or the stash list with, never a revision to resolve.
pub(crate) fn validate_hash(field: &str, value: &str) -> Result<(), AppError> {
    let hex = value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    // The zero id names no commit: `update-ref` reads it as "delete the ref".
    if hex && matches!(value.len(), 40 | 64) && value.bytes().any(|byte| byte != b'0') {
        Ok(())
    } else {
        Err(AppError::invalid_argument(field, "not a full commit hash"))
    }
}

/// A branch, tag or remote name in the shape git accepts for a new ref (the rules of
/// `git check-ref-format --branch`): no space, no `..`, `@{`, `~`, `^`, `:`, `?`, `*`, `[`
/// or backslash, no component starting with a dot or ending in `.lock`, no trailing slash
/// or dot.
pub(crate) fn validate_name(field: &str, value: &str) -> Result<(), AppError> {
    validate_rev(field, value)?;
    let bad = |why: &str| Err(AppError::invalid_argument(field, why));
    if value.contains(char::is_whitespace) {
        return bad("a space");
    }
    if value.contains("..") || value.contains("@{") {
        return bad("`..` or `@{`");
    }
    if value.contains(['~', '^', ':', '?', '*', '[', '\\']) {
        return bad("one of ~ ^ : ? * [ \\");
    }
    if value.ends_with('/') || value.ends_with('.') || value == "@" {
        return bad("ends with a slash or a dot");
    }
    if value.starts_with('+') {
        // Legal to `check-ref-format`, but a forced refspec on a fetch or push line.
        return bad("starts with a plus");
    }
    if value
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"))
    {
        return bad("a component that is empty, starts with a dot or ends in .lock");
    }
    Ok(())
}

fn validate_revs(field: &str, revs: &[String]) -> Result<(), AppError> {
    if revs.is_empty() {
        return Err(AppError::invalid_argument(field, "empty"));
    }
    if revs.len() > MAX_REVS {
        return Err(AppError::invalid_argument(
            field,
            format!("more than {MAX_REVS} revisions"),
        ));
    }
    for rev in revs {
        validate_rev(field, rev)?;
    }
    Ok(())
}

fn validate_message(field: &str, message: &str) -> Result<(), AppError> {
    if message.chars().count() > MAX_MESSAGE_CHARS {
        return Err(AppError::invalid_argument(
            field,
            format!("longer than {MAX_MESSAGE_CHARS} characters"),
        ));
    }
    if !message.lines().any(|line| !line.trim().is_empty()) {
        return Err(AppError::invalid_argument(field, "blank"));
    }
    Ok(())
}

/// Creates a branch at a start point, checking it out when asked, and tracking the start
/// point (a remote-tracking branch) with `track`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn branch_create(
    state: State<'_, AppState>,
    repo: PathBuf,
    name: String,
    start: String,
    checkout: bool,
    track: bool,
    op_id: String,
) -> Result<(), AppError> {
    validate_name("name", &name)?;
    validate_rev("start", &start)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?
            .branch_create(&name, &start, checkout, track, &cancel)
    })
    .await
}

/// Switches to a branch or a detached revision; git's refusal of a dirty switch comes back
/// as `git.cli_failed` with its message.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn switch(
    state: State<'_, AppState>,
    repo: PathBuf,
    target: SwitchTarget,
    op_id: String,
) -> Result<(), AppError> {
    match &target {
        SwitchTarget::Branch { name } => validate_name("name", name)?,
        SwitchTarget::Detached { rev } => validate_rev("rev", rev)?,
    }
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.switch(&target, &cancel)
    })
    .await
}

/// Renames a branch.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn branch_rename(
    state: State<'_, AppState>,
    repo: PathBuf,
    from: String,
    to: String,
    op_id: String,
) -> Result<(), AppError> {
    validate_name("from", &from)?;
    validate_name("to", &to)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.branch_rename(&from, &to, &cancel)
    })
    .await
}

/// Deletes a branch; an unmerged one only with `force`, after the confirmation that
/// mentions the reflog.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn branch_delete(
    state: State<'_, AppState>,
    repo: PathBuf,
    name: String,
    force: bool,
    op_id: String,
) -> Result<(), AppError> {
    validate_name("name", &name)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.branch_delete(&name, force, &cancel)
    })
    .await
}

/// Merges a revision into HEAD; a stop on conflicts is an outcome, not an error.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn merge(
    state: State<'_, AppState>,
    repo: PathBuf,
    rev: String,
    mode: MergeMode,
    op_id: String,
) -> Result<Outcome, AppError> {
    validate_rev("rev", &rev)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.merge(&rev, mode, &cancel)
    })
    .await
}

/// Rebases HEAD onto a revision, never interactively.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn rebase(
    state: State<'_, AppState>,
    repo: PathBuf,
    onto: String,
    op_id: String,
) -> Result<Outcome, AppError> {
    validate_rev("onto", &onto)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.rebase(&onto, &cancel)
    })
    .await
}

/// Resets HEAD; the confirmation of a hard reset names the reflog as the way back.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn reset(
    state: State<'_, AppState>,
    repo: PathBuf,
    rev: String,
    mode: ResetMode,
    op_id: String,
) -> Result<(), AppError> {
    validate_rev("rev", &rev)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.reset(&rev, mode, &cancel)
    })
    .await
}

/// Moves HEAD from `from` to `to` as a soft reset does, only while HEAD is still `from` on
/// `branch` (a full ref name, null when detached; `refs.head_moved` otherwise): the undo of
/// HEAD's commit and its redo.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn move_head(
    state: State<'_, AppState>,
    repo: PathBuf,
    from: String,
    to: String,
    branch: Option<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_hash("from", &from)?;
    validate_hash("to", &to)?;
    if let Some(branch) = &branch {
        validate_rev("branch", branch)?;
        if !branch.starts_with("refs/heads/") {
            return Err(AppError::invalid_argument(
                "branch",
                "not a local branch's ref",
            ));
        }
    }
    let app = state.inner().clone();
    // A ref's move, as a rename or a delete: no tree to check out, the default timeout.
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?
            .move_head(&from, &to, branch.as_deref(), &cancel)
    })
    .await
}

/// Cherry-picks revisions onto HEAD.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, revs), fields(revs = revs.len()))]
pub async fn cherry_pick(
    state: State<'_, AppState>,
    repo: PathBuf,
    revs: Vec<String>,
    op_id: String,
) -> Result<Outcome, AppError> {
    validate_revs("revs", &revs)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.cherry_pick(&revs, &cancel)
    })
    .await
}

/// Reverts revisions with git's prepared messages.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, revs), fields(revs = revs.len()))]
pub async fn revert(
    state: State<'_, AppState>,
    repo: PathBuf,
    revs: Vec<String>,
    op_id: String,
) -> Result<Outcome, AppError> {
    validate_revs("revs", &revs)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.revert(&revs, &cancel)
    })
    .await
}

/// Creates a tag at a revision, annotated when a message is given.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, message), fields(annotated = message.is_some()))]
pub async fn tag_create(
    state: State<'_, AppState>,
    repo: PathBuf,
    name: String,
    rev: String,
    message: Option<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_name("name", &name)?;
    validate_rev("rev", &rev)?;
    if let Some(message) = message.as_deref() {
        validate_message("message", message)?;
    }
    let app = state.inner().clone();
    // An annotated tag under `tag.gpgSign` waits on the signing program as a commit does.
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?
            .tag_create(&name, &rev, message.as_deref(), &cancel)
    })
    .await
}

/// Deletes a tag; answers what it pointed at (the tag object of an annotated tag).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn tag_delete(
    state: State<'_, AppState>,
    repo: PathBuf,
    name: String,
    op_id: String,
) -> Result<Option<String>, AppError> {
    validate_name("name", &name)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.tag_delete(&name, &cancel)
    })
    .await
}

/// Sets a branch's upstream (`remote/branch`), or unsets it with `null`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn set_upstream(
    state: State<'_, AppState>,
    repo: PathBuf,
    branch: String,
    upstream: Option<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_name("branch", &branch)?;
    if let Some(upstream) = upstream.as_deref() {
        validate_name("upstream", upstream)?;
    }
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?
            .set_upstream(&branch, upstream.as_deref(), &cancel)
    })
    .await
}

/// Moves the local branch `name` to its upstream's commit when that is a fast-forward, without
/// checking it out; the outcome says whether it moved, was level, has commits of its own, or a
/// worktree holds it.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn branch_fast_forward(
    state: State<'_, AppState>,
    repo: PathBuf,
    name: String,
    op_id: String,
) -> Result<FastForward, AppError> {
    validate_name("name", &name)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.branch_fast_forward(&name, &cancel)
    })
    .await
}

/// Moves the main branch to its upstream as `branch_fast_forward` moves a branch; `None` when
/// the repository has no main branch with an upstream to follow.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn main_fast_forward(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<Option<MainForward>, AppError> {
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.main_fast_forward(&cancel)
    })
    .await
}

/// What the repository is in the middle of.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn operation_state(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<OperationState, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |_cancel| {
        worker.open(&repo)?.operation_state()
    })
    .await
}

/// The conflicted paths with their kinds.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn conflicts(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<Vec<Conflict>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.conflicts(&cancel)
    })
    .await
}

/// Marks conflicted paths resolved (`git add`, as git asks).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(paths = paths.len()))]
pub async fn mark_resolved(
    state: State<'_, AppState>,
    repo: PathBuf,
    paths: Vec<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_paths("paths", &paths)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.mark_resolved(&paths, &cancel)
    })
    .await
}

/// The names of the operation's two sides (git's "ours" and "theirs"); null while no operation
/// is in progress.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn operation_sides(
    state: State<'_, AppState>,
    repo: PathBuf,
    op_id: String,
) -> Result<Option<OperationSides>, AppError> {
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |_cancel| {
        worker.open(&repo)?.operation_sides()
    })
    .await
}

/// Conflicted paths spelled as git lists them: the engine finds each by that spelling, and git
/// reads `a\b` (on Windows) or `a//b` as another, so a conflict put back under git's spelling
/// would be named gone under the caller's.
fn validate_conflict_paths(paths: &[String]) -> Result<(), AppError> {
    validate_paths("paths", paths)?;
    for path in paths {
        spelled_as_git_lists("paths", path)?;
    }
    Ok(())
}

/// A conflicted path as git lists it: forward slashes, no empty segment.
fn spelled_as_git_lists(field: &str, path: &str) -> Result<(), AppError> {
    let backslash = cfg!(windows) && path.contains('\\');
    if backslash || path.split('/').any(str::is_empty) {
        return Err(AppError::invalid_argument(
            field,
            "a path not spelled as git lists it",
        ));
    }
    Ok(())
}

/// One conflicted path, validated as the conflict list's paths are.
fn validate_conflict_path(path: &str) -> Result<(), AppError> {
    validate_paths("path", &[path.to_owned()])?;
    spelled_as_git_lists("path", path)
}

/// The most a conflict block's text or the block put back may hold: the largest file read for
/// its blocks (in bytes, or base64 characters for the block put back).
const MAX_BLOCK_BYTES: usize = CONFLICT_FILE_MAX_BYTES as usize;

/// A conflicted file's fingerprint: the git blob id of its bytes, as the blocks were read.
fn validate_fingerprint(field: &str, value: &str) -> Result<(), AppError> {
    let hex = value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if hex && matches!(value.len(), 40 | 64) {
        Ok(())
    } else {
        Err(AppError::invalid_argument(field, "not a blob id"))
    }
}

/// Takes conflicted paths whole from one side, resolved: its version, or the file deleted
/// where that side has none. A path that is not conflicted, or a submodule's conflict, is
/// refused before anything is written.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(paths = paths.len()))]
pub async fn take_side(
    state: State<'_, AppState>,
    repo: PathBuf,
    paths: Vec<String>,
    side: Side,
    op_id: String,
) -> Result<(), AppError> {
    validate_conflict_paths(&paths)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.take_side(&paths, side, &cancel)
    })
    .await
}

/// Puts back the conflicts of paths resolved during the operation in progress, from git's
/// resolve-undo record; a path whose sides git no longer holds, or any path outside an
/// operation, is `conflict.gone`.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, paths), fields(paths = paths.len()))]
pub async fn restore_conflicts(
    state: State<'_, AppState>,
    repo: PathBuf,
    paths: Vec<String>,
    op_id: String,
) -> Result<(), AppError> {
    validate_conflict_paths(&paths)?;
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        app.open(&repo)?.restore_conflicts(&paths, &cancel)
    })
    .await
}

/// The conflict blocks of a conflicted path's file in the working tree.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn conflict_blocks(
    state: State<'_, AppState>,
    repo: PathBuf,
    path: String,
    op_id: String,
) -> Result<ConflictText, AppError> {
    validate_conflict_path(&path)?;
    let app = state.inner().clone();
    let worker = app.clone();
    run_blocking(app.ops(), &op_id, DEFAULT_TIMEOUT, move |cancel| {
        worker.open(&repo)?.conflict_blocks(&path, &cancel)
    })
    .await
}

/// Rewrites one conflict block of a conflicted path's file, only while the file is the one
/// its fingerprint names; the answer carries the file read again and what puts the block back.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, resolution))]
pub async fn resolve_conflict_block(
    state: State<'_, AppState>,
    repo: PathBuf,
    path: String,
    fingerprint: String,
    block: usize,
    resolution: BlockResolution,
    op_id: String,
) -> Result<BlockResolved, AppError> {
    validate_conflict_path(&path)?;
    validate_fingerprint("fingerprint", &fingerprint)?;
    if let BlockResolution::Text { text } = &resolution {
        if text.len() > MAX_BLOCK_BYTES {
            return Err(AppError::invalid_argument(
                "resolution",
                "a text over 4 MiB",
            ));
        }
    }
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?
            .resolve_conflict_block(&path, &fingerprint, block, &resolution, &cancel)
    })
    .await
}

/// Puts back the conflict block a `resolve_conflict_block` replaced, while the file is the one
/// that write left (the undo's fingerprint).
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state, undo))]
pub async fn undo_conflict_block(
    state: State<'_, AppState>,
    repo: PathBuf,
    path: String,
    undo: BlockUndo,
    op_id: String,
) -> Result<ConflictText, AppError> {
    validate_conflict_path(&path)?;
    validate_fingerprint("undo", &undo.fingerprint)?;
    if undo.bytes.len() > MAX_BLOCK_BYTES / 3 * 4 + 4 {
        return Err(AppError::invalid_argument("undo", "a block over 4 MiB"));
    }
    let app = state.inner().clone();
    run_unregistered(&op_id, DEFAULT_TIMEOUT, move |cancel| {
        app.open(&repo)?.undo_conflict_block(&path, &undo, &cancel)
    })
    .await
}

/// Continues, skips or aborts the operation in progress; with nothing in progress (it was
/// finished elsewhere), or a skip on a merge (which has none), the action is refused as an
/// argument error before git runs.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(state))]
pub async fn sequencer(
    state: State<'_, AppState>,
    repo: PathBuf,
    action: SequencerAction,
    op_id: String,
) -> Result<Outcome, AppError> {
    let app = state.inner().clone();
    run_unregistered(&op_id, WRITE_TIMEOUT, move |cancel| {
        let engine = app.open(&repo)?;
        match engine.operation_state()? {
            OperationState::None => {
                return Err(AppError::invalid_argument(
                    "action",
                    "no merge, rebase, cherry-pick or revert is in progress",
                ));
            }
            OperationState::Merge if action == SequencerAction::Skip => {
                return Err(AppError::invalid_argument("action", "a merge has no skip"));
            }
            _ => {}
        }
        engine.sequencer(action, &cancel).map_err(AppError::from)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(result: Result<(), AppError>) -> String {
        result.expect_err("refused").code
    }

    #[test]
    fn a_move_of_head_takes_full_hashes_only() {
        for good in ["a".repeat(40), "0123456789abcdef".repeat(4)] {
            assert!(validate_hash("from", &good).is_ok(), "{good}");
        }
        for bad in [
            "HEAD~1".to_owned(),
            "0".repeat(40),
            "0".repeat(64),
            "A".repeat(40),
            "a".repeat(39),
            "a".repeat(41),
            format!("-{}", "a".repeat(39)),
            String::new(),
        ] {
            assert_eq!(
                code(validate_hash("from", &bad)),
                "ipc.invalid_argument",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn names_follow_check_ref_format() {
        for good in [
            "main",
            "feature/tile-cache",
            "claude/fix-auth",
            "v2.3.1",
            "release/2.4",
            "ünïcödé",
            "a.b",
        ] {
            assert!(validate_name("name", good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "  ",
            "-x",
            "a b",
            "a..b",
            "a@{1}",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[b",
            "a\\b",
            "a/",
            "a.",
            "a//b",
            ".hidden",
            "a.lock",
            "@",
            "+develop",
            "line\nbreak",
        ] {
            assert_eq!(
                code(validate_name("name", bad)),
                "ipc.invalid_argument",
                "{bad:?}"
            );
        }
        let long = "x".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(code(validate_name("name", &long)), "ipc.invalid_argument");
    }

    #[test]
    fn revisions_may_carry_git_s_syntax_but_never_an_option() {
        for good in [
            "HEAD~3",
            "main^{commit}",
            "v1^{}",
            "a1b2c3d",
            "@{-1}",
            "origin/main",
        ] {
            assert!(validate_rev("rev", good).is_ok(), "{good}");
        }
        for bad in ["", "--hard", "-f", "a\0b", "a\tb"] {
            assert_eq!(
                code(validate_rev("rev", bad)),
                "ipc.invalid_argument",
                "{bad:?}"
            );
        }
        assert_eq!(code(validate_revs("revs", &[])), "ipc.invalid_argument");
        let many: Vec<String> = (0..=MAX_REVS).map(|i| format!("r{i}")).collect();
        assert_eq!(code(validate_revs("revs", &many)), "ipc.invalid_argument");
    }

    #[test]
    fn tag_messages_need_a_line() {
        assert!(validate_message("message", "v1\n\nnotes").is_ok());
        assert_eq!(
            code(validate_message("message", " \n\t")),
            "ipc.invalid_argument"
        );
    }

    #[test]
    fn conflicted_paths_are_spelled_as_git_lists_them() {
        let paths = |list: &[&str]| list.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>();
        // A leading dash is a name: git reads every argument after `--unresolve` as a path.
        let good = paths(&["src/una ruta/ñandú.ts", "-dash.txt", "README.md"]);
        assert!(validate_conflict_paths(&good).is_ok());
        for bad in ["a//b.txt", "dir/", "", "../x", "/abs"] {
            assert_eq!(
                code(validate_conflict_paths(&paths(&[bad]))),
                "ipc.invalid_argument",
                "{bad:?}"
            );
        }
        let backslash = validate_conflict_paths(&paths(&["sub\\x.txt"]));
        assert_eq!(backslash.is_err(), cfg!(windows));
        assert_eq!(code(validate_conflict_paths(&[])), "ipc.invalid_argument");
    }
}
