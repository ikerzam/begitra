//! Local changes in the way of a switch, a merge or a rebase, against the git CLI on fixture
//! repositories: git's refusal under its own code, a switch that carries the changes or leaves
//! them in a stash, and git's autostash, with the stash it keeps when the changes come back
//! with conflicts, through the operation's end when it stops first.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    LocalChanges, MergeMode, OperationState, OutcomeKind, SequencerAction, SwitchTarget,
};
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn never() -> Cancel {
    Cancel::never()
}

fn to(name: &str) -> SwitchTarget {
    SwitchTarget::Branch {
        name: name.to_owned(),
    }
}

fn read(f: &Fixture, relative: &str) -> String {
    std::fs::read_to_string(f.root.join(relative)).expect("read")
}

fn head_ref(f: &Fixture) -> String {
    f.git(&["symbolic-ref", "-q", "HEAD"])
}

/// `main` with `f.txt` and `g.txt`, five lines each; `other` changes the second line of `f.txt`
/// and the fifth of `g.txt`; HEAD on `main`. git merges changes three lines apart cleanly and
/// takes changes to adjacent lines as a conflict.
fn two_branches() -> Fixture {
    let mut f = Fixture::empty();
    f.write("f.txt", "a\nb\nc\nd\ne\n");
    f.write("g.txt", "x\ny\nz\nw\nv\n");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "other"]);
    f.write("f.txt", "a\nB-other\nc\nd\ne\n");
    f.write("g.txt", "x\ny\nz\nw\nV-other\n");
    f.commit("other");
    f.git(&["switch", "-q", "main"]);
    f
}

/// The stash entries, newest first: `<commit> <subject>`.
fn stashes(f: &Fixture) -> Vec<String> {
    f.git(&["stash", "list", "--format=%H %s"])
        .lines()
        .map(str::to_owned)
        .collect()
}

/// A `post-checkout` hook that fails: git has switched when it runs.
fn failing_post_checkout(f: &Fixture) {
    let hook = f.git_dir().join("hooks").join("post-checkout");
    std::fs::create_dir_all(hook.parent().expect("hooks folder")).expect("hooks folder");
    std::fs::write(&hook, "#!/bin/sh\necho the hook refused >&2\nexit 1\n").expect("hook");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
}

/// `git status --porcelain=v2`: each record's kind, its `XY`, its index mode and its path,
/// which two branches with the same changes staged share.
fn index_shape(f: &Fixture) -> Vec<String> {
    f.git(&["status", "--porcelain=v2"])
        .lines()
        .map(|line| {
            let fields: Vec<&str> = line.split(' ').collect();
            match fields[0] {
                "1" => format!("1 {} {} {}", fields[1], fields[4], fields[8..].join(" ")),
                "2" => format!("2 {} {} {}", fields[1], fields[4], fields[9..].join(" ")),
                _ => line.to_owned(),
            }
        })
        .collect()
}

/// `two_branches` with more files, merged into `other` too, and on `main` every kind of staged
/// change: a modification, one staged with more on top, a move, a new file, a deletion; besides
/// f.txt's unstaged change three lines from `other`'s, which git refuses the switch over.
fn staged_mix() -> Fixture {
    let mut f = two_branches();
    f.write("u.txt", "u\n");
    f.write("r.txt", "r1\nr2\nr3\nr4\nr5\nr6\n");
    f.write("h.txt", "h\n");
    f.write("d.txt", "d\n");
    f.commit("more files");
    f.git(&["switch", "-q", "other"]);
    f.git(&["merge", "-q", "--no-edit", "main"]);
    f.git(&["switch", "-q", "main"]);
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    f.write("u.txt", "u staged\n");
    f.git(&["add", "u.txt"]);
    f.write("r.txt", "r1-staged\nr2\nr3\nr4\nr5\nr6\n");
    f.git(&["add", "r.txt"]);
    f.write("r.txt", "r1-staged\nr2\nr3\nr4\nr5\nr6-unstaged\n");
    f.git(&["mv", "h.txt", "h2.txt"]);
    f.write("n.txt", "new staged\n");
    f.git(&["add", "n.txt"]);
    f.git(&["rm", "-q", "d.txt"]);
    f.write("notes.txt", "untracked\n");
    f
}

/// Holds `path` open as a running program holds its log: others may read it, not write or
/// delete it.
#[cfg(windows)]
fn held_open(path: &std::path::Path) -> std::fs::File {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .expect("hold the file open")
}

/// `two_branches` where `other` also adds `new.txt`, which `main` has untracked.
fn untracked_in_the_way() -> Fixture {
    let mut f = two_branches();
    f.git(&["switch", "-q", "other"]);
    f.write("new.txt", "tracked\n");
    f.commit("other adds new.txt");
    f.git(&["switch", "-q", "main"]);
    f.write("new.txt", "untracked\n");
    f
}

