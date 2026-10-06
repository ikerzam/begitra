//! The branches that can go against the main branch, and their deletion with their worktrees,
//! against the git CLI on fixture repositories.

mod support;

use std::path::{Path, PathBuf};

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{BranchToDelete, CleanupCandidate, CleanupReason, KeptReason};
use support::Fixture;

use CleanupReason::{Gone, GoneApplied, Merged, NoCommits};

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn never() -> Cancel {
    Cancel::never()
}

/// A bare `origin` beside the repository, `main` pushed and tracked, `origin/HEAD` on it.
fn with_origin(f: &mut Fixture) {
    let origin = f.sibling("origin.git");
    let origin = origin.to_string_lossy().into_owned();
    f.git(&["init", "-q", "--bare", &origin]);
    f.git(&["remote", "add", "origin", &origin]);
    f.git(&["push", "-q", "-u", "origin", "main"]);
    f.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
}

/// A branch from `main` with one commit of its own writing `file`; answers its tip.
fn branch(f: &mut Fixture, name: &str, file: &str) -> String {
    f.git(&["switch", "-q", "-c", name, "main"]);
    f.write(file, &format!("{name}\n"));
    let tip = f.commit(&format!("{name} work"));
    f.git(&["switch", "-q", "main"]);
    tip
}

/// Pushed with its upstream set, then deleted on the remote: `[gone]` in `git branch -vv`.
fn gone(f: &Fixture, name: &str) {
    f.git(&["push", "-q", "-u", "origin", name]);
    f.git(&["push", "-q", "origin", "--delete", name]);
}

fn reasons(candidates: &[CleanupCandidate]) -> Vec<(String, CleanupReason)> {
    candidates
        .iter()
        .map(|candidate| (candidate.name.clone(), candidate.reason))
        .collect()
}

fn listed(name: &str, reason: CleanupReason) -> (String, CleanupReason) {
    (name.to_owned(), reason)
}

fn names(candidates: &[CleanupCandidate]) -> Vec<&str> {
    candidates
        .iter()
        .map(|candidate| candidate.name.as_str())
        .collect()
}

fn candidate<'a>(candidates: &'a [CleanupCandidate], name: &str) -> Option<&'a CleanupCandidate> {
    candidates.iter().find(|candidate| candidate.name == name)
}

/// `git worktree add` of a new folder beside the repository on `branch`; answers the path the
/// engine lists for it, which the app passes back.
fn worktree(f: &Fixture, folder: &str, branch: &str) -> PathBuf {
    let path = f.sibling(folder);
    let text = path.to_string_lossy().into_owned();
    f.git(&["worktree", "add", "-q", &text, branch]);
    engine(f)
        .worktrees(&never())
        .expect("worktrees")
        .into_iter()
        .find(|listed| listed.branch.as_deref() == Some(branch))
        .expect("listed")
        .path
}

fn to_delete(f: &Fixture, name: &str, worktree: Option<&Path>) -> BranchToDelete {
    BranchToDelete {
        name: name.to_owned(),
        tip: f.rev(name),
        worktree: worktree.map(Path::to_path_buf),
    }
}

fn branch_exists(f: &Fixture, name: &str) -> bool {
    f.try_git(&["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")])
        .0
}

/// The loose objects of the repository's object database.
fn loose_objects(f: &Fixture) -> usize {
    let objects = f.git_dir().join("objects");
    std::fs::read_dir(&objects)
        .expect("objects")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().len() == 2)
        .map(|entry| {
            std::fs::read_dir(entry.path())
                .map(|files| files.count())
                .unwrap_or(0)
        })
        .sum()
}

// ---------------------------------------------------------------------------- candidates

#[test]
fn lists_merged_squashed_and_gone_branches_against_main() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    branch(&mut f, "a", "a.txt");
    f.git(&["merge", "-q", "--no-ff", "-m", "merge a", "a"]);
    // b: squash-merged by its pull request, then deleted on the remote.
    branch(&mut f, "b", "b.txt");
    gone(&f, "b");
    f.git(&["merge", "-q", "--squash", "b"]);
    f.commit("squash b");
    // c: deleted on the remote, never merged.
    branch(&mut f, "c", "c.txt");
    gone(&f, "c");
    // d: neither, its upstream there.
    branch(&mut f, "d", "d.txt");
    f.git(&["push", "-q", "-u", "origin", "d"]);
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(found.main.as_deref(), Some("main"));
    assert_eq!(
        reasons(&found.candidates),
        [
            listed("a", Merged),
            listed("b", GoneApplied),
            listed("c", Gone),
            listed("develop", Merged),
        ]
    );
    let c = &found.candidates[2];
    assert_eq!(c.tip, f.rev("c"));
    assert_eq!(c.remote.as_deref(), Some("origin"));
    assert_eq!(c.worktree, None);
    // As git itself says.
    let merged = f.git(&["branch", "--merged", "main", "--format=%(refname:short)"]);
    assert!(merged.lines().any(|line| line == "a"), "{merged}");
    let tracking = f.git(&["branch", "-vv"]);
    assert!(
        tracking
            .lines()
            .any(|line| line.contains(" c ") && line.contains(": gone]")),
        "{tracking}"
    );
}

#[test]
fn a_branch_merged_on_the_remote_only_is_merged() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    // A pull request merged on the remote while the local main stays behind.
    branch(&mut f, "e", "e.txt");
    f.git(&["switch", "-q", "-c", "remote-main", "main"]);
    f.git(&["merge", "-q", "--no-ff", "-m", "merge e", "e"]);
    f.git(&["push", "-q", "origin", "remote-main:main"]);
    f.git(&["switch", "-q", "main"]);
    f.git(&["branch", "-q", "-D", "remote-main"]);
    f.git(&["fetch", "-q", "origin"]);
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert!(
        reasons(&found.candidates).contains(&listed("e", Merged)),
        "{:?}",
        found.candidates
    );
}

