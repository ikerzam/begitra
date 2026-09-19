//! "Open in terminal" and "Open in editor": spawn a configurable command template with the
//! repository path substituted, detached from the app, never through a shell.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{codes, AppError};

/// Splits a template into argv after replacing `{path}` in each word.
///
/// Splitting happens before substitution, so a path with spaces stays one argument. Fails with
/// `external.spawn_failed` when the template is empty or has unbalanced quotes.
pub fn argv(template: &str, path: &Path) -> Result<Vec<String>, AppError> {
    let words = shell_words::split(template).map_err(|error| {
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
    let path = path.to_string_lossy();
    Ok(words
        .into_iter()
        .map(|word| word.replace("{path}", &path))
        .collect())
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
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Tries each template in order and returns on the first that spawns. When none does, fails
/// with `external.spawn_failed`; `detail` lists every argv that was tried and why it failed.
#[tracing::instrument(level = "debug", skip_all, fields(cwd = %cwd.display()))]
pub fn open_with(templates: &[String], cwd: &Path) -> Result<Vec<String>, AppError> {
    let mut attempts = Vec::new();
    for template in templates {
        let argv = match argv(template, cwd) {
            Ok(argv) => argv,
            Err(error) => {
                attempts.push(error.detail.unwrap_or(error.message));
                continue;
            }
        };
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

    #[test]
    fn splits_before_substituting_so_spaces_survive() {
        let path = Path::new("C:/repos/my project");
        let words = argv("wt -d {path}", path).expect("argv");
        assert_eq!(words, vec!["wt", "-d", "C:/repos/my project"]);
        let words = argv("x-terminal-emulator --working-directory={path}", path).expect("argv");
        assert_eq!(
            words,
            vec![
                "x-terminal-emulator",
                "--working-directory=C:/repos/my project"
            ]
        );
        let words = argv(r#"code "{path}" --new-window"#, path).expect("argv");
        assert_eq!(words, vec!["code", "C:/repos/my project", "--new-window"]);
    }

    #[test]
    fn rejects_empty_and_unbalanced_templates() {
        let path = Path::new("/r");
        assert_eq!(
            argv("", path).expect_err("empty").code,
            codes::EXTERNAL_SPAWN_FAILED
        );
        let error = argv("code \"{path}", path).expect_err("unbalanced");
        assert_eq!(error.code, codes::EXTERNAL_SPAWN_FAILED);
        assert!(error.detail.expect("detail").contains("code"));
    }

    #[test]
    fn a_missing_executable_maps_to_spawn_failed_with_the_argv_in_detail() {
        let cwd = std::env::temp_dir();
        let templates = vec![
            "begira-no-such-terminal-1 {path}".to_owned(),
            "begira-no-such-terminal-2 --cwd {path}".to_owned(),
        ];
        let error = open_with(&templates, &cwd).expect_err("must fail");
        assert_eq!(error.code, codes::EXTERNAL_SPAWN_FAILED);
        let detail = error.detail.expect("detail");
        assert!(detail.contains("begira-no-such-terminal-1"));
        assert!(detail.contains("begira-no-such-terminal-2 --cwd"));
    }

    #[test]
    fn falls_through_to_the_next_template() {
        let cwd = std::env::temp_dir();
        #[cfg(windows)]
        let ok = "cmd /C exit 0";
        #[cfg(not(windows))]
        let ok = "true";
        let templates = vec!["begira-no-such-terminal {path}".to_owned(), ok.to_owned()];
        let argv = open_with(&templates, &cwd).expect("second template spawns");
        assert_eq!(argv[0], ok.split(' ').next().expect("program"));
    }
}
