//! `Git2Engine` branch, tag, upstream, merge, rebase, reset, cherry-pick and revert
//! operations against the git CLI on fixture repositories.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    ConflictKind, LocalChanges, MergeMode, OperationState, OutcomeKind, ResetMode, SequencerAction,
    SwitchTarget,
};
use support::canonical;
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn never() -> Cancel {
    Cancel::never()
}

fn head_ref(f: &Fixture) -> String {
    f.git(&["symbolic-ref", "-q", "HEAD"])
}

fn read(f: &Fixture, relative: &str) -> String {
    std::fs::read_to_string(f.root.join(relative)).expect("read")
}

// ------------------------------------------------------------------ branches and tags

#[test]
fn creates_a_branch_from_a_start_point_with_and_without_checkout() {
    let f = Fixture::basic();
    let e = engine(&f);
    e.branch_create(
        "feature/one",
        "v1",
        false,
        false,
        LocalChanges::Refuse,
        &never(),
    )
    .expect("create");
    assert_eq!(f.rev("feature/one"), f.rev("v1^{commit}"));
    assert_eq!(head_ref(&f), "refs/heads/main");
    e.branch_create(
        "feature/two",
        "v1",
        true,
        false,
        LocalChanges::Refuse,
        &never(),
    )
    .expect("create and switch");
    assert_eq!(head_ref(&f), "refs/heads/feature/two");
    assert_eq!(f.head(), f.rev("v1^{commit}"));
    // The tree of v1 has no docs folder.
    assert!(!f.root.join("docs/guide.md").exists());
    let error = e
        .branch_create(
            "feature/one",
            "main",
            false,
            false,
            LocalChanges::Refuse,
            &never(),
        )
        .expect_err("exists already");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
}

#[test]
fn switches_to_a_branch_and_to_a_detached_revision() {
    let f = Fixture::basic();
    let e = engine(&f);
    e.switch(
        &SwitchTarget::Branch {
            name: "develop".to_owned(),
        },
        LocalChanges::Refuse,
        &never(),
    )
    .expect("switch");
    assert_eq!(head_ref(&f), "refs/heads/develop");
    e.switch(
        &SwitchTarget::Detached {
            rev: "v1".to_owned(),
        },
        LocalChanges::Refuse,
        &never(),
    )
    .expect("detach");
    assert_eq!(f.head(), f.rev("v1^{commit}"));
    assert!(!f.try_git(&["symbolic-ref", "-q", "HEAD"]).0);
}

