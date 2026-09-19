//! `GitEngine::worktrees` against `git worktree list --porcelain`.

mod support;

use std::path::{Path, PathBuf};

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::Worktree;
use support::{canonical, Fixture};

/// One entry of `git worktree list --porcelain`.
#[derive(Debug, Default, PartialEq, Eq)]
struct CliWorktree {
    path: String,
    /// `None` when git prints the zero hash (unborn branch).
    head: Option<String>,
    /// Full ref name, as git prints it.
    branch: Option<String>,
    detached: bool,
    /// `Some(reason)` when locked; the reason is `None` when the lock has none.
    locked: Option<Option<String>>,
    prunable: bool,
}

fn cli_worktrees(f: &Fixture) -> Vec<CliWorktree> {
    let output = f.git(&["worktree", "list", "--porcelain"]);
    output
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(|block| {
            let mut entry = CliWorktree::default();
            for line in block.lines() {
                if let Some(path) = line.strip_prefix("worktree ") {
                    entry.path = path.to_owned();
                } else if let Some(head) = line.strip_prefix("HEAD ") {
                    entry.head = Some(head.to_owned()).filter(|h| h.chars().any(|c| c != '0'));
                } else if let Some(branch) = line.strip_prefix("branch ") {
                    entry.branch = Some(branch.to_owned());
                } else if line == "detached" {
                    entry.detached = true;
                } else if line == "locked" {
                    entry.locked = Some(None);
                } else if let Some(reason) = line.strip_prefix("locked ") {
                    entry.locked = Some(Some(reason.to_owned()));
                } else if line.starts_with("prunable") {
                    entry.prunable = true;
                } else {
                    panic!("unexpected porcelain line {line:?} in:\n{output}");
                }
            }
            entry
        })
        .collect()
}

fn worktrees_at(path: &Path) -> Vec<Worktree> {
    Git2Engine::open(path)
        .expect("open")
        .worktrees(&Cancel::never())
        .expect("worktrees")
}

fn normalized(path: &Path) -> PathBuf {
    path.components().collect()
}

/// Paths compare canonically when the folder exists and textually when it is gone.
fn same_path(actual: &Path, expected: &str) -> bool {
    let expected = Path::new(expected);
    if expected.exists() && actual.exists() {
        canonical(actual) == canonical(expected)
    } else {
        normalized(actual) == normalized(expected)
    }
}

/// Every CLI entry has one engine entry with the same path and the same state; the main
/// worktree comes first.
fn assert_matches_cli(ours: &[Worktree], cli: &[CliWorktree]) {
    assert_eq!(ours.len(), cli.len(), "ours: {ours:#?}\ncli: {cli:#?}");
    for expected in cli {
        let actual = ours
            .iter()
            .find(|w| same_path(&w.path, &expected.path))
            .unwrap_or_else(|| panic!("no entry for {}: {ours:#?}", expected.path));
        let branch = actual.branch.as_ref().map(|b| format!("refs/heads/{b}"));
        assert_eq!(actual.head, expected.head, "head of {}", expected.path);
        assert_eq!(branch, expected.branch, "branch of {}", expected.path);
        assert_eq!(
            actual.detached, expected.detached,
            "detached {}",
            expected.path
        );
        assert_eq!(
            actual.locked,
            expected.locked.is_some(),
            "locked {}",
            expected.path
        );
        assert_eq!(
            actual.lock_reason,
            expected.locked.clone().flatten(),
            "lock reason of {}",
            expected.path
        );
        assert_eq!(
            actual.prunable, expected.prunable,
            "prunable {}",
            expected.path
        );
    }
    assert!(ours[0].is_main, "main first: {ours:#?}");
    assert!(ours.iter().skip(1).all(|w| !w.is_main), "{ours:#?}");
}

#[test]
fn lists_the_main_and_the_linked_worktree_like_the_cli() {
    let f = Fixture::basic().with_linked_worktree();
    let ours = worktrees_at(&f.root);
    assert_matches_cli(&ours, &cli_worktrees(&f));
    assert_eq!(ours.len(), 2);

    let main = &ours[0];
    assert!(main.is_main);
    assert_eq!(main.name, None);
    assert_eq!(canonical(&main.path), canonical(&f.root));
    assert_eq!(main.branch.as_deref(), Some("main"));
    assert_eq!(main.head.as_deref(), Some(f.head().as_str()));
    assert!(!main.detached && !main.locked && !main.prunable);
    assert_eq!(main.lock_reason, None);

    let linked = &ours[1];
    assert!(!linked.is_main);
    assert_eq!(linked.name.as_deref(), Some("wt-feature"));
    assert_eq!(canonical(&linked.path), canonical(&f.worktree_path()));
    assert_eq!(linked.branch.as_deref(), Some("feature/wt"));
    assert_eq!(linked.head.as_deref(), Some(f.rev("feature/wt").as_str()));
    assert!(!linked.detached && !linked.locked && !linked.prunable);
}

