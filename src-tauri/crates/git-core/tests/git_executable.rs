//! The configurable git executable is process-global state, so its round trip lives in a
//! file of its own: detect, install the detected path, see every command use it, clear it.

use std::path::Path;

use git_core::cli;
use git_core::engine::Cancel;

#[test]
fn the_detected_executable_is_installed_used_and_cleared() {
    let never = Cancel::never();
    let detected = cli::detect_git(&never).expect("git is installed");
    assert!(detected.version.starts_with("git version "));
    // The bare name `git` stands for PATH; to see a path installed, resolve it once.
    let resolved = if detected.path == Path::new("git") {
        which_git()
    } else {
        detected.path.clone()
    };
    let installed =
        cli::set_git_executable(Some(&resolved), &never).expect("the resolved path runs");
    assert!(installed.path.is_absolute(), "{}", installed.path.display());
    assert_eq!(cli::git_executable(), installed.path);
    assert_eq!(
        cli::command(Path::new("."), &["--version"]).get_program(),
        installed.path.as_os_str()
    );
    let output = cli::run_git(Path::new("."), &["--version"]).expect("runs through the path");
    assert!(output.stdout.starts_with("git version "));
    let cleared = cli::set_git_executable(None, &never).expect("PATH's git answers");
    assert_eq!(cleared.path, Path::new("git"));
    assert_eq!(cli::git_executable(), Path::new("git"));
}

/// The absolute path of `git` on PATH, through git itself (`--exec-path` sits next to it on
/// every platform's layout only for the direct binary, so the shell's own lookup is used).
fn which_git() -> std::path::PathBuf {
    let lookup = if cfg!(windows) {
        ("where", "git.exe")
    } else {
        ("which", "git")
    };
    let output = std::process::Command::new(lookup.0)
        .arg(lookup.1)
        .output()
        .expect("lookup runs");
    let first = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .expect("git on PATH")
        .trim()
        .to_owned();
    std::path::PathBuf::from(first)
}
