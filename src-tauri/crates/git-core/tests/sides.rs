//! A conflicted file taken whole from one side of the operation, the sides by their names, and
//! the way back, against the git CLI on fixture repositories.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    MergeMode, OperationSides, OperationState, OutcomeKind, SequencerAction, Side, SideName,
};
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn never() -> Cancel {
    Cancel::never()
}

/// A file's content, or `None` when the working tree has none.
fn read(f: &Fixture, relative: &str) -> Option<String> {
    std::fs::read_to_string(f.root.join(relative)).ok()
}

fn named(name: &str) -> SideName {
    SideName::Ref {
        name: name.to_owned(),
    }
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|path| (*path).to_owned()).collect()
}

/// `git ls-files -u`: each conflicted path with the stages the index holds for it.
fn stages(f: &Fixture) -> Vec<(String, Vec<u8>)> {
    let mut by_path: Vec<(String, Vec<u8>)> = Vec::new();
    for line in f.git(&["ls-files", "-u"]).lines() {
        let Some((meta, path)) = line.split_once('\t') else {
            continue;
        };
        let stage = meta
            .split(' ')
            .nth(2)
            .and_then(|s| s.parse::<u8>().ok())
            .unwrap_or(0);
        match by_path.iter_mut().find(|(p, _)| p == path) {
            Some((_, list)) => list.push(stage),
            None => by_path.push((path.to_owned(), vec![stage])),
        }
    }
    by_path
}

/// `README.md` changed on `other` and on `main`.
fn conflicting(f: &mut Fixture) {
    f.git(&["switch", "-q", "-c", "other", "main"]);
    f.write("README.md", "# Other\n");
    f.commit("other readme");
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    f.commit("main readme");
}

/// The merge of `theirs` into `main` stops on four kinds: `a.txt` modified by both, `b.txt`
/// deleted by us, `c.txt` added by both, `d.txt` deleted by them.
fn four_kinds(f: &mut Fixture) {
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
}

const FOUR: [&str; 4] = ["a.txt", "b.txt", "c.txt", "d.txt"];

/// The merge of `theirs` into `main` stops on `e.txt` renamed to two names: `e.txt` deleted
/// by both, `e-ours.txt` added by us, `e-theirs.txt` added by them.
fn renamed_apart(f: &mut Fixture) {
    f.write("e.txt", "line one\nline two\nline three\nline four\n");
    f.commit("base e");
    f.git(&["switch", "-q", "-c", "theirs"]);
    f.git(&["mv", "e.txt", "e-theirs.txt"]);
    f.commit("theirs renames");
    f.git(&["switch", "-q", "main"]);
    f.git(&["mv", "e.txt", "e-ours.txt"]);
    f.commit("ours renames");
}

const RENAMED: [&str; 3] = ["e-ours.txt", "e-theirs.txt", "e.txt"];

/// `git ls-files -s` of one path: `<mode> <hash> <stage>\t<path>`.
fn index_entry(f: &Fixture, path: &str) -> String {
    f.git(&["ls-files", "-s", "--", path])
}

// ------------------------------------------------------------------------------ the sides

#[test]
fn names_a_merges_sides_and_none_without_an_operation() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    let e = engine(&f);
    assert_eq!(e.operation_sides().expect("sides"), None);
    e.merge("other", MergeMode::Default, false, &never())
        .expect("stops");
    assert_eq!(
        e.operation_sides().expect("sides"),
        Some(OperationSides {
            ours: named("main"),
            theirs: named("other"),
        })
    );
    // A name moved since no longer names the merged commit: the commit does.
    let other = f.rev("other");
    f.git(&["branch", "-f", "other", "main"]);
    assert_eq!(
        e.operation_sides().expect("sides").expect("a merge").theirs,
        SideName::Commit {
            hash: other.clone(),
            subject: "other readme".to_owned(),
        }
    );
    f.git(&["branch", "-f", "other", &other]);
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    // A name may hold a quote: it runs to the message's last one.
    f.git(&["branch", "it's", "other"]);
    e.merge("it's", MergeMode::Default, false, &never())
        .expect("stops");
    let sides = e.operation_sides().expect("sides").expect("a merge");
    assert_eq!(sides.theirs, named("it's"));
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    // A tag and a remote-tracking branch by their names; a bare commit by hash and subject.
    f.git(&["tag", "-a", "-m", "other's tag", "v-other", "other"]);
    f.git(&["update-ref", "refs/remotes/origin/other", "other"]);
    for (rev, theirs) in [
        ("v-other", named("v-other")),
        ("origin/other", named("origin/other")),
    ] {
        e.merge(rev, MergeMode::Default, false, &never())
            .expect("stops");
        let sides = e.operation_sides().expect("sides").expect("a merge");
        assert_eq!(sides.theirs, theirs, "{rev}");
        e.sequencer(SequencerAction::Abort, &never())
            .expect("abort");
    }
    let hash = f.rev("other");
    e.merge(&hash, MergeMode::Default, false, &never())
        .expect("stops");
    let sides = e.operation_sides().expect("sides").expect("a merge");
    assert_eq!(
        sides.theirs,
        SideName::Commit {
            hash: hash.clone(),
            subject: "other readme".to_owned(),
        }
    );
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
}

