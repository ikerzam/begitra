//! Smoke tests for the fixture builders: every scenario builds and git sees the expected shape.

mod support;

use support::Fixture;

#[test]
fn basic_has_six_commits_a_merge_and_a_tag() {
    let f = Fixture::basic();
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "6");
    assert_eq!(
        f.git(&["rev-list", "--parents", "-n", "1", "HEAD"])
            .split(' ')
            .count(),
        3
    );
    assert_eq!(f.git(&["branch", "--show-current"]), "main");
    assert_eq!(f.git(&["tag", "--list"]), "v1");
    assert_eq!(f.rev("v1^{commit}"), f.rev("main~2"));
    assert!(f.git(&["branch", "--list", "develop"]).contains("develop"));
}

#[test]
fn commit_dates_advance_one_minute_per_commit() {
    let f = Fixture::basic();
    let dates = f.git(&["log", "--format=%ct", "--reverse"]);
    let stamps: Vec<i64> = dates.lines().map(|l| l.parse().unwrap()).collect();
    assert_eq!(stamps.len(), 6);
    assert!(stamps.windows(2).all(|w| w[1] - w[0] == 60), "{stamps:?}");
}

#[test]
fn remote_leaves_develop_ahead_two_behind_three() {
    let f = Fixture::basic().with_remote();
    let counts = f.git(&[
        "rev-list",
        "--left-right",
        "--count",
        "develop...origin/develop",
    ]);
    assert_eq!(counts, "2\t3");
    assert_eq!(
        f.git(&["rev-parse", "--abbrev-ref", "develop@{upstream}"]),
        "origin/develop"
    );
    assert_eq!(
        f.git(&["rev-parse", "--abbrev-ref", "main@{upstream}"]),
        "origin/main"
    );
    assert_eq!(f.git(&["branch", "--show-current"]), "main");
}

#[test]
fn octopus_merge_has_four_parents() {
    let f = Fixture::basic().with_octopus();
    let parents = f.git(&["rev-list", "--parents", "-n", "1", "HEAD"]);
    assert_eq!(parents.split(' ').count(), 5, "{parents}");
}

#[test]
fn rename_is_detected_by_git() {
    let f = Fixture::basic().with_rename();
    let status = f.git(&["diff", "-M", "--name-status", "HEAD~1", "HEAD"]);
    assert!(status.starts_with("R0"), "{status}");
    assert!(status.contains("src/lib.rs\tsrc/core.rs"), "{status}");
}

#[test]
fn stash_is_listed() {
    let f = Fixture::basic().with_stash();
    assert!(f.git(&["stash", "list"]).contains("wip: stash"));
    assert_eq!(f.git(&["status", "--porcelain"]), "");
}

#[test]
fn linked_worktree_is_registered() {
    let f = Fixture::basic().with_linked_worktree();
    let list = f.git(&["worktree", "list", "--porcelain"]);
    assert!(list.contains("branch refs/heads/feature/wt"), "{list}");
    assert!(f.worktree_path().join("README.md").is_file());
    assert_eq!(
        f.git_in(&f.worktree_path(), &["branch", "--show-current"]),
        "feature/wt"
    );
}

#[test]
fn broken_worktrees_are_prunable_and_locked() {
    let f = Fixture::basic()
        .with_linked_worktree()
        .with_broken_worktrees();
    let list = f.git(&["worktree", "list", "--porcelain"]);
    assert!(list.contains("prunable"), "{list}");
    assert!(list.contains("locked testing"), "{list}");
}

#[test]
fn mixed_status_matches_porcelain_v2() {
    let f = Fixture::basic().with_mixed_status();
    let status = f.git(&["status", "--porcelain=v2"]);
    assert!(
        status
            .lines()
            .any(|l| l.starts_with("1 A.") && l.ends_with("staged.txt")),
        "{status}"
    );
    assert!(
        status
            .lines()
            .any(|l| l.starts_with("1 .M") && l.ends_with("README.md")),
        "{status}"
    );
    assert!(status.lines().any(|l| l == "? untracked.txt"), "{status}");
    assert!(!status.contains("ignored.log"), "{status}");
    let ignored = f.git(&["status", "--porcelain=v2", "--ignored"]);
    assert!(ignored.lines().any(|l| l == "! ignored.log"), "{ignored}");
}

#[test]
fn unborn_has_a_branch_name_and_no_head() {
    let f = Fixture::unborn();
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    let (ok, _, _) = f.try_git(&["rev-parse", "--verify", "HEAD"]);
    assert!(!ok);
}

#[test]
fn truncated_object_cannot_be_read() {
    let f = Fixture::basic();
    let hash = f.truncate_object("HEAD~1");
    let (ok, _, stderr) = f.try_git(&["cat-file", "-t", &hash]);
    assert!(!ok, "git still reads the object: {stderr}");
}

#[test]
fn odd_path_works() {
    let mut f = Fixture::with_odd_path();
    f.write("a.txt", "a\n");
    f.commit("odd path");
    assert!(f.root.to_string_lossy().contains("spaces ünïcödé"));
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "1");
}
