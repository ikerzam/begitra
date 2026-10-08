//! `refs_containing` walks from the tips it read: a ref another process moves between the
//! listing and the walk cannot drop a ref that holds the commit. The git executable is
//! process-global state, so this test lives in a file of its own.

mod support;

use std::path::{Path, PathBuf};

use git_core::cli;
use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use support::Fixture;

#[test]
fn a_ref_moved_as_the_walk_starts_counts_with_the_tip_that_was_read() {
    let mut fixture = Fixture::basic();
    let first = fixture.rev("main~3");
    fixture.git(&["checkout", "-q", "-b", "moved", &first]);
    fixture.write("m1.txt", "m1\n");
    fixture.commit("m1: the tip the listing reads");
    fixture.git(&["checkout", "-q", "-b", "elsewhere", &first]);
    fixture.write("m2.txt", "m2\n");
    let elsewhere = fixture.commit("m2: where another process moves the branch");
    fixture.git(&["checkout", "-q", "main"]);
    fixture.git(&["branch", "-q", "-D", "elsewhere"]);
    // A git that force-moves `moved` right before a walk starts, as a fetch or a rebase in
    // another process can: the tip read before is then reachable from no ref. The branch
    // holds the commit before the move and after it.
    let wrapper = mover(&fixture, &which_git(), &elsewhere);
    cli::set_git_executable(Some(&wrapper), &Cancel::never()).expect("the wrapper answers");
    let names = Git2Engine::open(&fixture.root)
        .expect("open")
        .refs_containing(&first, &Cancel::never());
    cli::set_git_executable(None, &Cancel::never()).expect("back to the git on PATH");
    let names = names.expect("refs containing");
    assert_eq!(
        fixture.rev("moved"),
        elsewhere,
        "the wrapper moved the branch"
    );
    assert!(
        names.iter().any(|name| name == "refs/heads/moved"),
        "{names:?}"
    );
}

/// A script that runs `real`, moving `refs/heads/moved` to `to` first when the command is
/// `rev-list`.
fn mover(fixture: &Fixture, real: &Path, to: &str) -> PathBuf {
    let real = real.display();
    if cfg!(windows) {
        let path = fixture.sibling("mover.cmd");
        let script = format!(
            "@echo off\r\nif \"%~1\"==\"rev-list\" \"{real}\" update-ref refs/heads/moved {to}\r\n\"{real}\" %*\r\n"
        );
        std::fs::write(&path, script).expect("wrapper");
        path
    } else {
        let path = fixture.sibling("mover.sh");
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = rev-list ]; then \"{real}\" update-ref refs/heads/moved {to}; fi\nexec \"{real}\" \"$@\"\n"
        );
        std::fs::write(&path, script).expect("wrapper");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        path
    }
}

/// The absolute path of `git` on PATH.
fn which_git() -> PathBuf {
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
    PathBuf::from(first)
}
