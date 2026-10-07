//! Ignore rules, the one write the engine makes outside git (ADR-0020): the line for an
//! untracked path (the path, its extension or its folder, each name escaped so the line
//! matches that name only), appended to `.gitignore` at the working tree's root or to
//! `info/exclude` in the common git directory without touching the file's other bytes, then
//! git's verdict on the path through `git check-ignore`.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

use super::staging::{root, LITERAL};
use super::Git2Engine;
use crate::cli::{run_git_cancellable, run_git_with_input};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{IgnoreOutcome, IgnorePlace, IgnoreRule, KeptBy};

/// A UTF-8 byte order mark, which git skips at the start of an ignore file.
const BOM: &[u8] = b"\xEF\xBB\xBF";

pub(super) fn ignore_path(
    engine: &Git2Engine,
    path: &str,
    rule: IgnoreRule,
    place: IgnorePlace,
    cancel: &Cancel,
) -> GitResult<IgnoreOutcome> {
    let invalid = |reason: &str| GitError::IgnoreInvalidPath {
        path: path.to_owned(),
        reason: reason.to_owned(),
    };
    let entry = entry(path).map_err(invalid)?;
    let line = rule_line(&entry, rule).ok_or_else(|| {
        invalid(match rule {
            IgnoreRule::Extension if entry.folder => "a folder has no extension to ignore",
            IgnoreRule::Extension => "the file name has no extension",
            IgnoreRule::Folder => "it is at the repository's root, in no folder",
            IgnoreRule::File => "the path names nothing",
        })
    })?;
    let root = root(engine);
    if fs::symlink_metadata(root.join(entry.names.join("/"))).is_err() {
        return Err(invalid("it is not in the working tree"));
    }
    if tracked(root, path, cancel)? {
        return Err(invalid(
            "it is tracked, and an ignore rule would not untrack it",
        ));
    }
    let file = match place {
        IgnorePlace::Gitignore => {
            let file = root.join(".gitignore");
            if !file.exists() && tracked(root, ".gitignore", cancel)? {
                return Err(GitError::IgnoreWriteFailed {
                    file,
                    reason: "the index holds it but the working tree does not (a sparse \
                             checkout): git reads its rules from the index, and a new file \
                             would replace them"
                        .to_owned(),
                });
            }
            file
        }
        IgnorePlace::Exclude => exclude_file(&engine.repo().common_dir)?,
    };
    // A timeout may have run out while git answered: nothing is written after it.
    cancel.check()?;
    let written = append_line(&file, &line)?;
    let ignored = is_ignored(root, path, cancel)?;
    let kept_by = if ignored {
        None
    } else {
        keeping_rule(root, path, cancel)?
    };
    Ok(IgnoreOutcome {
        line,
        file,
        written,
        ignored,
        kept_by,
    })
}

/// A repository-relative path as git lists it: its names, and whether it is a folder (git
/// lists an untracked nested repository with a trailing `/`).
#[derive(Debug, PartialEq, Eq)]
struct Entry<'a> {
    names: Vec<&'a str>,
    folder: bool,
}

/// The entry of `path`, or why it is none: empty, absolute, leaving the working tree, holding
/// a NUL or a line break (which no line of an ignore file can carry), or, on Windows, a name
/// with a `\` (a separator there), a `:` (a stream) or a trailing dot or space (dropped).
fn entry(path: &str) -> Result<Entry<'_>, &'static str> {
    if path.is_empty() {
        return Err("the path is empty");
    }
    if path.contains(['\0', '\n', '\r']) {
        return Err("the path holds a NUL or a line break");
    }
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if path.starts_with(['/', '\\']) || drive || Path::new(path).is_absolute() {
        return Err("the path is absolute");
    }
    let (body, folder) = match path.strip_suffix('/') {
        Some(body) => (body, true),
        None => (path, false),
    };
    let names: Vec<&str> = body.split('/').collect();
    if names
        .iter()
        .any(|name| name.is_empty() || *name == "." || *name == "..")
    {
        return Err("the path leaves the working tree or has an empty name");
    }
    if cfg!(windows)
        && names
            .iter()
            .any(|name| name.contains(['\\', ':']) || name.ends_with('.') || name.ends_with(' '))
    {
        return Err("the path holds a name Windows cannot spell as git lists it");
    }
    Ok(Entry { names, folder })
}

