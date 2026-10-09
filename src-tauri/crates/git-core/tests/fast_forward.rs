//! `GitEngine::branch_fast_forward` on fixture repositories, against what git does.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::FastForward;
use support::{canonical, Fixture};

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open")
}

fn fast_forward(f: &Fixture, name: &str) -> FastForward {
    engine(f)
        .branch_fast_forward(name, &Cancel::never())
        .expect("fast-forward")
}

/// `basic` with `origin`, `develop` reset to where it was pushed: three commits behind
/// `origin/develop`, none of its own; HEAD on `main`.
fn behind() -> Fixture {
    let f = Fixture::basic().with_remote();
    f.git(&["branch", "-f", "develop", "origin/develop~3"]);
    f
}

#[test]
fn moves_a_branch_behind_its_upstream_and_nothing_else() {
    let f = behind();
    let before = f.rev("develop");
    let head = f.rev("HEAD");
    let upstream = f.rev("origin/develop");
    assert_eq!(
        fast_forward(&f, "develop"),
        FastForward::Moved {
            from: before,
            to: upstream.clone(),
            commits: 3
        }
    );
    assert_eq!(f.rev("develop"), upstream);
    let reflog = f.git(&["reflog", "-1", "--format=%gs", "develop"]);
    assert!(reflog.ends_with(": fast-forward"), "{reflog}");
    assert!(
        reflog.contains("refs/remotes/origin/develop:refs/heads/develop"),
        "{reflog}"
    );
    assert_eq!(f.rev("HEAD"), head);
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/main");
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert!(
        !f.git_dir().join("FETCH_HEAD").exists(),
        "the fast-forward wrote FETCH_HEAD"
    );
}

#[test]
fn a_branch_level_with_its_upstream_is_up_to_date() {
    let f = Fixture::basic().with_remote();
    f.git(&["switch", "-q", "--detach"]);
    let entries = f.git(&["reflog", "--format=%H", "main"]).lines().count();
    assert_eq!(fast_forward(&f, "main"), FastForward::UpToDate);
    let after = f.git(&["reflog", "--format=%H", "main"]).lines().count();
    assert_eq!(entries, after, "the reflog took an entry");
}

#[test]
fn a_branch_with_commits_of_its_own_is_not_moved() {
    // `develop` is two commits ahead of `origin/develop` and three behind.
    let f = Fixture::basic().with_remote();
    let before = f.rev("develop");
    assert_eq!(fast_forward(&f, "develop"), FastForward::Diverged);
    assert_eq!(f.rev("develop"), before);
    // Ahead only: the upstream does not descend from the branch either.
    f.git(&["branch", "-f", "develop", "origin/develop"]);
    f.git(&["switch", "-q", "develop"]);
    f.write("ahead.txt", "ahead\n");
    f.git(&["add", "ahead.txt"]);
    f.git(&["commit", "-q", "-m", "ahead"]);
    f.git(&["switch", "-q", "main"]);
    let ahead = f.rev("develop");
    assert_eq!(fast_forward(&f, "develop"), FastForward::Diverged);
    assert_eq!(f.rev("develop"), ahead);
}

#[test]
fn a_branch_a_worktree_holds_is_not_moved() {
    let f = behind();
    let folder = f.sibling("wt-develop");
    let folder_arg = folder.to_string_lossy().into_owned();
    f.git(&["worktree", "add", "-q", &folder_arg, "develop"]);
    let before = f.rev("develop");
    match fast_forward(&f, "develop") {
        FastForward::Held { worktree } => {
            assert_eq!(
                canonical(std::path::Path::new(&worktree)),
                canonical(&folder)
            );
        }
        other => panic!("expected held, got {other:?}"),
    }
    assert_eq!(f.rev("develop"), before);
}

#[test]
fn the_current_branch_is_held_by_its_own_worktree() {
    let f = behind();
    f.git(&["switch", "-q", "develop"]);
    match fast_forward(&f, "develop") {
        FastForward::Held { worktree } => {
            assert_eq!(
                canonical(std::path::Path::new(&worktree)),
                canonical(&f.root)
            );
        }
        other => panic!("expected held, got {other:?}"),
    }
}

#[test]
fn a_branch_without_an_upstream_is_an_error_before_git_runs() {
    let f = Fixture::basic();
    let result = engine(&f).branch_fast_forward("develop", &Cancel::never());
    assert!(result.is_err(), "{result:?}");
    assert!(engine(&f)
        .branch_fast_forward("no-such-branch", &Cancel::never())
        .is_err());
}

#[test]
fn a_local_upstream_beside_a_tag_of_its_name() {
    let mut f = Fixture::basic();
    // `topic` tracks the local `main` and lags it by one commit.
    f.git(&["branch", "--track", "topic", "main"]);
    f.write("more.txt", "more\n");
    f.commit("one more on main");
    // A tag named like the upstream, on an older commit, which git takes first for a short name.
    f.git(&["tag", "main", "HEAD~2"]);
    let main = f.rev("refs/heads/main");
    match fast_forward(&f, "topic") {
        FastForward::Moved { to, commits, .. } => {
            assert_eq!(to, main);
            assert_eq!(commits, 1);
        }
        other => panic!("expected moved, got {other:?}"),
    }
    assert_eq!(f.rev("refs/heads/topic"), main);
}

#[test]
fn a_symbolic_branch_is_refused_before_git_runs() {
    // `master` names `main`, which is checked out; `master` has an upstream that is ahead.
    let f = Fixture::basic().with_remote();
    f.git(&["symbolic-ref", "refs/heads/master", "refs/heads/main"]);
    f.git(&["config", "branch.master.remote", "origin"]);
    f.git(&["config", "branch.master.merge", "refs/heads/develop"]);
    let main = f.rev("refs/heads/main");
    let result = engine(&f).branch_fast_forward("master", &Cancel::never());
    assert!(result.is_err(), "{result:?}");
    assert_eq!(f.rev("refs/heads/main"), main);
    assert_eq!(f.git(&["status", "--porcelain"]), "");
}

