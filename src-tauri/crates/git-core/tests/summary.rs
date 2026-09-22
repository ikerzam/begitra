//! `summary::describe` against the git CLI on fixtures.

mod support;

use std::path::Path;

use git_core::engine::Cancel;
use git_core::error::GitError;
use git_core::summary::describe;
use support::Fixture;

#[test]
fn describes_branch_upstream_counts_tip_and_a_clean_tree() {
    let f = Fixture::basic().with_remote();
    f.git(&["checkout", "-q", "develop"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.current_branch.as_deref(), Some("develop"));
    assert!(!summary.detached);
    assert_eq!((summary.ahead, summary.behind), (Some(2), Some(3)));
    let counts = f.git(&[
        "rev-list",
        "--left-right",
        "--count",
        "develop...origin/develop",
    ]);
    assert_eq!(counts, "2\t3");
    let tip_time: i64 = f.git(&["log", "-1", "--format=%ct"]).parse().expect("time");
    assert_eq!(summary.last_commit_at, Some(tip_time));
    assert_eq!(summary.dirty, Some(false));
    assert_eq!(summary.name, "repo");
    assert!(!summary.is_linked_worktree);
    assert!(summary.main_root.is_none());
}

#[test]
fn a_dirty_tree_detached_head_and_no_upstream() {
    let f = Fixture::basic();
    f.write("untracked.txt", "x\n");
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.dirty, Some(true));
    assert_eq!((summary.ahead, summary.behind), (None, None));
    assert!(!f.git(&["status", "--porcelain"]).is_empty());
    f.git(&["checkout", "-q", "--detach", "HEAD"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert!(summary.detached);
    assert!(summary.current_branch.is_none());
}

#[test]
fn an_unborn_repository_has_no_tip() {
    let f = Fixture::unborn();
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.current_branch.as_deref(), Some("main"));
    assert!(summary.last_commit_at.is_none());
    assert_eq!(summary.dirty, Some(false));
}

#[test]
fn a_linked_worktree_names_its_repository() {
    let f = Fixture::basic().with_linked_worktree();
    let wt = f.worktree_path();
    let summary = describe(&wt, &Cancel::never()).expect("summary");
    assert!(summary.is_linked_worktree);
    // Canonical on both sides: git reports the long path, while the fixture's temporary
    // folder can be the 8.3 short form (`C:\Users\RUNNER~1\…` on the CI runner).
    assert_eq!(
        summary.main_root.as_deref().map(support::canonical),
        Some(support::canonical(&f.root))
    );
    assert_eq!(summary.current_branch.as_deref(), Some("feature/wt"));
}

#[test]
fn a_cancel_leaves_dirty_unknown_and_a_missing_folder_is_not_found() {
    let f = Fixture::basic();
    let cancel = Cancel::new();
    cancel.cancel();
    let error = describe(&f.root, &cancel).expect_err("cancelled before status");
    assert!(matches!(error, GitError::Cancelled));
    let error = describe(Path::new("C:/no/such/folder"), &Cancel::never()).expect_err("missing");
    assert_eq!(error.code(), "repo.not_found");
}
