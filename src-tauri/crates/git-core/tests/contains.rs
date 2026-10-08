//! `GitEngine::refs_containing` against `git for-each-ref --contains`, with and without a
//! commit-graph file.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use support::Fixture;

fn engine(fixture: &Fixture) -> Git2Engine {
    Git2Engine::open(&fixture.root).expect("open")
}

/// git's own answer: the branches, remote branches and tags whose history holds `commit`,
/// without a remote's symbolic `HEAD` (a symbolic branch or tag stays, as the refs listing,
/// `git branch --contains` and `git tag --contains` keep it), sorted.
fn git_answer(fixture: &Fixture, commit: &str) -> Vec<String> {
    let listed = fixture.git(&[
        "for-each-ref",
        "--format=%(refname) %(symref)",
        "--contains",
        commit,
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ]);
    let mut names: Vec<String> = listed
        .lines()
        .filter_map(|line| {
            let (name, symref) = line.split_once(' ').unwrap_or((line, ""));
            (symref.is_empty() || !name.starts_with("refs/remotes/")).then(|| name.to_owned())
        })
        .collect();
    names.sort();
    names
}

fn answer(fixture: &Fixture, commit: &str) -> Vec<String> {
    let mut names = engine(fixture)
        .refs_containing(commit, &Cancel::never())
        .expect("refs containing");
    names.sort();
    names
}

/// Every commit of the fixture's refs gets git's answer.
fn every_commit_matches(fixture: &Fixture) {
    for commit in fixture.git(&["rev-list", "--all"]).lines() {
        assert_eq!(
            answer(fixture, commit),
            git_answer(fixture, commit),
            "{commit}"
        );
    }
}

#[test]
fn a_merged_commit_is_in_the_branches_tags_and_remote_branches_that_hold_it() {
    let fixture = Fixture::basic().with_remote();
    fixture.git(&["tag", "v2", "main"]);
    fixture.git(&["tag", "tree-tag", "main^{tree}"]);
    let first = fixture.rev("main^2~1");
    let names = answer(&fixture, &first);
    assert_eq!(names, git_answer(&fixture, &first));
    for expected in [
        "refs/heads/develop",
        "refs/heads/main",
        "refs/remotes/origin/develop",
        "refs/remotes/origin/main",
        "refs/tags/v2",
    ] {
        assert!(
            names.iter().any(|name| name == expected),
            "{expected} in {names:?}"
        );
    }
    assert!(
        !names.iter().any(|name| name == "refs/tags/v1"),
        "{names:?}"
    );
}

#[test]
fn every_commit_gets_git_s_answer() {
    let fixture = Fixture::basic().with_remote().with_octopus();
    fixture.git(&["tag", "-a", "v3", "-m", "version 3", "develop"]);
    every_commit_matches(&fixture);
}

#[test]
fn every_commit_gets_git_s_answer_with_a_commit_graph() {
    let mut fixture = Fixture::basic().with_remote().with_octopus();
    fixture.git(&["tag", "-a", "v3", "-m", "version 3", "develop"]);
    fixture.git(&["commit-graph", "write", "--reachable"]);
    // A commit after the graph was written is not in it: git walks it.
    fixture.write("after.txt", "after the graph\n");
    fixture.commit("a1: after the graph");
    every_commit_matches(&fixture);
}

#[test]
fn a_branch_whose_clock_is_behind_still_holds_the_commit() {
    for graph in [false, true] {
        let mut fixture = Fixture::basic();
        let commit = fixture.head();
        fixture.git(&["checkout", "-q", "-b", "skewed"]);
        // A year before the fixture's first commit: older than every commit it holds.
        fixture.set_clock(1_704_067_200 - 365 * 24 * 3600);
        fixture.write("skewed.txt", "a clock behind\n");
        fixture.commit("s1: a clock behind");
        fixture.git(&["checkout", "-q", "main"]);
        if graph {
            fixture.git(&["commit-graph", "write", "--reachable"]);
        }
        let names = answer(&fixture, &commit);
        assert!(
            names.iter().any(|name| name == "refs/heads/skewed"),
            "{names:?}"
        );
        assert_eq!(names, git_answer(&fixture, &commit));
    }
}