#[test]
fn a_switch_that_would_overwrite_local_changes_is_refused() {
    let f = Fixture::basic();
    // `src/dev.rs` differs between main and v1's ancestor: edit it, then switch to develop,
    // whose version differs.
    f.write("src/dev.rs", "local edit\n");
    let e = engine(&f);
    let error = e
        .switch(
            &SwitchTarget::Detached {
                rev: "d1".to_owned(),
            },
            LocalChanges::Refuse,
            &never(),
        )
        .or_else(|_| {
            e.switch(
                &SwitchTarget::Detached {
                    rev: f.rev("develop~1"),
                },
                LocalChanges::Refuse,
                &never(),
            )
        })
        .expect_err("refused");
    match error {
        GitError::LocalChanges { stderr, .. } => {
            assert!(stderr.contains("would be overwritten"), "{stderr}");
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(head_ref(&f), "refs/heads/main");
    assert_eq!(read(&f, "src/dev.rs"), "local edit\n");
}

#[test]
fn renames_and_deletes_branches_with_the_unmerged_safety() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    e.branch_rename("develop", "dev", &never()).expect("rename");
    assert!(!f.try_git(&["rev-parse", "--verify", "develop"]).0);
    assert_eq!(f.rev("dev"), f.rev("main^2"));
    // A branch with a commit not on HEAD.
    f.git(&["switch", "-q", "-c", "topic", "v1"]);
    f.write("topic.txt", "t\n");
    f.commit("topic commit");
    let tip = f.head();
    f.git(&["switch", "-q", "main"]);
    let refused = e
        .branch_delete("topic", false, &never())
        .expect_err("unmerged");
    match refused {
        GitError::Cli { stderr, .. } => assert!(stderr.contains("not fully merged"), "{stderr}"),
        other => panic!("unexpected {other:?}"),
    }
    assert!(f.try_git(&["rev-parse", "--verify", "topic"]).0);
    e.branch_delete("topic", true, &never()).expect("forced");
    assert!(!f.try_git(&["rev-parse", "--verify", "topic"]).0);
    // The commit is still there, reachable through the reflog of HEAD.
    assert!(f.try_git(&["cat-file", "-e", &tip]).0);
    let reflog = f.git(&["reflog", "--format=%H"]);
    assert!(reflog.lines().any(|line| line == tip), "{reflog}");
    // A merged branch deletes without force.
    e.branch_delete("dev", false, &never())
        .expect("merged branch");
}

#[test]
fn tags_are_created_lightweight_or_annotated_and_deleted() {
    let f = Fixture::basic();
    let e = engine(&f);
    e.tag_create("light", "main~1", None, &never())
        .expect("lightweight");
    assert_eq!(f.git(&["cat-file", "-t", "light"]), "commit");
    assert_eq!(f.rev("light"), f.rev("main~1"));
    e.tag_create("v2", "main", Some("Version 2\n\nWith a body."), &never())
        .expect("annotated");
    assert_eq!(f.git(&["cat-file", "-t", "v2"]), "tag");
    assert_eq!(
        f.git(&["tag", "-l", "--format=%(contents:subject)", "v2"]),
        "Version 2"
    );
    assert_eq!(f.rev("v2^{commit}"), f.head());
    e.tag_delete("light", &never()).expect("delete");
    assert!(!f.try_git(&["rev-parse", "--verify", "light"]).0);
    let error = e
        .tag_create("v2", "main", None, &never())
        .expect_err("exists");
    assert!(matches!(error, GitError::Cli { .. }));
}

#[test]
fn a_deleted_tag_answers_what_it_pointed_at_so_git_tag_puts_it_back() {
    let f = Fixture::basic();
    let e = engine(&f);
    e.tag_create("light", "main~1", None, &never())
        .expect("lightweight");
    e.tag_create("v2", "main", Some("Version 2"), &never())
        .expect("annotated");
    let light = f.git(&["rev-parse", "refs/tags/light"]);
    let object = f.git(&["rev-parse", "refs/tags/v2"]);
    assert_ne!(
        object,
        f.head(),
        "an annotated tag's ref names its tag object"
    );

    let was = e.tag_delete("light", &never()).expect("delete light");
    assert_eq!(was.as_deref(), Some(light.as_str()));
    // A cloned or fetched tag lives in `packed-refs`: it answers the same.
    f.git(&["pack-refs", "--all"]);
    let was = e.tag_delete("v2", &never()).expect("delete v2");
    assert_eq!(was.as_deref(), Some(object.as_str()));
    assert!(!f.try_git(&["rev-parse", "--verify", "refs/tags/v2"]).0);

    // The answer restores the annotated tag whole: its object, its message.
    f.git(&["tag", "v2", &object]);
    assert_eq!(f.git(&["cat-file", "-t", "refs/tags/v2"]), "tag");
    assert_eq!(
        f.git(&["tag", "-l", "--format=%(contents:subject)", "v2"]),
        "Version 2"
    );
    let error = e.tag_delete("gone", &never()).expect_err("no such tag");
    assert!(matches!(error, GitError::Cli { .. }));
}

#[test]
fn sets_and_unsets_the_upstream() {
    let f = Fixture::basic().with_remote();
    let e = engine(&f);
    // `main` tracks origin/main already (with_remote); point it at origin/develop, then unset.
    e.set_upstream("main", Some("origin/develop"), &never())
        .expect("set");
    assert_eq!(
        f.git(&["rev-parse", "--abbrev-ref", "main@{upstream}"]),
        "origin/develop"
    );
    e.set_upstream("main", None, &never()).expect("unset");
    assert!(
        !f.try_git(&["rev-parse", "--abbrev-ref", "main@{upstream}"])
            .0
    );
    let error = e
        .set_upstream("main", Some("origin/missing"), &never())
        .expect_err("unknown upstream");
    assert!(matches!(error, GitError::Cli { .. }));
}

#[test]
fn names_with_slashes_and_unicode_work_and_a_dash_is_a_name_not_an_option() {
    let f = Fixture::basic();
    let e = engine(&f);
    e.branch_create(
        "feat/ünïcödé/x",
        "main",
        false,
        false,
        LocalChanges::Refuse,
        &never(),
    )
    .expect("unicode");
    assert_eq!(f.rev("feat/ünïcödé/x"), f.head());
    // git itself refuses a name that starts with a dash as invalid; the bridge refuses it
    // earlier. Here the engine passes it after `--` so it is never read as an option.
    let error = e
        .branch_create("-x", "main", false, false, LocalChanges::Refuse, &never())
        .expect_err("invalid name");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert!(!f.try_git(&["rev-parse", "--verify", "refs/heads/-x"]).0);
}

// ------------------------------------------------------------ merge, rebase, reset, picks

#[test]
fn merges_fast_forward_no_ff_and_ff_only() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    // main is ahead of develop (m1 merged develop): merging develop is up to date.
    let outcome = e
        .merge("develop", MergeMode::Default, false, &never())
        .expect("merge");
    assert_eq!(outcome.kind, OutcomeKind::UpToDate);
    // A branch one commit ahead of main: fast-forward.
    f.git(&["switch", "-q", "-c", "ahead", "main"]);
    f.write("ahead.txt", "a\n");
    let ahead_tip = f.commit("ahead");
    f.git(&["switch", "-q", "main"]);
    let outcome = e
        .merge("ahead", MergeMode::Default, false, &never())
        .expect("ff");
    assert_eq!(outcome.kind, OutcomeKind::FastForward);
    assert_eq!(f.head(), ahead_tip);
    // Reset main back and merge with --no-ff: a merge commit.
    f.git(&["reset", "-q", "--hard", "main~1"]);
    let outcome = e
        .merge("ahead", MergeMode::NoFf, false, &never())
        .expect("no-ff");
    assert_eq!(outcome.kind, OutcomeKind::Merged);
    assert_eq!(f.git(&["rev-parse", "HEAD^2"]), ahead_tip);
    assert_eq!(outcome.hash.as_deref(), Some(f.head().as_str()));
    // ff-only on a diverged branch is refused.
    f.git(&["switch", "-q", "-c", "diverged", "main~1"]);
    f.write("d.txt", "d\n");
    f.commit("diverged");
    f.git(&["switch", "-q", "main"]);
    let error = e
        .merge("diverged", MergeMode::FfOnly, false, &never())
        .expect_err("not a fast-forward");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
    // A revision that names nothing (a path, a typo) is `refs.not_found`, before git runs.
    for wrong in ["src/lib.rs", "no-such-branch"] {
        let error = e
            .merge(wrong, MergeMode::Default, false, &never())
            .expect_err("nothing to merge");
        assert_eq!(error.code(), "refs.not_found", "{wrong}: {error:?}");
    }
}