fn refused_stderr(error: GitError) -> String {
    match error {
        GitError::LocalChanges { stderr, .. } => stderr,
        other => panic!("not refused over local changes: {other:?}"),
    }
}

// ------------------------------------------------------------------ the refusal's code

#[test]
fn a_switch_refused_over_local_changes_has_its_own_code() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    let error = engine(&f)
        .switch(&to("other"), LocalChanges::Refuse, &never())
        .expect_err("refused");
    assert_eq!(error.code(), "git.local_changes");
    let stderr = refused_stderr(error);
    assert!(
        stderr.contains("would be overwritten by checkout"),
        "{stderr}"
    );
    assert!(stderr.contains("\tf.txt"), "{stderr}");
    assert_eq!(head_ref(&f), "refs/heads/main");
    assert_eq!(read(&f, "f.txt"), "a\nb-local\nc\nd\ne\n");
}

#[test]
fn untracked_files_in_the_way_have_the_code_too() {
    let f = untracked_in_the_way();
    let stderr = refused_stderr(
        engine(&f)
            .switch(&to("other"), LocalChanges::Refuse, &never())
            .expect_err("refused"),
    );
    assert!(stderr.contains("untracked working tree files"), "{stderr}");
    assert!(stderr.contains("\tnew.txt"), "{stderr}");
}

#[test]
fn a_branch_created_and_checked_out_over_local_changes_has_the_code() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    let error = engine(&f)
        .branch_create(
            "topic",
            "other",
            true,
            false,
            LocalChanges::Refuse,
            &never(),
        )
        .expect_err("refused");
    assert_eq!(error.code(), "git.local_changes", "{error:?}");
    assert_eq!(head_ref(&f), "refs/heads/main");
    assert!(!f.try_git(&["rev-parse", "--verify", "-q", "topic"]).0);
}

#[test]
fn a_merge_and_a_rebase_refused_over_local_changes_have_the_code() {
    let f = two_branches();
    let e = engine(&f);
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    let stderr = refused_stderr(
        e.merge("other", MergeMode::Default, false, &never())
            .expect_err("refused"),
    );
    assert!(stderr.contains("would be overwritten by merge"), "{stderr}");
    // git refuses a rebase over any unstaged change, and over a staged one.
    let stderr = refused_stderr(e.rebase("other", false, &never()).expect_err("refused"));
    assert!(stderr.contains("You have unstaged changes"), "{stderr}");
    f.git(&["add", "f.txt"]);
    let stderr = refused_stderr(e.rebase("other", false, &never()).expect_err("refused"));
    assert!(
        stderr.contains("Your index contains uncommitted changes"),
        "{stderr}"
    );
    assert_eq!(f.git(&["status", "--porcelain"]), "M  f.txt");
}

#[test]
fn untracked_files_a_switch_or_a_merge_would_remove_are_in_the_way() {
    let mut f = two_branches();
    f.write("x.txt", "x\n");
    f.commit("main adds x");
    f.git(&["switch", "-q", "-c", "without-x", "other"]);
    f.git(&["switch", "-q", "main"]);
    f.git(&["switch", "-q", "-c", "deletes-x"]);
    f.remove("x.txt");
    f.commit("delete x");
    f.git(&["switch", "-q", "main"]);
    // Untracked here, and gone where the switch and the merge go.
    f.git(&["rm", "-q", "--cached", "x.txt"]);
    let e = engine(&f);
    let stderr = refused_stderr(
        e.switch(&to("without-x"), LocalChanges::Refuse, &never())
            .expect_err("refused"),
    );
    assert!(stderr.contains("would be removed by checkout"), "{stderr}");
    let stderr = refused_stderr(
        e.merge("deletes-x", MergeMode::Default, false, &never())
            .expect_err("refused"),
    );
    assert!(stderr.contains("would be removed by merge"), "{stderr}");
    assert_eq!(read(&f, "x.txt"), "x\n");
}

#[test]
fn another_refusal_keeps_the_generic_code() {
    let f = two_branches();
    let error = engine(&f)
        .switch(&to("nowhere"), LocalChanges::Refuse, &never())
        .expect_err("no such branch");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
}

// ------------------------------------------------------------------ carry and leave

#[test]
fn a_carried_change_comes_over_to_the_branch() {
    let f = two_branches();
    // Three lines away from the one `other` changed: git refuses the plain switch all the same.
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("carried");
    assert_eq!(switched.stash, None);
    assert!(switched.conflicts.is_empty());
    assert_eq!(switched.kept, None);
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(read(&f, "f.txt"), "a\nB-other\nc\nd\nE-local\n");
    assert!(stashes(&f).is_empty());
}