#[test]
fn a_symbolic_branch_or_tag_holds_what_its_target_holds_and_a_remote_head_is_left_out() {
    let fixture = Fixture::basic().with_remote();
    fixture.git(&["remote", "set-head", "origin", "main"]);
    fixture.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
    fixture.git(&["symbolic-ref", "refs/tags/latest", "refs/tags/v1"]);
    let first = fixture.rev("main~3");
    let names = answer(&fixture, &first);
    for expected in ["refs/heads/alias", "refs/tags/latest"] {
        assert!(
            names.iter().any(|name| name == expected),
            "{expected} in {names:?}"
        );
    }
    assert!(
        !names.iter().any(|name| name == "refs/remotes/origin/HEAD"),
        "{names:?}"
    );
    assert_eq!(names, git_answer(&fixture, &first));
}

#[test]
fn a_ref_whose_object_is_missing_is_skipped_as_git_skips_it() {
    // An interrupted fetch or an aggressive prune leaves refs that name an object the store
    // has not: git's listing of the refs skips them, `rev-list --branches` would die on them.
    let fixture = Fixture::basic().with_remote();
    let missing = "1234567890123456789012345678901234567890";
    for name in [
        "refs/heads/gone",
        "refs/remotes/origin/gone",
        "refs/tags/gone",
    ] {
        std::fs::write(fixture.git_dir().join(name), format!("{missing}\n")).expect("ref file");
    }
    let first = fixture.rev("main~3");
    assert_eq!(answer(&fixture, &first), git_answer(&fixture, &first));
}

#[test]
fn a_tag_whose_commit_is_gone_is_skipped_as_git_skips_it() {
    let mut fixture = Fixture::basic();
    fixture.git(&["checkout", "-q", "-b", "doomed"]);
    fixture.write("doomed.txt", "doomed\n");
    fixture.commit("x1: only a tag holds this");
    fixture.git(&["tag", "-a", "doomed-tag", "-m", "holds a pruned commit"]);
    fixture.git(&["checkout", "-q", "main"]);
    fixture.git(&["branch", "-q", "-D", "doomed"]);
    fixture.delete_object("doomed-tag^{commit}");
    let first = fixture.rev("main~3");
    assert_eq!(answer(&fixture, &first), git_answer(&fixture, &first));
}

#[test]
fn a_branch_whose_tip_cannot_be_read_is_skipped_as_git_skips_it() {
    let mut fixture = Fixture::basic();
    fixture.git(&["checkout", "-q", "-b", "broken"]);
    fixture.write("broken.txt", "broken\n");
    fixture.commit("b1: a tip that cannot be read");
    fixture.git(&["checkout", "-q", "main"]);
    fixture.truncate_object("broken");
    let first = fixture.rev("main~3");
    assert_eq!(answer(&fixture, &first), git_answer(&fixture, &first));
}

#[test]
fn a_ref_git_cannot_read_is_left_out_as_git_leaves_it_out() {
    // Names git refuses (a space, a tilde) and a loose ref whose content is not a hash: git's
    // listing ignores them with a warning, `rev-list --branches` would die on them.
    let fixture = Fixture::basic();
    let main = fixture.rev("main");
    for name in [
        "refs/heads/with space",
        "refs/heads/a~b",
        "refs/tags/bad tag",
    ] {
        std::fs::write(fixture.git_dir().join(name), format!("{main}\n")).expect("ref file");
    }
    std::fs::write(fixture.git_dir().join("refs/heads/garbage"), "not a hash\n").expect("ref file");
    let first = fixture.rev("main~3");
    assert_eq!(answer(&fixture, &first), git_answer(&fixture, &first));
}

