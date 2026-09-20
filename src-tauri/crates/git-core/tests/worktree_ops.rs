//! `Git2Engine::worktree_add`, `worktree_remove`, `worktree_prune`, `worktree_lock` and
//! `worktree_unlock` against `git worktree list --porcelain` and the folders on disk.

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{WorktreeAdd, WorktreeBranch};
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

/// The `(path, branch, locked reason)` triples of `git worktree list --porcelain`.
fn porcelain(f: &Fixture) -> Vec<(String, String, Option<String>)> {
    let output = f.git(&["worktree", "list", "--porcelain"]);
    let mut entries = Vec::new();
    for block in output.split("\n\n") {
        let mut path = String::new();
        let mut branch = String::new();
        let mut locked = None;
        for line in block.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = rest.to_owned();
            } else if let Some(rest) = line.strip_prefix("branch ") {
                branch = rest.to_owned();
            } else if let Some(rest) = line.strip_prefix("locked") {
                locked = Some(rest.trim().to_owned());
            }
        }
        if !path.is_empty() {
            entries.push((path, branch, locked));
        }
    }
    entries
}

fn same_path(a: &Path, b: &Path) -> bool {
    let canonical = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(a) == canonical(b)
}

fn add(f: &Fixture, engine: &Git2Engine, path: PathBuf, branch: WorktreeBranch) -> PathBuf {
    let added = engine
        .worktree_add(
            &WorktreeAdd {
                path: path.clone(),
                branch,
            },
            &Cancel::never(),
        )
        .expect("add");
    assert!(same_path(&added.path, &path));
    assert!(porcelain(f)
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &path)));
    path
}

#[test]
fn adds_worktrees_on_a_new_branch_an_existing_one_and_a_detached_revision() {
    let f = Fixture::basic();
    let engine = engine(&f);
    let new = add(
        &f,
        &engine,
        f.sibling("wt new ünïcode"),
        WorktreeBranch::New {
            name: "topic/new".to_owned(),
            start: "v1".to_owned(),
        },
    );
    assert!(new.join("src").join("lib.rs").exists());
    assert_eq!(f.git_in(&new, &["rev-parse", "HEAD"]), f.rev("v1^{commit}"));
    let entry = porcelain(&f)
        .into_iter()
        .find(|(p, _, _)| same_path(Path::new(p), &new))
        .expect("listed");
    assert_eq!(entry.1, "refs/heads/topic/new");

    let existing = add(
        &f,
        &engine,
        f.sibling("wt-develop"),
        WorktreeBranch::Existing {
            name: "develop".to_owned(),
        },
    );
    assert_eq!(
        f.git_in(&existing, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "develop"
    );

    let detached = add(
        &f,
        &engine,
        f.sibling("wt-detached"),
        WorktreeBranch::Detached {
            rev: "v1".to_owned(),
        },
    );
    assert_eq!(
        f.git_in(&detached, &["rev-parse", "HEAD"]),
        f.rev("v1^{commit}")
    );
    let listed = engine.worktrees(&Cancel::never()).expect("list");
    let found = listed
        .iter()
        .find(|w| same_path(&w.path, &detached))
        .expect("detached listed");
    assert!(found.detached && found.branch.is_none());

    // A branch checked out elsewhere, an unknown start point and an existing folder fail
    // with git's message.
    let taken = engine.worktree_add(
        &WorktreeAdd {
            path: f.sibling("wt-taken"),
            branch: WorktreeBranch::Existing {
                name: "develop".to_owned(),
            },
        },
        &Cancel::never(),
    );
    assert_eq!(
        taken.expect_err("checked out elsewhere").code(),
        "git.cli_failed"
    );
    let occupied = engine.worktree_add(
        &WorktreeAdd {
            path: new.clone(),
            branch: WorktreeBranch::Detached {
                rev: "v1".to_owned(),
            },
        },
        &Cancel::never(),
    );
    assert_eq!(
        occupied.expect_err("folder exists").code(),
        "git.cli_failed"
    );
}

#[test]
fn removes_clean_worktrees_and_refuses_dirty_ones_until_forced() {
    let f = Fixture::basic().with_linked_worktree();
    let engine = engine(&f);
    let path = f.worktree_path();
    // Dirty: an untracked file. git refuses; the folder stays; force removes it.
    fs::write(path.join("scratch.txt"), "wip\n").expect("write");
    let refused = engine
        .worktree_remove(&path, false, &Cancel::never())
        .expect_err("dirty");
    assert!(matches!(refused, GitError::WorktreeDirty(ref p) if same_path(p, &path)));
    assert_eq!(refused.code(), "worktree.dirty");
    assert!(path.exists());
    engine
        .worktree_remove(&path, true, &Cancel::never())
        .expect("forced");
    assert!(!path.exists());
    assert!(!porcelain(&f)
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &path)));
    // The branch stays.
    assert_eq!(
        f.git(&["rev-parse", "--verify", "refs/heads/feature/wt"])
            .len(),
        40
    );
    // A clean one goes on the first try.
    let clean = add(
        &f,
        &engine,
        f.sibling("wt-clean"),
        WorktreeBranch::New {
            name: "clean".to_owned(),
            start: "main".to_owned(),
        },
    );
    engine
        .worktree_remove(&clean, false, &Cancel::never())
        .expect("remove");
    assert!(!clean.exists());
    // Not a worktree: git's error.
    let missing = engine
        .worktree_remove(&f.sibling("nope"), false, &Cancel::never())
        .expect_err("unknown");
    assert_eq!(missing.code(), "git.cli_failed");
}