#[test]
fn names_a_pulls_merge_by_the_remote_tracking_branch_that_holds_it() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    let url = f.root.to_string_lossy().into_owned();
    f.git(&["remote", "add", "origin", &url]);
    f.git(&["fetch", "-q", "origin"]);
    // A pull merges FETCH_HEAD, which git's message names "branch 'other' of <url>": the
    // remote's branch, not the local `other`.
    f.git(&["fetch", "-q", "origin", "other"]);
    // Another remote branch at the same commit is not the one the message names.
    f.git(&["update-ref", "refs/remotes/origin/aaa", "other"]);
    let e = engine(&f);
    e.merge("FETCH_HEAD", MergeMode::Default, false, &never())
        .expect("stops");
    assert_eq!(
        e.operation_sides().expect("sides"),
        Some(OperationSides {
            ours: named("main"),
            theirs: named("origin/other"),
        })
    );
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
}

#[test]
fn names_no_sides_for_an_octopus_merge() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    for name in ["one", "two"] {
        f.git(&["switch", "-q", "-c", name, "main~1"]);
        f.write(&format!("{name}.txt"), &format!("{name}\n"));
        f.commit(name);
    }
    f.git(&["switch", "-q", "main"]);
    // git's octopus stops when its last head conflicts; ours is then HEAD with `one` and
    // `two` merged, theirs `other`, which no one name says.
    let (merged, _, _) = f.try_git(&["merge", "one", "two", "other"]);
    assert!(!merged, "the octopus stops");
    let e = engine(&f);
    assert_eq!(e.operation_state().expect("state"), OperationState::Merge);
    assert_eq!(e.operation_sides().expect("sides"), None);
}

#[test]
fn names_an_unborn_branch_by_the_name_head_points_at() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    let pick = f.rev("other");
    f.git(&["switch", "-q", "--orphan", "lonely"]);
    let e = engine(&f);
    let outcome = e
        .cherry_pick(std::slice::from_ref(&pick), &never())
        .expect("stops");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    let sides = e.operation_sides().expect("sides").expect("a cherry-pick");
    assert_eq!(sides.ours, named("lonely"));
}

#[test]
fn names_a_rebases_sides_the_branch_rebased_onto_and_the_branch_rebased() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    let e = engine(&f);
    // A local branch names the tip before a remote-tracking one does.
    f.git(&["update-ref", "refs/remotes/a-remote/x", "main"]);
    f.git(&["switch", "-q", "other"]);
    let outcome = e.rebase("main", false, &never()).expect("stops");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    // Git's --ours is main here: the names, not "ours" and "theirs", say which is which.
    assert_eq!(
        e.operation_sides().expect("sides"),
        Some(OperationSides {
            ours: named("main"),
            theirs: named("other"),
        })
    );
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    // Started at the hash, which names no branch in HEAD's reflog: a local branch at it, before
    // the remote-tracking one.
    e.rebase(&f.rev("main"), false, &never()).expect("stops");
    let sides = e.operation_sides().expect("sides").expect("a rebase");
    assert_eq!(sides.ours, named("main"));
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    // Onto a commit no branch points at: its hash and subject.
    f.git(&["switch", "-q", "--detach", "main"]);
    f.write("README.md", "# Detached\n");
    let onto = f.commit("detached readme");
    f.git(&["switch", "-q", "other"]);
    e.rebase(&onto, false, &never()).expect("stops");
    let sides = e.operation_sides().expect("sides").expect("a rebase");
    assert_eq!(
        sides.ours,
        SideName::Commit {
            hash: onto.clone(),
            subject: "detached readme".to_owned(),
        }
    );
    assert_eq!(sides.theirs, named("other"));
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    // Onto a remote-tracking branch's tip, as a pull's rebase goes: by that branch's name.
    f.git(&["update-ref", "refs/remotes/origin/up", &onto]);
    e.rebase(&onto, false, &never()).expect("stops");
    let sides = e.operation_sides().expect("sides").expect("a rebase");
    assert_eq!(sides.ours, named("origin/up"));
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    // Started detached two commits ahead: theirs is the commit being applied, the first, not
    // the one the rebase started at.
    let applied = f.rev("other");
    f.git(&["switch", "-q", "other"]);
    f.write("extra.txt", "extra\n");
    f.commit("other extra");
    f.git(&["switch", "-q", "--detach", "other"]);
    e.rebase("main", false, &never()).expect("stops");
    let sides = e.operation_sides().expect("sides").expect("a rebase");
    assert_eq!(sides.ours, named("main"));
    assert_eq!(
        sides.theirs,
        SideName::Commit {
            hash: applied,
            subject: "other readme".to_owned(),
        }
    );
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
}

#[test]
fn names_a_rebases_base_by_the_name_it_was_started_with() {
    let mut f = Fixture::basic();
    f.write("f.txt", "l1\n");
    f.commit("base f");
    f.git(&["switch", "-q", "-c", "feature"]);
    f.write("f.txt", "l1 feature\n");
    f.commit("feature f");
    f.git(&["switch", "-q", "main"]);
    f.write("f.txt", "l1 main\n");
    f.commit("main f");
    // A branch just made from main, which sorts before it.
    f.git(&["branch", "aaa-next", "main"]);
    f.git(&["switch", "-q", "feature"]);
    let e = engine(&f);
    e.rebase("main", false, &never()).expect("stops");
    // HEAD's reflog: "rebase (start): checkout main".
    let sides = e.operation_sides().expect("sides").expect("a rebase");
    assert_eq!(sides.ours, named("main"));
}

