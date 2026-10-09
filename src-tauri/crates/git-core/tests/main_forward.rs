//! `GitEngine::main_fast_forward` on fixture repositories: the main branch the cleanup names,
//! moved as `branch_fast_forward` moves a branch.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{FastForward, MainForward};
use support::{canonical, Fixture};

fn main_forward(f: &Fixture) -> Option<MainForward> {
    Git2Engine::open(&f.root)
        .expect("open")
        .main_fast_forward(&Cancel::never())
        .expect("main fast-forward")
}

/// A bare `origin` beside the repository with `branch` pushed and tracked.
fn with_origin(f: &Fixture, branch: &str) {
    let origin = f.sibling("origin.git");
    let origin = origin.to_string_lossy().into_owned();
    f.git(&["init", "-q", "--bare", &origin]);
    f.git(&["remote", "add", "origin", &origin]);
    f.git(&["push", "-q", "-u", "origin", branch]);
}

/// Two commits on `branch` pushed to `origin`, then `branch` put back where it was: two commits
/// behind its upstream and none of its own. HEAD ends on `feature`, made from those commits.
fn two_behind(f: &mut Fixture, branch: &str) {
    f.git(&["switch", "-q", branch]);
    for i in 1..=2 {
        f.write(&format!("{branch}-{i}.txt"), "pushed\n");
        f.commit(&format!("{branch} {i}: pushed"));
    }
    f.git(&["push", "-q", "origin", branch]);
    f.git(&["switch", "-q", "-C", "feature", branch]);
    f.git(&["branch", "-f", branch, &format!("{branch}~2")]);
}

/// `main` two commits behind `origin/main`, `origin/HEAD` on it, `feature` checked out.
fn main_behind() -> Fixture {
    let mut f = Fixture::basic();
    with_origin(&f, "main");
    f.git(&["remote", "set-head", "origin", "main"]);
    two_behind(&mut f, "main");
    f
}

#[test]
fn moves_main_behind_its_upstream_and_nothing_else() {
    let f = main_behind();
    let before = f.rev("main");
    let head = f.rev("HEAD");
    let upstream = f.rev("origin/main");
    assert_eq!(
        main_forward(&f),
        Some(MainForward {
            branch: "main".to_owned(),
            upstream: "origin/main".to_owned(),
            outcome: FastForward::Moved {
                from: before,
                to: upstream.clone(),
                commits: 2,
            },
        })
    );
    assert_eq!(f.rev("main"), upstream);
    let reflog = f.git(&["reflog", "-1", "--format=%gs", "main"]);
    assert!(
        reflog.contains("refs/remotes/origin/main:refs/heads/main"),
        "{reflog}"
    );
    assert_eq!(f.rev("HEAD"), head);
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/feature");
    assert_eq!(f.git(&["status", "--porcelain"]), "");
}

#[test]
fn the_branch_origin_head_names_goes_before_main() {
    let mut f = main_behind();
    f.git(&["push", "-q", "-u", "origin", "develop"]);
    two_behind(&mut f, "develop");
    f.git(&["remote", "set-head", "origin", "develop"]);
    let main = f.rev("main");
    let answer = main_forward(&f).expect("a main branch");
    assert_eq!(answer.branch, "develop");
    assert_eq!(answer.upstream, "origin/develop");
    assert!(matches!(
        answer.outcome,
        FastForward::Moved { commits: 2, .. }
    ));
    assert_eq!(f.rev("develop"), f.rev("origin/develop"));
    assert_eq!(f.rev("main"), main, "main moved too");
}

#[test]
fn master_without_main_or_origin_head() {
    let mut f = Fixture::basic();
    f.git(&["branch", "-q", "-m", "main", "master"]);
    with_origin(&f, "master");
    two_behind(&mut f, "master");
    let answer = main_forward(&f).expect("a main branch");
    assert_eq!(answer.branch, "master");
    assert_eq!(answer.upstream, "origin/master");
    assert!(matches!(
        answer.outcome,
        FastForward::Moved { commits: 2, .. }
    ));
    assert_eq!(f.rev("master"), f.rev("origin/master"));
}

#[test]
fn main_following_a_local_branch_moves_to_it() {
    let mut f = Fixture::basic();
    f.git(&["switch", "-q", "-c", "next"]);
    f.write("next.txt", "next\n");
    f.commit("next: one ahead of main");
    f.git(&["config", "branch.main.remote", "."]);
    f.git(&["config", "branch.main.merge", "refs/heads/next"]);
    let answer = main_forward(&f).expect("a main branch");
    assert_eq!(answer.upstream, "next");
    assert!(matches!(
        answer.outcome,
        FastForward::Moved { commits: 1, .. }
    ));
    assert_eq!(f.rev("main"), f.rev("next"));
}

