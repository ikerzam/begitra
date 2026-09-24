//! The status, and the working tree diff that takes its paths from it, fall back to libgit2
//! when git cannot be started. One test in a file of its own: it clears this process's PATH,
//! which no other test may share.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{DiffOptions, DiffTarget, StatusOptions, WorkingTreeBase};
use support::Fixture;

#[test]
fn without_git_on_path_the_status_and_the_working_tree_diff_come_from_libgit2() {
    let f = Fixture::basic().with_mixed_status();
    let engine = Git2Engine::open(&f.root).expect("open");
    let through_git = engine
        .status(&StatusOptions::default(), &Cancel::never())
        .expect("status through git");
    let targets = [
        WorkingTreeBase::Index,
        WorkingTreeBase::Head,
        WorkingTreeBase::Revision {
            rev: "v1".to_owned(),
        },
    ]
    .map(|base| DiffTarget::WorkingTree { base });
    let diffs = |engine: &Git2Engine| {
        targets
            .iter()
            .map(|target| {
                engine
                    .diff(target, &DiffOptions::default(), &Cancel::never())
                    .expect("diff")
                    .files
                    .into_iter()
                    .map(|file| (file.path, file.status, file.old_id, file.new_id))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    };
    let diffs_through_git = diffs(&engine);
    let empty = f.sibling("empty-path");
    std::fs::create_dir_all(&empty).expect("folder");
    // Edition 2021: setting the environment is a safe call; this process is the only one
    // that sees it, and the fixture's own git ran already.
    std::env::set_var("PATH", &empty);
    let fallback = engine
        .status(&StatusOptions::default(), &Cancel::never())
        .expect("status through libgit2");
    assert_eq!(fallback, through_git);
    assert!(!fallback.is_empty());
    // A restricted diff walks the whole tree too and keeps what its paths cover.
    for (target, listed) in targets.iter().zip(&diffs_through_git) {
        let requested: Vec<String> = listed.iter().map(|(path, ..)| path.clone()).collect();
        let restricted = engine
            .diff_paths(
                target,
                &DiffOptions::default(),
                &requested,
                &Cancel::never(),
            )
            .expect("restricted diff")
            .expect("within the cap");
        let restricted: Vec<_> = restricted
            .files
            .into_iter()
            .map(|file| (file.path, file.status, file.old_id, file.new_id))
            .collect();
        assert_eq!(&restricted, listed, "{target:?}");
    }
    // Without git's paths the diff walks the whole tree, and lists the same files.
    assert_eq!(diffs(&engine), diffs_through_git);
    assert!(diffs_through_git.iter().all(|files| !files.is_empty()));
}