/// The pull-request flow: the branch is squash-merged on the remote and deleted there, and the
/// dialog's "Fetch and prune" leaves the local `main` behind `origin/main`.
#[test]
fn a_gone_branch_squash_merged_on_the_remote_while_main_is_behind_is_applied() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    branch(&mut f, "feat", "feat.txt");
    f.git(&["push", "-q", "-u", "origin", "feat"]);
    let origin = f.sibling("origin.git").to_string_lossy().into_owned();
    let other = f.sibling("other");
    f.git(&[
        "clone",
        "-q",
        "-b",
        "main",
        &origin,
        &other.to_string_lossy(),
    ]);
    f.git_in(&other, &["merge", "-q", "--squash", "origin/feat"]);
    f.git_in(&other, &["commit", "-q", "-m", "feat (#1)"]);
    f.git_in(&other, &["push", "-q", "origin", "main"]);
    f.git_in(&other, &["push", "-q", "origin", "--delete", "feat"]);
    f.git(&["fetch", "-q", "--prune", "origin"]);
    // As git says: feat is gone, and merging it into origin/main changes nothing.
    assert!(f.git(&["branch", "-vv"]).contains("[origin/feat: gone]"));
    let merged = f.git(&["merge-tree", "--write-tree", "origin/main", "feat"]);
    assert_eq!(
        merged.lines().next(),
        Some(f.rev("origin/main^{tree}").as_str())
    );
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(
        candidate(&found.candidates, "feat").map(|c| c.reason),
        Some(GoneApplied),
        "{:?}",
        found.candidates
    );
}

/// The merge check answers each gone branch for itself, whatever their order.
#[test]
fn each_gone_branch_gets_its_own_answer() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    branch(&mut f, "a-unmerged", "a.txt");
    gone(&f, "a-unmerged");
    branch(&mut f, "m-unmerged", "m.txt");
    gone(&f, "m-unmerged");
    branch(&mut f, "z-squashed", "z.txt");
    gone(&f, "z-squashed");
    f.git(&["merge", "-q", "--squash", "z-squashed"]);
    f.commit("squash z");
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(
        reasons(&found.candidates),
        [
            listed("a-unmerged", Gone),
            listed("develop", Merged),
            listed("m-unmerged", Gone),
            listed("z-squashed", GoneApplied),
        ]
    );
}

#[test]
fn a_gone_branch_that_merges_with_conflicts_is_not_in_main() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    // g changes the readme, main changes it another way: merging g would conflict.
    branch(&mut f, "g", "README.md");
    gone(&f, "g");
    f.write("README.md", "# Main's own\n");
    f.commit("main readme");
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert!(reasons(&found.candidates).contains(&listed("g", Gone)));
}

/// `CHANGELOG.md merge=keepours` with `merge.keepours.driver = true`, a common way to keep one
/// side of a file in merges: the merge drops the branch's change, which main does not have.
#[test]
fn a_merge_driver_that_drops_the_branchs_change_does_not_make_it_applied() {
    let mut f = Fixture::basic();
    f.write(".gitattributes", "CHANGELOG.md merge=keepours\n");
    f.write("CHANGELOG.md", "v1\n");
    f.commit("changelog");
    with_origin(&mut f);
    f.git(&["config", "merge.keepours.driver", "true"]);
    f.git(&["switch", "-q", "-c", "notes", "main"]);
    f.write("CHANGELOG.md", "v1\nagent note nobody merged\n");
    f.commit("note");
    f.git(&["switch", "-q", "main"]);
    gone(&f, "notes");
    f.write("CHANGELOG.md", "v1\nv2 released\n");
    f.commit("v2");
    assert!(f
        .git(&["diff", "main", "notes"])
        .contains("+agent note nobody merged"));
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(
        candidate(&found.candidates, "notes").map(|c| c.reason),
        Some(Gone),
        "{:?}",
        found.candidates
    );
}

#[test]
fn the_listing_writes_no_object_to_the_repository() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    // One gone branch whose merge is main's own tree, one whose merge conflicts.
    branch(&mut f, "b", "b.txt");
    gone(&f, "b");
    f.git(&["merge", "-q", "--squash", "b"]);
    f.commit("squash b");
    branch(&mut f, "g", "README.md");
    gone(&f, "g");
    f.write("README.md", "# Main's own\n");
    f.commit("main readme");
    let before = loose_objects(&f);
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(
        reasons(&found.candidates),
        [
            listed("b", GoneApplied),
            listed("develop", Merged),
            listed("g", Gone)
        ]
    );
    assert_eq!(loose_objects(&f), before);
}

#[test]
fn names_the_main_branch_as_origin_head_main_or_master_and_never_guesses() {
    // origin/HEAD names develop, which exists locally.
    let mut f = Fixture::basic();
    with_origin(&mut f);
    f.git(&["push", "-q", "origin", "develop"]);
    f.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/develop",
    ]);
    assert_eq!(
        engine(&f)
            .cleanup_candidates(&never())
            .expect("candidates")
            .main
            .as_deref(),
        Some("develop")
    );
    // master, without main or origin/HEAD.
    let f = Fixture::basic();
    f.git(&["branch", "-q", "-m", "main", "master"]);
    assert_eq!(
        engine(&f)
            .cleanup_candidates(&never())
            .expect("candidates")
            .main
            .as_deref(),
        Some("master")
    );
    // A main line by another name is not guessed from what is checked out: with `trunk` and a
    // feature made from it checked out, git's --merged says trunk is in the feature, and
    // taking the feature for the main line would offer trunk for deletion.
    let mut f = Fixture::basic();
    f.git(&["branch", "-q", "-m", "main", "trunk"]);
    f.git(&["switch", "-q", "-c", "feature", "trunk"]);
    f.write("feature.txt", "feature\n");
    f.commit("feature work");
    let merged = f.git(&["branch", "--merged", "feature", "--format=%(refname:short)"]);
    assert!(merged.lines().any(|line| line == "trunk"), "{merged}");
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(found.main, None);
    assert!(found.candidates.is_empty(), "{:?}", found.candidates);
}

#[test]
fn a_symbolic_branch_is_neither_the_main_branch_nor_a_candidate() {
    let f = Fixture::basic();
    f.git(&["branch", "-q", "-m", "main", "master"]);
    f.git(&["symbolic-ref", "refs/heads/main", "refs/heads/master"]);
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(found.main.as_deref(), Some("master"));
    assert_eq!(names(&found.candidates), ["develop"]);
}