/// A repository where `main` and `other` changed the same line of `README.md`.
fn conflicting(f: &mut Fixture) {
    f.git(&["switch", "-q", "-c", "other", "main"]);
    f.write("README.md", "# Other\n");
    f.commit("other readme");
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    f.commit("main readme");
}

#[test]
fn a_merge_with_conflicts_stops_and_the_sequencer_finishes_or_abandons_it() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    let e = engine(&f);
    let before = f.head();
    let outcome = e
        .merge("other", MergeMode::Default, false, &never())
        .expect("stops");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    assert_eq!(outcome.conflicts.len(), 1);
    assert_eq!(outcome.conflicts[0].path, "README.md");
    assert_eq!(outcome.conflicts[0].kind, ConflictKind::BothModified);
    assert!(f.git_dir().join("MERGE_HEAD").exists());
    assert_eq!(e.operation_state().expect("state"), OperationState::Merge);
    assert_eq!(e.conflicts(&never()).expect("conflicts"), outcome.conflicts);
    // Continue with the conflict unresolved: refused.
    let error = e
        .sequencer(SequencerAction::Continue, &never())
        .expect_err("unresolved");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    // Abort: back to before.
    let outcome = e
        .sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(f.head(), before);
    assert_eq!(read(&f, "README.md"), "# Main\n");
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
    // Again, resolve and continue.
    e.merge("other", MergeMode::Default, false, &never())
        .expect("stops");
    f.write("README.md", "# Both\n");
    e.mark_resolved(&["README.md".to_owned()], &never())
        .expect("resolved");
    assert!(e.conflicts(&never()).expect("conflicts").is_empty());
    let outcome = e
        .sequencer(SequencerAction::Continue, &never())
        .expect("continue");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
    assert_eq!(f.git(&["rev-parse", "HEAD^1"]), before);
    assert_eq!(f.git(&["rev-parse", "HEAD^2"]), f.rev("other"));
    assert_eq!(read(&f, "README.md"), "# Both\n");
    assert_eq!(f.git(&["status", "--porcelain"]), "");
}

