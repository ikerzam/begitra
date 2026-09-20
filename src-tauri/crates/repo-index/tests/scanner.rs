//! The scanner against temporary trees: depth, skip list, worktrees, submodules, symlinks,
//! missing folders and cancellation.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use repo_index::scanner::scan;
use repo_index::{Cancel, Found, RepoKind, ScanEvent, ScanOptions};

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A fresh repository with one commit at `path`.
fn init_repo(path: &Path) {
    fs::create_dir_all(path).expect("mkdir");
    git(path, &["init", "-q", "-b", "main"]);
    git(path, &["config", "user.email", "t@x"]);
    git(path, &["config", "user.name", "t"]);
    fs::write(path.join("README.md"), "hi\n").expect("write");
    git(path, &["add", "README.md"]);
    git(path, &["commit", "-q", "-m", "init"]);
}

fn run(folders: &[PathBuf], options: &ScanOptions) -> Vec<ScanEvent> {
    let mut events = Vec::new();
    scan(folders, options, &Cancel::never(), |event| {
        events.push(event);
        std::ops::ControlFlow::Continue(())
    });
    events
}

fn found(events: &[ScanEvent]) -> Vec<&Found> {
    events
        .iter()
        .filter_map(|event| match event {
            ScanEvent::Found(found) => Some(found),
            _ => None,
        })
        .collect()
}

#[test]
fn finds_repositories_at_several_depths_and_never_enters_them() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("code");
    init_repo(&root.join("alpha"));
    init_repo(&root.join("team").join("beta"));
    init_repo(&root.join("team").join("deep").join("gamma"));
    // A repository inside a repository's working tree is not visited.
    init_repo(&root.join("alpha").join("vendor").join("nested"));
    let events = run(std::slice::from_ref(&root), &ScanOptions::default());
    let mut names: Vec<&str> = found(&events).iter().map(|f| f.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["alpha", "beta", "gamma"]);
    let alpha = found(&events)
        .into_iter()
        .find(|f| f.name == "alpha")
        .expect("alpha");
    assert_eq!(alpha.kind, RepoKind::Main);
    assert_eq!(alpha.scan_root, root);
    assert!(alpha.parent_path.is_none());
    assert!(matches!(
        events.last(),
        Some(ScanEvent::FolderDone { found: 3, .. })
    ));
    assert!(events
        .iter()
        .any(|e| matches!(e, ScanEvent::FolderStarted { .. })));
}

#[test]
fn a_linked_worktree_belongs_to_its_repository_and_a_submodule_is_skipped() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("code");
    let main = root.join("main");
    init_repo(&main);
    let wt = root.join("wt").join("feature");
    fs::create_dir_all(root.join("wt")).expect("mkdir");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            wt.to_str().expect("utf-8"),
            "-b",
            "feature",
        ],
    );
    // A submodule checkout: a `.git` file pointing at the parent's modules folder.
    let sub = root.join("app").join("libs").join("sub");
    fs::create_dir_all(&sub).expect("mkdir");
    fs::write(sub.join(".git"), "gitdir: ../../.git/modules/libs/sub\n").expect("write");
    let events = run(std::slice::from_ref(&root), &ScanOptions::default());
    let list = found(&events);
    let worktree = list.iter().find(|f| f.name == "feature").expect("worktree");
    assert_eq!(worktree.kind, RepoKind::Worktree);
    assert_eq!(
        worktree.parent_path.as_deref().map(normalise),
        Some(normalise(&main))
    );
    assert!(list.iter().all(|f| f.name != "sub"));
}

fn normalise(path: &Path) -> PathBuf {
    path.components().collect()
}

#[test]
fn skips_the_skip_list_symlinks_and_anything_deeper_than_the_limit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("code");
    init_repo(&root.join("node_modules").join("hidden"));
    init_repo(&root.join("Target").join("also-hidden"));
    init_repo(&root.join("a").join("b").join("c").join("too-deep"));
    init_repo(&root.join("visible"));
    #[cfg(unix)]
    {
        let elsewhere = dir.path().join("elsewhere");
        init_repo(&elsewhere.join("linked"));
        std::os::unix::fs::symlink(&elsewhere, root.join("link")).expect("symlink");
    }
    let options = ScanOptions {
        max_depth: 2,
        ..ScanOptions::default()
    };
    let events = run(&[root], &options);
    let mut names: Vec<&str> = found(&events).iter().map(|f| f.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["visible"]);
}

#[test]
fn a_missing_folder_is_reported_and_the_others_are_scanned() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("code");
    init_repo(&root.join("alpha"));
    let missing = dir.path().join("gone");
    let events = run(&[missing.clone(), root], &ScanOptions::default());
    assert!(events.iter().any(|e| matches!(
        e,
        ScanEvent::FolderError { folder, reason } if *folder == missing && !reason.is_empty()
    )));
    assert_eq!(found(&events).len(), 1);
}

#[test]
fn progress_is_reported_and_a_cancel_stops_quickly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("code");
    for i in 0..400 {
        fs::create_dir_all(root.join(format!("d{i}")).join("x")).expect("mkdir");
    }
    init_repo(&root.join("d399").join("repo"));
    let events = run(std::slice::from_ref(&root), &ScanOptions::default());
    assert!(events
        .iter()
        .any(|e| matches!(e, ScanEvent::Progress { scanned, .. } if *scanned >= 50)));
    assert_eq!(found(&events).len(), 1);

    let cancel = Cancel::new();
    let started = Instant::now();
    let mut seen = 0;
    scan(&[root], &ScanOptions::default(), &cancel, |event| {
        seen += 1;
        if matches!(event, ScanEvent::Progress { .. }) {
            cancel.cancel();
        }
        std::ops::ControlFlow::Continue(())
    });
    assert!(started.elapsed() < Duration::from_millis(200));
    assert!(seen < 30, "{seen} events after a cancel");
}

#[test]
fn a_callback_can_stop_the_scan() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("code");
    for name in ["a", "b", "c"] {
        init_repo(&root.join(name));
    }
    let mut count = 0;
    scan(
        &[root],
        &ScanOptions::default(),
        &Cancel::never(),
        |event| {
            if matches!(event, ScanEvent::Found(_)) {
                count += 1;
                return std::ops::ControlFlow::Break(());
            }
            std::ops::ControlFlow::Continue(())
        },
    );
    assert_eq!(count, 1);
}