/// `branch.main.remote = .`: main tracks a local branch, which holds commits main lacks.
#[test]
fn the_main_branchs_local_upstream_is_not_merged_into_main() {
    let mut f = Fixture::basic();
    branch(&mut f, "integration", "integration.txt");
    f.git(&["switch", "-q", "-c", "wip", "integration"]);
    f.write("wip.txt", "wip\n");
    f.commit("wip work");
    f.git(&["switch", "-q", "integration"]);
    f.git(&["merge", "-q", "--no-ff", "-m", "merge wip", "wip"]);
    f.git(&["switch", "-q", "main"]);
    f.git(&["branch", "-q", "--set-upstream-to=integration", "main"]);
    // git: neither is merged into main, and main lacks their commits.
    let merged = f.git(&["branch", "--merged", "main", "--format=%(refname:short)"]);
    assert!(!merged
        .lines()
        .any(|line| line == "integration" || line == "wip"));
    assert!(!f.git(&["log", "--oneline", "main..integration"]).is_empty());
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    let listed = names(&found.candidates);
    assert!(
        !listed.contains(&"integration") && !listed.contains(&"wip"),
        "{:?}",
        found.candidates
    );
}

/// A stacked branch tracking a local branch (`branch.<n>.remote = .`) whose base was deleted:
/// `[base: gone]`, with no remote involved.
#[test]
fn a_branch_whose_local_upstream_was_deleted_names_no_remote() {
    let mut f = Fixture::basic();
    branch(&mut f, "base", "base.txt");
    f.git(&["switch", "-q", "-c", "stacked", "--track", "base"]);
    f.write("stacked.txt", "stacked\n");
    f.commit("stacked work");
    f.git(&["switch", "-q", "main"]);
    f.git(&["branch", "-q", "-D", "base"]);
    assert!(f.git(&["branch", "-vv"]).contains("[base: gone]"));
    assert_eq!(f.git(&["config", "branch.stacked.remote"]), ".");
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    let stacked = candidate(&found.candidates, "stacked").expect("listed");
    assert_eq!(stacked.reason, Gone);
    assert_eq!(stacked.remote, None, "a dot names no remote");
}

#[test]
fn a_branch_with_no_commits_of_its_own_is_listed_apart() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    // At main's tip: an agent's new worktree before its first commit.
    f.git(&["branch", "fresh", "main"]);
    // Made from an older main and never moved since.
    f.git(&["branch", "older", "main~1"]);
    // Made from an older main, then given a commit that main merged.
    branch(&mut f, "worked", "worked.txt");
    f.git(&["merge", "-q", "--no-ff", "-m", "merge worked", "worked"]);
    // Tracking a remote branch at an older main than `origin/main`: its commits came from
    // elsewhere.
    f.git(&["push", "-q", "origin", "main~2:refs/heads/shared"]);
    // Tracking a remote branch at main's own tip: nothing of its own, whatever its reflog.
    f.git(&["push", "-q", "origin", "main:refs/heads/at-tip"]);
    f.git(&["fetch", "-q", "origin"]);
    f.git(&["branch", "-q", "--track", "shared", "origin/shared"]);
    f.git(&["branch", "-q", "--track", "at-tip", "origin/at-tip"]);
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(
        reasons(&found.candidates),
        [
            listed("at-tip", NoCommits),
            listed("develop", Merged),
            listed("fresh", NoCommits),
            listed("older", NoCommits),
            listed("shared", Merged),
            listed("worked", Merged),
        ]
    );
}

#[test]
fn never_lists_the_current_branch_or_a_missing_worktrees_branch_and_names_a_worktree() {
    let f = Fixture::basic();
    // Merged branches: one checked out here, one in a linked worktree, one in a worktree whose
    // folder is gone, one in a locked worktree whose folder is gone.
    for name in ["here", "linked", "lost", "lost-locked"] {
        f.git(&["branch", name, "main"]);
    }
    f.git(&["switch", "-q", "here"]);
    let linked = worktree(&f, "wt-linked", "linked");
    let lost = worktree(&f, "wt-lost", "lost");
    std::fs::remove_dir_all(&lost).expect("remove the folder");
    let lost_locked = worktree(&f, "wt-lost-locked", "lost-locked");
    f.git(&["worktree", "lock", &lost_locked.to_string_lossy()]);
    std::fs::remove_dir_all(&lost_locked).expect("remove the folder");
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(
        names(&found.candidates),
        ["develop", "linked"],
        "{:?}",
        found.candidates
    );
    assert_eq!(
        found.candidates[1].worktree.as_deref(),
        Some(linked.as_path())
    );
}

/// The app opens a linked worktree as the context: the main worktree's branch, merged into main,
/// stays out, as git refuses to delete a branch a worktree has checked out.
#[test]
fn never_lists_the_main_worktrees_branch_from_a_linked_worktree() {
    let f = Fixture::basic();
    f.git(&["branch", "release", "main~1"]);
    f.git(&["branch", "side", "main"]);
    let linked = worktree(&f, "wt-side", "side");
    f.git(&["switch", "-q", "release"]);
    let found = Git2Engine::open(&linked)
        .expect("open the linked worktree")
        .cleanup_candidates(&never())
        .expect("candidates");
    assert_eq!(found.main.as_deref(), Some("main"));
    assert_eq!(
        names(&found.candidates),
        ["develop"],
        "{:?}",
        found.candidates
    );
}

/// A paused rebase of a gone branch in an agent's linked worktree: git calls the branch in use
/// and refuses to delete it.
#[test]
fn a_branch_being_rebased_in_a_worktree_is_never_listed() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    branch(&mut f, "agent", "README.md");
    gone(&f, "agent");
    let folder = worktree(&f, "wt-agent", "agent");
    f.write("README.md", "# Main readme, changed\n");
    f.commit("main readme");
    let (rebased, _, _) = f.try_git_in(&folder, &["rebase", "main"]);
    assert!(!rebased, "the rebase stops on its conflict");
    let (deleted, _, refusal) = f.try_git(&["branch", "-D", "agent"]);
    assert!(
        !deleted && refusal.contains("used by worktree"),
        "{refusal}"
    );
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert!(
        candidate(&found.candidates, "agent").is_none(),
        "{:?}",
        found.candidates
    );
}

