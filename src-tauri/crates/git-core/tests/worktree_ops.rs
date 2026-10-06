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
    // A pruned worktree's folder is gone, so only its parent can be canonicalised;
    // without that, the runner's short 8.3 temporary path and git's long form differ.
    let canonical = |p: &Path| {
        fs::canonicalize(p).unwrap_or_else(|_| match (p.parent(), p.file_name()) {
            (Some(parent), Some(name)) => fs::canonicalize(parent)
                .map(|base| base.join(name))
                .unwrap_or_else(|_| p.to_path_buf()),
            _ => p.to_path_buf(),
        })
    };
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
            track: None,
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

/// git records a worktree under its real path (the on-disk case, `..` resolved); the engine
/// finds the entry it added whatever spelling the request used.
#[test]
fn adds_under_any_spelling_of_the_path() {
    let f = Fixture::basic();
    let engine = engine(&f);
    let lower = PathBuf::from(f.sibling("Wt-Case").to_string_lossy().to_lowercase());
    let added = engine
        .worktree_add(
            &WorktreeAdd {
                path: lower.clone(),
                branch: WorktreeBranch::Detached {
                    rev: "v1".to_owned(),
                },
            },
            &Cancel::never(),
        )
        .expect("lowercased spelling");
    assert!(same_path(&added.path, &lower));
    let dotted = f.sibling("wt-dot").join("..").join("wt-dotdot");
    let added = engine
        .worktree_add(
            &WorktreeAdd {
                path: dotted.clone(),
                branch: WorktreeBranch::Detached {
                    rev: "v1".to_owned(),
                },
            },
            &Cancel::never(),
        )
        .expect("a .. in the path");
    assert!(same_path(&added.path, &f.sibling("wt-dotdot")));
    assert!(!added.path.to_string_lossy().contains(".."));
}

/// A failing `post-checkout` hook makes `git worktree add` exit with the hook's status while
/// keeping the worktree: the engine reports the failure, and the listing has the entry.
#[test]
fn a_failing_post_checkout_hook_fails_the_add_but_keeps_the_worktree() {
    let f = Fixture::basic();
    let hooks = f.git_dir().join("hooks");
    fs::create_dir_all(&hooks).expect("hooks dir");
    let hook = hooks.join("post-checkout");
    fs::write(&hook, "#!/bin/sh\nexit 3\n").expect("hook");
    // Without the executable bit git skips the hook on Unix and the add succeeds.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).expect("hook is runnable");
    }
    let engine = engine(&f);
    let path = f.sibling("wt-hooked");
    let failed = engine
        .worktree_add(
            &WorktreeAdd {
                path: path.clone(),
                branch: WorktreeBranch::Detached {
                    rev: "v1".to_owned(),
                },
            },
            &Cancel::never(),
        )
        .expect_err("the hook's status");
    assert_eq!(failed.code(), "git.cli_failed");
    assert!(
        matches!(
            failed,
            GitError::Cli {
                status: Some(3),
                ..
            }
        ),
        "{failed:?}"
    );
    assert!(porcelain(&f)
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &path)));
}

/// A lock reason is free text: one that quotes git's dirty wording must not turn the locked
/// refusal into `worktree.dirty` (force would fail again; the user has to unlock).
#[test]
fn a_locked_worktree_is_refused_as_a_cli_failure_whatever_its_reason_says() {
    let f = Fixture::basic().with_linked_worktree();
    let engine = engine(&f);
    let path = f.worktree_path();
    engine
        .worktree_lock(&path, Some("use --force to remove me"), &Cancel::never())
        .expect("lock");
    let refused = engine
        .worktree_remove(&path, false, &Cancel::never())
        .expect_err("locked");
    assert_eq!(refused.code(), "git.cli_failed");
    assert!(matches!(refused, GitError::Cli { ref stderr, .. } if stderr.contains("locked")));
    let forced = engine
        .worktree_remove(&path, true, &Cancel::never())
        .expect_err("still locked");
    assert_eq!(forced.code(), "git.cli_failed");
    assert!(path.exists());
}

/// git runs in the main worktree, so an engine opened in a linked worktree removes that very
/// worktree cleanly (from inside the folder, Windows refuses the deletion halfway).
#[test]
fn removes_the_worktree_the_engine_is_opened_in() {
    let f = Fixture::basic().with_linked_worktree();
    let path = f.worktree_path();
    let engine = Git2Engine::open(&path).expect("open the worktree");
    engine
        .worktree_remove(&path, false, &Cancel::never())
        .expect("remove");
    assert!(!path.exists());
    assert!(!porcelain(&f)
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &path)));
}