/// The rule's line for `entry`, or `None` when it has nothing for the rule: no extension
/// (`Makefile`, `.env`, `notes.`, a folder), or no folder above it (an entry at the root).
fn rule_line(entry: &Entry<'_>, rule: IgnoreRule) -> Option<String> {
    let (name, folders) = entry.names.split_last()?;
    match rule {
        IgnoreRule::File => {
            let mut line = anchored(&entry.names);
            if entry.folder {
                line.push('/');
            }
            Some(line)
        }
        IgnoreRule::Extension => {
            if entry.folder {
                return None;
            }
            let dot = name
                .rfind('.')
                .filter(|&at| at > 0 && at + 1 < name.len())?;
            Some(format!("*.{}", escape(&name[dot + 1..])))
        }
        IgnoreRule::Folder => (!folders.is_empty()).then(|| format!("{}/", anchored(folders))),
    }
}

/// `/` and the names, escaped: anchored at the root, so the line starts with neither `#` (a
/// comment) nor `!` (a negation), whatever the first name.
fn anchored(names: &[&str]) -> String {
    let escaped: Vec<String> = names.iter().map(|name| escape(name)).collect();
    format!("/{}", escaped.join("/"))
}

/// A name as a pattern that matches it alone: `\`, `*`, `?` and `[` take a backslash, and so
/// does each trailing space, which git strips otherwise.
fn escape(name: &str) -> String {
    let kept = name.trim_end_matches(' ');
    let mut out = String::with_capacity(name.len() + 4);
    for c in kept.chars() {
        if matches!(c, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(c);
    }
    for _ in kept.len()..name.len() {
        out.push_str("\\ ");
    }
    out
}

/// Whether the index holds `path` (`git ls-files`: a tracked file, an intent to add, a
/// conflict's stages, a skip-worktree entry of a sparse checkout).
fn tracked(root: &Path, path: &str, cancel: &Cancel) -> GitResult<bool> {
    let args = [LITERAL, "ls-files", "-z", "--", path];
    let exit = run_git_cancellable(root, &args, cancel)?;
    if exit.status != Some(0) {
        return Err(exit.into_failure(&args));
    }
    Ok(!exit.stdout.is_empty())
}

/// `info/exclude` in the common git directory, its folder created when missing; refused when
/// the folder is a link or a junction (`symlink_metadata` says so for both), since the line
/// would go wherever it points, or when it is not a folder.
fn exclude_file(common_dir: &Path) -> GitResult<std::path::PathBuf> {
    let info = common_dir.join("info");
    let file = info.join("exclude");
    let fail = |reason: String| GitError::IgnoreWriteFailed {
        file: file.clone(),
        reason,
    };
    match fs::symlink_metadata(&info) {
        Ok(meta) if meta.file_type().is_symlink() => Err(fail(format!(
            "{} is a link, which could lead outside the repository",
            info.display()
        ))),
        Ok(meta) if !meta.is_dir() => Err(fail(format!("{} is not a folder", info.display()))),
        Ok(_) => Ok(file.clone()),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(&info).map_err(|error| fail(error.to_string()))?;
            Ok(file.clone())
        }
        Err(error) => Err(fail(error.to_string())),
    }
}

/// Appends `line` to `file`, created when missing; false when the file already holds the line
/// as git reads it (after a byte order mark, without unescaped trailing spaces). The file's
/// last line is ended first, in the file's own line ending (`\r\n` when it holds one), and no
/// other byte changes. Anything but a regular file is refused: a link would take the line
/// wherever it points, a folder cannot hold it, and reading a pipe would never end.
fn append_line(file: &Path, line: &str) -> GitResult<bool> {
    let fail = |reason: String| GitError::IgnoreWriteFailed {
        file: file.to_path_buf(),
        reason,
    };
    match fs::symlink_metadata(file) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(fail("it is a symbolic link".to_owned()))
        }
        Ok(meta) if !meta.is_file() => return Err(fail("it is not a regular file".to_owned())),
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(fail(error.to_string())),
    }
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(fail(error.to_string())),
    };
    let text = bytes.strip_prefix(BOM).unwrap_or(&bytes);
    let present = text.split(|&byte| byte == b'\n').any(|held| {
        let held = held.strip_suffix(b"\r").unwrap_or(held);
        without_trailing_spaces(held) == line.as_bytes()
    });
    if present {
        return Ok(false);
    }
    let eol: &[u8] = if bytes.windows(2).any(|pair| pair == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    };
    let mut out = Vec::with_capacity(line.len() + 4);
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        out.extend_from_slice(eol);
    }
    out.extend_from_slice(line.as_bytes());
    out.extend_from_slice(eol);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .and_then(|mut handle| handle.write_all(&out))
        .map_err(|error| fail(error.to_string()))?;
    Ok(true)
}