/// A rebase with `--update-refs` stopped on a conflict: the branch it rewrites and the branch
/// below it that it moves along are both in use for git.
#[test]
fn the_branches_a_stopped_rebase_moves_are_never_listed() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    branch(&mut f, "base", "base.txt");
    gone(&f, "base");
    f.git(&["switch", "-q", "-c", "stack", "base"]);
    f.write("README.md", "# Stack readme\n");
    f.commit("stack readme");
    gone(&f, "stack");
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main readme\n");
    f.commit("main readme");
    f.git(&["switch", "-q", "stack"]);
    let (rebased, _, _) = f.try_git(&["rebase", "--update-refs", "main"]);
    assert!(!rebased, "the rebase stops on its conflict");
    for name in ["base", "stack"] {
        let (deleted, _, refusal) = f.try_git(&["branch", "-D", name]);
        assert!(
            !deleted && refusal.contains("used by worktree"),
            "{refusal}"
        );
    }
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    let listed = names(&found.candidates);
    assert!(
        !listed.contains(&"base") && !listed.contains(&"stack"),
        "{:?}",
        found.candidates
    );
}

/// A bisect started from a merged branch: git shows "(no branch, bisect started on bis)" and
/// refuses to delete it.
#[test]
fn a_branch_being_bisected_is_never_listed() {
    let mut f = Fixture::basic();
    branch(&mut f, "bis", "bis.txt");
    f.git(&["switch", "-q", "bis"]);
    f.write("bis2.txt", "2\n");
    f.commit("bis 2");
    f.git(&["switch", "-q", "main"]);
    f.git(&["merge", "-q", "--no-ff", "-m", "merge bis", "bis"]);
    f.git(&["switch", "-q", "bis"]);
    f.git(&["bisect", "start", "bis", "main~1"]);
    let (deleted, _, refusal) = f.try_git(&["branch", "-D", "bis"]);
    assert!(
        !deleted && refusal.contains("used by worktree"),
        "{refusal}"
    );
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert!(
        candidate(&found.candidates, "bis").is_none(),
        "{:?}",
        found.candidates
    );
}

/// Windows and macOS: loose refs on a case-insensitive disk. The main line is `Master`, the
/// main worktree on a feature; git lists no `refs/heads/master`.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn the_main_branch_is_named_as_git_lists_it() {
    let mut f = Fixture::basic();
    f.git(&["branch", "-q", "-m", "main", "Master"]);
    f.git(&["switch", "-q", "-c", "feature", "Master"]);
    f.write("feature.txt", "feature\n");
    f.commit("feature work");
    assert_eq!(f.git(&["for-each-ref", "refs/heads/master"]), "");
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert_eq!(found.main, None);
    assert!(found.candidates.is_empty(), "{:?}", found.candidates);
}

/// Windows and macOS: `git switch Feature` checks out `feature` and writes
/// `ref: refs/heads/Feature` into HEAD; git's own `branch -D feature` then deletes the
/// checked-out branch, so the listing must not offer it.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn the_branch_head_names_in_another_case_is_never_listed() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    branch(&mut f, "feature", "feature.txt");
    gone(&f, "feature");
    f.git(&["switch", "-q", "Feature"]);
    assert_eq!(f.git(&["symbolic-ref", "HEAD"]), "refs/heads/Feature");
    let found = engine(&f).cleanup_candidates(&never()).expect("candidates");
    assert!(
        !found
            .candidates
            .iter()
            .any(|c| c.name.eq_ignore_ascii_case("feature")),
        "{:?}",
        found.candidates
    );
}

// ------------------------------------------------------------------------------ deletion

#[test]
fn deletes_a_branch_alone_and_one_with_its_worktree() {
    let mut f = Fixture::basic();
    branch(&mut f, "claude/árbol", "arbol.txt");
    f.git(&[
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "merge arbol",
        "claude/árbol",
    ]);
    f.git(&["branch", "with-wt", "main"]);
    let folder = worktree(&f, "wt with ñ", "with-wt");
    // Not merged in git's sense (a squash took it, or the user ticked it): `-D` deletes it.
    branch(&mut f, "unmerged", "unmerged.txt");
    let outcomes = engine(&f)
        .delete_branches(
            &[
                to_delete(&f, "claude/árbol", None),
                to_delete(&f, "with-wt", Some(&folder)),
                to_delete(&f, "unmerged", None),
            ],
            &never(),
        )
        .expect("deleted");
    assert!(
        outcomes.iter().all(|outcome| outcome.deleted),
        "{outcomes:?}"
    );
    assert!(!outcomes[0].worktree_removed);
    assert!(outcomes[1].worktree_removed);
    assert!(!branch_exists(&f, "claude/árbol"));
    assert!(!branch_exists(&f, "with-wt"));
    assert!(!branch_exists(&f, "unmerged"));
    assert!(!folder.exists());
    assert!(!f.git(&["worktree", "list"]).contains("wt with"));
}

#[test]
fn keeps_a_moved_branch_and_deletes_the_others() {
    let f = Fixture::basic();
    f.git(&["branch", "moved", "main"]);
    f.git(&["branch", "still", "main"]);
    let listed_moved = to_delete(&f, "moved", None);
    let listed_still = to_delete(&f, "still", None);
    // An agent commits on `moved` after the listing.
    f.git(&["switch", "-q", "moved"]);
    f.write("agent.txt", "new work\n");
    f.git(&["add", "agent.txt"]);
    f.git(&["commit", "-q", "-m", "agent work"]);
    f.git(&["switch", "-q", "main"]);
    let tip = f.rev("moved");
    let outcomes = engine(&f)
        .delete_branches(&[listed_moved, listed_still], &never())
        .expect("answered");
    assert_eq!(outcomes[0].name, "moved");
    assert!(!outcomes[0].deleted);
    assert_eq!(outcomes[0].reason, Some(KeptReason::Moved));
    assert_eq!(outcomes[0].message, None);
    assert!(outcomes[1].deleted, "{outcomes:?}");
    assert_eq!(f.rev("moved"), tip);
    assert!(!branch_exists(&f, "still"));
}

