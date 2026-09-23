//! `GitEngine::merge_base` against `git merge-base`.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{BlobAt, DiffOptions, DiffTarget, LineKind};
use support::Fixture;

/// Stages everything and commits at the fixture's current second, without ticking.
fn now(f: &Fixture, message: &str) {
    f.git(&["add", "-A"]);
    f.git(&["commit", "-q", "-m", message]);
}

/// A criss-cross whose two merge bases share one committer second: A and B each merge the
/// first commit of the other, so libgit2's pick depends on the order of the pair.
fn same_second_criss_cross() -> Fixture {
    let f = Fixture::empty();
    let lines: String = (1..=10).map(|i| format!("line {i}\n")).collect();
    f.write("shared.txt", &lines);
    now(&f, "c0");
    f.git(&["checkout", "-q", "-b", "A"]);
    f.write(
        "shared.txt",
        &lines.replacen("line 1\n", "line 1 changed on a1\n", 1),
    );
    now(&f, "a1");
    f.git(&["checkout", "-q", "-b", "B", "main"]);
    f.write(
        "shared.txt",
        &lines.replacen("line 10\n", "line 10 changed on b1\n", 1),
    );
    now(&f, "b1");
    f.git(&["checkout", "-q", "A"]);
    f.git(&["merge", "-q", "--no-edit", "-m", "a2: merge b1", "B"]);
    f.git(&["checkout", "-q", "B"]);
    f.git(&["merge", "-q", "--no-edit", "-m", "b2: merge a1", "A~1"]);
    f.git(&["checkout", "-q", "main"]);
    f
}

/// (path, old line number, text) of every removed line of the three-dot diff `from...to`.
fn three_dot_removed(engine: &Git2Engine, from: &str, to: &str) -> Vec<(String, u32, String)> {
    let never = Cancel::never();
    let target = DiffTarget::Range {
        from: from.to_owned(),
        to: to.to_owned(),
        three_dot: true,
    };
    let mut walk = engine
        .diff_pages(&target, &DiffOptions::default(), 100, &never)
        .expect("diff");
    let mut removed = Vec::new();
    loop {
        let page = walk.next_page(&never).expect("page");
        for file in &page.files {
            for hunk in &file.hunks {
                for line in hunk.lines.iter().filter(|l| l.kind == LineKind::Removed) {
                    let number = line.old_number.unwrap_or(0);
                    removed.push((file.path.clone(), number, line.text.clone()));
                }
            }
        }
        if page.done {
            return removed;
        }
    }
}

#[test]
fn a_swapped_pair_gets_its_own_merge_base_everywhere() {
    let f = same_second_criss_cross();
    let fresh = |a: &str, b: &str| {
        let engine = Git2Engine::open(&f.root).expect("open");
        engine.merge_base(a, b).expect("base")
    };
    let (ab, ba) = (fresh("A", "B"), fresh("B", "A"));
    assert_ne!(ab, ba, "the fixture ties: the base depends on the order");
    assert_eq!(ab, f.git(&["merge-base", "A", "B"]));
    assert_eq!(ba, f.git(&["merge-base", "B", "A"]));

    // Compare B with A, then swap: the comparison, the old side and the diff agree.
    let engine = Git2Engine::open(&f.root).expect("open");
    let never = Cancel::never();
    engine.compare("B", "A", &never).expect("compare");
    let swapped = engine.compare("A", "B", &never).expect("compare");
    assert_eq!(swapped.base.hash, ab, "comparison base after a swap");
    assert_eq!(engine.merge_base("A", "B").expect("base"), ab);
    let old = engine
        .read_blob(
            &BlobAt::MergeBase {
                a: "A".to_owned(),
                b: "B".to_owned(),
            },
            "shared.txt",
        )
        .expect("old side");
    let text = old.text.unwrap_or_default();
    let old_lines: Vec<&str> = text.lines().collect();
    let removed = three_dot_removed(&engine, "A", "B");
    assert!(!removed.is_empty());
    for (path, number, line) in removed {
        assert_eq!(path, "shared.txt");
        assert_eq!(old_lines[number as usize - 1], line, "old line {number}");
    }
}

#[test]
fn a_branch_that_moved_gets_its_new_merge_base() {
    // The engine remembers the last pair's merge base by commit: the same names naming
    // other commits must not get the remembered one.
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "topic"]);
    f.write("topic.txt", "topic\n");
    let topic_tip = f.commit("t1: topic");
    f.git(&["checkout", "-q", "main"]);
    f.write("main.txt", "main\n");
    let fork = f.rev("main");
    f.commit("c4: main");
    let engine = Git2Engine::open(&f.root).expect("open");
    assert_eq!(engine.merge_base("main", "topic").expect("base"), fork);
    let base = BlobAt::MergeBase {
        a: "main".to_owned(),
        b: "topic".to_owned(),
    };
    assert!(
        engine.read_blob(&base, "topic.txt").is_err(),
        "not at the fork"
    );

    f.git(&["merge", "-q", "--no-ff", "-m", "m2: merge topic", "topic"]);
    assert_eq!(engine.merge_base("main", "topic").expect("base"), topic_tip);
    let moved = engine
        .read_blob(&base, "topic.txt")
        .expect("at the new base");
    assert_eq!(moved.text.as_deref(), Some("topic\n"));
}

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