#[test]
fn rebases_cleanly_and_stops_on_conflicts_with_skip_and_continue() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    // develop rebased onto main: clean (main merged develop; the commits replay as no-ops or
    // apply cleanly).
    f.git(&["switch", "-q", "-c", "topic", "v1"]);
    f.write("topic.txt", "one\n");
    f.commit("topic one");
    f.write("topic.txt", "one\ntwo\n");
    f.commit("topic two");
    let outcome = e.rebase("main", false, &never()).expect("rebase");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(f.git(&["rev-parse", "HEAD~2"]), f.rev("main"));
    assert_eq!(f.git(&["rev-list", "--count", "main..HEAD"]), "2");
    // Again onto the same base: up to date, nothing moved.
    let tip = f.head();
    let outcome = e.rebase("main", false, &never()).expect("nothing to do");
    assert_eq!(outcome.kind, OutcomeKind::UpToDate);
    assert_eq!(f.head(), tip);
    // A conflicting rebase: topic2 edits README as main did.
    f.git(&["switch", "-q", "-c", "topic2", "v1"]);
    f.write("README.md", "# Topic\n");
    f.commit("topic readme");
    f.write("extra.txt", "x\n");
    f.commit("topic extra");
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    f.commit("main readme");
    f.git(&["switch", "-q", "topic2"]);
    let outcome = e.rebase("main", false, &never()).expect("stops");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    assert_eq!(outcome.conflicts[0].path, "README.md");
    assert_eq!(e.operation_state().expect("state"), OperationState::Rebase);
    // Continue with the conflict unresolved: `git rebase --continue` exits 1 (where a merge
    // exits 128) and moves nothing, which is a refusal, not a second stop.
    let stopped_at = f.head();
    let error = e
        .sequencer(SequencerAction::Continue, &never())
        .expect_err("unresolved");
    match &error {
        GitError::Cli { stderr, .. } => assert!(stderr.contains("needs merge"), "{stderr}"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(f.head(), stopped_at);
    assert_eq!(e.operation_state().expect("state"), OperationState::Rebase);
    // Skip the conflicting commit: the rest replays.
    let outcome = e.sequencer(SequencerAction::Skip, &never()).expect("skip");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
    assert_eq!(f.git(&["rev-list", "--count", "main..HEAD"]), "1");
    assert_eq!(read(&f, "README.md"), "# Main\n");
    assert!(f.root.join("extra.txt").exists());
}

#[test]
fn resets_soft_mixed_and_hard_and_the_reflog_keeps_the_old_head() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    let tip = f.head();
    let parent = f.git(&["rev-parse", "HEAD~1"]);
    e.reset("HEAD~1", ResetMode::Soft, &never()).expect("soft");
    assert_eq!(f.head(), parent);
    assert!(
        !f.git(&["diff", "--cached", "--stat"]).is_empty(),
        "the merge's changes are staged"
    );
    f.git(&["reset", "-q", "--hard", &tip]);
    e.reset("HEAD~1", ResetMode::Mixed, &never())
        .expect("mixed");
    assert_eq!(f.head(), parent);
    assert_eq!(f.git(&["diff", "--cached", "--stat"]), "");
    assert!(
        !f.git(&["status", "--porcelain"]).is_empty(),
        "the changes are unstaged"
    );
    f.git(&["reset", "-q", "--hard", &tip]);
    f.write("scratch.txt", "will be lost\n");
    f.git(&["add", "scratch.txt"]);
    e.reset("HEAD~1", ResetMode::Hard, &never()).expect("hard");
    assert_eq!(f.head(), parent);
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert!(!f.root.join("scratch.txt").exists());
    let reflog = f.git(&["reflog", "--format=%H"]);
    assert_eq!(reflog.lines().nth(1), Some(tip.as_str()), "{reflog}");
    f.tick();
}

#[test]
fn cherry_picks_and_reverts_with_their_outcomes() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    f.git(&["switch", "-q", "-c", "source", "v1"]);
    f.write("pick.txt", "picked\n");
    let picked = f.commit("pick me");
    f.write("pick2.txt", "picked too\n");
    let picked2 = f.commit("pick me too");
    f.git(&["switch", "-q", "main"]);
    let outcome = e
        .cherry_pick(&[picked.clone(), picked2.clone()], &never())
        .expect("pick");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(f.git(&["log", "-1", "--format=%s"]), "pick me too");
    assert_eq!(f.git(&["log", "-2", "--format=%s"]), "pick me too\npick me");
    assert!(f.root.join("pick.txt").exists() && f.root.join("pick2.txt").exists());
    let outcome = e.revert(&["HEAD".to_owned()], &never()).expect("revert");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert!(f
        .git(&["log", "-1", "--format=%s"])
        .starts_with("Revert \"pick me too\""));
    assert!(!f.root.join("pick2.txt").exists());
    // A conflicting pick: a commit editing README on top of a different README.
    f.git(&["switch", "-q", "-c", "conflict", "v1"]);
    f.write("README.md", "# Conflict\n");
    let conflicting = f.commit("conflicting readme");
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    f.commit("main readme");
    let outcome = e.cherry_pick(&[conflicting], &never()).expect("stops");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    assert_eq!(
        e.operation_state().expect("state"),
        OperationState::CherryPick
    );
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
    assert_eq!(read(&f, "README.md"), "# Main\n");
}