#[test]
fn a_carried_change_that_conflicts_stays_in_its_stash() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(
        switched
            .conflicts
            .iter()
            .map(|c| c.path.as_str())
            .collect::<Vec<_>>(),
        ["f.txt"]
    );
    let listed = stashes(&f);
    assert_eq!(listed.len(), 1, "{listed:?}");
    let stash = switched.stash.expect("the stash is kept");
    assert!(listed[0].starts_with(&stash), "{listed:?} {stash}");
    assert!(
        listed[0].ends_with("Begitra: carried to other"),
        "{listed:?}"
    );
}

#[test]
fn a_carried_untracked_file_the_branch_tracks_stays_in_its_stash() {
    let f = untracked_in_the_way();
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    // git puts the tracked change back and refuses the untracked file: the stash keeps both.
    let kept = switched.kept.expect("git's words");
    assert!(kept.contains("new.txt already exists"), "{kept}");
    assert_eq!(read(&f, "new.txt"), "tracked\n");
    assert_eq!(stashes(&f).len(), 1);
    assert!(switched.stash.is_some());
}

#[test]
fn changes_left_in_a_stash_take_the_untracked_files_along() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    f.write("notes.txt", "mine\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Leave, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    let stash = switched.stash.expect("the stash");
    let listed = stashes(&f);
    assert!(listed[0].starts_with(&stash), "{listed:?}");
    assert!(
        listed[0].ends_with("Begitra: left before switching to other"),
        "{listed:?}"
    );
    // The untracked files are in the stash's third parent.
    assert_eq!(
        f.git(&["ls-tree", "-r", "--name-only", &format!("{stash}^3")]),
        "notes.txt"
    );
    assert!(switched.conflicts.is_empty());
}

#[test]
fn a_switch_that_fails_after_the_stash_puts_the_changes_back() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    f.git(&["add", "f.txt"]);
    f.write("notes.txt", "mine\n");
    // Leave stashes before it switches; the switch to no branch fails with HEAD where it was.
    let error = engine(&f)
        .switch(&to("nowhere"), LocalChanges::Leave, &never())
        .expect_err("no such branch");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(head_ref(&f), "refs/heads/main");
    assert_eq!(read(&f, "f.txt"), "a\nb-local\nc\nd\ne\n");
    assert_eq!(read(&f, "notes.txt"), "mine\n");
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "f.txt");
    assert!(stashes(&f).is_empty());
}

#[test]
fn a_carry_git_refuses_for_another_reason_stashes_nothing() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    let error = engine(&f)
        .switch(&to("nowhere"), LocalChanges::Carry, &never())
        .expect_err("no such branch");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(read(&f, "f.txt"), "a\nb-local\nc\nd\ne\n");
    assert!(stashes(&f).is_empty());
}

#[test]
fn staged_changes_are_carried_staged() {
    let f = two_branches();
    // `other` changes the fifth line of g.txt: the staged first line applies on its index.
    f.write("g.txt", "X-local\ny\nz\nw\nv\n");
    f.git(&["add", "g.txt"]);
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("carried");
    assert_eq!(switched, Default::default());
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "g.txt");
    assert_eq!(f.git(&["diff", "--name-only"]), "f.txt");
    assert_eq!(read(&f, "g.txt"), "X-local\ny\nz\nw\nV-other\n");
    assert!(stashes(&f).is_empty());
}

#[test]
fn a_staged_change_that_does_not_apply_staged_comes_back_unstaged() {
    let f = two_branches();
    // The staged hunk's context holds the line `other` changed: git cannot apply it to the
    // index, and merges it into the file instead.
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    f.git(&["add", "f.txt"]);
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("carried");
    // The answer says so: which lines were staged is known nowhere else now.
    assert!(switched.unstaged, "{switched:?}");
    assert_eq!(switched.stash, None);
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "");
    assert_eq!(read(&f, "f.txt"), "a\nB-other\nc\nd\nE-local\n");
    assert!(stashes(&f).is_empty());
}

#[test]
fn untracked_files_not_in_the_way_stay_out_of_the_carry() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    f.write("notes.txt", "mine\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("switched");
    // The conflict keeps the stash: it holds no untracked files (no third parent).
    let stash = switched.stash.expect("kept");
    assert!(
        !f.try_git(&["rev-parse", "--verify", "-q", &format!("{stash}^3")])
            .0
    );
    assert_eq!(read(&f, "notes.txt"), "mine\n");
}

#[test]
fn carried_changes_keep_what_was_staged() {
    let f = staged_mix();
    let before = index_shape(&f);
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("carried");
    assert_eq!(switched, Default::default());
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(index_shape(&f), before);
}