/// A line of an ignore file without its unescaped trailing spaces, as git reads it (its
/// `trim_trailing_spaces`): a backslash keeps the character after it, a space included.
fn without_trailing_spaces(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    let mut spaces_from: Option<usize> = None;
    let mut at = 0;
    while at < line.len() {
        match line[at] {
            b' ' => {
                spaces_from.get_or_insert(at);
            }
            b'\\' => {
                spaces_from = None;
                at += 1;
            }
            _ => spaces_from = None,
        }
        at += 1;
    }
    if let Some(from) = spaces_from {
        end = from;
    }
    &line[..end]
}

/// `path` as `git check-ignore` takes it: from `./`, since the command reads its paths as
/// pathspecs and refuses `--literal-pathspecs`, so a name starting with `:` would be magic.
fn relative(path: &str) -> String {
    format!("./{path}")
}

/// Whether git ignores `path`: `git check-ignore -q --no-index` exits 0, or 1 when it does
/// not. `--no-index` because the path, read as a glob, may match a tracked file (`br[1].txt`
/// matches `br1.txt`), which check-ignore then skips as tracked; this one is untracked. `-v`
/// cannot say it: it exits 0 when the last rule matching the path is a `!` re-including it.
fn is_ignored(root: &Path, path: &str, cancel: &Cancel) -> GitResult<bool> {
    let path = relative(path);
    let args = ["check-ignore", "-q", "--no-index", "--", path.as_str()];
    let exit = run_git_cancellable(root, &args, cancel)?;
    match exit.status {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(exit.into_failure(&args)),
    }
}