#[test]
fn conflict_kinds_follow_the_porcelain() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    // On `ours`: modify a.txt, delete b.txt, add c.txt; on `theirs`: modify a.txt differently,
    // modify b.txt, add c.txt with other content, delete d.txt while ours modifies it.
    f.write("a.txt", "a\n");
    f.write("b.txt", "b\n");
    f.write("d.txt", "d\n");
    f.commit("base files");
    f.git(&["switch", "-q", "-c", "theirs"]);
    f.write("a.txt", "a theirs\n");
    f.write("b.txt", "b theirs\n");
    f.write("c.txt", "c theirs\n");
    f.remove("d.txt");
    f.commit("theirs");
    f.git(&["switch", "-q", "main"]);
    f.write("a.txt", "a ours\n");
    f.remove("b.txt");
    f.write("c.txt", "c ours\n");
    f.write("d.txt", "d ours\n");
    f.commit("ours");
    let outcome = e
        .merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    let kinds: Vec<(String, ConflictKind)> = outcome
        .conflicts
        .iter()
        .map(|c| (c.path.clone(), c.kind))
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("a.txt".to_owned(), ConflictKind::BothModified),
            ("b.txt".to_owned(), ConflictKind::DeletedByUs),
            ("c.txt".to_owned(), ConflictKind::BothAdded),
            ("d.txt".to_owned(), ConflictKind::DeletedByThem),
        ]
    );
    let porcelain = f.git(&["status", "--porcelain=v2"]);
    for (xy, path) in [
        ("UU", "a.txt"),
        ("DU", "b.txt"),
        ("AA", "c.txt"),
        ("UD", "d.txt"),
    ] {
        assert!(
            porcelain
                .lines()
                .any(|l| l.starts_with(&format!("u {xy} ")) && l.ends_with(path)),
            "{xy} {path} in {porcelain}"
        );
    }
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
}

#[test]
fn a_reset_takes_a_revision_never_a_path() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    f.append("src/lib.rs", "// staged\n");
    f.git(&["add", "src/lib.rs"]);
    let head = f.head();
    // `git reset src/lib.rs` would unstage the path and leave HEAD; the engine resolves the
    // revision first, so a path is a revision that does not exist.
    let error = e
        .reset("src/lib.rs", ResetMode::Mixed, &never())
        .expect_err("a path is not a revision");
    assert_eq!(error.code(), "refs.not_found", "{error:?}");
    assert_eq!(f.head(), head);
    assert_eq!(f.git(&["status", "--porcelain"]), "M  src/lib.rs");
    // The option-shaped revision the bridge refuses is not one either.
    let error = e
        .reset("--hard", ResetMode::Soft, &never())
        .expect_err("not a revision");
    assert_eq!(error.code(), "refs.not_found", "{error:?}");
    assert_eq!(f.git(&["status", "--porcelain"]), "M  src/lib.rs");
    f.tick();
}

#[test]
fn an_autostash_that_conflicts_after_a_clean_rebase_is_a_stop() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    f.git(&["config", "rebase.autoStash", "true"]);
    f.git(&["switch", "-q", "-c", "topic", "v1"]);
    f.write("topic.txt", "one\n");
    f.commit("topic one");
    // main changed README since v1 (the merge of develop kept it, c3 did not touch it): make
    // main's README differ, then edit README in the tree so the autostash re-applies onto a
    // different base and conflicts.
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    f.commit("main readme");
    f.git(&["switch", "-q", "topic"]);
    f.write("README.md", "# Dirty\n");
    // git rebases (exit 0), then says the autostash conflicted and keeps it in the stash.
    let outcome = e.rebase("main", false, &never()).expect("rebased");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts, "{outcome:?}");
    assert_eq!(outcome.conflicts[0].path, "README.md");
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
    assert_eq!(f.git(&["rev-parse", "HEAD~1"]), f.rev("main"));
    assert!(
        f.git(&["stash", "list"]).contains("autostash"),
        "the stash is kept"
    );
    f.git(&["reset", "-q", "--hard"]);
    f.git(&["stash", "drop", "-q"]);
    f.tick();
}