#[test]
fn names_a_pulls_rebase_base_by_the_upstream_of_the_branch_rebased() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    let url = f.root.to_string_lossy().into_owned();
    f.git(&["remote", "add", "origin", &url]);
    f.git(&["fetch", "-q", "origin"]);
    f.git(&["branch", "--set-upstream-to=origin/main", "other"]);
    // A local branch at the same commit, which sorts before both.
    f.git(&["branch", "aaa", "main"]);
    f.git(&["switch", "-q", "other"]);
    // A pull's rebase starts at the fetched hash, which names no branch in the reflog.
    let onto = f.rev("origin/main");
    let e = engine(&f);
    e.rebase(&onto, false, &never()).expect("stops");
    let sides = e.operation_sides().expect("sides").expect("a rebase");
    assert_eq!(sides.ours, named("origin/main"));
    assert_eq!(sides.theirs, named("other"));
}

#[test]
fn names_a_rebase_merges_stop_by_the_parents_of_the_merge_it_recreates() {
    let mut f = Fixture::basic();
    f.write("f.txt", "a\n");
    f.write("g.txt", "b\n");
    f.commit("base fg");
    f.git(&["switch", "-q", "-c", "feature"]);
    f.write("f.txt", "feature f\n");
    f.commit("feature f");
    f.git(&["switch", "-q", "-c", "side", "feature"]);
    f.write("g.txt", "side g\n");
    f.commit("side g");
    f.git(&["switch", "-q", "feature"]);
    f.write("g.txt", "feature g\n");
    f.commit("feature g");
    f.try_git(&["merge", "-q", "--no-ff", "side"]);
    f.write("g.txt", "resolved g\n");
    f.commit("merge side");
    f.git(&["switch", "-q", "main"]);
    f.write("f.txt", "main f\n");
    f.commit("main f");
    f.git(&["switch", "-q", "feature"]);
    let (done, _, _) = f.try_git(&["rebase", "-r", "main"]);
    assert!(!done);
    // The first stop is a pick on f.txt; taken, the rebase goes on to the merge's stop on g.txt.
    let e = engine(&f);
    e.take_side(&paths(&["f.txt"]), Side::Theirs, &never())
        .expect("taken");
    let _ = e.sequencer(SequencerAction::Continue, &never());
    assert_eq!(f.git(&["diff", "--name-only", "--diff-filter=U"]), "g.txt");
    let sides = e.operation_sides().expect("sides").expect("a rebase");
    // Stage 2 is HEAD (the rebased feature line), stage 3 MERGE_HEAD (the merged side).
    assert_eq!(f.rev(":2:g.txt"), f.rev("HEAD:g.txt"));
    assert_eq!(f.rev(":3:g.txt"), f.rev("MERGE_HEAD:g.txt"));
    assert_eq!(
        sides.ours,
        SideName::Commit {
            hash: f.head(),
            subject: "feature g".to_owned(),
        }
    );
    assert_eq!(
        sides.theirs,
        SideName::Commit {
            hash: f.rev("MERGE_HEAD"),
            subject: "side g".to_owned(),
        }
    );
}

#[test]
fn names_a_pulls_merge_by_the_remote_branch_the_message_names() {
    let mut f = Fixture::basic();
    f.write("f.txt", "base\n");
    f.commit("base f");
    f.git(&["switch", "-q", "-c", "x"]);
    f.write("f.txt", "x\n");
    f.commit("x changes f");
    f.git(&["switch", "-q", "main"]);
    f.write("f.txt", "main\n");
    f.commit("main changes f");
    let origin = f.root.to_string_lossy().into_owned();
    let fork = f.sibling("fork.git");
    let fork = fork.to_string_lossy().into_owned();
    f.git(&["clone", "-q", "--bare", &origin, &fork]);
    f.git(&["remote", "add", "origin", &origin]);
    f.git(&["remote", "add", "fork", &fork]);
    f.git(&["fetch", "-q", "fork"]);
    f.git(&["fetch", "-q", "origin"]);
    // `fork/x` holds the same commit and sorts first; the message names origin's URL.
    let (merged, _, _) = f.try_git(&["pull", "-q", "--no-rebase", "origin", "x"]);
    assert!(!merged);
    let sides = engine(&f)
        .operation_sides()
        .expect("sides")
        .expect("a merge");
    assert_eq!(sides.theirs, named("origin/x"));
}

#[test]
fn names_a_merge_into_a_branch_whose_name_holds_a_quote() {
    let mut f = Fixture::basic();
    f.write("f.txt", "base\n");
    f.commit("base f");
    f.git(&["switch", "-q", "-c", "other"]);
    f.write("f.txt", "other\n");
    f.commit("other f");
    f.git(&["switch", "-q", "-c", "it's", "main"]);
    f.write("f.txt", "quote\n");
    f.commit("quote f");
    let e = engine(&f);
    e.merge("other", MergeMode::Default, false, &never())
        .expect("stops");
    // MERGE_MSG: "Merge branch 'other' into it's".
    let sides = e.operation_sides().expect("sides").expect("a merge");
    assert_eq!(sides.theirs, named("other"));
    assert_eq!(sides.ours, named("it's"));
}