#[test]
fn prunes_the_entries_whose_folders_are_gone() {
    let f = Fixture::basic()
        .with_linked_worktree()
        .with_broken_worktrees();
    let engine = engine(&f);
    let gone = f.sibling("wt-gone");
    assert!(!gone.exists());
    let pruned = engine.worktree_prune(&Cancel::never()).expect("prune");
    assert_eq!(pruned.len(), 1);
    assert!(same_path(&pruned[0], &gone));
    let listed = porcelain(&f);
    assert!(!listed
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &gone)));
    // The locked one and the live one stay, and the branch of the pruned one too.
    assert!(listed
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &f.worktree_path())));
    assert!(listed
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &f.sibling("wt-locked"))));
    assert_eq!(
        f.git(&["rev-parse", "--verify", "refs/heads/gone"]).len(),
        40
    );
    // Nothing more to prune.
    assert!(engine
        .worktree_prune(&Cancel::never())
        .expect("again")
        .is_empty());
}

#[test]
fn locks_with_and_without_a_reason_and_unlocks() {
    let f = Fixture::basic().with_linked_worktree();
    let engine = engine(&f);
    let path = f.worktree_path();
    engine
        .worktree_lock(&path, Some("review"), &Cancel::never())
        .expect("lock");
    let entry = porcelain(&f)
        .into_iter()
        .find(|(p, _, _)| same_path(Path::new(p), &path))
        .expect("listed");
    assert_eq!(entry.2.as_deref(), Some("review"));
    let listed = engine.worktrees(&Cancel::never()).expect("list");
    let found = listed
        .iter()
        .find(|w| same_path(&w.path, &path))
        .expect("found");
    assert!(found.locked);
    assert_eq!(found.lock_reason.as_deref(), Some("review"));
    // Locking a locked worktree is git's error.
    let twice = engine
        .worktree_lock(&path, None, &Cancel::never())
        .expect_err("already locked");
    assert_eq!(twice.code(), "git.cli_failed");
    engine
        .worktree_unlock(&path, &Cancel::never())
        .expect("unlock");
    let entry = porcelain(&f)
        .into_iter()
        .find(|(p, _, _)| same_path(Path::new(p), &path))
        .expect("listed");
    assert_eq!(entry.2, None);
    engine
        .worktree_lock(&path, Some("  "), &Cancel::never())
        .expect("lock without reason");
    let entry = porcelain(&f)
        .into_iter()
        .find(|(p, _, _)| same_path(Path::new(p), &path))
        .expect("listed");
    assert_eq!(entry.2.as_deref(), Some(""));
    // A cancelled operation never runs git.
    let cancel = Cancel::new();
    cancel.cancel();
    assert_eq!(
        engine
            .worktree_unlock(&path, &cancel)
            .expect_err("cancelled")
            .code(),
        "op.cancelled"
    );
}