#[test]
fn a_switch_that_fails_puts_back_what_was_staged() {
    let f = staged_mix();
    let before = index_shape(&f);
    engine(&f)
        .switch(&to("nowhere"), LocalChanges::Leave, &never())
        .expect_err("no such branch");
    assert_eq!(index_shape(&f), before);
    assert!(stashes(&f).is_empty());
}

#[test]
fn a_staged_mode_change_is_carried() {
    let mut f = two_branches();
    f.git(&["config", "core.fileMode", "false"]);
    f.write("run.sh", "echo hi\n");
    f.commit("script");
    f.git(&["switch", "-q", "other"]);
    f.git(&["merge", "-q", "--no-edit", "main"]);
    f.git(&["switch", "-q", "main"]);
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    f.git(&["update-index", "--chmod=+x", "run.sh"]);
    engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("carried");
    assert!(
        f.git(&["ls-files", "-s", "run.sh"]).starts_with("100755"),
        "{}",
        f.git(&["ls-files", "-s", "run.sh"])
    );
}

#[test]
fn a_file_taken_out_of_the_index_stays_out() {
    let mut f = two_branches();
    f.write(".env", "TOKEN=placeholder\n");
    f.commit("env");
    f.git(&["switch", "-q", "other"]);
    f.git(&["merge", "-q", "--no-edit", "main"]);
    f.git(&["switch", "-q", "main"]);
    f.git(&["rm", "-q", "--cached", ".env"]);
    f.write(".gitignore", ".env\n");
    f.write(".env", "TOKEN=mine\n");
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("carried");
    assert_eq!(f.git(&["ls-files", ".env"]), "");
    assert_eq!(read(&f, ".env"), "TOKEN=mine\n");
}

#[test]
fn a_plain_switch_whose_hook_failed_still_switched() {
    let f = two_branches();
    failing_post_checkout(&f);
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Refuse, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(switched.stash, None);
    assert!(switched
        .notice
        .expect("git's words")
        .contains("the hook refused"));
}

#[test]
fn carrying_from_an_unborn_branch_says_why_it_cannot() {
    let mut f = Fixture::empty();
    f.write("a.txt", "a\n");
    f.commit("on other");
    f.git(&["branch", "-m", "other"]);
    f.git(&["switch", "-q", "--orphan", "main"]);
    f.write("a.txt", "untracked on unborn main\n");
    let error = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect_err("no commit to stash on");
    let words = error.detail().unwrap_or_default().to_owned();
    assert!(words.contains("initial commit"), "{error:?}");
    assert_eq!(read(&f, "a.txt"), "untracked on unborn main\n");
}

/// git stores the stash, removes notes.txt, and cannot remove the log another program holds:
/// notes.txt comes back and the stash goes, nothing having been switched.
#[cfg(windows)]
#[test]
fn a_stash_stopped_by_an_untracked_file_held_open_takes_nothing() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    f.write("notes.txt", "mine\n");
    f.write("server.log", "a line\n");
    let held = held_open(&f.root.join("server.log"));
    let error = engine(&f)
        .switch(&to("other"), LocalChanges::Leave, &never())
        .expect_err("git could not clean the tree");
    drop(held);
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(head_ref(&f), "refs/heads/main");
    assert_eq!(read(&f, "notes.txt"), "mine\n");
    assert_eq!(read(&f, "server.log"), "a line\n");
    assert_eq!(read(&f, "f.txt"), "a\nb-local\nc\nd\ne\n");
    assert!(stashes(&f).is_empty(), "{:?}", stashes(&f));
}

/// git stores the stash and cannot reset the changed file another program holds.
#[cfg(windows)]
#[test]
fn a_stash_stopped_by_a_changed_file_held_open_takes_nothing() {
    let f = two_branches();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    f.write("g.txt", "X-local\ny\nz\nw\nv\n");
    f.git(&["add", "g.txt"]);
    let held = held_open(&f.root.join("f.txt"));
    let error = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect_err("git could not reset the tree");
    drop(held);
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(head_ref(&f), "refs/heads/main");
    assert_eq!(read(&f, "f.txt"), "a\nb-local\nc\nd\ne\n");
    assert_eq!(read(&f, "g.txt"), "X-local\ny\nz\nw\nv\n");
    assert_eq!(f.git(&["diff", "--cached", "--name-only"]), "g.txt");
    assert!(stashes(&f).is_empty(), "{:?}", stashes(&f));
}