#[test]
fn keeps_a_moved_branch_with_its_worktree() {
    let f = Fixture::basic();
    f.git(&["branch", "agent", "main"]);
    let folder = worktree(&f, "wt-agent", "agent");
    let asked = to_delete(&f, "agent", Some(&folder));
    // The agent commits in its worktree after the listing.
    std::fs::write(folder.join("agent.txt"), "work\n").expect("write");
    f.git_in(&folder, &["add", "agent.txt"]);
    f.git_in(&folder, &["commit", "-q", "-m", "agent work"]);
    let outcomes = engine(&f)
        .delete_branches(&[asked], &never())
        .expect("answered");
    assert_eq!(outcomes[0].reason, Some(KeptReason::Moved), "{outcomes:?}");
    assert!(!outcomes[0].worktree_removed);
    assert!(folder.join("agent.txt").exists());
    assert!(branch_exists(&f, "agent"));
}

#[test]
fn says_a_branch_deleted_since_the_listing_is_missing() {
    let f = Fixture::basic();
    f.git(&["branch", "elsewhere", "main"]);
    let asked = to_delete(&f, "elsewhere", None);
    f.git(&["branch", "-q", "-D", "elsewhere"]);
    let outcomes = engine(&f)
        .delete_branches(&[asked], &never())
        .expect("answered");
    assert!(!outcomes[0].deleted);
    assert_eq!(outcomes[0].reason, Some(KeptReason::Missing));
}

/// The tip is checked before the worktree goes, and `git worktree remove` can take seconds (a
/// large `node_modules`): a commit that lands on the branch meanwhile must keep it. The landing
/// is made deterministic by a clean filter on a tracked file, which `git worktree remove` runs
/// through its `git status` of the worktree.
#[test]
fn a_commit_that_lands_while_the_worktree_goes_keeps_the_branch() {
    let mut f = Fixture::basic();
    f.write(".gitattributes", "probe.txt filter=probe\n");
    f.write("probe.txt", "probe\n");
    f.commit("probe file");
    f.git(&["branch", "racing", "main"]);
    let folder = worktree(&f, "wt-racing", "racing");
    let asked = to_delete(&f, "racing", Some(&folder));
    let tree = f.rev("racing^{tree}");
    let landed = f.git(&["commit-tree", "-p", "racing", "-m", "agent commit", &tree]);
    // The worktree's copy differs on disk with the same size (a size change alone reads as
    // modified without the filter) and cleans to the committed content, so status runs the
    // filter, which moves the branch as the agent's commit would.
    let filter =
        format!("git update-ref refs/heads/racing {landed} && cat >/dev/null && echo probe");
    f.git(&["config", "filter.probe.clean", &filter]);
    std::fs::write(folder.join("probe.txt"), "PROBE\n").expect("write");
    let outcomes = engine(&f)
        .delete_branches(&[asked], &never())
        .expect("answered");
    assert!(branch_exists(&f, "racing"), "{outcomes:?}");
    assert_eq!(f.rev("racing"), landed);
    assert!(!outcomes[0].deleted, "{outcomes:?}");
    assert_eq!(outcomes[0].reason, Some(KeptReason::Moved), "{outcomes:?}");
    assert!(outcomes[0].worktree_removed, "{outcomes:?}");
}

#[test]
fn keeps_a_branch_whose_worktree_has_changes_or_is_locked() {
    let f = Fixture::basic();
    f.git(&["branch", "dirty", "main"]);
    f.git(&["branch", "locked", "main"]);
    let dirty = worktree(&f, "wt-dirty", "dirty");
    std::fs::write(dirty.join("README.md"), "an edit nobody committed\n").expect("edit");
    let locked = worktree(&f, "wt-locked", "locked");
    f.git(&[
        "worktree",
        "lock",
        "--reason",
        "agent at work",
        &locked.to_string_lossy(),
    ]);
    let outcomes = engine(&f)
        .delete_branches(
            &[
                to_delete(&f, "dirty", Some(&dirty)),
                to_delete(&f, "locked", Some(&locked)),
            ],
            &never(),
        )
        .expect("answered");
    for outcome in &outcomes {
        assert!(!outcome.deleted, "{outcome:?}");
        assert!(!outcome.worktree_removed, "{outcome:?}");
        assert_eq!(outcome.reason, Some(KeptReason::Worktree), "{outcome:?}");
    }
    let dirty_words = outcomes[0].message.clone().unwrap_or_default();
    assert!(
        dirty_words.contains("modified or untracked"),
        "{dirty_words}"
    );
    let locked_words = outcomes[1].message.clone().unwrap_or_default();
    assert!(locked_words.contains("locked"), "{locked_words}");
    assert!(branch_exists(&f, "dirty") && branch_exists(&f, "locked"));
    assert_eq!(
        std::fs::read_to_string(dirty.join("README.md")).expect("kept"),
        "an edit nobody committed\n"
    );
    assert!(locked.exists());
}

/// A worktree with untracked files only: git's refusal says so, and so does the outcome.
#[test]
fn a_worktree_with_untracked_files_only_stays_with_gits_words() {
    let f = Fixture::basic();
    f.git(&["branch", "notes-only", "main"]);
    let folder = worktree(&f, "wt-notes", "notes-only");
    std::fs::write(folder.join("notes.txt"), "new\n").expect("write");
    let (removed, _, refusal) = f.try_git(&["worktree", "remove", &folder.to_string_lossy()]);
    assert!(!removed && refusal.contains("untracked"), "{refusal}");
    let outcomes = engine(&f)
        .delete_branches(&[to_delete(&f, "notes-only", Some(&folder))], &never())
        .expect("answered");
    assert_eq!(outcomes[0].reason, Some(KeptReason::Worktree));
    let message = outcomes[0].message.clone().unwrap_or_default();
    assert!(message.contains("untracked files"), "{message}");
    assert!(folder.join("notes.txt").exists());
}

