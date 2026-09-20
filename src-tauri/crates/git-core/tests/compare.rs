//! `Git2Engine::compare` and `merge_preview` against `git merge-base`, `git rev-list
//! --left-right --count` and `git merge-tree --write-tree`.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{ComparisonRelation, MergePreviewKind};
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

/// `git rev-list --left-right --count a...b` as (only in a, only in b).
fn left_right(f: &Fixture, a: &str, b: &str) -> (u32, u32) {
    let output = f.git(&["rev-list", "--left-right", "--count", &format!("{a}...{b}")]);
    let mut parts = output
        .split_whitespace()
        .map(|n| n.parse::<u32>().expect("count"));
    (parts.next().expect("left"), parts.next().expect("right"))
}

/// `main` and `feature` diverged at `v1`: main has the basic fixture's four commits plus one
/// rewriting `src/lib.rs`, feature three commits rewriting the same file and appending to
/// `README.md`, which main leaves alone.
fn diverged() -> Fixture {
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "feature", "v1"]);
    for i in 0..3 {
        f.write("src/lib.rs", &format!("pub fn lib() -> u32 {{ {i} }}\n"));
        f.append("README.md", &format!("feature {i}\n"));
        f.commit(&format!("feature {i}"));
    }
    f.git(&["checkout", "-q", "main"]);
    f.write("src/lib.rs", "pub fn one() -> u32 {\n    100\n}\n");
    f.commit("main: bump one");
    f
}

#[test]
fn compare_reports_the_base_the_counts_and_the_relation() {
    let f = diverged();
    let engine = engine(&f);
    let comparison = engine
        .compare("main", "feature", &Cancel::never())
        .expect("compare");
    assert_eq!(
        comparison.base.hash,
        f.git(&["merge-base", "main", "feature"])
    );
    let base_time: i64 = f
        .git(&["show", "-s", "--format=%ct", &comparison.base.hash])
        .parse()
        .expect("time");
    assert_eq!(comparison.base.time, base_time);
    assert_eq!(comparison.a.rev, "main");
    assert_eq!(comparison.a.hash, f.rev("main"));
    assert_eq!(comparison.b.hash, f.rev("feature"));
    let (only_a, only_b) = left_right(&f, "main", "feature");
    assert_eq!(
        (comparison.only_in_a, comparison.only_in_b),
        (only_a, only_b)
    );
    assert!(only_a > 0 && only_b == 3);
    assert_eq!(comparison.relation, ComparisonRelation::Diverged);

    // The other way round swaps the counts.
    let mirrored = engine
        .compare("feature", "main", &Cancel::never())
        .expect("compare");
    assert_eq!((mirrored.only_in_a, mirrored.only_in_b), (only_b, only_a));

    // An ancestor: v1 against main is a fast-forward, main against v1 is up to date, and a
    // tag endpoint is peeled to its commit.
    let forward = engine
        .compare("v1", "main", &Cancel::never())
        .expect("compare");
    assert_eq!(forward.relation, ComparisonRelation::FastForward);
    assert_eq!(forward.only_in_a, 0);
    assert_eq!(forward.a.hash, f.rev("v1^{commit}"));
    let behind = engine
        .compare("main", "v1", &Cancel::never())
        .expect("compare");
    assert_eq!(behind.relation, ComparisonRelation::UpToDate);
    assert_eq!(behind.only_in_b, 0);
    let same = engine
        .compare("main", "main", &Cancel::never())
        .expect("compare");
    assert_eq!(same.relation, ComparisonRelation::Same);
    assert_eq!((same.only_in_a, same.only_in_b), (0, 0));
}

#[test]
fn compare_fails_readably() {
    let f = Fixture::basic();
    let engine = engine(&f);
    let unknown = engine
        .compare("main", "nope", &Cancel::never())
        .expect_err("unknown");
    assert_eq!(unknown.code(), "refs.not_found");
    // An orphan branch shares nothing with main.
    f.git(&["checkout", "-q", "--orphan", "orphan"]);
    f.git(&["rm", "-rfq", "."]);
    f.write("alone.txt", "alone\n");
    f.git(&["add", "alone.txt"]);
    f.git(&["commit", "-q", "-m", "orphan root"]);
    f.git(&["checkout", "-q", "main"]);
    let unrelated = engine
        .compare("main", "orphan", &Cancel::never())
        .expect_err("unrelated");
    assert_eq!(unrelated.code(), "refs.unrelated_histories");
}