#[test]
fn names_a_cherry_picks_commit_and_a_reverts_state_before_its_commit() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    let e = engine(&f);
    let pick = f.rev("other");
    e.cherry_pick(std::slice::from_ref(&pick), &never())
        .expect("stops");
    assert_eq!(
        e.operation_sides().expect("sides"),
        Some(OperationSides {
            ours: named("main"),
            theirs: SideName::Commit {
                hash: pick.clone(),
                subject: "other readme".to_owned(),
            },
        })
    );
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    // On a detached HEAD, ours is HEAD's commit.
    let main = f.rev("main");
    f.git(&["switch", "-q", "--detach", "main"]);
    e.cherry_pick(std::slice::from_ref(&pick), &never())
        .expect("stops");
    assert_eq!(
        e.operation_sides()
            .expect("sides")
            .expect("a cherry-pick")
            .ours,
        SideName::Commit {
            hash: main,
            subject: "main readme".to_owned(),
        }
    );
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
    f.git(&["switch", "-q", "main"]);
    // A revert of a change a later commit changed again stops on it.
    f.write("README.md", "# One\n");
    let one = f.commit("readme one");
    f.write("README.md", "# Two\n");
    f.commit("readme two");
    let outcome = e
        .revert(std::slice::from_ref(&one), &never())
        .expect("stops");
    assert_eq!(outcome.kind, OutcomeKind::Conflicts);
    assert_eq!(
        e.operation_sides().expect("sides"),
        Some(OperationSides {
            ours: named("main"),
            theirs: SideName::Before {
                hash: one,
                subject: "readme one".to_owned(),
            },
        })
    );
    e.sequencer(SequencerAction::Abort, &never())
        .expect("abort");
}

#[test]
fn names_the_sides_from_a_linked_worktrees_own_state() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    f.git(&["branch", "work", "main"]);
    let folder = f.sibling("work");
    let folder_arg = folder.to_string_lossy().into_owned();
    f.git(&["worktree", "add", "-q", &folder_arg, "work"]);
    let linked = Git2Engine::open(&folder).expect("open the linked worktree");
    linked
        .merge("other", MergeMode::Default, false, &never())
        .expect("stops");
    assert_eq!(
        linked.operation_sides().expect("sides"),
        Some(OperationSides {
            ours: named("work"),
            theirs: named("other"),
        })
    );
    // The main worktree has no operation of its own.
    assert_eq!(engine(&f).operation_sides().expect("sides"), None);
}

// ------------------------------------------------------------------------- taking a side

#[test]
fn takes_each_kind_whole_from_ours() {
    let mut f = Fixture::basic();
    four_kinds(&mut f);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    e.take_side(&paths(&FOUR), Side::Ours, &never())
        .expect("taken");
    assert!(e.conflicts(&never()).expect("conflicts").is_empty());
    assert_eq!(read(&f, "a.txt").as_deref(), Some("a ours\n"));
    assert_eq!(read(&f, "b.txt"), None);
    assert_eq!(read(&f, "c.txt").as_deref(), Some("c ours\n"));
    assert_eq!(read(&f, "d.txt").as_deref(), Some("d ours\n"));
    // As git itself leaves them: the index holds ours' blobs, b.txt deleted.
    for path in ["a.txt", "c.txt", "d.txt"] {
        assert_eq!(
            f.rev(&format!(":{path}")),
            f.rev(&format!("main:{path}")),
            "{path}"
        );
    }
    assert!(f.git(&["ls-files", "b.txt"]).is_empty());
}

#[test]
fn takes_each_kind_whole_from_theirs() {
    let mut f = Fixture::basic();
    four_kinds(&mut f);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    e.take_side(&paths(&FOUR), Side::Theirs, &never())
        .expect("taken");
    assert!(e.conflicts(&never()).expect("conflicts").is_empty());
    assert_eq!(read(&f, "a.txt").as_deref(), Some("a theirs\n"));
    assert_eq!(read(&f, "b.txt").as_deref(), Some("b theirs\n"));
    assert_eq!(read(&f, "c.txt").as_deref(), Some("c theirs\n"));
    assert_eq!(read(&f, "d.txt"), None);
    for path in ["a.txt", "b.txt", "c.txt"] {
        assert_eq!(
            f.rev(&format!(":{path}")),
            f.rev(&format!("theirs:{path}")),
            "{path}"
        );
    }
    assert!(f.git(&["ls-files", "d.txt"]).is_empty());
    // The merge goes on to its commit with the sides taken.
    let outcome = e
        .sequencer(SequencerAction::Continue, &never())
        .expect("continue");
    assert_eq!(outcome.kind, OutcomeKind::Done);
}

#[test]
fn takes_a_side_and_puts_it_back_for_names_with_spaces_dashes_and_beyond_ascii() {
    let mut f = Fixture::basic();
    let names = ["src/una ruta/ñandú.ts", "dir/-dash.txt", "-dash.txt", "--"];
    for name in names {
        f.write(name, "base\n");
    }
    f.commit("base");
    f.git(&["switch", "-q", "-c", "theirs"]);
    for name in names {
        f.write(name, "theirs\n");
    }
    f.commit("theirs");
    f.git(&["switch", "-q", "main"]);
    for name in names {
        f.write(name, "ours\n");
    }
    f.commit("ours");
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    let at_stop = stages(&f);
    e.take_side(&paths(&names), Side::Theirs, &never())
        .expect("taken");
    for name in names {
        assert_eq!(read(&f, name).as_deref(), Some("theirs\n"), "{name}");
    }
    assert!(e.conflicts(&never()).expect("conflicts").is_empty());
    // A leading dash, and a file named `--`, are names after `--unresolve` too.
    e.restore_conflicts(&paths(&names), &never())
        .expect("put back");
    assert_eq!(stages(&f), at_stop);
    for name in names {
        let text = read(&f, name).expect("written");
        assert!(text.contains("<<<<<<<"), "{name}: {text}");
    }
}