#[test]
fn creates_a_branch_that_tracks_a_remote_branch_whatever_auto_setup_merge_says() {
    let f = Fixture::basic().with_remote();
    let e = engine(&f);
    f.git(&["config", "branch.autoSetupMerge", "false"]);
    e.branch_create(
        "remote-develop",
        "refs/remotes/origin/develop",
        true,
        true,
        LocalChanges::Refuse,
        &never(),
    )
    .expect("create, switch and track");
    assert_eq!(head_ref(&f), "refs/heads/remote-develop");
    assert_eq!(f.head(), f.rev("refs/remotes/origin/develop"));
    assert_eq!(
        f.git(&["rev-parse", "--abbrev-ref", "remote-develop@{upstream}"]),
        "origin/develop"
    );
    // Without the checkout, `git branch --track` records the upstream too.
    e.branch_create(
        "remote-main",
        "refs/remotes/origin/main",
        false,
        true,
        LocalChanges::Refuse,
        &never(),
    )
    .expect("create and track");
    assert_eq!(head_ref(&f), "refs/heads/remote-develop");
    assert_eq!(
        f.git(&["rev-parse", "--abbrev-ref", "remote-main@{upstream}"]),
        "origin/main"
    );
}

#[test]
fn a_tracked_branch_from_a_ref_two_remotes_claim_is_refused_before_anything_changes() {
    let f = Fixture::basic().with_remote();
    let e = engine(&f);
    let origin = f.sibling("origin.git");
    let origin = origin.to_str().expect("utf-8 temp path");
    f.git(&["config", "remote.mirror.url", origin]);
    f.git(&[
        "config",
        "remote.mirror.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
    ]);
    for checkout in [true, false] {
        e.branch_create(
            "remote-develop",
            "refs/remotes/origin/develop",
            checkout,
            true,
            LocalChanges::Refuse,
            &never(),
        )
        .expect_err("ambiguous upstream");
        assert_eq!(head_ref(&f), "refs/heads/main", "checkout: {checkout}");
        assert_eq!(
            f.git(&["status", "--porcelain"]),
            "",
            "checkout: {checkout}"
        );
        assert!(
            !f.try_git(&["rev-parse", "--verify", "refs/heads/remote-develop"])
                .0,
            "checkout: {checkout}"
        );
    }
}

#[test]
fn a_tracked_branch_from_a_ref_no_remote_fetches_is_refused_before_anything_changes() {
    let f = Fixture::basic().with_remote();
    let e = engine(&f);
    f.git(&[
        "update-ref",
        "refs/remotes/stale/develop",
        "refs/remotes/origin/develop",
    ]);
    e.branch_create(
        "stale-develop",
        "refs/remotes/stale/develop",
        true,
        true,
        LocalChanges::Refuse,
        &never(),
    )
    .expect_err("no remote fetches it");
    assert_eq!(head_ref(&f), "refs/heads/main");
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert!(
        !f.try_git(&["rev-parse", "--verify", "refs/heads/stale-develop"])
            .0
    );
}

// ------------------------------------------------------------------ move_head

/// What a soft reset leaves: HEAD, the index's tree and git's own status with its branch line.
fn soft_view(f: &Fixture) -> (String, String, String) {
    (
        f.head(),
        f.git(&["write-tree"]),
        f.git(&[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
        ]),
    )
}

#[test]
fn moves_head_to_the_parent_as_a_soft_reset_does_and_back() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    let parent = f.head();
    f.write("undo.txt", "undone\n");
    f.write("src/lib.rs", "pub fn one() -> u32 {\n    11\n}\n");
    let tip = f.commit("u1: a commit to undo");
    let tree = f.rev("HEAD^{tree}");
    f.git(&["config", "core.logAllRefUpdates", "always"]);
    e.move_head(&tip, &parent, Some("refs/heads/main"), &never())
        .expect("undo");
    assert_eq!(f.head(), parent);
    assert_eq!(head_ref(&f), "refs/heads/main");
    // The index keeps the undone commit's tree: its changes are staged, the files as they were.
    assert_eq!(f.git(&["write-tree"]), tree);
    assert_eq!(
        f.git(&["diff", "--cached", "--name-only"]),
        "src/lib.rs\nundo.txt"
    );
    assert_eq!(read(&f, "undo.txt"), "undone\n");
    let reason = format!("reset: moving to {parent}");
    assert_eq!(f.git(&["reflog", "-1", "--format=%gs", "main"]), reason);
    assert_eq!(f.git(&["reflog", "-1", "--format=%gs", "HEAD"]), reason);
    assert_eq!(f.rev("ORIG_HEAD"), tip);
    assert_eq!(
        f.git(&["reflog", "-1", "--format=%gs", "ORIG_HEAD"]),
        "reset: updating ORIG_HEAD"
    );
    let undone = soft_view(&f);
    e.move_head(&parent, &tip, Some("refs/heads/main"), &never())
        .expect("redo");
    assert_eq!(f.head(), tip);
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "");
    assert_eq!(f.rev("ORIG_HEAD"), parent);
    // git's own soft reset leaves the same HEAD, index and status.
    f.git(&["reset", "-q", "--soft", "HEAD~1"]);
    assert_eq!(soft_view(&f), undone);
}

