//! `GitEngine::merge_base` against `git merge-base`.

mod support;

use git_core::engine::GitEngine;
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use support::Fixture;

#[test]
fn matches_the_cli_for_related_revisions() {
    let f = Fixture::basic().with_remote();
    let engine = Git2Engine::open(&f.root).expect("open");
    let c3 = f.rev("main^1");
    let pairs = [
        ("main", "develop"),
        ("develop", "origin/develop"),
        ("v1", "develop"),
        ("HEAD~1", "develop"),
        ("main", "main"),
        (c3.as_str(), "origin/develop"),
    ];
    for (a, b) in pairs {
        let expected = f.git(&["merge-base", a, b]);
        assert_eq!(
            engine.merge_base(a, b).expect("merge base"),
            expected,
            "{a} {b}"
        );
        assert_eq!(
            engine.merge_base(b, a).expect("merge base"),
            expected,
            "{b} {a}"
        );
    }
    assert_eq!(
        engine.merge_base("main", "develop").expect("merge base"),
        f.rev("main^2")
    );
}

#[test]
fn fails_with_unrelated_histories_for_an_orphan_branch() {
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "--orphan", "lonely"]);
    f.write("lonely.txt", "alone\n");
    f.commit("orphan root");
    f.git(&["checkout", "-q", "main"]);
    let (ok, _, _) = f.try_git(&["merge-base", "main", "lonely"]);
    assert!(!ok, "git found a merge base for unrelated histories");

    let engine = Git2Engine::open(&f.root).expect("open");
    let error = engine.merge_base("main", "lonely").expect_err("must fail");
    assert_eq!(error.code(), "refs.unrelated_histories");
    match &error {
        GitError::UnrelatedHistories { a, b } => {
            assert_eq!((a.as_str(), b.as_str()), ("main", "lonely"));
        }
        other => panic!("unexpected error {other:?}"),
    }
}

#[test]
fn fails_with_refs_not_found_for_an_unknown_revision() {
    let f = Fixture::basic();
    let engine = Git2Engine::open(&f.root).expect("open");
    let error = engine.merge_base("main", "nope").expect_err("must fail");
    assert_eq!(error.code(), "refs.not_found");
    assert!(
        matches!(&error, GitError::RefNotFound(rev) if rev == "nope"),
        "{error:?}"
    );
}

#[test]
fn fails_with_refs_not_found_on_an_unborn_repository() {
    let f = Fixture::unborn();
    let engine = Git2Engine::open(&f.root).expect("open");
    let error = engine.merge_base("HEAD", "HEAD").expect_err("must fail");
    assert_eq!(error.code(), "refs.not_found");
}

#[test]
fn a_tree_tag_is_not_found_and_a_truncated_target_is_corrupt() {
    let f = Fixture::basic();
    f.git(&["tag", "treetag", "HEAD^{tree}"]);
    let engine = Git2Engine::open(&f.root).expect("open");
    assert_eq!(
        engine
            .merge_base("treetag", "main")
            .expect_err("a tree is not a commit")
            .code(),
        "refs.not_found"
    );
    let hash = f.truncate_object("develop");
    match engine.merge_base("main", "develop").expect_err("must fail") {
        GitError::CorruptObject { hash: reported, .. } => assert_eq!(reported, hash),
        other => panic!("unexpected error {other:?}"),
    }
}