#[test]
fn keeps_a_branch_whose_worktree_holds_another_branch_now() {
    let f = Fixture::basic();
    f.git(&["branch", "listed", "main"]);
    f.git(&["branch", "other", "main"]);
    let folder = worktree(&f, "wt-switched", "listed");
    let asked = to_delete(&f, "listed", Some(&folder));
    // The worktree moves to another branch after the listing.
    f.git_in(&folder, &["switch", "-q", "other"]);
    let outcomes = engine(&f)
        .delete_branches(&[asked], &never())
        .expect("answered");
    assert_eq!(
        outcomes[0].reason,
        Some(KeptReason::WorktreeMoved),
        "{outcomes:?}"
    );
    assert!(folder.exists());
    assert!(branch_exists(&f, "listed"));
}

/// The worktree goes, then git refuses the branch (another git holds its ref lock): the outcome
/// says the worktree went with git's words for the branch.
#[test]
fn a_branch_kept_after_its_worktree_went_says_the_worktree_went() {
    let f = Fixture::basic();
    f.git(&["branch", "held", "main"]);
    let folder = worktree(&f, "wt-held", "held");
    let asked = to_delete(&f, "held", Some(&folder));
    std::fs::write(f.git_dir().join("refs/heads/held.lock"), "").expect("lock");
    let outcomes = engine(&f)
        .delete_branches(&[asked], &never())
        .expect("answered");
    assert!(!folder.exists(), "the worktree went");
    assert!(branch_exists(&f, "held"));
    assert_eq!(outcomes[0].reason, Some(KeptReason::Failed));
    assert!(outcomes[0].worktree_removed, "{outcomes:?}");
    let message = outcomes[0].message.clone().unwrap_or_default();
    assert!(message.contains("lock"), "{message}");
}

/// A worktree whose folder went after the listing is unregistered by `git worktree remove`,
/// which accepts a missing folder, and its branch goes.
#[test]
fn a_worktree_whose_folder_went_after_the_listing_is_unregistered_and_its_branch_deleted() {
    let f = Fixture::basic();
    f.git(&["branch", "vanished", "main"]);
    let folder = worktree(&f, "wt vanished ñ", "vanished");
    let asked = to_delete(&f, "vanished", Some(&folder));
    std::fs::remove_dir_all(&folder).expect("remove the folder");
    let outcomes = engine(&f)
        .delete_branches(&[asked], &never())
        .expect("answered");
    assert!(outcomes[0].deleted, "{outcomes:?}");
    assert!(!branch_exists(&f, "vanished"));
    assert!(!f
        .git(&["worktree", "list", "--porcelain"])
        .contains("wt vanished"));
}

#[test]
fn keeps_a_branch_git_refuses_with_its_words() {
    let f = Fixture::basic();
    // The branch the main worktree has checked out: git refuses to delete it.
    let outcomes = engine(&f)
        .delete_branches(&[to_delete(&f, "main", None)], &never())
        .expect("answered");
    assert!(!outcomes[0].deleted);
    assert_eq!(outcomes[0].reason, Some(KeptReason::Failed));
    let message = outcomes[0].message.clone().unwrap_or_default();
    assert!(message.contains("main"), "{message}");
    assert!(branch_exists(&f, "main"));
}

#[test]
fn a_cancel_keeps_every_branch_not_reached() {
    let f = Fixture::basic();
    f.git(&["branch", "one", "main"]);
    f.git(&["branch", "two", "main"]);
    let cancel = Cancel::new();
    cancel.cancel();
    let outcomes = engine(&f)
        .delete_branches(
            &[to_delete(&f, "one", None), to_delete(&f, "two", None)],
            &cancel,
        )
        .expect("answered");
    for outcome in &outcomes {
        assert!(!outcome.deleted, "{outcome:?}");
        assert_eq!(outcome.reason, Some(KeptReason::Stopped), "{outcome:?}");
    }
    assert!(branch_exists(&f, "one") && branch_exists(&f, "two"));
}

// ------------------------------------------------------- second review round: no commits

fn reason_of(f: &Fixture, name: &str) -> Option<CleanupReason> {
    let found = engine(f).cleanup_candidates(&never()).expect("candidates");
    candidate(&found.candidates, name).map(|c| c.reason)
}

fn reflog(f: &Fixture, name: &str) -> String {
    std::fs::read_to_string(f.git_dir().join("logs/refs/heads").join(name)).expect("reflog")
}

/// The common way to start an agent from the freshest main: `git worktree add -b <name> <path>
/// origin/main`, which makes the branch track `origin/main`. Before its first commit, once main
/// moved on, it has nothing of its own: its reflog holds its creation alone.
#[test]
fn an_agent_branch_made_from_origin_main_has_no_commits_of_its_own() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    let folder = f.sibling("wt-agent");
    f.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "agent",
        &folder.to_string_lossy(),
        "origin/main",
    ]);
    assert_eq!(
        f.git(&["rev-parse", "--abbrev-ref", "agent@{upstream}"]),
        "origin/main"
    );
    f.write("later.txt", "main moves on\n");
    f.commit("main moves on");
    f.git(&["push", "-q", "origin", "main"]);
    assert_eq!(
        reflog(&f, "agent").lines().count(),
        1,
        "{}",
        reflog(&f, "agent")
    );
    assert_eq!(f.git(&["rev-list", "--count", "main..agent"]), "0");
    assert_eq!(reason_of(&f, "agent"), Some(NoCommits));
}

/// A fresh branch renamed (`git branch -m`) or copied (`git branch -c`) never pointed at
/// anything but the commit it was made at: git's rename and copy entries keep the tip.
#[test]
fn a_fresh_branch_renamed_or_copied_has_no_commits_of_its_own() {
    let mut f = Fixture::basic();
    f.git(&["branch", "draft", "main"]);
    f.git(&["branch", "-m", "draft", "renamed"]);
    f.git(&["branch", "seed", "main"]);
    f.git(&["branch", "-c", "seed", "copied"]);
    f.write("later.txt", "main moves on\n");
    f.commit("main moves on");
    for name in ["renamed", "copied"] {
        let tip = f.rev(name);
        let log = reflog(&f, name);
        assert!(
            log.lines()
                .all(|line| line.split(' ').nth(1) == Some(tip.as_str())),
            "{log}"
        );
        assert_eq!(reason_of(&f, name), Some(NoCommits), "{name}");
    }
}

