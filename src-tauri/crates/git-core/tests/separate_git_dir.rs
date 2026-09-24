//! A repository whose git directory lives elsewhere (`git init --separate-git-dir`, `git clone
//! --separate-git-dir`): its `.git` is a file that names the directory, and the working tree
//! is the folder that file sits in, which every read and write must use.

mod support;

use std::path::{Path, PathBuf};
use std::sync::Once;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    BlobAt, ChangeKind, DiffOptions, DiffTarget, StatusEntry, StatusOptions, WorkingTreeBase,
    WorktreeAdd, WorktreeBranch,
};
use support::{canonical, Fixture};

/// Every git of this file refuses a git directory it would find by itself
/// (`safe.bareRepository=explicit`, as a hardened configuration sets it): the engine must name
/// the one it means. Once per process, before the first fixture.
fn explicit_repositories_only() {
    static SET: Once = Once::new();
    SET.call_once(|| {
        std::env::set_var("GIT_CONFIG_COUNT", "1");
        std::env::set_var("GIT_CONFIG_KEY_0", "safe.bareRepository");
        std::env::set_var("GIT_CONFIG_VALUE_0", "explicit");
    });
}

/// The basic fixture with its git directory moved beside the working tree, then an edit of a
/// tracked file and an untracked file.
fn separated() -> (Fixture, PathBuf) {
    explicit_repositories_only();
    let f = Fixture::basic();
    let gitdir = f.sibling("separate.git");
    f.git(&[
        "init",
        "-q",
        "--separate-git-dir",
        gitdir.to_str().expect("utf-8 temp path"),
    ]);
    f.append("src/lib.rs", "pub fn two() -> u32 {\n    2\n}\n");
    f.write("notes.txt", "untracked\n");
    (f, gitdir)
}

fn assert_same_path(actual: &Path, expected: &Path) {
    assert_eq!(
        canonical(actual),
        canonical(expected),
        "{} vs {}",
        actual.display(),
        expected.display()
    );
}

/// `(path, unstaged change, untracked)` of each entry, sorted.
fn listed(entries: &[StatusEntry]) -> Vec<(String, Option<ChangeKind>, bool)> {
    let mut listed: Vec<_> = entries
        .iter()
        .map(|entry| (entry.path.clone(), entry.unstaged, entry.untracked))
        .collect();
    listed.sort_by(|a, b| a.0.cmp(&b.0));
    listed
}

fn working_tree(base: WorkingTreeBase) -> DiffTarget {
    DiffTarget::WorkingTree { base }
}

#[test]
fn opens_with_the_folder_its_git_file_sits_in() {
    let (f, gitdir) = separated();
    for path in [f.root.clone(), f.root.join("src")] {
        let engine = Git2Engine::open(&path).expect("open");
        let repo = engine.repo();
        assert_same_path(&repo.root, &f.root);
        assert_same_path(&repo.common_dir, &gitdir);
        assert_eq!(repo.current_branch.as_deref(), Some("main"));
        assert!(!repo.is_linked_worktree);
        let (own, shared) = engine.git_dirs();
        assert_same_path(&own, &gitdir);
        assert_same_path(&shared, &gitdir);
    }
}

#[test]
fn the_status_lists_the_working_tree_the_git_file_names() {
    let (f, _) = separated();
    let engine = Git2Engine::open(&f.root).expect("open");
    let expected = vec![
        ("notes.txt".to_owned(), None, true),
        ("src/lib.rs".to_owned(), Some(ChangeKind::Modified), false),
    ];
    let options = StatusOptions::default();
    let through_git = engine.status(&options, &Cancel::never()).expect("status");
    assert_eq!(listed(&through_git), expected);
    let through_libgit2 = engine
        .status_through_libgit2(&options, &Cancel::never())
        .expect("status through libgit2");
    assert_eq!(listed(&through_libgit2), expected);
}