#[test]
fn a_carry_into_a_folder_that_becomes_a_file_takes_the_untracked_files_too() {
    let mut f = Fixture::empty();
    f.write("d/x.txt", "x\n");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "other"]);
    f.git(&["rm", "-q", "-r", "d"]);
    f.write("d", "a file now\n");
    f.commit("d is a file");
    f.git(&["switch", "-q", "main"]);
    // git names the changed file first, and the untracked one only once the first is out of
    // its way.
    f.write("d/x.txt", "x, changed\n");
    f.write("d/y.txt", "mine\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    // The changed file comes back over the branch's file as a conflict: the stash keeps the
    // changes, with their untracked file.
    assert!(
        switched.conflicts.iter().any(|c| c.path == "d/x.txt"),
        "{switched:?}"
    );
    let stash = switched.stash.expect("kept");
    assert_eq!(
        f.git(&["ls-tree", "-r", "--name-only", &format!("{stash}^3")]),
        "d/y.txt"
    );
}

#[test]
fn a_target_named_with_double_spaces_is_carried_to() {
    let mut f = two_branches();
    f.git(&["switch", "-q", "other"]);
    f.write("h.txt", "h\n");
    f.commit("fix  the  thing");
    f.git(&["switch", "-q", "main"]);
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    let target = SwitchTarget::Detached {
        rev: "other^{/fix  the  thing}".to_owned(),
    };
    let switched = engine(&f)
        .switch(&target, LocalChanges::Carry, &never())
        .expect("carried");
    // git writes the stash's message with one space where there were two: it is still ours.
    assert_eq!(switched, Default::default());
    assert_eq!(f.head(), f.rev("other"));
    assert_eq!(read(&f, "f.txt"), "a\nB-other\nc\nd\nE-local\n");
    assert!(stashes(&f).is_empty());
}

/// git stores the stash, cleans the untracked files but the one held open, and stops: the file
/// taken out of the index, which the stash holds, is not a change that stayed in it.
#[cfg(windows)]
#[test]
fn a_stash_stopped_half_way_counts_a_file_taken_out_of_the_index_as_back() {
    let mut f = two_branches();
    f.write(".env", "TOKEN=placeholder\n");
    f.commit("env");
    f.git(&["rm", "-q", "--cached", ".env"]);
    f.write(".gitignore", ".env\n");
    f.write(".env", "TOKEN=mine\n");
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    f.write("notes.txt", "mine\n");
    f.write("server.log", "a line\n");
    let held = held_open(&f.root.join("server.log"));
    engine(&f)
        .switch(&to("other"), LocalChanges::Leave, &never())
        .expect_err("git could not clean the tree");
    drop(held);
    assert_eq!(head_ref(&f), "refs/heads/main");
    assert_eq!(read(&f, "notes.txt"), "mine\n");
    assert_eq!(read(&f, ".env"), "TOKEN=mine\n");
    assert_eq!(f.git(&["ls-files", ".env"]), "");
    assert!(stashes(&f).is_empty(), "{:?}", stashes(&f));
}

/// git's reset puts back a file the changes delete before it stops on the held one: HEAD's
/// version, which goes again, so that everything is as it was and the stash goes.
#[cfg(windows)]
#[test]
fn a_stash_stopped_half_way_takes_away_a_deleted_file_the_reset_put_back() {
    let mut f = two_branches();
    f.write("a.txt", "a\n");
    f.write("z.txt", "z\n");
    f.commit("more files");
    f.git(&["rm", "-q", "a.txt"]);
    f.write("z.txt", "z, changed\n");
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    let held = held_open(&f.root.join("z.txt"));
    let error = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect_err("git could not reset the tree");
    drop(held);
    assert_eq!(head_ref(&f), "refs/heads/main");
    let words = error.detail().unwrap_or_default().to_owned();
    assert!(!words.contains("The changes are in the stash"), "{words}");
    assert!(!f.root.join("a.txt").exists());
    assert!(stashes(&f).is_empty(), "{:?}", stashes(&f));
    assert_eq!(
        f.git(&["status", "--porcelain", "--untracked-files=all"]),
        "D  a.txt\n M f.txt\n M z.txt"
    );
    assert_eq!(read(&f, "z.txt"), "z, changed\n");
    assert_eq!(read(&f, "f.txt"), "a\nb-local\nc\nd\ne\n");
}

/// git lets a file another program holds keep its old content and switches all the same: the
/// answer says what git wrote about it.
#[cfg(windows)]
#[test]
fn a_switch_git_completes_with_an_error_says_so() {
    let f = two_branches();
    let held = held_open(&f.root.join("g.txt"));
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Refuse, &never())
        .expect("switched");
    drop(held);
    assert_eq!(head_ref(&f), "refs/heads/other");
    let notice = switched.notice.expect("git's words");
    assert!(notice.contains("unable to unlink"), "{notice}");
}

#[test]
fn a_switch_that_happened_before_its_hook_failed_goes_on() {
    let f = two_branches();
    failing_post_checkout(&f);
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(read(&f, "f.txt"), "a\nB-other\nc\nd\nE-local\n");
    assert_eq!(switched.stash, None);
    assert_eq!(switched.kept, None);
    let notice = switched.notice.expect("git's words");
    assert!(notice.contains("the hook refused"), "{notice}");
    assert!(stashes(&f).is_empty());
}

