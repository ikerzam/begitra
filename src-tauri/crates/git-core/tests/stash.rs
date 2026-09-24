//! `Git2Engine` stash push, apply, pop and drop against `git stash list`; the stash is
//! named by its commit, as the stash sheet names the row the user chose.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{OperationState, OutcomeKind, RefKind, StashPush};
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

/// The commit of `stash@{n}`, as the refs listing gives it to the frontend.
fn stash_commit(f: &Fixture, n: usize) -> String {
    f.git(&["rev-parse", &format!("stash@{{{n}}}")])
}

/// The stashes the engine lists, as `git stash list --format='%gd %H'` prints them.
fn listed(e: &Git2Engine) -> Vec<String> {
    e.refs(&never())
        .expect("refs")
        .into_iter()
        .filter(|entry| entry.kind == RefKind::Stash)
        .map(|entry| format!("{} {}", entry.name, entry.target))
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
    let outcome = e.stash_pop(&stash_commit(&f, 0), &never()).expect("pop");
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
    let outcome = e
        .stash_apply(&stash_commit(&f, 0), &never())
        .expect("apply");
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
    e.stash_pop(&stash_commit(&f, 0), &never()).expect("pop");
    assert!(f.root.join("star[1].txt").exists());
}

#[test]
fn drops_the_older_of_two_by_its_commit() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.append("README.md", "first\n");
    f.git(&["stash", "push", "-q", "-m", "first"]);
    f.append("README.md", "second\n");
    f.git(&["stash", "push", "-q", "-m", "second"]);
    assert_eq!(stash_list(&f), ["On main: second", "On main: first"]);
    e.stash_drop(&stash_commit(&f, 1), &never())
        .expect("drop the older one");
    assert_eq!(stash_list(&f), ["On main: second"]);
    // A commit that is no stash.
    let head = f.head();
    let error = e.stash_drop(&head, &never()).expect_err("no such stash");
    assert!(
        matches!(&error, GitError::StashNotFound(hash) if *hash == head),
        "{error:?}"
    );
    assert_eq!(stash_list(&f), ["On main: second"]);
}

#[test]
fn nothing_is_written_when_there_is_no_stash() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.append("README.md", "only\n");
    f.git(&["stash", "push", "-q", "-m", "only"]);
    let only = stash_commit(&f, 0);
    // Dropped from a terminal: no stash is left, and git removes the list.
    f.git(&["stash", "drop", "-q"]);
    let log = f.git_dir().join("logs").join("refs").join("stash");
    assert!(!log.exists());
    for error in [
        e.stash_drop(&only, &never()).expect_err("drop"),
        e.stash_pop(&only, &never()).map(|_| ()).expect_err("pop"),
        e.stash_apply(&only, &never())
            .map(|_| ())
            .expect_err("apply"),
    ] {
        assert_eq!(error.code(), "stash.not_found", "{error:?}");
    }
    // libgit2 creates an empty reflog when asked for a missing one: the lookup must not ask.
    assert!(!log.exists(), "the lookup wrote {}", log.display());
    assert_eq!(read(&f, "README.md"), "# Fixture\n");
    // `refs/stash` without its reflog, as `git update-ref` leaves it: no stash for git either.
    f.git(&["update-ref", "refs/stash", &only]);
    assert!(listed(&e).is_empty());
    for error in [
        e.stash_drop(&only, &never()).expect_err("drop"),
        e.stash_pop(&only, &never()).map(|_| ()).expect_err("pop"),
        e.stash_apply(&only, &never())
            .map(|_| ())
            .expect_err("apply"),
    ] {
        assert_eq!(error.code(), "stash.not_found", "{error:?}");
    }
    assert!(!log.exists(), "the lookup wrote {}", log.display());
    let (popped, _, _) = f.try_git_in(&f.root, &["stash", "pop"]);
    assert!(!popped, "git still finds no stash");
}

#[test]
fn an_entry_git_does_not_count_is_not_in_the_list() {
    let f = Fixture::basic();
    let e = engine(&f);
    for message in ["s1", "s2"] {
        f.append("README.md", &format!("{message}\n"));
        f.git(&["stash", "push", "-q", "-m", message]);
    }
    // git skips a reflog line whose time is 0 as corrupt, in `git stash list` and in
    // `stash@{n}` alike; libgit2 reads it.
    f.append("README.md", "zero\n");
    f.git_with_env(
        &[("GIT_COMMITTER_DATE", "@0 +0000")],
        &["stash", "push", "-q", "-m", "zero"],
    );
    let zero = f.git(&["rev-parse", "refs/stash"]);
    f.append("README.md", "s3\n");
    f.git(&["stash", "push", "-q", "-m", "s3"]);
    assert_eq!(
        stash_list(&f),
        ["On main: s3", "On main: s2", "On main: s1"]
    );
    let git: Vec<String> = f
        .git(&["stash", "list", "--format=%gd %H"])
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(listed(&e), git);
    assert_eq!(
        e.stash_drop(&zero, &never())
            .expect_err("not counted")
            .code(),
        "stash.not_found"
    );
    e.stash_drop(&stash_commit(&f, 1), &never())
        .expect("drop s2");
    assert_eq!(stash_list(&f), ["On main: s3", "On main: s1"]);
}

