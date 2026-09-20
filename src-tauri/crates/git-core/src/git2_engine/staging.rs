//! The staging writes: stage, unstage and discard paths, apply a selection of hunks and
//! lines, commit. All through the git CLI in the repository's root (a linked worktree
//! opened as the context has its own index), the paths on stdin as literal NUL-separated
//! pathspecs (no argv limit, no glob or `:` magic, a leading dash harmless), the message and
//! the patch on stdin too. Every failure of git is [`GitError::Cli`] with its stderr; a
//! cancel stops the child.

use std::path::Path;

use git2::ErrorCode;

use super::{patch, Git2Engine};
use crate::cli::{run_git_cancellable, run_git_with_input, CliExit};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{ChangeKind, CommitContext, CommitRequest, PatchSelection, SelectionTarget};

/// Global options and the pathspec options every path command shares.
const LITERAL: &str = "--literal-pathspecs";
const FROM_STDIN: [&str; 2] = ["--pathspec-from-file=-", "--pathspec-file-nul"];

fn root(engine: &Git2Engine) -> &Path {
    &GitEngine::repo(engine).root
}

/// Turns a non-zero status into [`GitError::Cli`].
fn judged(args: &[&str], exit: CliExit) -> GitResult<CliExit> {
    if exit.status == Some(0) {
        Ok(exit)
    } else {
        Err(GitError::Cli {
            command: args.join(" "),
            status: exit.status,
            stderr: exit.stderr,
        })
    }
}

/// The NUL-separated list `--pathspec-from-file=-` reads.
fn nul_list(paths: &[String]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(paths.iter().map(|p| p.len() + 1).sum());
    for path in paths {
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(0);
    }
    bytes
}

/// Runs `git --literal-pathspecs <verb> <options> --pathspec-from-file=- --pathspec-file-nul`
/// with `paths` on stdin; nothing runs for an empty list.
fn on_paths(
    engine: &Git2Engine,
    verb: &[&str],
    paths: &[String],
    cancel: &Cancel,
) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec![LITERAL];
    args.extend_from_slice(verb);
    args.extend_from_slice(&FROM_STDIN);
    let exit = run_git_with_input(root(engine), &args, nul_list(paths), cancel)?;
    judged(&args, exit).map(|_| ())
}

/// See [`GitEngine::stage_paths`].
#[tracing::instrument(level = "debug", skip_all, fields(paths = paths.len()))]
pub(super) fn stage_paths(engine: &Git2Engine, paths: &[String], cancel: &Cancel) -> GitResult<()> {
    on_paths(engine, &["add", "-A"], paths, cancel)
}

/// See [`GitEngine::unstage_paths`]. `git restore --staged` touches the given entries only
/// (0.06 s for ten paths on the synthetic tree), where `git reset` refreshes the whole index
/// afterwards (0.9 s there); an unborn branch has no HEAD to restore from, so it takes
/// `git reset`, which resets against the empty tree.
#[tracing::instrument(level = "debug", skip_all, fields(paths = paths.len()))]
pub(super) fn unstage_paths(
    engine: &Git2Engine,
    paths: &[String],
    cancel: &Cancel,
) -> GitResult<()> {
    if unborn(engine)? {
        on_paths(engine, &["reset", "-q"], paths, cancel)
    } else {
        on_paths(engine, &["restore", "--staged"], paths, cancel)
    }
}

/// Whether HEAD names no commit yet.
fn unborn(engine: &Git2Engine) -> GitResult<bool> {
    engine.with_repo(|repo| match repo.head() {
        Ok(_) => Ok(false),
        Err(error) if error.code() == ErrorCode::UnbornBranch => Ok(true),
        Err(error) => Err(GitError::from(error)),
    })
}