#[test]
fn takes_a_sides_mode_where_the_file_system_keeps_none() {
    let mut f = Fixture::basic();
    // Windows' default: git reads no executable bit from the files.
    f.git(&["config", "core.filemode", "false"]);
    f.write("run.sh", "echo base\n");
    f.commit("base run");
    f.git(&["switch", "-q", "-c", "theirs"]);
    f.write("run.sh", "echo theirs\n");
    f.git(&["add", "run.sh"]);
    f.git(&["update-index", "--chmod=+x", "run.sh"]);
    f.git(&["commit", "-q", "-m", "theirs runs"]);
    f.git(&["switch", "-q", "main"]);
    f.write("run.sh", "echo ours\n");
    f.commit("ours run");
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    let at_stop = stages(&f);
    e.take_side(&paths(&["run.sh"]), Side::Theirs, &never())
        .expect("taken");
    let theirs = f.rev("theirs:run.sh");
    assert_eq!(
        index_entry(&f, "run.sh"),
        format!("100755 {theirs} 0\trun.sh")
    );
    assert_eq!(read(&f, "run.sh").as_deref(), Some("echo theirs\n"));
    e.restore_conflicts(&paths(&["run.sh"]), &never())
        .expect("put back");
    assert_eq!(stages(&f), at_stop);
    e.take_side(&paths(&["run.sh"]), Side::Ours, &never())
        .expect("taken");
    let ours = f.rev("main:run.sh");
    assert_eq!(
        index_entry(&f, "run.sh"),
        format!("100644 {ours} 0\trun.sh")
    );
}

#[test]
fn refuses_a_path_that_is_not_conflicted_before_git_runs() {
    let mut f = Fixture::basic();
    four_kinds(&mut f);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    f.write("README.md", "an edit\n");
    let error = e
        .take_side(&paths(&["a.txt", "README.md"]), Side::Theirs, &never())
        .expect_err("refused");
    assert!(
        matches!(&error, GitError::NotConflicted(path) if path == "README.md"),
        "{error:?}"
    );
    assert_eq!(error.code(), "conflict.not_conflicted");
    // Nothing ran: the edit stays and a.txt is still conflicted.
    assert_eq!(read(&f, "README.md").as_deref(), Some("an edit\n"));
    assert_eq!(e.conflicts(&never()).expect("conflicts").len(), 4);
}

