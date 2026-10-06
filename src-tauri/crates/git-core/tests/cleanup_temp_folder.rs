//! The merge check's object folder cannot be made (the temp folder is unusable): the check
//! answers nothing, every gone branch reads as not checked, and the listing still lists. A test
//! binary of its own, since it changes the process's temp folder.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::CleanupReason;
use support::Fixture;

#[test]
fn a_temp_folder_that_cannot_be_used_reads_gone_branches_as_not_checked() {
    let mut f = Fixture::basic();
    let origin = f.sibling("origin.git").to_string_lossy().into_owned();
    f.git(&["init", "-q", "--bare", &origin]);
    f.git(&["remote", "add", "origin", &origin]);
    f.git(&["push", "-q", "-u", "origin", "main"]);
    f.git(&["switch", "-q", "-c", "c", "main"]);
    f.write("c.txt", "c\n");
    f.commit("c work");
    f.git(&["switch", "-q", "main"]);
    f.git(&["push", "-q", "-u", "origin", "c"]);
    f.git(&["push", "-q", "origin", "--delete", "c"]);
    // A file where the temp folder should be.
    let not_a_folder = f.sibling("not-a-folder");
    std::fs::write(&not_a_folder, "").expect("write");
    let saved: Vec<(&str, Option<std::ffi::OsString>)> = ["TMP", "TEMP", "TMPDIR"]
        .into_iter()
        .map(|var| (var, std::env::var_os(var)))
        .collect();
    for (var, _) in &saved {
        std::env::set_var(var, &not_a_folder);
    }
    let found = Git2Engine::open(&f.root)
        .expect("open")
        .cleanup_candidates(&Cancel::never());
    for (var, value) in saved {
        match value {
            Some(value) => std::env::set_var(var, value),
            None => std::env::remove_var(var),
        }
    }
    let found = found.expect("the listing answers");
    assert!(
        found
            .candidates
            .iter()
            .any(|c| c.name == "c" && c.reason == CleanupReason::GoneUnchecked),
        "{found:?}"
    );
}