#[test]
fn refs_libgit2_cannot_read_are_an_error_not_an_empty_answer() {
    // git reads a packed-refs line whose hash and name a tab separates; libgit2 calls the
    // file corrupted. The answer must not be "in no ref".
    let fixture = Fixture::basic();
    fixture.git(&["pack-refs", "--all"]);
    let packed = fixture.git_dir().join("packed-refs");
    let text = std::fs::read_to_string(&packed).expect("packed-refs");
    std::fs::write(
        &packed,
        text.replacen(" refs/heads/main", "\trefs/heads/main", 1),
    )
    .expect("rewrite packed-refs");
    let first = fixture.rev("main~3");
    assert!(
        !git_answer(&fixture, &first).is_empty(),
        "git reads the refs"
    );
    let result = engine(&fixture).refs_containing(&first, &Cancel::never());
    assert!(result.is_err(), "{result:?}");
}

#[test]
fn a_ref_whose_name_is_not_utf8_is_left_out() {
    // git lists it; the answer is text, and the refs listing leaves such a ref out too.
    let fixture = Fixture::basic();
    fixture.git(&["pack-refs", "--all"]);
    let packed = fixture.git_dir().join("packed-refs");
    // Without the `sorted` trait git sorts the records itself, so the new one can go last.
    let text = std::fs::read_to_string(&packed).expect("packed-refs");
    let mut bytes = text.replacen(" sorted", "", 1).into_bytes();
    bytes.extend_from_slice(format!("{} refs/heads/caf", fixture.rev("main")).as_bytes());
    bytes.extend_from_slice(&[0xe9, b'\n']);
    std::fs::write(&packed, bytes).expect("rewrite packed-refs");
    let first = fixture.rev("main~3");
    let git = git_answer(&fixture, &first);
    let readable: Vec<String> = git
        .iter()
        .filter(|name| !name.contains('\u{fffd}'))
        .cloned()
        .collect();
    assert_eq!(readable.len() + 1, git.len(), "git lists the name: {git:?}");
    assert_eq!(answer(&fixture, &first), readable);
}

#[test]
fn a_commit_only_a_stash_holds_is_in_no_ref() {
    let fixture = Fixture::basic().with_stash();
    let stash = fixture.rev("stash@{0}");
    assert_eq!(answer(&fixture, &stash), Vec::<String>::new());
    assert_eq!(git_answer(&fixture, &stash), Vec::<String>::new());
}

#[test]
fn a_hash_that_is_no_commit_of_the_repository_is_not_found() {
    let fixture = Fixture::basic();
    let tag = fixture.rev("v1");
    assert_ne!(tag, fixture.rev("v1^{commit}"), "an annotated tag object");
    for asked in ["0".repeat(40), "main".to_owned(), tag] {
        let error = engine(&fixture)
            .refs_containing(&asked, &Cancel::never())
            .expect_err("not a commit");
        assert!(
            matches!(error, GitError::RefNotFound(_)),
            "{asked}: {error:?}"
        );
    }
}

#[test]
fn a_history_with_a_missing_commit_is_an_error_not_a_guess() {
    // git's `for-each-ref --contains` prints "could not parse commit" and then counts the
    // failed check as a yes; the walk fails instead.
    let fixture = Fixture::basic();
    let first = fixture.rev("main~3");
    fixture.delete_object("main~1");
    let result = engine(&fixture).refs_containing(&first, &Cancel::never());
    assert!(result.is_err(), "{result:?}");
}

#[test]
fn a_cancelled_read_answers_cancelled() {
    let fixture = Fixture::basic();
    let cancel = Cancel::new();
    cancel.cancel();
    let error = engine(&fixture)
        .refs_containing(&fixture.head(), &cancel)
        .expect_err("cancelled");
    assert!(matches!(error, GitError::Cancelled), "{error:?}");
}

#[test]
fn a_packed_refs_file_libgit2_cannot_open_is_an_error() {
    let fixture = Fixture::basic();
    let head = fixture.head();
    fixture.git(&["pack-refs", "--all"]);
    let packed = fixture.git_dir().join("packed-refs");
    std::fs::remove_file(&packed).expect("remove packed-refs");
    std::fs::create_dir(&packed).expect("a folder in its place");
    let result = engine(&fixture).refs_containing(&head, &Cancel::never());
    assert!(result.is_err(), "{result:?}");
}