#[test]
fn a_stash_whose_commit_is_missing_is_left_out_and_the_rest_listed() {
    let f = Fixture::basic();
    let e = engine(&f);
    for message in ["s1", "s2", "s3"] {
        f.append("README.md", &format!("{message}\n"));
        f.git(&["stash", "push", "-q", "-m", message]);
    }
    let (s3, s2, s1) = (
        stash_commit(&f, 0),
        stash_commit(&f, 1),
        stash_commit(&f, 2),
    );
    f.delete_object(&s2);
    // `git stash list` leaves the entry out and keeps counting it; the branches stay listed.
    assert_eq!(
        listed(&e),
        [format!("stash@{{0}} {s3}"), format!("stash@{{2}} {s1}")]
    );
    assert!(e
        .refs(&never())
        .expect("refs")
        .iter()
        .any(|entry| entry.kind == RefKind::LocalBranch));
}

#[test]
fn pop_drops_the_chosen_stash_when_the_list_moves_during_its_apply() {
    let mut f = Fixture::basic();
    // The apply writes `gated.txt` through a filter that waits for a signal, so another
    // process can stash while it runs.
    f.write(".gitattributes", "gated.txt filter=gate\n");
    f.write("gated.txt", "one\n");
    f.commit("gated");
    f.write("gated.txt", "chosen\n");
    f.git(&["stash", "push", "-q", "-m", "chosen"]);
    let chosen = stash_commit(&f, 0);
    f.append("README.md", "other\n");
    f.git(&["stash", "push", "-q", "-m", "other"]);
    f.append("src/lib.rs", "// late\n");
    let late = f.git(&["stash", "create", "late"]);
    f.git(&["checkout", "-q", "--", "src/lib.rs"]);
    let signals = f.sibling("signals");
    std::fs::create_dir_all(&signals).expect("signals folder");
    let (started, go) = (signals.join("started"), signals.join("go"));
    let slashed = |path: &std::path::Path| path.to_string_lossy().replace('\\', "/");
    f.git(&[
        "config",
        "filter.gate.smudge",
        &format!(
            "sh -c 'touch \"{}\"; while [ ! -e \"{}\" ]; do sleep 0.05; done; cat'",
            slashed(&started),
            slashed(&go)
        ),
    ]);
    let e = engine(&f);
    let popping = std::thread::spawn(move || e.stash_pop(&chosen, &never()));
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !started.exists() && std::time::Instant::now() < until {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let waited = started.exists();
    // Another process stashes while the apply waits: every position moves by one.
    f.git(&["stash", "store", "-m", "late", &late]);
    std::fs::write(&go, "").expect("go");
    let outcome = popping.join().expect("the pop's thread").expect("pop");
    assert!(waited, "the apply went through the filter");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(read(&f, "gated.txt"), "chosen\n");
    assert_eq!(stash_list(&f), ["late", "On main: other"]);
}

#[test]
fn pops_what_the_list_shows_after_its_newest_entry_was_deleted() {
    let f = Fixture::basic();
    let e = engine(&f);
    for (file, message) in [("a.txt", "a"), ("b.txt", "b"), ("c.txt", "c")] {
        f.write(file, &format!("{message}\n"));
        f.git(&["add", file]);
        f.git(&["stash", "push", "-q", "-m", message]);
    }
    // Without `--updateref`, `refs/stash` keeps naming "c" while the list starts at "b": git
    // reads `stash@{0}` as the ref, the list and the app as the reflog's newest entry.
    f.git(&["reflog", "delete", "stash@{0}"]);
    assert_eq!(stash_list(&f), ["On main: b", "On main: a"]);
    let newest = f.git(&["log", "-g", "--format=%H", "refs/stash"]);
    let b = newest.lines().next().expect("the list's newest entry");
    assert_ne!(stash_commit(&f, 0), b, "git reads stash@{{0}} as the ref");
    let outcome = e.stash_pop(b, &never()).expect("pop");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert!(f.root.join("b.txt").exists(), "b applied");
    assert!(!f.root.join("c.txt").exists(), "c not applied");
    assert_eq!(stash_list(&f), ["On main: a"]);
}

#[test]
fn a_stash_stored_twice_drops_its_newest_copy() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.append("README.md", "twice\n");
    f.git(&["stash", "push", "-q", "-m", "twice"]);
    let twice = stash_commit(&f, 0);
    f.append("src/lib.rs", "// other\n");
    f.git(&["stash", "push", "-q", "-m", "other"]);
    f.git(&["stash", "store", "-m", "copy", &twice]);
    assert_eq!(stash_list(&f), ["copy", "On main: other", "On main: twice"]);
    e.stash_drop(&twice, &never()).expect("drop");
    assert_eq!(stash_list(&f), ["On main: other", "On main: twice"]);
}