#[test]
fn changes_left_before_a_failing_hook_stay_in_their_stash() {
    let f = two_branches();
    failing_post_checkout(&f);
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Leave, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    let stash = switched.stash.expect("the stash");
    assert!(stashes(&f)[0].starts_with(&stash));
    assert!(switched
        .notice
        .expect("git's words")
        .contains("the hook refused"));
}

#[test]
fn a_carry_with_conflicts_and_an_untracked_file_refused_reports_both() {
    let f = untracked_in_the_way();
    f.write("f.txt", "a\nb-local\nc\nd\ne\n");
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(
        switched
            .conflicts
            .iter()
            .map(|c| c.path.as_str())
            .collect::<Vec<_>>(),
        ["f.txt"]
    );
    let kept = switched.kept.expect("git's words");
    assert!(kept.contains("could not restore untracked files"), "{kept}");
    assert_eq!(read(&f, "new.txt"), "tracked\n");
    assert!(stashes(&f)[0].starts_with(&switched.stash.expect("kept")));
}

#[test]
fn untracked_files_a_directory_update_would_lose_are_in_the_way() {
    let mut f = Fixture::empty();
    f.write("d/a.txt", "a\n");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "other"]);
    f.git(&["rm", "-q", "-r", "d"]);
    f.write("d", "a file now\n");
    f.commit("d is a file");
    f.git(&["switch", "-q", "main"]);
    f.write("d/b.txt", "mine\n");
    let e = engine(&f);
    let stderr = refused_stderr(
        e.switch(&to("other"), LocalChanges::Refuse, &never())
            .expect_err("refused"),
    );
    assert!(stderr.contains("would lose untracked files"), "{stderr}");
    let switched = e
        .switch(&to("other"), LocalChanges::Leave, &never())
        .expect("switched");
    assert_eq!(read(&f, "d"), "a file now\n");
    let stash = switched.stash.expect("the stash");
    assert_eq!(
        f.git(&["ls-tree", "-r", "--name-only", &format!("{stash}^3")]),
        "d/b.txt"
    );
}

#[test]
fn nothing_to_carry_is_a_plain_switch() {
    let f = two_branches();
    let switched = engine(&f)
        .switch(&to("other"), LocalChanges::Carry, &never())
        .expect("switched");
    assert_eq!(head_ref(&f), "refs/heads/other");
    assert_eq!(switched.stash, None);
    assert!(stashes(&f).is_empty());
}

#[test]
fn a_branch_created_and_checked_out_carries_the_changes() {
    let f = two_branches();
    f.write("f.txt", "a\nb\nc\nd\nE-local\n");
    engine(&f)
        .branch_create("topic", "other", true, false, LocalChanges::Carry, &never())
        .expect("created");
    assert_eq!(head_ref(&f), "refs/heads/topic");
    assert_eq!(read(&f, "f.txt"), "a\nB-other\nc\nd\nE-local\n");
}

// ------------------------------------------------------------------ autostash

#[test]
fn a_merge_sets_the_changes_aside_and_brings_them_back() {
    let f = two_branches();
    let e = engine(&f);
    f.write("g.txt", "X-local\ny\nz\nw\nv\n");
    e.merge("other", MergeMode::Default, false, &never())
        .expect_err("refused without autostash");
    let outcome = e
        .merge("other", MergeMode::Default, true, &never())
        .expect("merged");
    assert_eq!(outcome.kind, OutcomeKind::FastForward, "{outcome:?}");
    assert_eq!(outcome.stash, None);
    assert_eq!(e.held_aside().expect("read"), None);
    assert_eq!(read(&f, "g.txt"), "X-local\ny\nz\nw\nV-other\n");
    assert!(stashes(&f).is_empty());
}

#[test]
fn changes_that_come_back_with_conflicts_stay_in_the_autostash() {
    let f = two_branches();
    f.write("g.txt", "x\ny\nz\nw\nv-local\n");
    let e = engine(&f);
    let outcome = e
        .merge("other", MergeMode::Default, true, &never())
        .expect("merged");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts, "{outcome:?}");
    assert_eq!(outcome.conflicts[0].path, "g.txt");
    assert_eq!(e.held_aside().expect("read"), None);
    let stash = outcome.stash.expect("git kept the autostash");
    let listed = stashes(&f);
    assert!(listed[0].starts_with(&stash), "{listed:?}");
    assert_eq!(f.head(), f.rev("other"));
}