/// The last rule matching `path` (`git check-ignore -v -n -z --no-index --stdin`, which takes
/// `-z` only with `--stdin`: source, line, pattern and path, NUL-separated, the first three
/// empty when no rule matches).
fn keeping_rule(root: &Path, path: &str, cancel: &Cancel) -> GitResult<Option<KeptBy>> {
    let args = ["check-ignore", "-v", "-n", "-z", "--no-index", "--stdin"];
    let mut input = relative(path).into_bytes();
    input.push(0);
    let exit = run_git_with_input(root, &args, input, cancel)?;
    if !matches!(exit.status, Some(0 | 1)) {
        return Err(exit.into_failure(&args));
    }
    let mut fields = exit.stdout.split(|&byte| byte == 0);
    let source = String::from_utf8_lossy(fields.next().unwrap_or_default()).into_owned();
    let line = String::from_utf8_lossy(fields.next().unwrap_or_default())
        .parse()
        .unwrap_or(0);
    let pattern = String::from_utf8_lossy(fields.next().unwrap_or_default()).into_owned();
    Ok((!source.is_empty()).then_some(KeptBy {
        source,
        line,
        pattern,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(path: &str, rule: IgnoreRule) -> Option<String> {
        rule_line(&entry(path).expect("a path"), rule)
    }

    #[test]
    fn each_rule_s_line() {
        assert_eq!(
            line("logs/debug.log", IgnoreRule::File).as_deref(),
            Some("/logs/debug.log")
        );
        assert_eq!(
            line("logs/debug.log", IgnoreRule::Extension).as_deref(),
            Some("*.log")
        );
        assert_eq!(
            line("logs/debug.log", IgnoreRule::Folder).as_deref(),
            Some("/logs/")
        );
        assert_eq!(
            line("a/b/c.txt", IgnoreRule::Folder).as_deref(),
            Some("/a/b/")
        );
        assert_eq!(
            line("archive.tar.gz", IgnoreRule::Extension).as_deref(),
            Some("*.gz")
        );
        assert_eq!(
            line(".env.local", IgnoreRule::Extension).as_deref(),
            Some("*.local")
        );
        assert_eq!(
            line(".env.local", IgnoreRule::File).as_deref(),
            Some("/.env.local")
        );
    }

    #[test]
    fn a_folder_git_lists_with_its_slash_keeps_it() {
        // An untracked nested repository: `nested/`, or one deeper in a folder.
        assert_eq!(
            line("nested/", IgnoreRule::File).as_deref(),
            Some("/nested/")
        );
        assert_eq!(line("nested/", IgnoreRule::Extension), None);
        assert_eq!(line("nested/", IgnoreRule::Folder), None);
        assert_eq!(
            line("tools/clone.d/", IgnoreRule::File).as_deref(),
            Some("/tools/clone.d/")
        );
        assert_eq!(line("tools/clone.d/", IgnoreRule::Extension), None);
        assert_eq!(
            line("tools/clone.d/", IgnoreRule::Folder).as_deref(),
            Some("/tools/")
        );
    }

    #[test]
    fn a_path_without_an_extension_or_a_folder_has_no_such_rule() {
        for name in ["Makefile", ".env"] {
            assert_eq!(line(name, IgnoreRule::Extension), None, "{name}");
        }
        // A trailing dot: no extension where such a name exists (Windows drops the dot).
        if !cfg!(windows) {
            assert_eq!(line("notes.", IgnoreRule::Extension), None);
        }
        assert_eq!(line("Makefile", IgnoreRule::Folder), None);
    }

    #[test]
    fn names_are_escaped_to_match_themselves_alone() {
        assert_eq!(escape("star*.txt"), "star\\*.txt");
        assert_eq!(escape("q?.txt"), "q\\?.txt");
        assert_eq!(escape("br[1].txt"), "br\\[1].txt");
        assert_eq!(escape("back\\slash"), "back\\\\slash");
        assert_eq!(escape("trail  "), "trail\\ \\ ");
        assert_eq!(escape("mid space"), "mid space");
        // Anchored, a leading `#` or `!` is neither a comment nor a negation.
        assert_eq!(
            line("#notes.txt", IgnoreRule::File).as_deref(),
            Some("/#notes.txt")
        );
        assert_eq!(
            line("!bang.txt", IgnoreRule::File).as_deref(),
            Some("/!bang.txt")
        );
        assert_eq!(
            line("x.lo*", IgnoreRule::Extension).as_deref(),
            Some("*.lo\\*")
        );
    }

    #[test]
    fn paths_that_are_not_repository_paths_are_refused() {
        for path in [
            "",
            "/",
            "/etc/hosts",
            "\\server\\share",
            "C:/Windows/win.ini",
            "c:file",
            "../outside",
            "a/../b",
            "a//b",
            "./a",
            "a//",
            "line\nbreak",
            "nul\0byte",
        ] {
            assert!(entry(path).is_err(), "{path:?}");
        }
        assert_eq!(
            entry("a b/ü.txt"),
            Ok(Entry {
                names: vec!["a b", "ü.txt"],
                folder: false
            })
        );
        assert_eq!(
            entry("nested/"),
            Ok(Entry {
                names: vec!["nested"],
                folder: true
            })
        );
    }

    #[cfg(windows)]
    #[test]
    fn names_windows_spells_otherwise_are_refused() {
        // `\` separates names there, `:` opens a stream, and a trailing dot or space is dropped.
        for path in [
            "logs\\debug.log",
            "README.md::$DATA",
            "dots.",
            "a/b ",
            "x/.. ",
        ] {
            assert!(entry(path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn a_line_is_read_without_its_unescaped_trailing_spaces() {
        assert_eq!(without_trailing_spaces(b"*.log  "), b"*.log");
        assert_eq!(without_trailing_spaces(b"/trail\\ "), b"/trail\\ ");
        assert_eq!(without_trailing_spaces(b"/trail\\  "), b"/trail\\ ");
        // An escaped backslash does not escape the space after it.
        assert_eq!(without_trailing_spaces(b"/x\\\\ "), b"/x\\\\");
        assert_eq!(without_trailing_spaces(b"a b"), b"a b");
        assert_eq!(without_trailing_spaces(b"   "), b"");
    }
}