#[test]
fn drops_the_chosen_stash_after_another_was_pushed() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.append("README.md", "first\n");
    f.git(&["stash", "push", "-q", "-m", "first"]);
    f.append("README.md", "second\n");
    f.git(&["stash", "push", "-q", "-m", "second"]);
    let first = stash_commit(&f, 1);
    // A stash pushed from a terminal: the chosen one is `stash@{2}` now.
    f.append("src/lib.rs", "// third\n");
    f.git(&["stash", "push", "-q", "-m", "third"]);
    assert_eq!(
        stash_list(&f),
        ["On main: third", "On main: second", "On main: first"]
    );
    e.stash_drop(&first, &never()).expect("drop the chosen one");
    assert_eq!(stash_list(&f), ["On main: third", "On main: second"]);
}

#[test]
fn applies_and_pops_the_chosen_stash_after_another_was_pushed() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.append("README.md", "chosen\n");
    f.git(&["stash", "push", "-q", "-m", "chosen"]);
    let chosen = stash_commit(&f, 0);
    f.append("src/lib.rs", "// other\n");
    f.git(&["stash", "push", "-q", "-m", "other"]);
    // Applied where it sits now, `stash@{1}`, and kept.
    let outcome = e.stash_apply(&chosen, &never()).expect("apply");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(read(&f, "README.md"), "# Fixture\nchosen\n");
    assert!(!read(&f, "src/lib.rs").contains("// other"));
    assert_eq!(stash_list(&f), ["On main: other", "On main: chosen"]);
    f.git(&["checkout", "-q", "--", "README.md"]);
    let outcome = e.stash_pop(&chosen, &never()).expect("pop");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(read(&f, "README.md"), "# Fixture\nchosen\n");
    assert_eq!(stash_list(&f), ["On main: other"]);
}

#[test]
fn a_stash_gone_meanwhile_is_not_found_and_nothing_runs() {
    let f = Fixture::basic();
    let e = engine(&f);
    for message in ["one", "two", "three"] {
        f.append("README.md", &format!("{message}\n"));
        f.git(&["stash", "push", "-q", "-m", message]);
    }
    // Dropped from a terminal.
    let dropped = stash_commit(&f, 0);
    f.git(&["stash", "drop", "-q", "stash@{0}"]);
    // Deleted from the stash's reflog alone.
    let deleted = stash_commit(&f, 1);
    f.git(&["reflog", "delete", "stash@{1}"]);
    assert_eq!(stash_list(&f), ["On main: two"]);
    for gone in [&dropped, &deleted] {
        for error in [
            e.stash_drop(gone, &never()).expect_err("drop"),
            e.stash_pop(gone, &never()).map(|_| ()).expect_err("pop"),
            e.stash_apply(gone, &never())
                .map(|_| ())
                .expect_err("apply"),
        ] {
            assert!(
                matches!(&error, GitError::StashNotFound(hash) if hash == gone),
                "{error:?}"
            );
            assert_eq!(error.code(), "stash.not_found");
        }
    }
    assert_eq!(stash_list(&f), ["On main: two"]);
    assert_eq!(read(&f, "README.md"), "# Fixture\n", "nothing was applied");
}

#[test]
fn a_conflicting_pop_reports_the_conflicts_and_keeps_the_stash() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    f.write("README.md", "# Stashed\n");
    f.git(&["stash", "push", "-q"]);
    f.write("README.md", "# Committed\n");
    f.commit("readme");
    let stashed = stash_commit(&f, 0);
    let outcome = e
        .stash_pop(&stashed, &never())
        .expect("pop stops on conflicts");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    assert_eq!(outcome.conflicts[0].path, "README.md");
    assert_eq!(stash_list(&f).len(), 1, "the stash stays");
    assert!(f.git(&["status", "--porcelain"]).contains("UU README.md"));
    // Over the conflicted path git refuses to start anything, with the exit code of a stop:
    // neither a rebase nor another apply is a stop, and nothing is in progress.
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
    let error = e
        .rebase("HEAD~1", &never())
        .expect_err("refused over an unmerged file");
    match &error {
        GitError::Cli { stderr, .. } => assert!(
            stderr.contains("unstaged changes") || stderr.contains("needs merge"),
            "{stderr}"
        ),
        other => panic!("unexpected {other:?}"),
    }
    let error = e.stash_apply(&stashed, &never()).expect_err("refused");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
    assert_eq!(stash_list(&f).len(), 1);
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