/// A branch with two commits of its own, fast-forwarded into main: git calls it merged, its
/// reflog records both commits, and it has work of its own though it sits at main's tip.
#[test]
fn a_branch_fast_forwarded_into_main_is_merged_not_empty() {
    let mut f = Fixture::basic();
    f.git(&["switch", "-q", "-c", "agent-work", "main"]);
    f.write("w1.txt", "1\n");
    f.commit("agent 1");
    f.write("w2.txt", "2\n");
    f.commit("agent 2");
    f.git(&["switch", "-q", "main"]);
    f.git(&["merge", "-q", "--ff-only", "agent-work"]);
    let log = reflog(&f, "agent-work");
    assert_eq!(
        log.lines()
            .filter(|line| line.contains("commit: agent"))
            .count(),
        2,
        "{log}"
    );
    assert_eq!(reason_of(&f, "agent-work"), Some(Merged));
}

// ----------------------------------------------------------- second review round: gone

/// A remote whose fetch refspec maps its branches outside `refs/remotes/`: the upstream is
/// there and up to date, and `git branch -vv` shows `[mirror/mirrored]`, not `gone`.
#[test]
fn an_upstream_outside_refs_remotes_is_not_gone() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    branch(&mut f, "mirrored", "mirrored.txt");
    f.git(&["push", "-q", "origin", "mirrored"]);
    let origin = f.sibling("origin.git").to_string_lossy().into_owned();
    f.git(&["remote", "add", "mirror", &origin]);
    f.git(&[
        "config",
        "remote.mirror.fetch",
        "+refs/heads/*:refs/mirror/*",
    ]);
    f.git(&["fetch", "-q", "mirror"]);
    f.git(&["config", "branch.mirrored.remote", "mirror"]);
    f.git(&["config", "branch.mirrored.merge", "refs/heads/mirrored"]);
    let tracking = f.git(&["branch", "-vv"]);
    assert!(tracking.contains("[mirror/mirrored]"), "{tracking}");
    assert_eq!(reason_of(&f, "mirrored"), None);
}

/// Windows and macOS: `branch.<n>.merge` names the remote branch in another case than the
/// loose remote-tracking ref on disk; git resolves it and says the upstream is there.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn an_upstream_named_in_another_case_than_its_ref_is_not_gone() {
    let mut f = Fixture::basic();
    with_origin(&mut f);
    branch(&mut f, "cased", "cased.txt");
    f.git(&["push", "-q", "-u", "origin", "cased"]);
    f.git(&["config", "branch.cased.merge", "refs/heads/Cased"]);
    let tracking = f.git(&["branch", "-vv"]);
    assert!(
        tracking.contains("[origin/Cased]") && !tracking.contains("gone"),
        "{tracking}"
    );
    assert_eq!(reason_of(&f, "cased"), None);
}

// ---------------------------------------------------- second review round: merge drivers

/// A gone branch whose change to CHANGELOG.md main lacks; main changed the file too, so the
/// merge goes through the file's merge driver, which `configure` names some way.
fn gone_note_with_driver(configure: impl Fn(&Fixture)) -> Fixture {
    let mut f = Fixture::basic();
    f.write("CHANGELOG.md", "v1\n");
    f.commit("changelog");
    with_origin(&mut f);
    f.git(&["config", "merge.keepours.driver", "true"]);
    configure(&f);
    f.git(&["switch", "-q", "-c", "notes", "main"]);
    f.write("CHANGELOG.md", "v1\nagent note nobody merged\n");
    f.commit("note");
    f.git(&["switch", "-q", "main"]);
    gone(&f, "notes");
    f.write("CHANGELOG.md", "v1\nv2 released\n");
    f.commit("v2");
    assert!(f
        .git(&["diff", "main", "notes"])
        .contains("+agent note nobody merged"));
    f
}

/// `.git/info/attributes` is the repository's attributes too.
#[test]
fn a_merge_driver_named_in_info_attributes_does_not_make_it_applied() {
    let f = gone_note_with_driver(|f| {
        let info = f.git_dir().join("info");
        std::fs::create_dir_all(&info).expect("info");
        std::fs::write(info.join("attributes"), "CHANGELOG.md merge=keepours\n").expect("write");
    });
    assert_eq!(reason_of(&f, "notes"), Some(Gone));
}

/// The attributes file of `core.attributesFile` (the user's global one, set in the repository
/// so the test stays hermetic).
#[test]
fn a_merge_driver_named_in_the_attributes_file_does_not_make_it_applied() {
    let f = gone_note_with_driver(|f| {
        let file = f.sibling("attributes");
        std::fs::write(&file, "CHANGELOG.md merge=keepours\n").expect("write");
        f.git(&["config", "core.attributesFile", &file.to_string_lossy()]);
    });
    assert_eq!(reason_of(&f, "notes"), Some(Gone));
}

/// `merge.default` names the driver of every path without a `merge` attribute.
#[test]
fn a_default_merge_driver_does_not_make_it_applied() {
    let f = gone_note_with_driver(|f| {
        f.git(&["config", "merge.default", "keepours"]);
    });
    assert_eq!(reason_of(&f, "notes"), Some(Gone));
}

/// `CHANGELOG.md merge=union`, a common way to merge changelogs: git's union driver keeps both
/// sides' lines and never reports a conflict, so a branch that only deleted a line main kept, main
/// adding one beside it, merges into main's own tree.
#[test]
fn the_union_driver_does_not_make_a_deletion_read_as_applied() {
    let mut f = Fixture::basic();
    f.write(".gitattributes", "CHANGELOG.md merge=union\n");
    f.write("CHANGELOG.md", "v1\nstale line\n");
    f.commit("changelog");
    with_origin(&mut f);
    f.git(&["switch", "-q", "-c", "prune-notes", "main"]);
    f.write("CHANGELOG.md", "v1\n");
    f.commit("drop the stale line");
    f.git(&["switch", "-q", "main"]);
    gone(&f, "prune-notes");
    f.write("CHANGELOG.md", "v1\nstale line\nv2 released\n");
    f.commit("v2");
    // git's own merge, with the union driver, gives main's tree: the deletion is lost in it.
    let merged = f.git(&["merge-tree", "--write-tree", "main", "prune-notes"]);
    assert_eq!(merged.lines().next(), Some(f.rev("main^{tree}").as_str()));
    assert_eq!(
        reason_of(&f, "prune-notes"),
        Some(Gone),
        "main still has the line the branch deleted"
    );
}

