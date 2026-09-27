//! `summary::describe` against the git CLI on fixtures.

mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use git_core::engine::Cancel;
use git_core::error::GitError;
use git_core::summary::{describe, Upstream};
use git_core::types::OperationState;
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
    assert_eq!(
        summary.last_commit_subject.as_deref(),
        Some(f.git(&["log", "-1", "--format=%s"]).as_str())
    );
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
    assert!(summary.last_commit_subject.is_none());
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

/// `git for-each-ref` of `branch`'s upstream: the short name git shows, the remote and the
/// branch on it (`%(upstream:remoteref)` without `refs/heads/`), from the branch's
/// configuration whether or not the tracking ref exists.
fn cli_upstream(f: &Fixture, branch: &str) -> Option<Upstream> {
    let full = format!("refs/heads/{branch}");
    let line = f.git(&[
        "for-each-ref",
        "--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push:remotename)",
        &full,
    ]);
    let mut parts = line.split('\0');
    let name = parts.next().unwrap_or_default();
    if name.is_empty() {
        return None;
    }
    let remote = parts.next().unwrap_or_default();
    let merge = parts.next().unwrap_or_default();
    let push = parts.next().unwrap_or_default();
    Some(Upstream {
        name: name.to_owned(),
        remote: remote.to_owned(),
        branch: merge
            .strip_prefix("refs/heads/")
            .unwrap_or(merge)
            .to_owned(),
        push_remote: push.to_owned(),
    })
}

fn upstream(name: &str, remote: &str, branch: &str) -> Option<Upstream> {
    Some(Upstream {
        name: name.to_owned(),
        remote: remote.to_owned(),
        branch: branch.to_owned(),
        push_remote: remote.to_owned(),
    })
}

