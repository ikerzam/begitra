//! The status falls back to libgit2 when git cannot be started. One test in a file of its
//! own: it clears this process's PATH, which no other test may share.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::StatusOptions;
use support::Fixture;

#[test]
fn without_git_on_path_the_status_comes_from_libgit2() {
    let f = Fixture::basic().with_mixed_status();
    let engine = Git2Engine::open(&f.root).expect("open");
    let through_git = engine
        .status(&StatusOptions::default(), &Cancel::never())
        .expect("status through git");
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
}
