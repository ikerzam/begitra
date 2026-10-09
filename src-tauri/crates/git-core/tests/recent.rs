//! `GitEngine::recent_branches` against git's own `@{-N}` on fixture repositories.

mod support;

use git_core::engine::GitEngine;
use git_core::git2_engine::Git2Engine;
use support::Fixture;

fn recent(root: &std::path::Path, limit: usize) -> Vec<String> {
    Git2Engine::open(root)
        .expect("open")
        .recent_branches(limit)
        .expect("recent branches")
}

/// The branch `@{-n}` names, as git resolves it in `cwd`.
fn previous(f: &Fixture, cwd: &std::path::Path, n: usize) -> String {
    let spec = format!("@{{-{n}}}");
    f.git_in(cwd, &["rev-parse", "--symbolic-full-name", &spec])
        .trim_start_matches("refs/heads/")
        .to_owned()
}

/// Appends `lines` to the reflog at `path`, as git would have written them.
fn append(path: &std::path::Path, lines: &str) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .expect("open the reflog");
    file.write_all(lines.as_bytes())
        .expect("append to the reflog");
}

/// A reflog line moving HEAD from `from` to `to` at `time`, at the commit `head`.
fn switch_line(head: &str, time: u64, from: &str, to: &str) -> String {
    format!("{head} {head} A U Thor <author@example.com> {time} +0000\tcheckout: moving from {from} to {to}\n")
}

/// A history of one commit with the branches `names`, HEAD on `main`.
fn with_branches(names: &[&str]) -> Fixture {
    let mut f = Fixture::empty();
    f.write("a.txt", "a\n");
    f.commit("first");
    for name in names {
        f.git(&["branch", name]);
    }
    f
}

#[test]
fn back_and_forth_counts_as_git_switch_dash_does() {
    let f = with_branches(&["a", "b", "c"]);
    for to in ["a", "b", "a", "c"] {
        f.git(&["switch", "-q", to]);
    }
    let names = recent(&f.root, 5);
    assert_eq!(names, ["a", "b", "main"]);
    // The previous branches git resolves, in order, with the repeat of `a` folded.
    assert_eq!(previous(&f, &f.root, 1), "a");
    assert_eq!(previous(&f, &f.root, 2), "b");
    assert_eq!(previous(&f, &f.root, 4), "main");
    assert_eq!(recent(&f.root, 2), ["a", "b"]);
}

#[test]
fn a_deleted_branch_and_a_detached_head_left_are_not_listed() {
    let f = with_branches(&["a", "b", "c"]);
    f.git(&["switch", "-q", "a"]);
    f.git(&["switch", "-q", "b"]);
    f.git(&["switch", "-q", "--detach", "HEAD"]);
    f.git(&["switch", "-q", "c"]);
    f.git(&["branch", "-D", "b"]);
    // `git checkout -b` and `git checkout` write the same entry as `git switch`.
    f.git(&["checkout", "-q", "-b", "d"]);
    assert_eq!(recent(&f.root, 5), ["c", "a", "main"]);
}

#[test]
fn the_current_branch_and_other_entries_are_left_out() {
    let mut f = with_branches(&["a"]);
    f.git(&["switch", "-q", "a"]);
    f.write("a.txt", "b\n");
    f.commit("on a");
    f.git(&["reset", "-q", "--soft", "HEAD~1"]);
    f.git(&["switch", "-q", "main"]);
    f.git(&["switch", "-q", "a"]);
    // HEAD is on `a`: what it left last is `main`, and `a` itself is not listed.
    assert_eq!(recent(&f.root, 5), ["main"]);
}

#[test]
fn a_linked_worktree_reads_its_own_head() {
    let f = with_branches(&["x", "w2"]).with_linked_worktree();
    let linked = f.worktree_path();
    f.git(&["switch", "-q", "x"]);
    f.git(&["switch", "-q", "main"]);
    f.git_in(&linked, &["switch", "-q", "w2"]);
    f.git_in(&linked, &["switch", "-q", "feature/wt"]);
    assert_eq!(recent(&f.root, 5), ["x"]);
    assert_eq!(recent(&linked, 5), ["w2"]);
    assert_eq!(previous(&f, &linked, 1), "w2");
}

#[test]
fn no_switch_and_no_reflog_list_nothing_and_write_nothing() {
    let f = with_branches(&["a"]);
    assert!(recent(&f.root, 5).is_empty(), "commits only");
    f.git(&["switch", "-q", "a"]);
    let reflog = f.git_dir().join("logs").join("HEAD");
    std::fs::remove_file(&reflog).expect("remove the reflog");
    assert!(recent(&f.root, 5).is_empty(), "no reflog");
    // libgit2 creates a missing reflog when asked to read it, and git then appends to it.
    assert!(!reflog.exists(), "the read created HEAD's reflog");
    let unborn = Fixture::unborn();
    assert!(recent(&unborn.root, 5).is_empty(), "unborn");
    let unborn_reflog = unborn.git_dir().join("logs").join("HEAD");
    assert!(
        !unborn_reflog.exists(),
        "the read created the unborn HEAD's reflog"
    );
}

