//! `Git2Engine` stash push, apply, pop and drop against `git stash list`.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{OutcomeKind, StashPush};
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn never() -> Cancel {
    Cancel::never()
}

fn stash_list(f: &Fixture) -> Vec<String> {
    f.git(&["stash", "list", "--format=%gs"])
        .lines()
        .map(str::to_owned)
        .collect()
}

fn read(f: &Fixture, relative: &str) -> String {
    std::fs::read_to_string(f.root.join(relative)).expect("read")
}

#[test]
fn pushes_with_a_message_and_untracked_files_and_pops() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.append("README.md", "wip\n");
    f.write("new.txt", "new\n");
    let made = e
        .stash_push(
            &StashPush {
                message: Some("wip: readme".to_owned()),
                include_untracked: true,
                paths: vec![],
            },
            &never(),
        )
        .expect("push");
    assert!(made);
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert!(!f.root.join("new.txt").exists());
    assert_eq!(stash_list(&f), ["On main: wip: readme"]);
    let outcome = e.stash_pop(0, &never()).expect("pop");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(read(&f, "README.md"), "# Fixture\nwip\n");
    assert!(f.root.join("new.txt").exists());
    assert!(stash_list(&f).is_empty());
}

#[test]
fn pushes_only_the_given_paths_and_applies_keeping_the_stash() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.append("README.md", "one\n");
    f.append("src/lib.rs", "// two\n");
    e.stash_push(
        &StashPush {
            message: None,
            include_untracked: false,
            paths: vec!["README.md".to_owned()],
        },
        &never(),
    )
    .expect("push paths");
    assert_eq!(read(&f, "README.md"), "# Fixture\n");
    assert!(read(&f, "src/lib.rs").ends_with("// two\n"));
    assert_eq!(stash_list(&f).len(), 1);
    let outcome = e.stash_apply(0, &never()).expect("apply");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(read(&f, "README.md"), "# Fixture\none\n");
    assert_eq!(stash_list(&f).len(), 1, "apply keeps the stash");
}

#[test]
fn paths_with_glob_characters_are_stashed_literally() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.write(
        "star[1].txt",
        "one
",
    );
    f.write(
        "star1.txt",
        "two
",
    );
    let made = e
        .stash_push(
            &StashPush {
                message: None,
                include_untracked: true,
                paths: vec!["star[1].txt".to_owned()],
            },
            &never(),
        )
        .expect("push");
    assert!(made);
    assert!(!f.root.join("star[1].txt").exists());
    assert!(
        f.root.join("star1.txt").exists(),
        "the glob would have matched it"
    );
    e.stash_pop(0, &never()).expect("pop");
    assert!(f.root.join("star[1].txt").exists());
}

#[test]
fn drops_by_index() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.append("README.md", "first\n");
    f.git(&["stash", "push", "-q", "-m", "first"]);
    f.append("README.md", "second\n");
    f.git(&["stash", "push", "-q", "-m", "second"]);
    assert_eq!(stash_list(&f), ["On main: second", "On main: first"]);
    e.stash_drop(1, &never()).expect("drop the older one");
    assert_eq!(stash_list(&f), ["On main: second"]);
    let error = e.stash_drop(5, &never()).expect_err("no such stash");
    assert!(matches!(error, GitError::Cli { .. }));
}

#[test]
fn a_conflicting_pop_reports_the_conflicts_and_keeps_the_stash() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    f.write("README.md", "# Stashed\n");
    f.git(&["stash", "push", "-q"]);
    f.write("README.md", "# Committed\n");
    f.commit("readme");
    let outcome = e.stash_pop(0, &never()).expect("pop stops on conflicts");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    assert_eq!(outcome.conflicts[0].path, "README.md");
    assert_eq!(stash_list(&f).len(), 1, "the stash stays");
    assert!(f.git(&["status", "--porcelain"]).contains("UU README.md"));
    f.git(&["reset", "-q", "--hard"]);
    f.tick();
}

#[test]
fn nothing_to_stash_makes_no_stash() {
    let f = Fixture::basic();
    let made = engine(&f)
        .stash_push(
            &StashPush {
                message: None,
                include_untracked: false,
                paths: vec![],
            },
            &never(),
        )
        .expect("git says there is nothing to save and exits 0");
    assert!(!made);
    assert!(stash_list(&f).is_empty());
}