/// A commit, then a reset back to where the branch was made: its reflog shows it moved, which is
/// work of its own although its tip is main's again.
#[test]
fn a_branch_reset_back_after_a_commit_is_merged_not_empty() {
    let mut f = Fixture::basic();
    f.git(&["switch", "-q", "-c", "retry", "main"]);
    f.write("attempt.txt", "x\n");
    f.commit("attempt");
    f.git(&["reset", "-q", "--hard", "main"]);
    f.git(&["switch", "-q", "main"]);
    assert_eq!(
        reflog(&f, "retry").lines().count(),
        3,
        "{}",
        reflog(&f, "retry")
    );
    assert_eq!(f.rev("retry"), f.rev("main"));
    assert_eq!(reason_of(&f, "retry"), Some(Merged));
}

// ------------------------------------------------------- second review round: deletion

/// A worktree that switches to another branch while an earlier branch's worktree goes (an
/// agent at work; each removal can take seconds) stays. The switch is made deterministic by a
/// clean filter that the first removal's `git status` runs.
#[test]
fn a_worktree_that_switched_branch_while_an_earlier_one_went_stays() {
    let mut f = Fixture::basic();
    f.write(".gitattributes", "probe.txt filter=probe\n");
    f.write("probe.txt", "probe\n");
    f.commit("probe file");
    for name in ["first", "second", "other"] {
        f.git(&["branch", name, "main"]);
    }
    let first = worktree(&f, "wt-first", "first");
    let second = worktree(&f, "wt-second", "second");
    let asked = [
        to_delete(&f, "first", Some(&first)),
        to_delete(&f, "second", Some(&second)),
    ];
    // `git worktree remove` runs `git status` in the worktree with GIT_DIR and GIT_WORK_TREE
    // set; the filter clears them before it switches the other worktree.
    let target = second
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let marker = f.sibling("switched");
    let marker_text = marker
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let filter = format!(
        "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE; git -C '{target}' switch -q other && echo done > '{marker_text}'; cat >/dev/null; echo probe"
    );
    f.git(&["config", "filter.probe.clean", &filter]);
    std::fs::write(first.join("probe.txt"), "PROBE\n").expect("write");
    let outcomes = engine(&f)
        .delete_branches(&asked, &never())
        .expect("answered");
    assert!(outcomes[0].deleted, "{outcomes:?}");
    assert!(
        marker.exists(),
        "the switch ran while the first worktree went"
    );
    assert!(second.exists(), "{outcomes:?}");
    assert_eq!(
        f.git_in(&second, &["symbolic-ref", "--short", "HEAD"]),
        "other"
    );
    assert_eq!(
        outcomes[1].reason,
        Some(KeptReason::WorktreeMoved),
        "{outcomes:?}"
    );
}

/// The status bar's Stop while the first branch's worktree goes: the removal runs to its end and
/// that branch goes whole, and the branches after it stay, stopped. The cancel lands during the
/// removal through a clean filter its `git status` runs, which says it started, then holds it.
#[test]
fn a_cancel_during_a_removal_finishes_that_branch_and_stops_the_rest() {
    let mut f = Fixture::basic();
    f.write(".gitattributes", "probe.txt filter=probe\n");
    f.write("probe.txt", "probe\n");
    f.commit("probe file");
    for name in ["first", "second"] {
        f.git(&["branch", name, "main"]);
    }
    let first = worktree(&f, "wt-first", "first");
    let marker = f.sibling("removal-started");
    let marker_text = marker
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let filter = format!("echo started > '{marker_text}'; sleep 1; cat >/dev/null; echo probe");
    f.git(&["config", "filter.probe.clean", &filter]);
    std::fs::write(first.join("probe.txt"), "PROBE\n").expect("write");
    let cancel = Cancel::new();
    let flag = cancel.clone();
    let started = marker.clone();
    let canceller = std::thread::spawn(move || {
        let waiting = std::time::Instant::now();
        while !started.exists() && waiting.elapsed() < std::time::Duration::from_secs(60) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        flag.cancel();
    });
    let asked = [
        to_delete(&f, "first", Some(&first)),
        to_delete(&f, "second", None),
    ];
    let outcomes = engine(&f)
        .delete_branches(&asked, &cancel)
        .expect("answered");
    canceller.join().expect("the canceller ends");
    assert!(marker.exists(), "the cancel landed during the removal");
    assert!(
        outcomes[0].deleted && outcomes[0].worktree_removed,
        "{outcomes:?}"
    );
    assert!(!first.exists() && !branch_exists(&f, "first"));
    assert_eq!(
        outcomes[1].reason,
        Some(KeptReason::Stopped),
        "{outcomes:?}"
    );
    assert!(branch_exists(&f, "second"));
}

/// Windows: another program holds a file of the worktree open (a dev server, an editor, an
/// antivirus scan). git checks the worktree is clean, unregisters it, deletes what it can and
/// fails on the held file: the worktree is gone for git, its folder half deleted.
#[cfg(windows)]
#[test]
fn a_worktree_git_unregistered_before_failing_on_a_held_file_is_said_removed() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::basic();
    f.git(&["branch", "held", "main"]);
    let folder = worktree(&f, "wt-held", "held");
    std::fs::create_dir_all(folder.join("node_modules")).expect("folder");
    std::fs::write(folder.join("node_modules/held.js"), "x\n").expect("write");
    std::fs::write(f.git_dir().join("info/exclude"), "node_modules/\n").expect("exclude");
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(folder.join("node_modules/held.js"))
        .expect("hold the file");
    let outcomes = engine(&f)
        .delete_branches(&[to_delete(&f, "held", Some(&folder))], &never())
        .expect("answered");
    drop(held);
    let listed = f.git(&["worktree", "list", "--porcelain"]);
    assert!(!listed.contains("wt-held"), "git unregistered it: {listed}");
    assert_eq!(
        outcomes[0].reason,
        Some(KeptReason::Worktree),
        "{outcomes:?}"
    );
    assert!(outcomes[0].worktree_removed, "{outcomes:?}");
    assert!(branch_exists(&f, "held"));
}