#[test]
fn marks_a_missing_folder_prunable_and_a_locked_one_locked() {
    let f = Fixture::basic()
        .with_linked_worktree()
        .with_broken_worktrees();
    let ours = worktrees_at(&f.root);
    assert_matches_cli(&ours, &cli_worktrees(&f));

    let names: Vec<Option<&str>> = ours.iter().map(|w| w.name.as_deref()).collect();
    assert_eq!(
        names,
        [None, Some("wt-feature"), Some("wt-gone"), Some("wt-locked")]
    );

    let gone = &ours[2];
    assert!(gone.prunable);
    assert!(!gone.locked);
    assert!(gone.path.ends_with("wt-gone"), "{}", gone.path.display());
    assert_eq!(gone.branch.as_deref(), Some("gone"));
    assert_eq!(gone.head.as_deref(), Some(f.rev("gone").as_str()));
    assert!(!gone.detached);

    let locked = &ours[3];
    assert!(locked.locked);
    assert_eq!(locked.lock_reason.as_deref(), Some("testing"));
    assert!(!locked.prunable);
    assert_eq!(locked.branch.as_deref(), Some("locked"));

    assert!(ours.iter().take(2).all(|w| !w.prunable && !w.locked));
}

#[test]
fn reports_a_detached_worktree_and_a_lock_without_reason() {
    let mut f = Fixture::basic();
    let path = f.sibling("wt-detached");
    let path = path.to_str().expect("utf-8 temp path");
    f.tick();
    f.git(&["worktree", "add", "-q", "--detach", path, "HEAD~1"]);
    f.git(&["worktree", "lock", path]);

    let ours = worktrees_at(&f.root);
    assert_matches_cli(&ours, &cli_worktrees(&f));
    let detached = &ours[1];
    assert_eq!(detached.name.as_deref(), Some("wt-detached"));
    assert!(detached.detached);
    assert_eq!(detached.branch, None);
    assert_eq!(detached.head.as_deref(), Some(f.rev("HEAD~1").as_str()));
    assert!(detached.locked);
    assert_eq!(detached.lock_reason, None);
    assert!(!detached.prunable);
}

#[test]
fn an_unborn_repository_has_only_its_main_worktree() {
    let f = Fixture::unborn();
    let ours = worktrees_at(&f.root);
    assert_matches_cli(&ours, &cli_worktrees(&f));
    assert_eq!(ours.len(), 1);
    assert_eq!(ours[0].head, None);
    assert_eq!(ours[0].branch.as_deref(), Some("main"));
    assert!(!ours[0].detached);
}

#[test]
fn a_worktree_on_an_orphan_branch_has_no_head() {
    let mut f = Fixture::basic();
    let path = f.sibling("wt-orphan");
    let path = path.to_str().expect("utf-8 temp path");
    f.tick();
    let (ok, _, stderr) = f.try_git(&["worktree", "add", "-q", "--orphan", "-b", "orphan", path]);
    if !ok {
        eprintln!("skipping: this git cannot add an orphan worktree: {stderr}");
        return;
    }
    let ours = worktrees_at(&f.root);
    assert_matches_cli(&ours, &cli_worktrees(&f));
    let orphan = &ours[1];
    assert_eq!(orphan.name.as_deref(), Some("wt-orphan"));
    assert_eq!(orphan.head, None);
    assert_eq!(orphan.branch.as_deref(), Some("orphan"));
    assert!(!orphan.detached);
}

#[test]
fn the_list_is_the_same_from_a_linked_worktree() {
    let f = Fixture::basic()
        .with_linked_worktree()
        .with_broken_worktrees();
    let from_root = worktrees_at(&f.root);
    let from_linked = worktrees_at(&f.worktree_path());
    assert_eq!(from_root, from_linked);
    assert_eq!(canonical(&from_linked[0].path), canonical(&f.root));
}

#[test]
fn stops_when_cancelled() {
    let f = Fixture::basic().with_linked_worktree();
    let engine = Git2Engine::open(&f.root).expect("open");
    let cancel = Cancel::new();
    cancel.cancel();
    let error = engine.worktrees(&cancel).expect_err("must be cancelled");
    assert!(matches!(error, GitError::Cancelled), "{error:?}");
    assert_eq!(error.code(), "op.cancelled");
}
