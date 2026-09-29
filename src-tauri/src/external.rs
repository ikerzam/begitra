//! "Open in terminal" and "Open in editor": spawn a configurable command template with the
//! repository path substituted, detached from the app, never through a shell.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{codes, AppError};

/// Splits a template into argv after replacing `{line}` and then `{path}` in each word, so a
/// file named `{line}.ts` keeps its name.
///
/// Splitting happens before substitution, so a path with spaces stays one argument. Windows
/// Terminal (`wt`) reads an unescaped `;` in any argument as the start of another command, so
/// the path's semicolons are escaped for it. Fails with `external.spawn_failed` when the
/// template is empty or has unbalanced quotes.
pub fn argv(template: &str, path: &Path, line: Option<u32>) -> Result<Vec<String>, AppError> {
    let words = split_template(template).map_err(|error| {
        AppError::new(
            codes::EXTERNAL_SPAWN_FAILED,
            "The command template could not be parsed",
        )
        .with_detail(format!("{template}: {error}"))
    })?;
    if words.is_empty() {
        return Err(AppError::new(
            codes::EXTERNAL_SPAWN_FAILED,
            "The command template is empty",
        ));
    }
    let mut path = path.to_string_lossy().into_owned();
    if words
        .first()
        .map(|program| program_name(program))
        .as_deref()
        == Some("wt")
    {
        path = path.replace(';', "\\;");
    }
    let line = line.map(|line| line.to_string()).unwrap_or_default();
    Ok(words
        .into_iter()
        .map(|word| word.replace("{line}", &line).replace("{path}", &path))
        .collect())
}

/// A program's file name without its folder and extension, in lower case: `cmd` for
/// `C:\Windows\System32\CMD.EXE`.
fn program_name(program: &str) -> String {
    let file = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let lower = file.to_ascii_lowercase();
    [".exe", ".cmd", ".bat", ".com"]
        .iter()
        .find_map(|extension| lower.strip_suffix(extension))
        .unwrap_or(&lower)
        .to_owned()
}

/// The characters a shell reads in a command line it is given, by shell, for a template that
/// runs one: a path holding one of them is refused rather than handed to it.
fn shell_specials(program: &str) -> Option<&'static str> {
    match program_name(program).as_str() {
        "cmd" => Some("&|<>^%!\"()"),
        "powershell" | "pwsh" => Some(";&|$`(){}<>\"'@#"),
        "sh" | "bash" | "zsh" | "dash" | "fish" | "ksh" | "wsl" => Some(";&|$`(){}<>\"'\\*?[]~!#"),
        _ => None,
    }
}

/// Why a template that runs a shell may not take `path`: the first character of the path that
/// shell would read; `None` for any other program, or a path it reads as plain text.
fn shell_refusal(program: &str, path: &Path) -> Option<char> {
    let specials = shell_specials(program)?;
    path.to_string_lossy()
        .chars()
        .find(|c| specials.contains(*c) || c.is_control())
}

/// The folder a command starts in: `path` itself when it is a folder, else its parent, since
/// no platform starts a process in a file.
pub fn working_directory(path: &Path) -> &Path {
    if path.is_dir() {
        return path;
    }
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(path)
}

/// Splits a template into words: POSIX shell rules on Unix (`shell-words`), and on Windows
/// whitespace with double quotes only, since a backslash is a path separator there
/// (`C:\tools\wezterm.exe` must survive) and never an escape.
fn split_template(template: &str) -> Result<Vec<String>, String> {
    if cfg!(windows) {
        split_windows(template)
    } else {
        shell_words::split(template).map_err(|error| error.to_string())
    }
}

/// Windows template words: separated by whitespace, grouped by double quotes (which are
/// removed), with a backslash before a quote inside quotes standing for a literal quote;
/// nothing else is special.
fn split_windows(template: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quoted = false;
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                in_word = true;
            }
            '\\' if quoted && chars.peek() == Some(&'"') => {
                word.push('"');
                chars.next();
            }
            c if c.is_whitespace() && !quoted => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            c => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if quoted {
        return Err("missing closing quote".to_owned());
    }
    if in_word {
        words.push(word);
    }
    Ok(words)
}

/// Spawns `argv` detached, with `cwd` as its working directory. The child is reaped by a
/// background thread so it never lingers as a zombie, and its output is not captured.
fn spawn_detached(argv: &[String], cwd: &Path) -> std::io::Result<()> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| std::io::Error::other("empty argv"))?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_CONSOLE: console programs such as `cmd /K` get their own window instead
        // of attaching to the app, which has none.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    // A thread the platform refuses leaves the child unreaped, never the open undone.
    let _ = std::thread::Builder::new()
        .name("begitra-external-wait".to_owned())
        .spawn(move || {
            let _ = child.wait();
        });
    Ok(())
}