#[test]
fn a_merge_that_stops_holds_the_changes_aside_until_it_is_committed() {
    let mut f = two_branches();
    f.write("f.txt", "a\nB-main\nc\nd\ne\n");
    f.commit("main");
    f.write("notes.txt", "mine\n");
    f.git(&["add", "notes.txt"]);
    f.commit("notes");
    f.write("notes.txt", "mine, edited\n");
    let e = engine(&f);
    let outcome = e
        .merge("other", MergeMode::Default, true, &never())
        .expect("stopped");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts, "{outcome:?}");
    assert_eq!(
        e.held_aside().expect("read").as_deref(),
        Some(
            f.git(&["rev-parse", "--verify", "MERGE_AUTOSTASH"])
                .as_str()
        )
    );
    assert_eq!(outcome.stash, None);
    assert_eq!(read(&f, "notes.txt"), "mine\n");
    f.write("f.txt", "a\nB-both\nc\nd\ne\n");
    f.git(&["add", "f.txt"]);
    f.git(&["commit", "-q", "--no-edit"]);
    assert_eq!(read(&f, "notes.txt"), "mine, edited\n");
}

#[test]
fn a_rebase_that_stops_holds_the_changes_aside() {
    let mut f = two_branches();
    f.write("f.txt", "a\nB-main\nc\nd\ne\n");
    f.commit("main");
    f.write("g.txt", "X-local\ny\nz\nw\nv\n");
    let e = engine(&f);
    let outcome = e.rebase("other", true, &never()).expect("stopped");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts, "{outcome:?}");
    assert!(e.held_aside().expect("read").is_some());
    f.git(&["rebase", "--abort"]);
    assert_eq!(e.held_aside().expect("read"), None);
    assert_eq!(read(&f, "g.txt"), "X-local\ny\nz\nw\nv\n");
}

#[test]
fn continuing_a_merge_brings_the_changes_back_or_keeps_their_stash() {
    let mut f = two_branches();
    f.git(&["switch", "-q", "other"]);
    f.write("notes.txt", "theirs\n");
    f.commit("other writes notes");
    f.git(&["switch", "-q", "main"]);
    f.write("notes.txt", "mine\n");
    f.commit("main writes notes");
    f.write("f.txt", "a\nB-main\nc\nd\ne\n");
    f.commit("main");
    f.write("notes.txt", "mine, edited\n");
    let e = engine(&f);
    let stopped = e
        .merge("other", MergeMode::Default, true, &never())
        .expect("stopped");
    assert_eq!(stopped.kind, OutcomeKind::Conflicts, "{stopped:?}");
    let held = e.held_aside().expect("read").expect("held aside");
    assert_eq!(held, f.git(&["rev-parse", "--verify", "MERGE_AUTOSTASH"]));
    f.write("f.txt", "a\nB-both\nc\nd\ne\n");
    f.write("notes.txt", "theirs\n");
    f.git(&["add", "f.txt", "notes.txt"]);
    // The merge takes their notes; the edit to mine comes back over them with a conflict.
    let outcome = e
        .sequencer(SequencerAction::Continue, &never())
        .expect("continued");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts, "{outcome:?}");
    assert_eq!(outcome.conflicts[0].path, "notes.txt");
    assert_eq!(outcome.stash.as_deref(), Some(held.as_str()));
    assert_eq!(e.held_aside().expect("read"), None);
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
}

#[test]
fn continuing_a_rebase_keeps_the_stash_it_held_when_the_changes_conflict() {
    let mut f = two_branches();
    f.write("f.txt", "a\nB-main\nc\nd\ne\n");
    f.commit("main");
    // `other` changes the same line: the edit comes back over the rebased branch with a conflict.
    f.write("g.txt", "x\ny\nz\nw\nv-local\n");
    let e = engine(&f);
    let stopped = e.rebase("other", true, &never()).expect("stopped");
    assert_eq!(stopped.kind, OutcomeKind::Conflicts, "{stopped:?}");
    let held = e.held_aside().expect("read").expect("held aside");
    let file = std::fs::read_to_string(f.git_dir().join("rebase-merge").join("autostash"))
        .expect("the autostash");
    assert_eq!(held, file.trim());
    f.write("f.txt", "a\nB-both\nc\nd\ne\n");
    f.git(&["add", "f.txt"]);
    // HEAD moved while the rebase replayed: the stash git keeps is told by what it held.
    let outcome = e
        .sequencer(SequencerAction::Continue, &never())
        .expect("continued");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts, "{outcome:?}");
    assert_eq!(outcome.conflicts[0].path, "g.txt");
    assert_eq!(outcome.stash.as_deref(), Some(held.as_str()));
    assert_eq!(e.operation_state().expect("state"), OperationState::None);
}