/// Mode and blob of a path's entry at a stage (0 for a resolved path), as `git ls-files -s`
/// lists them.
fn entry(f: &Fixture, stage: u8, path: &str) -> String {
    let tail = format!("{stage}\t");
    f.git(&["ls-files", "-s", "--", path])
        .lines()
        .find(|line| line.split(' ').nth(2).is_some_and(|s| s.starts_with(&tail)))
        .map(|line| line.split(' ').take(2).collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

#[test]
fn takes_theirs_with_its_executable_bit_where_the_file_system_has_none() {
    let mut f = Fixture::basic();
    // Git for Windows' default: no mode is read from the files, so `git add` would keep the
    // mode of the entry it replaces (stage 2 first, then 1).
    f.git(&["config", "core.filemode", "false"]);
    let list = ["gains.sh", "loses.sh", "du.sh"];
    for name in list {
        f.write(name, "base\n");
    }
    f.git(&["add", "gains.sh", "loses.sh", "du.sh"]);
    f.git(&["update-index", "--chmod=+x", "loses.sh"]);
    f.commit("base scripts");
    f.git(&["switch", "-q", "-c", "theirs"]);
    for name in list {
        f.write(name, "theirs\n");
    }
    f.git(&["add", "gains.sh", "loses.sh", "du.sh"]);
    f.git(&["update-index", "--chmod=+x", "gains.sh", "du.sh"]);
    f.git(&["update-index", "--chmod=-x", "loses.sh"]);
    f.commit("theirs scripts");
    f.git(&["switch", "-q", "main"]);
    f.write("gains.sh", "ours\n");
    f.write("loses.sh", "ours\n");
    f.remove("du.sh");
    f.commit("ours scripts");
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    let wanted: Vec<String> = list.iter().map(|path| entry(&f, 3, path)).collect();
    assert_eq!(wanted[0].split(' ').next(), Some("100755"));
    e.take_side(&paths(&list), Side::Theirs, &never())
        .expect("taken");
    let got: Vec<String> = list.iter().map(|path| entry(&f, 0, path)).collect();
    assert_eq!(got, wanted);
}

#[test]
fn takes_theirs_with_its_own_line_endings_under_autocrlf() {
    let mut f = Fixture::basic();
    // Blobs committed as written, then the merge runs as Git for Windows configures it.
    f.write("lf-to-crlf.txt", "one\ntwo\n");
    f.write("crlf-to-lf.txt", "one\r\ntwo\r\n");
    f.commit("base endings");
    f.git(&["switch", "-q", "-c", "theirs"]);
    f.write("lf-to-crlf.txt", "one theirs\r\ntwo\r\n");
    f.write("crlf-to-lf.txt", "one theirs\ntwo\n");
    f.commit("theirs endings");
    f.git(&["switch", "-q", "main"]);
    f.write("lf-to-crlf.txt", "one ours\ntwo\n");
    f.write("crlf-to-lf.txt", "one ours\r\ntwo\r\n");
    f.commit("ours endings");
    f.git(&["config", "core.autocrlf", "true"]);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    let list = ["lf-to-crlf.txt", "crlf-to-lf.txt"];
    let wanted: Vec<String> = list.iter().map(|path| entry(&f, 3, path)).collect();
    e.take_side(&paths(&list), Side::Theirs, &never())
        .expect("taken");
    let got: Vec<String> = list.iter().map(|path| entry(&f, 0, path)).collect();
    assert_eq!(
        got, wanted,
        "theirs' blobs, not their line endings turned around"
    );
}

#[test]
fn deletes_a_file_the_side_taken_never_had_and_puts_it_back() {
    // theirs renames dir to dir2 and ours adds dir/new.txt, which git places at dir2/new.txt as
    // added by us: theirs has no version of it, so taking theirs deletes it, as the dialog
    // says, and Undo brings it back.
    let mut f = Fixture::basic();
    for i in 1..=3 {
        f.write(&format!("dir/f{i}.txt"), &format!("file {i}\nline\nline\n"));
    }
    f.commit("base dir");
    f.git(&["switch", "-q", "-c", "theirs"]);
    f.git(&["mv", "dir", "dir2"]);
    f.commit("theirs renames dir");
    f.git(&["switch", "-q", "main"]);
    f.write("dir/new.txt", "new from ours\n");
    f.commit("ours adds dir/new.txt");
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    assert_eq!(
        f.git(&["diff", "--name-only", "--diff-filter=U"]),
        "dir2/new.txt"
    );
    let at_stop = stages(&f);
    e.take_side(&paths(&["dir2/new.txt"]), Side::Theirs, &never())
        .expect("taken");
    assert_eq!(read(&f, "dir2/new.txt"), None);
    e.restore_conflicts(&paths(&["dir2/new.txt"]), &never())
        .expect("put back");
    assert_eq!(stages(&f), at_stop);
    assert_eq!(read(&f, "dir2/new.txt").as_deref(), Some("new from ours\n"));
}

#[test]
fn takes_a_side_for_conflicts_outside_the_sparse_checkout() {
    let mut f = Fixture::basic();
    f.write("in/a.txt", "base\n");
    f.write("out/b.txt", "base\n");
    f.write("out/c.txt", "base\n");
    f.commit("base sparse");
    f.git(&["switch", "-q", "-c", "theirs"]);
    f.write("out/b.txt", "theirs\n");
    f.remove("out/c.txt");
    f.commit("theirs sparse");
    f.git(&["switch", "-q", "main"]);
    f.write("out/b.txt", "ours\n");
    f.write("out/c.txt", "ours c\n");
    f.commit("ours sparse");
    f.git(&["sparse-checkout", "set", "--cone", "in"]);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    e.take_side(&paths(&["out/b.txt", "out/c.txt"]), Side::Theirs, &never())
        .expect("taken");
    assert!(e.conflicts(&never()).expect("conflicts").is_empty());
    assert_eq!(f.rev(":out/b.txt"), f.rev("theirs:out/b.txt"));
}

#[test]
fn refuses_a_submodule_conflict_before_git_runs() {
    let f = Fixture::basic();
    // A submodule's commit on each side, its repository never cloned: the conflict is the
    // pointer's, and git's checkout leaves a submodule's own checkout where it is.
    let point = |hash: &str| {
        let info = format!("160000,{hash},sub");
        f.git(&["update-index", "--add", "--cacheinfo", &info]);
    };
    point(&"1".repeat(40));
    f.git(&["commit", "-q", "-m", "base sub"]);
    f.git(&["switch", "-q", "-c", "theirs"]);
    point(&"2".repeat(40));
    f.git(&["commit", "-q", "-m", "theirs sub"]);
    f.git(&["switch", "-q", "main"]);
    point(&"3".repeat(40));
    f.git(&["commit", "-q", "-m", "ours sub"]);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    let at_stop = stages(&f);
    assert_eq!(at_stop, vec![("sub".to_owned(), vec![1, 2, 3])]);
    for side in [Side::Ours, Side::Theirs] {
        let error = e
            .take_side(&paths(&["sub"]), side, &never())
            .expect_err("refused");
        assert!(
            matches!(&error, GitError::SubmoduleConflict(path) if path == "sub"),
            "{error:?}"
        );
        assert_eq!(error.code(), "conflict.submodule");
    }
    assert_eq!(stages(&f), at_stop);
}

// -------------------------------------------------------------------------- the way back

#[test]
fn puts_each_kind_back_as_git_left_it_at_the_stop() {
    let mut f = Fixture::basic();
    four_kinds(&mut f);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    let at_stop = stages(&f);
    let files_at_stop: Vec<Option<String>> = FOUR.iter().map(|path| read(&f, path)).collect();
    e.take_side(&paths(&FOUR), Side::Theirs, &never())
        .expect("taken");
    e.restore_conflicts(&paths(&FOUR), &never())
        .expect("put back");
    assert_eq!(stages(&f), at_stop);
    assert_eq!(e.conflicts(&never()).expect("conflicts").len(), 4);
    // Both sides: the markers again (git's checkout -m labels them ours and theirs).
    for path in ["a.txt", "c.txt"] {
        let text = read(&f, path).expect("written");
        assert!(
            text.contains("<<<<<<<") && text.contains(">>>>>>>"),
            "{path}: {text}"
        );
        assert!(
            text.contains(&format!("{} ours", &path[..1])),
            "{path}: {text}"
        );
        assert!(
            text.contains(&format!("{} theirs", &path[..1])),
            "{path}: {text}"
        );
    }
    // One side: its version, as git left it in the tree when it stopped.
    assert_eq!(read(&f, "b.txt"), files_at_stop[1]);
    assert_eq!(read(&f, "d.txt"), files_at_stop[3]);
    assert_eq!(read(&f, "b.txt").as_deref(), Some("b theirs\n"));
    assert_eq!(read(&f, "d.txt").as_deref(), Some("d ours\n"));
}

#[test]
fn takes_a_rename_to_two_names_from_each_side_and_puts_it_back() {
    for (side, kept, gone) in [
        (Side::Ours, "e-ours.txt", "e-theirs.txt"),
        (Side::Theirs, "e-theirs.txt", "e-ours.txt"),
    ] {
        let mut f = Fixture::basic();
        renamed_apart(&mut f);
        let e = engine(&f);
        e.merge("theirs", MergeMode::Default, false, &never())
            .expect("stops");
        let at_stop = stages(&f);
        assert_eq!(
            at_stop,
            vec![
                ("e-ours.txt".to_owned(), vec![2]),
                ("e-theirs.txt".to_owned(), vec![3]),
                ("e.txt".to_owned(), vec![1]),
            ]
        );
        let files_at_stop: Vec<Option<String>> =
            RENAMED.iter().map(|path| read(&f, path)).collect();
        e.take_side(&paths(&RENAMED), side, &never())
            .expect("taken");
        assert!(
            e.conflicts(&never()).expect("conflicts").is_empty(),
            "{side:?}"
        );
        assert_eq!(
            read(&f, kept).as_deref(),
            Some("line one\nline two\nline three\nline four\n"),
            "{side:?}"
        );
        assert_eq!(read(&f, gone), None, "{side:?}");
        assert_eq!(read(&f, "e.txt"), None, "{side:?}");
        assert_eq!(f.git(&["ls-files", "--", kept]), kept, "{side:?}");
        assert!(
            f.git(&["ls-files", "--", gone, "e.txt"]).is_empty(),
            "{side:?}"
        );
        // Back to the stop: the three stages, both names in the tree, `e.txt` in neither.
        e.restore_conflicts(&paths(&RENAMED), &never())
            .expect("put back");
        assert_eq!(stages(&f), at_stop, "{side:?}");
        let files: Vec<Option<String>> = RENAMED.iter().map(|path| read(&f, path)).collect();
        assert_eq!(files, files_at_stop, "{side:?}");
    }
}

#[test]
fn leaves_a_path_still_conflicted_as_it_is() {
    let mut f = Fixture::basic();
    four_kinds(&mut f);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    // A conflict half resolved by hand: nothing to bring back, and the edit stays.
    f.write("a.txt", "a by hand\n");
    e.restore_conflicts(&paths(&["a.txt"]), &never())
        .expect("nothing to do");
    assert_eq!(read(&f, "a.txt").as_deref(), Some("a by hand\n"));
    assert_eq!(e.conflicts(&never()).expect("conflicts").len(), 4);
}

#[test]
fn puts_back_only_the_paths_it_is_given() {
    let mut f = Fixture::basic();
    // git reads every argument after `--unresolve` as a path, so a `--` before the paths
    // would put back a resolved file of that name too.
    let names = ["a.txt", "--"];
    for (round, text) in [
        ("base", "base\n"),
        ("theirs", "theirs\n"),
        ("ours", "ours\n"),
    ] {
        if round == "theirs" {
            f.git(&["switch", "-q", "-c", "theirs"]);
        }
        if round == "ours" {
            f.git(&["switch", "-q", "main"]);
        }
        for name in names {
            f.write(name, text);
        }
        f.commit(round);
    }
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    e.take_side(&paths(&names), Side::Theirs, &never())
        .expect("taken");
    e.restore_conflicts(&paths(&["a.txt"]), &never())
        .expect("put back");
    let conflicted: Vec<String> = e
        .conflicts(&never())
        .expect("conflicts")
        .into_iter()
        .map(|conflict| conflict.path)
        .collect();
    assert_eq!(conflicted, ["a.txt"]);
    assert_eq!(read(&f, "--").as_deref(), Some("theirs\n"));
}

#[test]
fn puts_back_more_paths_than_one_command_line_holds() {
    let mut f = Fixture::basic();
    // 300 names of 58 bytes: two runs of `git update-index --unresolve`.
    let names: Vec<String> = (0..300)
        .map(|i| format!("many/a-rather-long-file-name-for-the-command-line-{i:03}.txt"))
        .collect();
    for (round, text) in [
        ("base", "base\n"),
        ("theirs", "theirs\n"),
        ("ours", "ours\n"),
    ] {
        if round == "theirs" {
            f.git(&["switch", "-q", "-c", "theirs"]);
        }
        if round == "ours" {
            f.git(&["switch", "-q", "main"]);
        }
        for name in &names {
            f.write(name, text);
        }
        f.commit(round);
    }
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    e.take_side(&names, Side::Theirs, &never()).expect("taken");
    assert!(e.conflicts(&never()).expect("conflicts").is_empty());
    e.restore_conflicts(&names, &never()).expect("put back");
    assert_eq!(e.conflicts(&never()).expect("conflicts").len(), 300);
    for name in [&names[0], &names[299]] {
        assert!(
            read(&f, name).expect("written").contains("<<<<<<<"),
            "{name}"
        );
    }
}

/// `held/a.txt` modified by both, `d.txt` deleted by them.
#[cfg(windows)]
fn held_and_deleted(f: &mut Fixture) {
    f.write("held/a.txt", "a\n");
    f.write("d.txt", "d\n");
    f.commit("base held");
    f.git(&["switch", "-q", "-c", "theirs"]);
    f.write("held/a.txt", "a theirs\n");
    f.remove("d.txt");
    f.commit("theirs held");
    f.git(&["switch", "-q", "main"]);
    f.write("held/a.txt", "a ours\n");
    f.write("d.txt", "d ours\n");
    f.commit("ours held");
}

/// A file git cannot replace while another program holds it open without sharing (Windows
/// only: elsewhere a test running as root writes through a read-only folder).
#[cfg(windows)]
#[test]
fn writes_every_file_it_brought_back_when_git_cannot_write_one() {
    use std::os::windows::fs::OpenOptionsExt;
    let mut f = Fixture::basic();
    held_and_deleted(&mut f);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    let both = paths(&["held/a.txt", "d.txt"]);
    e.take_side(&both, Side::Theirs, &never()).expect("taken");
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(f.root.join("held/a.txt"))
        .expect("hold the file");
    let error = e
        .restore_conflicts(&both, &never())
        .expect_err("git cannot replace the held file");
    drop(held);
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    // The other file is back as git left it at the stop, and both are conflicted again.
    assert_eq!(read(&f, "d.txt").as_deref(), Some("d ours\n"));
    assert_eq!(e.conflicts(&never()).expect("conflicts").len(), 2);
}

#[test]
fn names_a_conflict_git_no_longer_holds_after_putting_back_the_others() {
    let mut f = Fixture::basic();
    four_kinds(&mut f);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    e.take_side(&paths(&["a.txt"]), Side::Ours, &never())
        .expect("taken");
    // README.md was never conflicted: git keeps no sides for it.
    let error = e
        .restore_conflicts(&paths(&["a.txt", "README.md"]), &never())
        .expect_err("refused");
    assert!(
        matches!(&error, GitError::ConflictGone(path) if path == "README.md"),
        "{error:?}"
    );
    assert_eq!(error.code(), "conflict.gone");
    // a.txt is back, with its markers.
    assert!(stages(&f).iter().any(|(path, _)| path == "a.txt"));
    assert!(read(&f, "a.txt").expect("written").contains("<<<<<<<"));
}

#[test]
fn reports_gits_refusal_to_bring_back_with_its_words() {
    let mut f = Fixture::basic();
    four_kinds(&mut f);
    let e = engine(&f);
    e.merge("theirs", MergeMode::Default, false, &never())
        .expect("stops");
    e.take_side(&paths(&["a.txt"]), Side::Ours, &never())
        .expect("taken");
    let error = e
        .restore_conflicts(&paths(&["a.txt", "../outside.txt"]), &never())
        .expect_err("refused");
    match &error {
        GitError::Cli { stderr, .. } => assert!(stderr.contains("outside"), "{stderr}"),
        other => panic!("not git's refusal: {other:?}"),
    }
}

#[test]
fn refuses_to_bring_back_a_conflict_whose_stop_continued_to_an_exec() {
    let mut f = Fixture::basic();
    f.write("f.txt", "l1\nl2\n");
    f.commit("base f");
    f.git(&["switch", "-q", "-c", "feature"]);
    f.write("f.txt", "l1 feature\nl2\n");
    f.commit("feature f");
    f.write("g.txt", "g\n");
    f.commit("feature g");
    f.git(&["switch", "-q", "main"]);
    f.write("f.txt", "l1 main\nl2\n");
    f.commit("main f");
    f.git(&["switch", "-q", "feature"]);
    // An exec after each pick; the first pick stops on f.txt.
    let (done, _, _) = f.try_git(&["rebase", "-x", "false", "main"]);
    assert!(!done);
    let e = engine(&f);
    e.take_side(&paths(&["f.txt"]), Side::Theirs, &never())
        .expect("taken");
    // The pick is committed, then the exec fails: a stop with no merge, which keeps the record.
    let _ = e.sequencer(SequencerAction::Continue, &never());
    let head = f.head();
    assert_ne!(
        f.git(&["ls-files", "--resolve-undo"]),
        "",
        "git kept the record"
    );
    let error = e
        .restore_conflicts(&paths(&["f.txt"]), &never())
        .expect_err("the stop that held the conflict has ended");
    assert!(
        matches!(&error, GitError::ConflictGone(path) if path == "f.txt"),
        "{error:?}"
    );
    assert_eq!(f.head(), head);
    assert_eq!(f.git(&["ls-files", "-u"]), "");
}

#[test]
fn a_committed_resolution_cannot_be_put_back() {
    let mut f = Fixture::basic();
    conflicting(&mut f);
    let e = engine(&f);
    e.merge("other", MergeMode::Default, false, &never())
        .expect("stops");
    e.take_side(&paths(&["README.md"]), Side::Theirs, &never())
        .expect("taken");
    e.sequencer(SequencerAction::Continue, &never())
        .expect("committed");
    let head = f.head();
    let error = e
        .restore_conflicts(&paths(&["README.md"]), &never())
        .expect_err("refused");
    assert!(matches!(error, GitError::ConflictGone(_)), "{error:?}");
    assert_eq!(f.head(), head);
    assert_eq!(read(&f, "README.md").as_deref(), Some("# Other\n"));
    assert_eq!(f.git(&["status", "--porcelain"]), "");
}