/// An entry whose folder is gone is unregistered by `remove` as by `prune` (git 2.54 accepts
/// a missing folder); the branch stays.
#[test]
fn removes_an_entry_whose_folder_is_gone() {
    let f = Fixture::basic()
        .with_linked_worktree()
        .with_broken_worktrees();
    let engine = engine(&f);
    let gone = f.sibling("wt-gone");
    engine
        .worktree_remove(&gone, false, &Cancel::never())
        .expect("remove a missing folder");
    assert!(!porcelain(&f)
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &gone)));
    assert_eq!(
        f.git(&["rev-parse", "--verify", "refs/heads/gone"]).len(),
        40
    );
}

/// The value of `-b` cannot be protected by `--`: an option-shaped name is refused before
/// git would hand it to `git branch` as an option (and move a branch).
#[test]
fn an_option_shaped_branch_name_is_refused_and_moves_nothing() {
    let f = Fixture::basic();
    let engine = engine(&f);
    let develop = f.rev("develop");
    let refused = engine
        .worktree_add(
            &WorktreeAdd {
                path: f.sibling("wt-dash"),
                branch: WorktreeBranch::New {
                    name: "--force".to_owned(),
                    start: "develop".to_owned(),
                    track: None,
                },
            },
            &Cancel::never(),
        )
        .expect_err("option-shaped");
    assert_eq!(refused.code(), "git.cli_failed");
    assert_eq!(f.rev("develop"), develop);
    assert!(!f.sibling("wt-dash").exists());
}

/// An add cancelled while git checks the tree out is rolled back: no entry, no folder, the
/// branch kept, as after a failure git cleans up itself.
#[test]
fn a_cancelled_add_is_rolled_back() {
    let mut f = Fixture::basic();
    for dir in 0..60 {
        for file in 0..40 {
            f.write(
                &format!("bulk/d{dir}/f{file}.txt"),
                &format!("{dir}-{file}\n"),
            );
        }
    }
    f.commit("bulk");
    let engine = std::sync::Arc::new(engine(&f));
    let path = f.sibling("wt-cancelled");
    let cancel = Cancel::new();
    let flag = cancel.clone();
    let request = WorktreeAdd {
        path: path.clone(),
        branch: WorktreeBranch::New {
            name: "cancelled".to_owned(),
            start: "main".to_owned(),
            track: None,
        },
    };
    let worker = std::sync::Arc::clone(&engine);
    let adding = std::thread::spawn(move || worker.worktree_add(&request, &flag));
    std::thread::sleep(std::time::Duration::from_millis(150));
    cancel.cancel();
    let result = adding.join().expect("thread");
    match result {
        // A fast disk finished the checkout before the flag was seen.
        Ok(added) => assert!(same_path(&added.path, &path)),
        Err(error) => {
            assert_eq!(error.code(), "op.cancelled");
            assert!(!path.exists(), "the partial folder is gone");
            assert!(!porcelain(&f)
                .iter()
                .any(|(p, _, _)| same_path(Path::new(p), &path)));
            assert!(engine
                .worktrees(&Cancel::never())
                .expect("list")
                .iter()
                .all(|w| !w.locked));
        }
    }
    assert_eq!(
        f.git(&["rev-parse", "--verify", "refs/heads/cancelled"])
            .len(),
        40
    );
}

/// A cancel that lands before git runs creates nothing and rolls nothing back: a folder that
/// was there before the add stays, with its files.
#[test]
fn a_cancel_before_git_runs_leaves_an_existing_folder_alone() {
    let f = Fixture::basic();
    let engine = engine(&f);
    let path = f.sibling("wt-precious");
    fs::create_dir_all(path.join("sub")).expect("folder");
    fs::write(path.join("sub").join("precious.txt"), "keep\n").expect("file");
    let cancel = Cancel::new();
    cancel.cancel();
    let refused = engine
        .worktree_add(
            &WorktreeAdd {
                path: path.clone(),
                branch: WorktreeBranch::Detached {
                    rev: "v1".to_owned(),
                },
            },
            &cancel,
        )
        .expect_err("cancelled");
    assert_eq!(refused.code(), "op.cancelled");
    assert!(path.join("sub").join("precious.txt").exists());
    assert!(!porcelain(&f)
        .iter()
        .any(|(p, _, _)| same_path(Path::new(p), &path)));
}