#[test]
fn the_working_tree_diffs_read_the_working_tree() {
    let (f, _) = separated();
    let engine = Git2Engine::open(&f.root).expect("open");
    let cancel = Cancel::never();
    let options = DiffOptions::default();
    let paths = |target: &DiffTarget| -> Vec<(String, ChangeKind)> {
        engine
            .diff(target, &options, &cancel)
            .expect("diff")
            .files
            .into_iter()
            .map(|file| (file.path, file.status))
            .collect()
    };
    assert_eq!(
        paths(&working_tree(WorkingTreeBase::Index)),
        vec![
            ("notes.txt".to_owned(), ChangeKind::Added),
            ("src/lib.rs".to_owned(), ChangeKind::Modified),
        ]
    );
    assert_eq!(
        paths(&working_tree(WorkingTreeBase::Head)),
        vec![("src/lib.rs".to_owned(), ChangeKind::Modified)]
    );
    let restricted = engine
        .diff_paths(
            &working_tree(WorkingTreeBase::Index),
            &options,
            &["src/lib.rs".to_owned()],
            &cancel,
        )
        .expect("restricted diff")
        .expect("under the cap");
    assert_eq!(restricted.files.len(), 1);
    assert_eq!(restricted.files[0].path, "src/lib.rs");
    assert_eq!(restricted.additions, 3);
}

#[test]
fn a_working_file_is_read_from_the_working_tree() {
    let (f, _) = separated();
    let engine = Git2Engine::open(&f.root).expect("open");
    let blob = engine
        .read_blob(&BlobAt::WorkingTree, "src/lib.rs")
        .expect("read");
    assert_eq!(
        blob.text.as_deref(),
        Some("pub fn one() -> u32 {\n    1\n}\npub fn two() -> u32 {\n    2\n}\n")
    );
}

#[test]
fn the_main_worktree_is_the_folder_opened() {
    let (f, _) = separated();
    let engine = Git2Engine::open(&f.root).expect("open");
    let worktrees = engine.worktrees(&Cancel::never()).expect("worktrees");
    assert_eq!(worktrees.len(), 1);
    assert!(worktrees[0].is_main);
    assert_same_path(&worktrees[0].path, &f.root);
}

#[test]
fn seen_from_a_linked_worktree_the_main_one_is_where_git_says() {
    // git cannot tell where the main working tree of a separate git directory is from the
    // directory alone, and `git worktree list` names the directory itself; libgit2 would
    // guess the directory's parent, a folder that holds no working tree.
    let (f, gitdir) = separated();
    let linked = f.sibling("linked");
    f.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/linked",
        linked.to_str().expect("utf-8 temp path"),
    ]);
    let engine = Git2Engine::open(&linked).expect("open");
    assert_same_path(&engine.repo().root, &linked);
    let worktrees = engine.worktrees(&Cancel::never()).expect("worktrees");
    let main = worktrees
        .iter()
        .find(|worktree| worktree.is_main)
        .expect("main worktree");
    assert_same_path(&main.path, &gitdir);
    let listed = f.git_in(&linked, &["worktree", "list", "--porcelain"]);
    let first = listed
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("worktree "))
        .expect("git names the main worktree");
    assert_same_path(&main.path, Path::new(first));
}

#[test]
fn the_git_directory_itself_is_not_a_working_tree() {
    // Opened by its own path, libgit2 takes the directory's parent as the working tree; git
    // refuses to run there ("must be run in a work tree"), and a stage would read every
    // tracked file as deleted.
    let (_f, gitdir) = separated();
    for path in [gitdir.clone(), gitdir.join("refs")] {
        match Git2Engine::open(&path) {
            Err(GitError::Invalid { .. }) => {}
            other => panic!("{} opened: {other:?}", path.display()),
        }
    }
}

#[test]
fn a_standard_git_folder_opened_by_its_path_keeps_its_working_tree() {
    let f = Fixture::basic();
    let engine = Git2Engine::open(&f.git_dir()).expect("open");
    assert_same_path(&engine.repo().root, &f.root);
}

#[test]
fn the_worktree_commands_name_a_git_directory_git_would_not_find() {
    // From a linked worktree the main one is listed at the git directory, where git refuses
    // to find a repository by itself under `safe.bareRepository=explicit`.
    let (f, _) = separated();
    let linked = f.sibling("linked");
    f.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature/linked",
        linked.to_str().expect("utf-8 temp path"),
    ]);
    let engine = Git2Engine::open(&linked).expect("open");
    let cancel = Cancel::never();
    let added = f.sibling("added");
    let worktree = engine
        .worktree_add(
            &WorktreeAdd {
                path: added.clone(),
                branch: WorktreeBranch::New {
                    name: "feature/added".to_owned(),
                    start: "HEAD".to_owned(),
                },
            },
            &cancel,
        )
        .expect("add");
    assert_same_path(&worktree.path, &added);
    engine
        .worktree_lock(&added, Some("kept"), &cancel)
        .expect("lock");
    engine.worktree_unlock(&added, &cancel).expect("unlock");
    engine
        .worktree_remove(&added, false, &cancel)
        .expect("remove");
    assert!(!added.exists());
    assert!(engine.worktree_prune(&cancel).expect("prune").is_empty());
}