#[test]
fn refuses_to_move_head_that_moved_since_the_plan() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    let parent = f.head();
    f.write("a.txt", "a\n");
    let planned = f.commit("a: the commit the undo was planned on");
    f.write("b.txt", "b\n");
    let since = f.commit("b: a commit made since");
    let error = e
        .move_head(&planned, &parent, Some("refs/heads/main"), &never())
        .expect_err("HEAD moved");
    assert!(
        matches!(&error, GitError::HeadMoved { expected, actual } if *expected == planned && *actual == since),
        "{error:?}"
    );
    assert_eq!(error.code(), "refs.head_moved");
    assert_eq!(f.head(), since, "nothing moved");
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "");
}

#[test]
fn moves_a_detached_head_and_a_linked_worktrees_branch_only() {
    let f = Fixture::basic().with_linked_worktree();
    let e = engine(&f);
    let tip = f.head();
    let parent = f.rev("HEAD~1");
    f.git(&["switch", "-q", "--detach"]);
    e.move_head(&tip, &parent, None, &never())
        .expect("detached");
    assert_eq!(f.head(), parent);
    assert_eq!(f.rev("main"), tip, "the branch stays");
    assert!(
        !f.try_git(&["symbolic-ref", "-q", "HEAD"]).0,
        "HEAD stays detached"
    );
    f.git(&["switch", "-q", "main"]);
    // The linked worktree's HEAD is its own: only its branch moves.
    let wt = canonical(&f.worktree_path());
    let w = Git2Engine::open(&wt).expect("open the worktree");
    let wt_tip = f.git_in(&wt, &["rev-parse", "HEAD"]);
    let wt_parent = f.git_in(&wt, &["rev-parse", "HEAD~1"]);
    w.move_head(&wt_tip, &wt_parent, Some("refs/heads/feature/wt"), &never())
        .expect("worktree");
    assert_eq!(f.rev("feature/wt"), wt_parent);
    assert_eq!(f.rev("main"), tip);
    assert_eq!(f.head(), tip);
}

#[test]
fn refuses_to_move_head_during_a_merge_or_with_conflicts() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    let tip = f.head();
    f.git(&["switch", "-q", "-c", "other", "v1"]);
    f.write("README.md", "# Other\n");
    f.commit("o1: other readme");
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    let main_tip = f.commit("m2: main readme");
    let (merged, _, _) = f.try_git(&["merge", "other"]);
    assert!(!merged, "the merge must stop on conflicts");
    let error = e
        .move_head(&main_tip, &tip, Some("refs/heads/main"), &never())
        .expect_err("a merge in progress");
    assert_eq!(error.code(), "refs.head_held", "{error:?}");
    assert_eq!(f.head(), main_tip);
    f.git(&["merge", "--abort"]);
    // Unmerged entries without a merge: a stash whose pop conflicts.
    f.write("README.md", "# Stashed\n");
    f.git(&["stash", "push", "-q"]);
    f.write("README.md", "# Committed\n");
    let committed = f.commit("m3: another readme");
    let (popped, _, _) = f.try_git(&["stash", "pop"]);
    assert!(!popped, "the pop must stop on conflicts");
    let error = e
        .move_head(&committed, &main_tip, Some("refs/heads/main"), &never())
        .expect_err("conflicts in the index");
    assert_eq!(error.code(), "refs.head_held", "{error:?}");
    assert_eq!(f.head(), committed);
}

#[test]
fn refuses_a_zero_a_missing_or_an_option_shaped_target() {
    let f = Fixture::basic();
    let e = engine(&f);
    let tip = f.head();
    let reflog = f.git(&["reflog", "--format=%H %gs", "main"]);
    for to in [
        "0".repeat(40),
        "f".repeat(40),
        "-d".to_owned(),
        "HEAD~1".to_owned(),
    ] {
        let error = e
            .move_head(&tip, &to, Some("refs/heads/main"), &never())
            .expect_err("refused");
        assert_eq!(error.code(), "refs.not_found", "{to}: {error:?}");
        assert_eq!(f.head(), tip, "{to}");
        assert_eq!(f.rev("main"), tip, "{to}: the branch stays");
        assert_eq!(
            f.git(&["reflog", "--format=%H %gs", "main"]),
            reflog,
            "{to}"
        );
    }
}