#[test]
fn the_upstream_is_named_as_git_names_it_set_unset_gone_local_or_detached() {
    let f = Fixture::basic().with_remote();
    f.git(&["checkout", "-q", "develop"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(
        summary.upstream,
        upstream("origin/develop", "origin", "develop")
    );
    assert_eq!(summary.upstream, cli_upstream(&f, "develop"));

    f.git(&["checkout", "-q", "-b", "solo"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.upstream, None);
    assert_eq!(cli_upstream(&f, "solo"), None);

    // A branch tracking a local branch (`branch.solo.remote = .`).
    f.git(&["branch", "-q", "--set-upstream-to=main", "solo"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.upstream, upstream("main", ".", "main"));
    assert_eq!(summary.upstream, cli_upstream(&f, "solo"));

    // Gone: the tracking ref deleted keeps the name and loses the counts.
    f.git(&["checkout", "-q", "develop"]);
    f.git(&["branch", "-q", "-r", "-d", "origin/develop"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(
        summary.upstream,
        upstream("origin/develop", "origin", "develop")
    );
    assert_eq!(summary.upstream, cli_upstream(&f, "develop"));
    assert_eq!((summary.ahead, summary.behind), (None, None));

    f.git(&["checkout", "-q", "--detach", "main"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.upstream, None);
    assert!(!f.try_git(&["rev-parse", "--abbrev-ref", "@{upstream}"]).0);
}

#[test]
fn an_upstream_names_its_remote_with_a_slash_and_a_tracking_prefix_of_another_name() {
    let f = Fixture::basic().with_remote();
    let origin = f.sibling("origin.git");
    let origin = origin.to_str().expect("utf-8 temp path");
    // A remote whose name holds a slash: splitting `my/fork/main` at the first slash names
    // the wrong remote.
    f.git(&["remote", "add", "my/fork", origin]);
    f.git(&["fetch", "-q", "my/fork"]);
    f.git(&["checkout", "-q", "-b", "on-fork", "--track", "my/fork/main"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(
        summary.upstream,
        upstream("my/fork/main", "my/fork", "main")
    );
    assert_eq!(summary.upstream, cli_upstream(&f, "on-fork"));
    assert_eq!((summary.ahead, summary.behind), (Some(0), Some(0)));

    // A remote whose tracking refs live under another name.
    f.git(&["remote", "add", "mirror-src", origin]);
    f.git(&[
        "config",
        "remote.mirror-src.fetch",
        "+refs/heads/*:refs/remotes/elsewhere/*",
    ]);
    f.git(&["fetch", "-q", "mirror-src"]);
    f.git(&[
        "checkout",
        "-q",
        "-b",
        "mirrored",
        "--track",
        "elsewhere/develop",
    ]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(
        summary.upstream,
        upstream("elsewhere/develop", "mirror-src", "develop")
    );
    assert_eq!(summary.upstream, cli_upstream(&f, "mirrored"));
}

#[test]
fn the_push_remote_follows_push_remote_then_push_default_as_git_push_does() {
    let f = Fixture::basic().with_remote();
    let origin = f.sibling("origin.git");
    let origin = origin.to_str().expect("utf-8 temp path");
    f.git(&["remote", "add", "fork", origin]);
    f.git(&["checkout", "-q", "develop"]);
    f.git(&["config", "remote.pushDefault", "fork"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    let pushed = summary.upstream.as_ref().map(|u| u.push_remote.as_str());
    assert_eq!(pushed, Some("fork"));
    assert_eq!(summary.upstream, cli_upstream(&f, "develop"));
    f.git(&["config", "branch.develop.pushRemote", "origin"]);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    let pushed = summary.upstream.as_ref().map(|u| u.push_remote.as_str());
    assert_eq!(pushed, Some("origin"));
    assert_eq!(summary.upstream, cli_upstream(&f, "develop"));
}

#[test]
fn a_branch_whose_remote_is_a_url_has_no_upstream_as_git_shows_none() {
    // `gh pr checkout` of a fork's pull request writes the fork's URL as the remote.
    let f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "fork-pr"]);
    f.git(&[
        "config",
        "branch.fork-pr.remote",
        "https://example.invalid/someone/fork.git",
    ]);
    f.git(&["config", "branch.fork-pr.merge", "refs/heads/fix"]);
    assert_eq!(cli_upstream(&f, "fork-pr"), None);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.upstream, None);
    assert_eq!((summary.ahead, summary.behind), (None, None));
}

#[test]
fn a_merge_and_a_rebase_in_progress_are_named() {
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "left"]);
    f.write("conflict.txt", "left\n");
    f.commit("left: conflict");
    f.git(&["checkout", "-q", "-b", "right", "main"]);
    f.write("conflict.txt", "right\n");
    f.commit("right: conflict");
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.operation, OperationState::None);

    assert!(
        !f.try_git(&["merge", "-q", "left"]).0,
        "the merge conflicts"
    );
    assert!(f.try_git(&["rev-parse", "-q", "--verify", "MERGE_HEAD"]).0);
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.operation, OperationState::Merge);
    f.git(&["merge", "--abort"]);

    assert!(!f.try_git(&["rebase", "left"]).0, "the rebase conflicts");
    let rebase_dir = f.git(&["rev-parse", "--git-path", "rebase-merge"]);
    assert!(f.root.join(rebase_dir).is_dir());
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.operation, OperationState::Rebase);
    f.git(&["rebase", "--abort"]);

    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.operation, OperationState::None);
}

/// Where git keeps `FETCH_HEAD` for the worktree at `cwd`, and its modification time in unix
/// seconds when it exists.
fn cli_fetch_head(f: &Fixture, cwd: &Path) -> (PathBuf, Option<i64>) {
    let path = cwd.join(f.git_in(cwd, &["rev-parse", "--git-path", "FETCH_HEAD"]));
    let time = fs::metadata(&path).ok().map(|meta| {
        let modified = meta.modified().expect("modification time");
        let since = modified.duration_since(UNIX_EPOCH).expect("after 1970");
        i64::try_from(since.as_secs()).expect("seconds fit")
    });
    (path, time)
}

#[test]
fn the_last_fetch_is_each_worktree_s_own_fetch_head() {
    let f = Fixture::basic().with_remote().with_linked_worktree();
    let wt = f.worktree_path();
    assert_eq!(cli_fetch_head(&f, &f.root).1, None, "no fetch yet");
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.fetched_at, None);

    let before = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("after 1970")
        .as_secs();
    f.git(&["fetch", "-q", "origin"]);
    let (main_path, main_time) = cli_fetch_head(&f, &f.root);
    assert!(main_time.is_some(), "{} exists", main_path.display());
    let summary = describe(&f.root, &Cancel::never()).expect("summary");
    assert_eq!(summary.fetched_at, main_time);
    let fetched = u64::try_from(summary.fetched_at.unwrap_or_default()).expect("positive");
    assert!(fetched + 1 >= before, "the fetch's own time");

    // The linked worktree shares the refs, not `FETCH_HEAD`: a fetch in the main repository
    // leaves the worktree without one, and its own fetch writes its own.
    let (wt_path, wt_time) = cli_fetch_head(&f, &wt);
    let folder = |path: &Path| support::canonical(path.parent().expect("a git directory"));
    assert_ne!(folder(&wt_path), folder(&main_path));
    assert_eq!(wt_time, None);
    let summary = describe(&wt, &Cancel::never()).expect("summary");
    assert_eq!(summary.fetched_at, None);
    f.git_in(&wt, &["fetch", "-q", "origin"]);
    let (_, wt_time) = cli_fetch_head(&f, &wt);
    assert!(wt_time.is_some());
    let summary = describe(&wt, &Cancel::never()).expect("summary");
    assert_eq!(summary.fetched_at, wt_time);
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