#[test]
fn reads_the_name_as_git_does_whatever_the_messages_hold() {
    let mut f = with_branches(&["a", "b"]);
    f.git(&["switch", "-q", "a"]);
    // A commit whose subject reads like a switch writes `commit: checkout: moving from b to a`.
    f.write("a.txt", "c\n");
    f.commit("checkout: moving from b to a");
    // A target holding " to ": git writes it as it was given.
    f.write("a.txt", "d\n");
    f.commit("fix to x");
    f.git(&["switch", "-q", "--detach", ":/fix to x"]);
    f.git(&["switch", "-q", "main"]);
    // HEAD left a detached commit (a hash), and before it `a` for ":/fix to x".
    assert_eq!(recent(&f.root, 5), ["a"]);
    assert_eq!(previous(&f, &f.root, 2), "a");
}

#[test]
fn an_entry_whose_time_is_zero_is_skipped_as_git_skips_it() {
    let f = with_branches(&["a", "b"]);
    f.git(&["switch", "-q", "a"]);
    f.git(&["switch", "-q", "main"]);
    let head = f.git(&["rev-parse", "HEAD"]);
    let reflog = f.git_dir().join("logs").join("HEAD");
    append(&reflog, &switch_line(&head, 0, "b", "main"));
    assert_eq!(previous(&f, &f.root, 1), "a");
    assert_eq!(recent(&f.root, 5), ["a"]);
}

#[test]
fn a_last_line_cut_short_is_skipped_as_git_skips_it() {
    let f = with_branches(&["a", "b"]);
    for to in ["a", "b", "main"] {
        f.git(&["switch", "-q", to]);
    }
    let head = f.git(&["rev-parse", "HEAD"]);
    let reflog = f.git_dir().join("logs").join("HEAD");
    // A crash or a full disk while git appended: the line has no line feed.
    let cut = switch_line(&head, 1_700_000_000, "a", "main");
    append(&reflog, cut.trim_end_matches('\n'));
    assert_eq!(previous(&f, &f.root, 1), "b");
    assert_eq!(recent(&f.root, 5), ["b", "a"]);
}

#[test]
fn a_branch_another_worktree_holds_is_listed_as_git_names_it() {
    let f = with_branches(&["a", "c"]);
    let other = f.sibling("other");
    let other_path = other.to_string_lossy().into_owned();
    f.git(&["worktree", "add", "-q", &other_path, "a"]);
    f.git(&["switch", "-q", "c"]);
    f.git(&["switch", "-q", "main"]);
    f.git_in(&other, &["switch", "-q", "c"]);
    // `git switch -` refuses it; the checkout offers that worktree instead.
    assert_eq!(previous(&f, &f.root, 1), "c");
    assert_eq!(recent(&f.root, 5), ["c"]);
}

#[test]
fn a_linked_worktree_without_a_reflog_gets_none_written() {
    let f = with_branches(&["x"]).with_linked_worktree();
    let linked = f.worktree_path();
    let git_dir = f.git_in(&linked, &["rev-parse", "--absolute-git-dir"]);
    let reflog = std::path::Path::new(&git_dir).join("logs").join("HEAD");
    std::fs::remove_file(&reflog).expect("remove the linked worktree's reflog");
    assert!(recent(&linked, 5).is_empty());
    assert!(
        !reflog.exists(),
        "the read created the linked worktree's reflog"
    );
}

#[test]
fn a_rebase_that_checks_a_branch_out_counts_no_more_than_for_git() {
    let mut f = with_branches(&["a", "b"]);
    f.git(&["switch", "-q", "a"]);
    f.git(&["switch", "-q", "main"]);
    f.write("a.txt", "m\n");
    f.commit("on main");
    // `git rebase main b` ends on `b` with "rebase (finish): returning to refs/heads/b".
    f.git(&["rebase", "-q", "main", "b"]);
    assert_eq!(previous(&f, &f.root, 1), "a");
    assert_eq!(recent(&f.root, 5), ["a", "main"]);
}

#[test]
fn reads_the_newest_five_hundred_switches() {
    let f = with_branches(&["old"]);
    f.git(&["switch", "-q", "old"]);
    f.git(&["switch", "-q", "main"]);
    let head = f.git(&["rev-parse", "HEAD"]);
    let reflog = f.git_dir().join("logs").join("HEAD");
    // Detached checkouts after the switch from `old`, as a long run of them writes.
    let detached = switch_line(&head, 1_700_000_000, &head, "main");
    append(&reflog, &detached.repeat(499));
    assert_eq!(recent(&f.root, 5), ["old"], "the five hundredth switch");
    append(&reflog, &detached);
    assert!(
        recent(&f.root, 5).is_empty(),
        "beyond the five hundredth switch"
    );
}