#[test]
fn a_missing_branch_is_not_found() {
    let f = Fixture::basic();
    let result = engine(&f).branch_fast_forward("no-such-branch", &Cancel::never());
    assert!(
        matches!(result, Err(GitError::RefNotFound(ref name)) if name == "no-such-branch"),
        "{result:?}"
    );
}

#[test]
fn the_fast_forward_runs_no_maintenance() {
    let mut f = behind();
    // Three packs, a limit of one, and maintenance in the foreground: an automatic run would
    // repack them into one before git returned.
    for i in 0..3 {
        f.write(&format!("pack-{i}.txt"), "pack\n");
        f.commit(&format!("pack {i}"));
        f.git(&["repack", "-q"]);
    }
    f.git(&["config", "gc.autoPackLimit", "1"]);
    f.git(&["config", "gc.autoDetach", "false"]);
    f.git(&["config", "maintenance.autoDetach", "false"]);
    let packs = || {
        std::fs::read_dir(f.git_dir().join("objects").join("pack"))
            .expect("pack folder")
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "pack"))
            .count()
    };
    let before = packs();
    assert!(before >= 3, "{before} packs");
    assert!(matches!(
        fast_forward(&f, "develop"),
        FastForward::Moved { .. }
    ));
    assert_eq!(packs(), before);
}

/// Whether the fixture's disk folds case (`core.ignorecase`), where `Develop` names `develop`.
fn folds_case(f: &Fixture) -> bool {
    let (_, value, _) = f.try_git(&["config", "--bool", "core.ignorecase"]);
    value.trim() == "true"
}

#[test]
fn a_branch_checked_out_under_another_spelling_is_held() {
    let f = behind();
    if !folds_case(&f) {
        // A case-sensitive disk holds two branches.
        return;
    }
    let before = f.rev("refs/heads/develop");
    f.git(&["checkout", "-q", "Develop"]);
    assert!(
        matches!(fast_forward(&f, "develop"), FastForward::Held { .. }),
        "moved under the main worktree"
    );
    f.git(&["checkout", "-q", "main"]);
    let folder = f.sibling("wt-spelling");
    let folder_arg = folder.to_string_lossy().into_owned();
    f.git(&["worktree", "add", "-q", &folder_arg, "Develop"]);
    match fast_forward(&f, "develop") {
        FastForward::Held { worktree } => {
            assert_eq!(
                canonical(std::path::Path::new(&worktree)),
                canonical(&folder)
            );
        }
        other => panic!("expected held, got {other:?}"),
    }
    assert_eq!(f.rev("refs/heads/develop"), before);
    assert_eq!(f.git_in(&folder, &["status", "--porcelain"]), "");
}

#[test]
fn a_bisect_of_the_branch_in_a_worktree_holds_it_whatever_git_says() {
    let f = behind();
    let folder = f.sibling("wt-bisect");
    let folder_arg = folder.to_string_lossy().into_owned();
    f.git(&["worktree", "add", "-q", &folder_arg, "develop"]);
    f.git_in(&folder, &["bisect", "start", "develop", "develop~2"]);
    // A git fetch that ran would die on this setting before its own check.
    f.git(&["config", "fetch.recurseSubmodules", "bogus"]);
    let before = f.rev("refs/heads/develop");
    match fast_forward(&f, "develop") {
        FastForward::Held { worktree } => {
            assert_eq!(
                canonical(std::path::Path::new(&worktree)),
                canonical(&folder)
            );
        }
        other => panic!("expected held, got {other:?}"),
    }
    assert_eq!(f.rev("refs/heads/develop"), before);
}

#[test]
fn the_first_merge_value_is_the_upstream() {
    let f = behind();
    f.git(&["config", "--add", "branch.develop.merge", "refs/heads/main"]);
    let upstream = f.rev("develop@{u}");
    match fast_forward(&f, "develop") {
        FastForward::Moved { to, commits, .. } => {
            assert_eq!(to, upstream);
            assert_eq!(commits, 3);
        }
        other => panic!("expected moved, got {other:?}"),
    }
}

#[test]
fn a_local_upstream_written_short_is_listed_and_followed() {
    let mut f = Fixture::basic();
    f.git(&["branch", "topic", "main"]);
    f.git(&["config", "branch.topic.remote", "."]);
    f.git(&["config", "branch.topic.merge", "main"]);
    f.write("more.txt", "more\n");
    f.commit("one more on main");
    let listed = engine(&f).refs(&Cancel::never()).expect("refs listed");
    let topic = listed
        .iter()
        .find(|entry| entry.name == "topic")
        .expect("topic listed");
    assert_eq!(topic.upstream.as_deref(), Some("main"));
    assert!(matches!(
        fast_forward(&f, "topic"),
        FastForward::Moved { commits: 1, .. }
    ));
    assert_eq!(f.rev("refs/heads/topic"), f.rev("refs/heads/main"));
}

#[test]
fn the_fast_forward_needs_no_transport() {
    let f = behind();
    f.git(&["config", "protocol.file.allow", "never"]);
    f.git(&["config", "transfer.hideRefs", "refs/remotes"]);
    assert!(matches!(
        fast_forward(&f, "develop"),
        FastForward::Moved { commits: 3, .. }
    ));
    assert_eq!(f.rev("develop"), f.rev("origin/develop"));
}