/// An entry whose admin directory libgit2 cannot open (its `gitdir` file gone) is pruned by
/// git and reported under its name.
#[test]
fn prunes_an_entry_libgit2_cannot_open() {
    let f = Fixture::basic().with_linked_worktree();
    let engine = engine(&f);
    let admin = f.git_dir().join("worktrees").join("wt-feature");
    fs::remove_file(admin.join("gitdir")).expect("drop the gitdir file");
    assert!(engine
        .worktrees(&Cancel::never())
        .expect("list")
        .iter()
        .all(|w| w.is_main));
    let pruned = engine.worktree_prune(&Cancel::never()).expect("prune");
    assert_eq!(pruned, vec![PathBuf::from("wt-feature")]);
    assert!(!admin.exists());
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
            track: None,
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

/// A new branch that tracks its start point, whatever `branch.autoSetupMerge` says; without
/// `track` git's setting decides, and under `false` there is no upstream.
#[test]
fn adds_a_new_branch_that_tracks_its_start_point() {
    let f = Fixture::basic().with_remote();
    let engine = engine(&f);
    // Without `track`, git's default decides: a remote-tracking start is tracked.
    let default = add(
        &f,
        &engine,
        f.sibling("wt-default"),
        WorktreeBranch::New {
            name: "default".to_owned(),
            start: "origin/develop".to_owned(),
            track: None,
        },
    );
    assert_eq!(
        f.git_in(
            &default,
            &["rev-parse", "--abbrev-ref", "default@{upstream}"]
        ),
        "origin/develop"
    );
    f.git(&["config", "branch.autoSetupMerge", "false"]);
    let tracking = add(
        &f,
        &engine,
        f.sibling("wt-tracking"),
        WorktreeBranch::New {
            name: "tracking".to_owned(),
            start: "origin/develop".to_owned(),
            track: Some(true),
        },
    );
    assert_eq!(
        f.git_in(
            &tracking,
            &["rev-parse", "--abbrev-ref", "tracking@{upstream}"]
        ),
        "origin/develop"
    );
    let plain = add(
        &f,
        &engine,
        f.sibling("wt-plain"),
        WorktreeBranch::New {
            name: "plain".to_owned(),
            start: "origin/develop".to_owned(),
            track: None,
        },
    );
    let (has_upstream, _, _) =
        f.try_git_in(&plain, &["rev-parse", "--abbrev-ref", "plain@{upstream}"]);
    assert!(
        !has_upstream,
        "no upstream under branch.autoSetupMerge=false"
    );
    // `Some(false)` is `--no-track`: no upstream even where git's setting would set one.
    f.git(&["config", "branch.autoSetupMerge", "always"]);
    let untracked = add(
        &f,
        &engine,
        f.sibling("wt-untracked"),
        WorktreeBranch::New {
            name: "untracked".to_owned(),
            start: "origin/develop".to_owned(),
            track: Some(false),
        },
    );
    let (has_upstream, _, _) = f.try_git_in(
        &untracked,
        &["rev-parse", "--abbrev-ref", "untracked@{upstream}"],
    );
    assert!(!has_upstream, "no upstream with --no-track");
}

/// `--track` from a remote-tracking ref that no remote fetches, or that two do: git creates
/// the branch, then refuses to track it, and leaves it behind. Refused before git, as a
/// tracking branch's creation is: nothing is created.
#[test]
fn refuses_to_track_a_ref_no_remote_or_two_remotes_fetch() {
    let f = Fixture::basic().with_remote();
    let engine = engine(&f);
    // A ref under refs/remotes that no fetch refspec maps.
    f.git(&["update-ref", "refs/remotes/stray/x", "main"]);
    // A second remote that fetches into origin's namespace too.
    let mirror = f.sibling("mirror.git");
    f.git(&[
        "init",
        "-q",
        "--bare",
        mirror.to_str().expect("utf-8 temp path"),
    ]);
    f.git(&[
        "remote",
        "add",
        "mirror",
        mirror.to_str().expect("utf-8 temp path"),
    ]);
    f.git(&[
        "config",
        "remote.mirror.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
    ]);
    for (name, start) in [
        ("stray", "refs/remotes/stray/x"),
        ("ambiguous", "refs/remotes/origin/develop"),
    ] {
        let path = f.sibling(&format!("wt-{name}"));
        let error = engine
            .worktree_add(
                &WorktreeAdd {
                    path: path.clone(),
                    branch: WorktreeBranch::New {
                        name: name.to_owned(),
                        start: start.to_owned(),
                        track: Some(true),
                    },
                },
                &Cancel::never(),
            )
            .expect_err("refused");
        assert!(
            error.to_string().contains("cannot be tracked"),
            "{name}: {error}"
        );
        assert!(!path.exists(), "{name}: no folder");
        let (exists, _, _) =
            f.try_git(&["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]);
        assert!(!exists, "{name}: no branch left behind");
    }
}