/// Opens `path` (a folder, or a file at `line`) with the first template that spawns, started
/// in the folder it opens or holds; a template that names `{line}` waits for a line, and one
/// that runs a shell (`cmd /C …`, `sh -c …`) is skipped for a path holding a character that
/// shell would read. A path that is not on disk fails with `external.not_found` before any
/// template runs; when no template spawns, `external.spawn_failed`, whose `detail` lists every
/// argv that was tried and why it failed.
#[tracing::instrument(level = "debug", skip_all, fields(path = %path.display(), line = ?line))]
pub fn open_with(
    templates: &[String],
    path: &Path,
    line: Option<u32>,
) -> Result<Vec<String>, AppError> {
    // An editor opens a missing path as a new, unsaved file, each in its own way; the
    // refusal is Begitra's, before anything starts. A link is followed: one whose target is
    // gone is not on disk either. A name the platform cannot hold (`?` on Windows) and a
    // path through a file are not there the same way.
    if let Err(error) = std::fs::metadata(path) {
        use std::io::ErrorKind;
        if matches!(
            error.kind(),
            ErrorKind::NotFound | ErrorKind::NotADirectory | ErrorKind::InvalidFilename
        ) {
            return Err(
                AppError::new(codes::EXTERNAL_NOT_FOUND, "The path is not on disk")
                    .with_detail(path.display().to_string()),
            );
        }
    }
    let cwd = working_directory(path);
    let mut attempts = Vec::new();
    for template in templates {
        if line.is_none() && template.contains("{line}") {
            attempts.push(format!("{template}: needs a line"));
            continue;
        }
        let argv = match argv(template, path, line) {
            Ok(argv) => argv,
            Err(error) => {
                attempts.push(error.detail.unwrap_or(error.message));
                continue;
            }
        };
        if let Some(special) = argv
            .first()
            .and_then(|program| shell_refusal(program, path))
        {
            attempts.push(format!(
                "{template}: runs a shell, which would read {special:?} in the path"
            ));
            continue;
        }
        match spawn_detached(&argv, cwd) {
            Ok(()) => return Ok(argv),
            Err(error) => attempts.push(format!("{}: {error}", argv.join(" "))),
        }
    }
    Err(AppError::new(
        codes::EXTERNAL_SPAWN_FAILED,
        "The command could not be started",
    )
    .with_detail(attempts.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A template that spawns and exits at once.
    fn harmless() -> String {
        if cfg!(windows) {
            "cmd /C exit 0".to_owned()
        } else {
            "true".to_owned()
        }
    }

    #[test]
    fn splits_before_substituting_so_spaces_survive() {
        let path = Path::new("C:/repos/my project");
        let words = argv("wt -d {path}", path, None).expect("argv");
        assert_eq!(words, vec!["wt", "-d", "C:/repos/my project"]);
        let words =
            argv("x-terminal-emulator --working-directory={path}", path, None).expect("argv");
        assert_eq!(
            words,
            vec![
                "x-terminal-emulator",
                "--working-directory=C:/repos/my project"
            ]
        );
        let words = argv(r#"code "{path}" --new-window"#, path, None).expect("argv");
        assert_eq!(words, vec!["code", "C:/repos/my project", "--new-window"]);
    }

    #[test]
    fn a_path_named_like_a_placeholder_keeps_its_name() {
        let path = Path::new("C:/r/{line}.ts");
        let words = argv("code.cmd -g {path}:{line}", path, Some(42)).expect("argv");
        assert_eq!(words, vec!["code.cmd", "-g", "C:/r/{line}.ts:42"]);
        let words = argv("code.cmd {path}", path, None).expect("argv");
        assert_eq!(words, vec!["code.cmd", "C:/r/{line}.ts"]);
    }

    #[test]
    fn windows_terminal_gets_its_semicolons_escaped() {
        let path = Path::new("C:/code/a;calc");
        let words = argv("wt -d {path}", path, None).expect("argv");
        assert_eq!(words, vec!["wt", "-d", r"C:/code/a\;calc"]);
        let words = argv("code.cmd {path}", path, None).expect("argv");
        assert_eq!(words, vec!["code.cmd", "C:/code/a;calc"]);
    }

    #[test]
    fn a_shell_never_gets_a_path_it_would_read() {
        let dir = tempfile::tempdir().expect("temp dir");
        let hostile = dir.path().join("a&md PWNED&.ts");
        std::fs::write(&hostile, "x\n").expect("write");
        let templates = vec![
            "cmd /C start \"\" editor.exe {path}".to_owned(),
            "C:/Windows/System32/CMD.EXE /C echo {path}".to_owned(),
            "sh -c \"editor {path}\"".to_owned(),
        ];
        let error = open_with(&templates, &hostile, None).expect_err("every template skipped");
        assert_eq!(error.code, codes::EXTERNAL_SPAWN_FAILED);
        let detail = error.detail.expect("detail");
        assert_eq!(detail.matches("runs a shell").count(), 3, "{detail}");
        assert!(!dir.path().join("PWNED").exists());
        // A plain path goes to the same shell template.
        assert_eq!(
            shell_refusal("cmd", Path::new("C:/code/geo/src/a.ts")),
            None
        );
        assert_eq!(shell_refusal("code.cmd", &hostile), None);
    }

    #[test]
    fn a_line_goes_where_its_placeholder_is() {
        let path = Path::new("C:/repos/my project/src/a.ts");
        let words = argv("code.cmd -g {path}:{line}", path, Some(42)).expect("argv");
        assert_eq!(
            words,
            vec!["code.cmd", "-g", "C:/repos/my project/src/a.ts:42"]
        );
        let words = argv("idea64.exe --line {line} {path}", path, Some(7)).expect("argv");
        assert_eq!(
            words,
            vec!["idea64.exe", "--line", "7", "C:/repos/my project/src/a.ts"]
        );
    }

    #[test]
    fn a_file_opens_with_its_folder_as_the_working_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("a file.ts");
        std::fs::write(&file, "const a = 1;\n").expect("write");
        // A file cannot be a process's working directory: the editor starts in its folder.
        let argv = open_with(&[harmless()], &file, None).expect("spawns in the file's folder");
        assert_eq!(argv[0], harmless().split(' ').next().expect("program"));
        assert_eq!(working_directory(&file), dir.path());
        assert_eq!(working_directory(dir.path()), dir.path());
    }

    #[test]
    fn a_template_with_a_line_waits_for_one() {
        let dir = tempfile::tempdir().expect("temp dir");
        let templates = vec![
            "begitra-no-such-editor -g {path}:{line}".to_owned(),
            harmless(),
        ];
        // Without a line the first template is skipped, not run with a literal `{line}`.
        let argv = open_with(&templates, dir.path(), None).expect("the second spawns");
        let expected: Vec<String> = harmless().split(' ').map(str::to_owned).collect();
        assert_eq!(argv, expected);
        // With a line, a template that names it runs, with the line in its place.
        let with_line = format!("{} {{line}}", harmless());
        let argv = open_with(&[with_line], dir.path(), Some(5)).expect("spawns with the line");
        assert_eq!(argv.last().map(String::as_str), Some("5"));
        let error = open_with(&templates[..1], dir.path(), None).expect_err("nothing to run");
        assert_eq!(error.code, codes::EXTERNAL_SPAWN_FAILED);
        assert!(error.detail.expect("detail").contains("needs a line"));
    }

    #[test]
    fn a_path_not_on_disk_is_refused_before_any_template_runs() {
        let dir = tempfile::tempdir().expect("temp dir");
        let missing = dir.path().join("gone").join("tiles.ts");
        let error = open_with(&[harmless()], &missing, Some(3)).expect_err("refused");
        assert_eq!(error.code, codes::EXTERNAL_NOT_FOUND);
        assert!(error.detail.expect("detail").contains("tiles.ts"));
    }

    #[test]
    fn windows_words_keep_backslashes_and_group_quotes() {
        let words = split_windows(r#"C:\tools\wezterm.exe start --cwd "{path}" "a \"b\" c""#)
            .expect("words");
        assert_eq!(
            words,
            vec![
                r"C:\tools\wezterm.exe",
                "start",
                "--cwd",
                "{path}",
                r#"a "b" c"#
            ]
        );
        assert_eq!(
            split_windows("  cmd   /K  ").expect("words"),
            vec!["cmd", "/K"]
        );
        assert!(split_windows(r#"code "{path}"#).is_err());
        assert_eq!(split_windows("").expect("words"), Vec::<String>::new());
    }

    #[test]
    fn rejects_empty_and_unbalanced_templates() {
        let path = Path::new("/r");
        assert_eq!(
            argv("", path, None).expect_err("empty").code,
            codes::EXTERNAL_SPAWN_FAILED
        );
        let error = argv("code \"{path}", path, None).expect_err("unbalanced");
        assert_eq!(error.code, codes::EXTERNAL_SPAWN_FAILED);
        assert!(error.detail.expect("detail").contains("code"));
    }

    #[test]
    fn a_missing_executable_maps_to_spawn_failed_with_the_argv_in_detail() {
        let cwd = std::env::temp_dir();
        let templates = vec![
            "begitra-no-such-terminal-1 {path}".to_owned(),
            "begitra-no-such-terminal-2 --cwd {path}".to_owned(),
        ];
        let error = open_with(&templates, &cwd, None).expect_err("must fail");
        assert_eq!(error.code, codes::EXTERNAL_SPAWN_FAILED);
        let detail = error.detail.expect("detail");
        assert!(detail.contains("begitra-no-such-terminal-1"));
        assert!(detail.contains("begitra-no-such-terminal-2 --cwd"));
    }

    #[test]
    fn falls_through_to_the_next_template() {
        let cwd = std::env::temp_dir();
        let ok = harmless();
        let templates = vec!["begitra-no-such-terminal {path}".to_owned(), ok.clone()];
        let argv = open_with(&templates, &cwd, None).expect("second template spawns");
        assert_eq!(argv[0], ok.split(' ').next().expect("program"));
    }
}