/// See [`GitEngine::discard_paths`]. `git clean` takes no pathspec file, so its paths go
/// on argv in runs that stay well under the shortest command-line limit (Windows, 32 K);
/// the error names the count of paths, not the paths (the span logs them).
#[tracing::instrument(level = "debug", skip_all, fields(tracked = tracked.len(), untracked = untracked.len()))]
pub(super) fn discard_paths(
    engine: &Git2Engine,
    tracked: &[String],
    untracked: &[String],
    cancel: &Cancel,
) -> GitResult<()> {
    on_paths(engine, &["restore", "--worktree"], tracked, cancel)?;
    for chunk in argv_chunks(untracked) {
        let mut args = vec![LITERAL, "clean", "-f", "--"];
        args.extend(chunk.iter().map(String::as_str));
        let exit = run_git_cancellable(root(engine), &args, cancel)?;
        if exit.status != Some(0) {
            return Err(GitError::Cli {
                command: format!("clean -f -- ({} paths)", chunk.len()),
                status: exit.status,
                stderr: exit.stderr,
            });
        }
    }
    Ok(())
}

/// Longest argv a run of `git clean` carries, in bytes of paths.
const ARGV_CHUNK_BYTES: usize = 16 * 1024;

/// Splits paths into runs whose joined length stays under [`ARGV_CHUNK_BYTES`].
fn argv_chunks(paths: &[String]) -> Vec<&[String]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut bytes = 0;
    for (index, path) in paths.iter().enumerate() {
        if bytes > 0 && bytes + path.len() + 1 > ARGV_CHUNK_BYTES {
            chunks.push(&paths[start..index]);
            start = index;
            bytes = 0;
        }
        bytes += path.len() + 1;
    }
    if start < paths.len() {
        chunks.push(&paths[start..]);
    }
    chunks
}

/// See [`GitEngine::apply_selection`]. A file added or deleted and selected whole is the
/// path operation itself (`git add` records the mode of an executable file, which a patch
/// header could only guess); everything else is a patch.
#[tracing::instrument(level = "debug", skip_all, fields(path = %selection.path, target = ?target))]
pub(super) fn apply_selection(
    engine: &Git2Engine,
    selection: &PatchSelection,
    target: SelectionTarget,
    cancel: &Cancel,
) -> GitResult<()> {
    let reverse = target != SelectionTarget::Stage;
    let whole_file = matches!(selection.status, ChangeKind::Added | ChangeKind::Deleted)
        && patch::is_whole(selection);
    if whole_file {
        let path = std::slice::from_ref(&selection.path);
        return match (target, selection.status) {
            (SelectionTarget::Stage, _) => stage_paths(engine, path, cancel),
            (SelectionTarget::Unstage, _) => unstage_paths(engine, path, cancel),
            (SelectionTarget::Discard, ChangeKind::Added) => {
                discard_paths(engine, &[], path, cancel)
            }
            (SelectionTarget::Discard, _) => discard_paths(engine, path, &[], cancel),
        };
    }
    let patch = match patch::build(selection, reverse) {
        Ok(Some(patch)) => patch,
        Ok(None) => return Ok(()),
        Err(reason) => return Err(GitError::Git(reason)),
    };
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if target != SelectionTarget::Discard {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    let exit = run_git_with_input(root(engine), &args, patch.into_bytes(), cancel)?;
    judged(&args, exit).map(|_| ())
}

/// See [`GitEngine::commit`]. `--cleanup=strip` drops comment lines (`core.commentChar`)
/// and trailing blanks as an editor session would, so a prefilled template's comments never
/// land in the message.
#[tracing::instrument(level = "debug", skip_all, fields(amend = request.amend, signoff = request.signoff))]
pub(super) fn commit(
    engine: &Git2Engine,
    request: &CommitRequest,
    cancel: &Cancel,
) -> GitResult<String> {
    let mut args = vec!["commit", "-q", "--cleanup=strip", "-F", "-"];
    if request.amend {
        args.push("--amend");
    }
    if request.signoff {
        args.push("--signoff");
    }
    let exit = run_git_with_input(
        root(engine),
        &args,
        request.message.clone().into_bytes(),
        cancel,
    )?;
    judged(&args, exit)?;
    let head = judged(
        &["rev-parse", "HEAD"],
        run_git_cancellable(root(engine), &["rev-parse", "HEAD"], cancel)?,
    )?;
    Ok(String::from_utf8_lossy(&head.stdout).trim().to_owned())
}

/// See [`GitEngine::commit_context`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn commit_context(engine: &Git2Engine, cancel: &Cancel) -> GitResult<CommitContext> {
    let cwd = root(engine);
    let ident = judged(
        &["var", "GIT_AUTHOR_IDENT"],
        run_git_cancellable(cwd, &["var", "GIT_AUTHOR_IDENT"], cancel)?,
    )?;
    let ident = String::from_utf8_lossy(&ident.stdout);
    // `Name <email> <seconds> <zone>`: the ident without the time.
    let author = ident.find('>').map_or_else(
        || ident.trim().to_owned(),
        |end| ident[..=end].trim().to_owned(),
    );
    let unborn = unborn(engine)?;
    let head_message = if unborn {
        None
    } else {
        let log = judged(
            &["log", "-1", "--format=%B"],
            run_git_cancellable(cwd, &["log", "-1", "--format=%B"], cancel)?,
        )?;
        Some(String::from_utf8_lossy(&log.stdout).trim_end().to_owned())
    };
    let template = template_text(cwd, cancel)?;
    Ok(CommitContext {
        author,
        template,
        head_message,
        unborn,
    })
}

