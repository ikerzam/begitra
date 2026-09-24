//! `Git2Engine::open` against the fixture repositories.

mod support;

use std::path::Path;

use git_core::engine::GitEngine;
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use support::{canonical, Fixture};

fn assert_same_path(actual: &Path, expected: &Path) {
    assert_eq!(
        canonical(actual),
        canonical(expected),
        "{} vs {}",
        actual.display(),
        expected.display()
    );
}

#[test]
fn opens_from_the_root() {
    let f = Fixture::basic();
    let engine = Git2Engine::open(&f.root).expect("open");
    let repo = engine.repo();
    assert_same_path(&repo.root, &f.root);
    assert_same_path(&repo.common_dir, &f.git_dir());
    assert_eq!(repo.current_branch.as_deref(), Some("main"));
    assert!(!repo.detached);
    assert!(!repo.is_linked_worktree);
    assert_eq!(engine.backend_name(), "git2");
}

#[test]
fn opens_from_a_subdirectory() {
    let f = Fixture::basic();
    let engine = Git2Engine::open(&f.root.join("src")).expect("open");
    assert_same_path(&engine.repo().root, &f.root);
    assert_eq!(engine.repo().current_branch.as_deref(), Some("main"));
}

#[test]
fn opens_a_linked_worktree() {
    let f = Fixture::basic().with_linked_worktree();
    let engine = Git2Engine::open(&f.worktree_path().join("src")).expect("open");
    let repo = engine.repo();
    assert_same_path(&repo.root, &f.worktree_path());
    assert_same_path(&repo.common_dir, &f.git_dir());
    assert_eq!(repo.current_branch.as_deref(), Some("feature/wt"));
    assert!(repo.is_linked_worktree);
    assert!(!repo.detached);
}

#[test]
fn fails_outside_a_repository() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("plain");
    std::fs::create_dir_all(&path).expect("create folder");
    let error = Git2Engine::open(&path).expect_err("must fail");
    assert_eq!(error.code(), "repo.not_found");
    match &error {
        GitError::NotFound(reported) => assert_eq!(reported, &path),
        other => panic!("unexpected error {other:?}"),
    }
    assert!(error.to_string().contains(&path.display().to_string()));
}

#[test]
fn reports_an_unborn_branch() {
    let f = Fixture::unborn();
    let engine = Git2Engine::open(&f.root).expect("open");
    assert_eq!(engine.repo().current_branch.as_deref(), Some("main"));
    assert!(!engine.repo().detached);
}

#[test]
fn reports_a_detached_head() {
    let f = Fixture::basic();
    f.git(&["checkout", "-q", "HEAD~1"]);
    let engine = Git2Engine::open(&f.root).expect("open");
    assert_eq!(engine.repo().current_branch, None);
    assert!(engine.repo().detached);
}

#[test]
fn opens_paths_with_spaces_and_unicode() {
    let mut f = Fixture::with_odd_path();
    f.write("a.txt", "a\n");
    f.commit("odd path");
    let engine = Git2Engine::open(&f.root).expect("open");
    assert_same_path(&engine.repo().root, &f.root);
}

#[test]
fn opens_through_a_symlink() {
    let f = Fixture::basic();
    let link = f.sibling("link-to-repo");
    #[cfg(windows)]
    let created = std::os::windows::fs::symlink_dir(&f.root, &link);
    #[cfg(not(windows))]
    let created = std::os::unix::fs::symlink(&f.root, &link);
    if created.is_err() {
        eprintln!("skipping: this account cannot create symlinks");
        return;
    }
    let engine = Git2Engine::open(&link.join("src")).expect("open through symlink");
    assert_eq!(engine.repo().current_branch.as_deref(), Some("main"));
    assert_same_path(&engine.repo().root, &f.root);
}

#[test]
fn names_the_build_folders_the_index_holds_now() {
    let mut f = Fixture::basic();
    let engine = Git2Engine::open(&f.root).expect("open");
    assert!(engine.tracked_names(&["dist"]).expect("index").is_empty());
    // Committed after the engine read the index.
    f.write("dist/index.js", "built\n");
    f.commit("committed build output");
    assert_eq!(
        engine.tracked_names(&["dist"]).expect("index"),
        vec!["dist".to_owned()]
    );
}

#[test]
fn names_a_tracked_file_named_like_a_build_folder() {
    let mut f = Fixture::basic();
    f.write(
        "build",
        "#!/bin/sh
",
    );
    f.write(
        "target.md",
        "not a file named target
",
    );
    f.commit("a build script");
    let engine = Git2Engine::open(&f.root).expect("open");
    assert_eq!(
        engine.tracked_names(&["build", "target"]).expect("index"),
        vec!["build".to_owned()]
    );
}

#[test]
fn names_the_build_folders_that_hold_tracked_files() {
    let mut f = Fixture::basic();
    f.write("dist/index.js", "built\n");
    f.write("build/ci/pipeline.yml", "steps: []\n");
    f.write(
        "targets/readme.md",
        "a folder whose name starts like target\n",
    );
    f.commit("committed build output");
    f.write("node_modules/dep/index.js", "installed\n");
    f.write("target/debug/app", "built\n");
    let engine = Git2Engine::open(&f.root).expect("open");
    let names = ["node_modules", "target", "dist", "build", ".cache"];
    assert_eq!(
        engine.tracked_names(&names).expect("index"),
        vec!["dist".to_owned(), "build".to_owned()]
    );
}