#[test]
fn a_held_lock_is_gits_refusal_and_an_unborn_head_moved() {
    let f = Fixture::basic();
    let e = engine(&f);
    let tip = f.head();
    let parent = f.rev("HEAD~1");
    let lock = f.git_dir().join("refs").join("heads").join("main.lock");
    std::fs::write(&lock, "").expect("lock");
    let error = e
        .move_head(&tip, &parent, Some("refs/heads/main"), &never())
        .expect_err("the lock is held");
    assert_eq!(error.code(), "git.cli_failed", "{error:?}");
    assert_eq!(f.head(), tip);
    std::fs::remove_file(&lock).expect("unlock");
    f.git(&["checkout", "-q", "--orphan", "fresh"]);
    let error = e
        .move_head(&tip, &parent, Some("refs/heads/main"), &never())
        .expect_err("HEAD names no commit");
    assert!(
        matches!(&error, GitError::HeadMoved { actual, .. } if actual.is_empty()),
        "{error:?}"
    );
    assert!(error.to_string().contains("no commit"), "{error}");
}

#[test]
fn a_linked_worktrees_head_moved_is_refused_there() {
    let f = Fixture::basic().with_linked_worktree();
    let wt = canonical(&f.worktree_path());
    let w = Git2Engine::open(&wt).expect("open the worktree");
    let planned = f.git_in(&wt, &["rev-parse", "HEAD"]);
    let parent = f.git_in(&wt, &["rev-parse", "HEAD~1"]);
    std::fs::write(wt.join("wt.txt"), "wt\n").expect("write");
    f.git_in(&wt, &["add", "wt.txt"]);
    f.git_in(&wt, &["commit", "-q", "-m", "w1: committed since"]);
    let since = f.git_in(&wt, &["rev-parse", "HEAD"]);
    let error = w
        .move_head(&planned, &parent, Some("refs/heads/feature/wt"), &never())
        .expect_err("HEAD moved");
    assert_eq!(error.code(), "refs.head_moved");
    assert_eq!(f.rev("feature/wt"), since);
}

#[test]
fn a_redo_moves_only_the_branch_it_undid() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    let parent = f.head();
    f.write("redo.txt", "redo\n");
    let tip = f.commit("r1: undone, then redone");
    e.move_head(&tip, &parent, Some("refs/heads/main"), &never())
        .expect("undo");
    // A branch at the same commit, checked out from a terminal before the redo.
    f.git(&["switch", "-q", "-c", "other"]);
    let error = e
        .move_head(&parent, &tip, Some("refs/heads/main"), &never())
        .expect_err("HEAD names another branch");
    assert_eq!(error.code(), "refs.head_moved", "{error:?}");
    assert_eq!(f.rev("other"), parent, "the branch checked out stays");
    assert_eq!(f.rev("main"), parent);
}

#[test]
fn a_move_keeps_the_messages_git_prepared() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    f.git(&["switch", "-q", "-c", "squashed", "v1"]);
    f.write("squash.txt", "squash\n");
    f.commit("s1: to squash");
    f.git(&["switch", "-q", "main"]);
    let parent = f.head();
    f.write("kept.txt", "kept\n");
    let tip = f.commit("k1: the commit undone");
    f.git(&["merge", "-q", "--squash", "squashed"]);
    assert!(f.git_dir().join("SQUASH_MSG").exists());
    e.move_head(&tip, &parent, Some("refs/heads/main"), &never())
        .expect("undo");
    // Unlike `git reset --soft`, which drops it: the squash's staged changes stay, and so
    // does the message git prepared for their commit.
    assert!(f.git_dir().join("SQUASH_MSG").exists());
    assert_eq!(f.head(), parent);
}

#[test]
fn refuses_to_move_head_during_a_paused_pick_sequence() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    f.git(&["switch", "-q", "-c", "picks", "v1"]);
    for (i, text) in ["one", "two", "three"].iter().enumerate() {
        f.write("README.md", &format!("# {text}\n"));
        f.commit(&format!("p{i}: {text}"));
    }
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    let main_tip = f.commit("m2: main readme");
    let (picked, _, _) = f.try_git(&["cherry-pick", "picks~2", "picks~1", "picks"]);
    assert!(!picked, "the sequence must stop");
    f.write("README.md", "# resolved\n");
    f.git(&["add", "README.md"]);
    f.git(&["commit", "-q", "--no-edit"]);
    let head = f.head();
    let error = e
        .move_head(&head, &main_tip, Some("refs/heads/main"), &never())
        .expect_err("a paused sequence");
    assert_eq!(error.code(), "refs.head_held", "{error:?}");
    assert_eq!(f.head(), head);
}