#[test]
fn an_autostash_entry_from_before_the_operation_is_not_taken_for_its_own() {
    let f = two_branches();
    // A stash named as git names its autostash, made over HEAD before the merge.
    f.write("g.txt", "x\ny\nz\nw\nv-old\n");
    let created = f.git(&["stash", "create"]);
    f.git(&["stash", "store", "-q", "-m", "autostash", &created]);
    f.git(&["checkout", "--", "g.txt"]);
    f.write("g.txt", "X-local\ny\nz\nw\nv\n");
    let outcome = engine(&f)
        .merge("other", MergeMode::Default, true, &never())
        .expect("merged");
    assert_eq!(outcome.kind, OutcomeKind::FastForward, "{outcome:?}");
    assert_eq!(outcome.stash, None);
    assert_eq!(stashes(&f).len(), 1);
}

#[test]
fn a_merge_abort_git_cannot_finish_keeps_the_changes_set_aside() {
    let mut f = two_branches();
    f.write("f.txt", "a\nB-main\nc\nd\ne\n");
    f.commit("main");
    f.write("g.txt", "x\ny\nz\nw\nv-local\n");
    let e = engine(&f);
    e.merge("other", MergeMode::Default, true, &never())
        .expect("stopped");
    let held = e.held_aside().expect("read").expect("held aside");
    // An edit to a file the merge changed, made during the stop, stops git's reset: git has
    // let go of the changes it held aside by then.
    f.write("g.txt", "x\ny\nz\nw\nV-edited\n");
    let error = e
        .sequencer(SequencerAction::Abort, &never())
        .expect_err("git could not abort");
    let words = error
        .detail()
        .map_or_else(|| error.to_string(), str::to_owned);
    assert!(words.contains(&held), "{words}");
    assert!(stashes(&f)[0].starts_with(&held), "{:?}", stashes(&f));
    assert_eq!(
        f.git(&["show", &format!("{held}:g.txt")]),
        "x\ny\nz\nw\nv-local"
    );
}

#[test]
fn aborting_a_merge_brings_the_changes_back() {
    let mut f = two_branches();
    f.write("f.txt", "a\nB-main\nc\nd\ne\n");
    f.commit("main");
    f.write("g.txt", "X-local\ny\nz\nw\nv\n");
    let e = engine(&f);
    let stopped = e
        .merge("other", MergeMode::Default, true, &never())
        .expect("stopped");
    assert!(e.held_aside().expect("read").is_some(), "{stopped:?}");
    let outcome = e
        .sequencer(SequencerAction::Abort, &never())
        .expect("aborted");
    assert_eq!(outcome.kind, OutcomeKind::Done, "{outcome:?}");
    assert_eq!(outcome.stash, None);
    assert_eq!(read(&f, "g.txt"), "X-local\ny\nz\nw\nv\n");
    assert!(stashes(&f).is_empty());
}

#[test]
fn a_merge_a_hook_stopped_holds_the_changes_aside() {
    let mut f = two_branches();
    f.write("h.txt", "main\n");
    f.commit("main diverges");
    let hook = f.git_dir().join("hooks").join("pre-merge-commit");
    std::fs::create_dir_all(hook.parent().expect("hooks folder")).expect("hooks folder");
    std::fs::write(&hook, "#!/bin/sh\necho not yet >&2\nexit 1\n").expect("hook");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    f.write("g.txt", "X-local\ny\nz\nw\nv\n");
    let e = engine(&f);
    let error = e
        .merge("other", MergeMode::Default, true, &never())
        .expect_err("the hook stopped it");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(e.operation_state().expect("state"), OperationState::Merge);
    assert_eq!(
        e.held_aside().expect("read").as_deref(),
        Some(
            f.git(&["rev-parse", "--verify", "MERGE_AUTOSTASH"])
                .as_str()
        )
    );
    f.git(&["merge", "--abort"]);
    assert_eq!(read(&f, "g.txt"), "X-local\ny\nz\nw\nv\n");
}

#[test]
fn a_rebase_that_stops_on_an_untracked_file_keeps_git_s_error() {
    let mut f = two_branches();
    f.write("x.txt", "x\n");
    f.commit("add x");
    f.remove("x.txt");
    f.commit("drop x");
    f.write("x.txt", "untracked\n");
    let e = engine(&f);
    // The replay of "add x" stops on the untracked file: a rebase in progress, which no stash
    // gets through.
    let error = e.rebase("other", true, &never()).expect_err("stopped");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(e.operation_state().expect("state"), OperationState::Rebase);
    f.git(&["rebase", "--abort"]);
}

#[test]
fn untracked_files_in_the_way_are_refused_even_with_autostash() {
    let f = untracked_in_the_way();
    let error = engine(&f)
        .merge("other", MergeMode::Default, true, &never())
        .expect_err("refused");
    let stderr = refused_stderr(error);
    assert!(stderr.contains("untracked working tree files"), "{stderr}");
    assert_eq!(read(&f, "new.txt"), "untracked\n");
    assert!(stashes(&f).is_empty());
}