#[test]
fn an_upstream_libgit2_reads_otherwise_moves_nothing() {
    // An include libgit2 does not evaluate (`hasconfig:`) names main's first merge value: git's
    // upstream is origin/side, libgit2's origin/main.
    let mut f = main_behind();
    f.git(&["switch", "-q", "-c", "side-work", "main"]);
    f.write("side.txt", "side\n");
    f.commit("side: one ahead of main");
    f.git(&["update-ref", "refs/remotes/origin/side", "HEAD"]);
    f.git(&["switch", "-q", "feature"]);
    f.git(&["branch", "-q", "-D", "side-work"]);
    std::fs::write(
        f.git_dir().join("side.inc"),
        "[branch \"main\"]\n\tmerge = refs/heads/side\n",
    )
    .expect("write include");
    f.git(&["config", "--remove-section", "branch.main"]);
    f.git(&[
        "config",
        "includeIf.hasconfig:remote.*.url:**.path",
        "side.inc",
    ]);
    f.git(&["config", "branch.main.remote", "origin"]);
    f.git(&["config", "branch.main.merge", "refs/heads/main"]);
    let git_upstream = f.git(&[
        "for-each-ref",
        "--format=%(upstream:short)",
        "refs/heads/main",
    ]);
    assert_eq!(git_upstream, "origin/side");
    let main = f.rev("main");
    assert_eq!(main_forward(&f), None);
    assert_eq!(f.rev("main"), main);
}

#[test]
fn an_upstream_whose_commit_is_missing_is_none() {
    let f = main_behind();
    let tracking = f.git_dir().join("refs").join("remotes").join("origin");
    std::fs::create_dir_all(&tracking).expect("tracking folder");
    std::fs::write(
        tracking.join("main"),
        "1111111111111111111111111111111111111111\n",
    )
    .expect("write ref");
    let main = f.rev("main");
    assert_eq!(main_forward(&f), None);
    assert_eq!(f.rev("main"), main);
}

#[test]
fn no_main_branch_is_none_and_moves_nothing() {
    // `trunk` is the main line by a name Begitra does not guess, behind its upstream.
    let mut f = Fixture::basic();
    f.git(&["branch", "-q", "-m", "main", "trunk"]);
    with_origin(&f, "trunk");
    two_behind(&mut f, "trunk");
    let trunk = f.rev("trunk");
    assert_eq!(main_forward(&f), None);
    assert_eq!(f.rev("trunk"), trunk);
}

#[test]
fn main_without_an_upstream_there_is_none() {
    // No upstream at all.
    let f = Fixture::basic();
    assert_eq!(main_forward(&f), None);
    // An upstream configured whose remote's branch was never fetched.
    let origin = f.sibling("elsewhere.git");
    let origin = origin.to_string_lossy().into_owned();
    f.git(&["init", "-q", "--bare", &origin]);
    f.git(&["remote", "add", "origin", &origin]);
    f.git(&["config", "branch.main.remote", "origin"]);
    f.git(&["config", "branch.main.merge", "refs/heads/main"]);
    let (listed, _, _) = f.try_git(&["rev-parse", "--verify", "-q", "origin/main"]);
    assert!(!listed, "origin/main exists");
    let main = f.rev("main");
    assert_eq!(main_forward(&f), None);
    assert_eq!(f.rev("main"), main);
}

#[test]
fn main_checked_out_is_held_where_it_is() {
    let f = main_behind();
    f.git(&["switch", "-q", "main"]);
    let main = f.rev("main");
    let answer = main_forward(&f).expect("a main branch");
    match answer.outcome {
        FastForward::Held { worktree } => {
            assert_eq!(
                canonical(std::path::Path::new(&worktree)),
                canonical(&f.root)
            );
        }
        other => panic!("expected held, got {other:?}"),
    }
    assert_eq!(f.rev("main"), main);
}

#[test]
fn main_with_commits_of_its_own_is_diverged() {
    let mut f = main_behind();
    f.git(&["switch", "-q", "main"]);
    f.write("own.txt", "own\n");
    f.commit("own work on main");
    f.git(&["switch", "-q", "feature"]);
    let main = f.rev("main");
    assert_eq!(
        main_forward(&f).map(|answer| answer.outcome),
        Some(FastForward::Diverged)
    );
    assert_eq!(f.rev("main"), main);
}

#[test]
fn main_level_with_its_upstream_is_up_to_date() {
    let f = Fixture::basic();
    with_origin(&f, "main");
    f.git(&["switch", "-q", "-c", "feature"]);
    assert_eq!(
        main_forward(&f).map(|answer| answer.outcome),
        Some(FastForward::UpToDate)
    );
}