#[test]
fn a_git_directory_that_names_its_working_tree_opens_it() {
    // `core.worktree` names the working tree, which holds no `.git`: the directory opens by
    // its own path, and every second handle reopens from it.
    let f = Fixture::empty();
    let gitdir = f.sibling("named.git");
    let tree = f.sibling("tree");
    std::fs::create_dir_all(&tree).expect("create the tree");
    let named = |args: &[&str]| {
        let mut all = vec![
            format!("--git-dir={}", gitdir.display()),
            format!("--work-tree={}", tree.display()),
        ];
        all.extend(args.iter().map(|arg| (*arg).to_owned()));
        let all: Vec<&str> = all.iter().map(String::as_str).collect();
        f.git_in(&tree, &all)
    };
    named(&["init", "-q", "-b", "main"]);
    named(&["config", "user.name", "Fixture"]);
    named(&["config", "user.email", "fixture@example.com"]);
    std::fs::write(
        tree.join("a.txt"),
        "a
",
    )
    .expect("write");
    named(&["add", "a.txt"]);
    named(&["commit", "-q", "-m", "a"]);
    std::fs::write(
        tree.join("a.txt"),
        "a
b
",
    )
    .expect("write");
    let engine = Git2Engine::open(&gitdir).expect("open");
    assert_same_path(&engine.repo().root, &tree);
    let listed = engine
        .diff(
            &working_tree(WorkingTreeBase::Index),
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect("diff");
    assert_eq!(listed.files.len(), 1);
    assert_eq!(listed.files[0].path, "a.txt");
    // Seen from a linked worktree, the main one is the folder the setting names.
    let linked = f.sibling("linked");
    named(&[
        "worktree",
        "add",
        "-q",
        linked.to_str().expect("utf-8 temp path"),
    ]);
    let from_linked = Git2Engine::open(&linked).expect("open");
    let worktrees = from_linked.worktrees(&Cancel::never()).expect("worktrees");
    assert_same_path(&worktrees[0].path, &tree);
}

#[test]
fn a_linked_worktrees_own_directory_opens_its_working_tree() {
    let f = Fixture::basic().with_linked_worktree();
    let private = f.git_dir().join("worktrees").join("wt-feature");
    let engine = Git2Engine::open(&private).expect("open");
    assert_same_path(&engine.repo().root, &f.worktree_path());
    assert!(engine.repo().is_linked_worktree);
}

#[test]
fn a_submodules_own_directory_opens_its_working_tree() {
    let mut f = Fixture::basic();
    let source = f.sibling("subsrc");
    let source_path = source.to_str().expect("utf-8 temp path").to_owned();
    f.git(&["init", "-q", "-b", "main", &source_path]);
    std::fs::write(
        source.join("s.txt"),
        "s
",
    )
    .expect("write");
    f.git_in(&source, &["add", "s.txt"]);
    f.git_in(&source, &["commit", "-q", "-m", "s"]);
    f.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        &source_path,
        "sub",
    ]);
    f.commit("add submodule");
    let engine = Git2Engine::open(&f.git_dir().join("modules").join("sub")).expect("open");
    assert_same_path(&engine.repo().root, &f.root.join("sub"));
}

#[test]
fn a_bare_repository_is_not_opened() {
    let f = Fixture::empty();
    let bare = f.sibling("bare.git");
    f.git(&[
        "init",
        "-q",
        "--bare",
        bare.to_str().expect("utf-8 temp path"),
    ]);
    match Git2Engine::open(&bare) {
        Err(GitError::Invalid { reason, .. }) => {
            assert_eq!(reason, "bare repositories are not supported");
        }
        other => panic!("a bare repository opened: {other:?}"),
    }
}