/// Longest `commit.template` shipped to the commit box.
const MAX_TEMPLATE_BYTES: usize = 64 * 1024;

/// The text of `commit.template`, `~` expanded; a missing setting, a lookup git cannot make
/// (no home folder to expand `~` into, a broken configuration file) or an unreadable file
/// is no template, logged, as git itself only warns about it.
fn template_text(cwd: &Path, cancel: &Cancel) -> GitResult<Option<String>> {
    let args = ["config", "--get", "--path", "commit.template"];
    let exit = run_git_cancellable(cwd, &args, cancel)?;
    match exit.status {
        Some(0) => {}
        // Not set.
        Some(1) => return Ok(None),
        _ => {
            tracing::warn!(stderr = %exit.stderr.trim(), "commit.template cannot be read");
            return Ok(None);
        }
    }
    let raw = String::from_utf8_lossy(&exit.stdout).trim().to_owned();
    if raw.is_empty() {
        return Ok(None);
    }
    let path = expand_home(&raw);
    let path = if Path::new(&path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        cwd.join(path)
    };
    match std::fs::read(&path) {
        Ok(bytes) if bytes.len() > MAX_TEMPLATE_BYTES => {
            tracing::warn!(path = %path.display(), bytes = bytes.len(), "commit.template too large");
            Ok(None)
        }
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "commit.template cannot be read");
            Ok(None)
        }
    }
}

/// `~` and `~/…` as the shell would read them.
fn expand_home(path: &str) -> String {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| home.to_string_lossy().into_owned());
    match (path.strip_prefix('~'), home) {
        (Some(rest), Some(home))
            if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') =>
        {
            format!("{home}{rest}")
        }
        _ => path.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_become_a_nul_separated_list() {
        assert_eq!(nul_list(&["a b".to_owned(), "c".to_owned()]), b"a b\0c\0");
        assert!(nul_list(&[]).is_empty());
    }

    #[test]
    fn argv_runs_stay_under_the_limit() {
        let paths: Vec<String> = (0..2000)
            .map(|i| format!("folder/file-{i:05}.txt"))
            .collect();
        let chunks = argv_chunks(&paths);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.iter().map(|c| c.len()).sum::<usize>(), 2000);
        for chunk in &chunks {
            let bytes: usize = chunk.iter().map(|p| p.len() + 1).sum();
            assert!(bytes <= ARGV_CHUNK_BYTES);
        }
        assert!(argv_chunks(&[]).is_empty());
    }

    #[test]
    fn a_tilde_expands_to_the_home_folder() {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .expect("a home")
            .to_string_lossy()
            .into_owned();
        assert_eq!(expand_home("~/.gitmessage"), format!("{home}/.gitmessage"));
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~other/x"), "~other/x");
        assert_eq!(expand_home("/etc/msg"), "/etc/msg");
    }
}