#[test]
fn merge_preview_agrees_with_git_merge_tree() {
    let f = diverged();
    let engine = engine(&f);
    let refs_before = f.git(&["for-each-ref"]);
    // Both sides changed the same lines of src/lib.rs: a conflict git names too.
    let preview = engine
        .merge_preview("main", "feature", &Cancel::never())
        .expect("preview");
    assert_eq!(preview.kind, MergePreviewKind::Conflicts);
    let (ok, stdout, _) = f.try_git(&[
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "main",
        "feature",
    ]);
    assert!(!ok, "git merge-tree exits 1 on conflicts");
    let named: Vec<&str> = stdout.lines().skip(1).filter(|l| !l.is_empty()).collect();
    assert_eq!(preview.conflicts, named);
    assert_eq!(preview.conflicts, vec!["src/lib.rs"]);

    // Nothing changed in the repository: no ref, no index entry, no working tree change.
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert_eq!(f.git(&["for-each-ref"]), refs_before);

    // A clean merge: a branch that only adds a file.
    f.git(&["checkout", "-q", "-b", "docs", "main"]);
    f.write("docs/new.md", "new\n");
    f.git(&["add", "docs/new.md"]);
    f.git(&["commit", "-q", "-m", "docs"]);
    f.git(&["checkout", "-q", "main"]);
    f.write("src/other.rs", "// other\n");
    f.git(&["add", "src/other.rs"]);
    f.git(&["commit", "-q", "-m", "other"]);
    let clean = engine
        .merge_preview("main", "docs", &Cancel::never())
        .expect("preview");
    assert_eq!(clean.kind, MergePreviewKind::Clean);
    assert!(clean.conflicts.is_empty());
    let (ok, _, _) = f.try_git(&["merge-tree", "--write-tree", "main", "docs"]);
    assert!(ok);

    // Fast-forward and up-to-date come from the counts, without git.
    let forward = engine
        .merge_preview("v1", "main", &Cancel::never())
        .expect("preview");
    assert_eq!(forward.kind, MergePreviewKind::FastForward);
    let up_to_date = engine
        .merge_preview("main", "v1", &Cancel::never())
        .expect("preview");
    assert_eq!(up_to_date.kind, MergePreviewKind::UpToDate);
    let same = engine
        .merge_preview("main", "main", &Cancel::never())
        .expect("preview");
    assert_eq!(same.kind, MergePreviewKind::UpToDate);
}

/// A file on one side and a directory of the same name on the other: git moves the file
/// aside under `thing~<label>` (the label being the argument it was given: a hash here, the
/// branch name in a terminal), and the preview lists `thing`, the path the user can open.
#[test]
fn merge_preview_names_a_directory_file_conflict_by_its_path() {
    let f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "dir-file-a", "main"]);
    f.write("thing", "a file\n");
    f.git(&["add", "thing"]);
    f.git(&["commit", "-q", "-m", "file"]);
    f.git(&["checkout", "-q", "-b", "dir-file-b", "main"]);
    f.write("thing/inner.txt", "inside\n");
    f.git(&["add", "thing/inner.txt"]);
    f.git(&["commit", "-q", "-m", "directory"]);
    f.git(&["checkout", "-q", "main"]);
    let engine = engine(&f);
    for (a, b) in [("dir-file-a", "dir-file-b"), ("dir-file-b", "dir-file-a")] {
        let preview = engine
            .merge_preview(a, b, &Cancel::never())
            .expect("preview");
        assert_eq!(preview.kind, MergePreviewKind::Conflicts, "{a} {b}");
        assert_eq!(preview.conflicts, vec!["thing"], "{a} {b}");
        // git, given the names, labels the moved file with the first name.
        let (ok, stdout, _) = f.try_git(&[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            a,
            b,
        ]);
        assert!(!ok);
        let named: Vec<&str> = stdout.lines().skip(1).filter(|l| !l.is_empty()).collect();
        assert_eq!(named, vec!["thing~dir-file-a"]);
    }
}

#[test]
fn merge_preview_reports_unrelated_histories_and_cancellation() {
    let f = diverged();
    let engine = engine(&f);
    let cancel = Cancel::new();
    cancel.cancel();
    let cancelled = engine
        .merge_preview("main", "feature", &cancel)
        .expect_err("cancelled");
    assert_eq!(cancelled.code(), "op.cancelled");
    let unknown = engine
        .merge_preview("main", "nope", &Cancel::never())
        .expect_err("unknown");
    assert_eq!(unknown.code(), "refs.not_found");
}
