//! The index snapshot and the paths two snapshots differ in: what an `index` change moved.

mod support;

use std::fs;

use git_core::git2_engine::index_snapshot::IndexSnapshot;
use support::Fixture;

fn snapshot(f: &Fixture) -> IndexSnapshot {
    IndexSnapshot::read(&f.git_dir().join("index")).expect("read the index")
}

/// The paths `after` differs from `before` in, and whether an unmerged entry moved.
fn changes(before: &IndexSnapshot, after: &IndexSnapshot) -> (Vec<String>, bool) {
    let changes = before.changes(after, usize::MAX);
    (changes.paths.expect("UTF-8 paths"), changes.conflicts)
}

fn owned(paths: &[&str]) -> Vec<String> {
    paths.iter().map(|path| (*path).to_owned()).collect()
}

#[test]
fn a_staged_file_is_named_alone() {
    let f = Fixture::basic();
    let before = snapshot(&f);
    f.append("README.md", "staged\n");
    f.git(&["add", "README.md"]);
    assert_eq!(
        changes(&before, &snapshot(&f)),
        (owned(&["README.md"]), false)
    );
}

#[test]
fn a_refresh_of_the_stat_data_names_nothing() {
    let f = Fixture::basic();
    let index = f.git_dir().join("index");
    let before = snapshot(&f);
    let bytes = fs::read(&index).expect("index");
    // Every tracked file written again with its own content: new stat data, the same
    // entries, which a plain status writes back. The time is set outright: a rewrite within
    // the clock tick of the checkout (about 16 ms on Windows) keeps the time git recorded.
    let stamp = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
    for path in f.git(&["ls-files"]).lines() {
        let content = fs::read(f.root.join(path)).expect("read");
        fs::write(f.root.join(path), content).expect("write");
        fs::File::options()
            .write(true)
            .open(f.root.join(path))
            .and_then(|file| file.set_modified(stamp))
            .expect("set the modification time");
    }
    f.git(&["status", "--porcelain"]);
    assert_ne!(
        fs::read(&index).expect("index"),
        bytes,
        "git rewrote the index"
    );
    assert_eq!(changes(&before, &snapshot(&f)), (Vec::new(), false));
}

#[test]
fn a_conflict_moves_the_unmerged_entries() {
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "conflict"]);
    f.write("README.md", "# Conflict A\n");
    f.commit("a: edit readme");
    f.git(&["checkout", "-q", "main"]);
    f.write("README.md", "# Conflict B\n");
    f.commit("b: edit readme");
    let before = snapshot(&f);
    let (ok, _, _) = f.try_git(&["merge", "conflict"]);
    assert!(!ok, "the merge must conflict");
    let during = snapshot(&f);
    assert_eq!(changes(&before, &during), (owned(&["README.md"]), true));
    // Resolving it removes the stages.
    f.write("README.md", "# Resolved\n");
    f.git(&["add", "README.md"]);
    assert_eq!(
        changes(&during, &snapshot(&f)),
        (owned(&["README.md"]), true)
    );
}

#[test]
fn a_flag_git_honours_is_a_change() {
    let f = Fixture::basic();
    let before = snapshot(&f);
    f.git(&["update-index", "--assume-unchanged", "README.md"]);
    let assumed = snapshot(&f);
    assert_eq!(changes(&before, &assumed), (owned(&["README.md"]), false));
    f.git(&["update-index", "--skip-worktree", "src/lib.rs"]);
    assert_eq!(
        changes(&assumed, &snapshot(&f)),
        (owned(&["src/lib.rs"]), false)
    );
}

#[test]
fn removed_and_added_entries_are_named_in_order() {
    let f = Fixture::basic();
    let before = snapshot(&f);
    f.git(&["rm", "-q", "--cached", "docs/guide.md"]);
    f.write("added.txt", "a\n");
    f.git(&["add", "added.txt"]);
    f.write("intent.txt", "i\n");
    f.git(&["add", "-N", "intent.txt"]);
    assert_eq!(
        changes(&before, &snapshot(&f)),
        (owned(&["added.txt", "docs/guide.md", "intent.txt"]), false)
    );
}

#[test]
fn a_split_index_is_refused_cleanly() {
    let f = Fixture::basic();
    f.git(&["update-index", "--split-index"]);
    assert!(IndexSnapshot::read(&f.git_dir().join("index")).is_err());
}

#[test]
fn a_repository_without_an_index_file_starts_empty() {
    let f = Fixture::empty();
    let index = f.git_dir().join("index");
    assert!(!index.exists(), "git init writes no index");
    let before = snapshot(&f);
    f.write("new.txt", "new\n");
    f.git(&["add", "new.txt"]);
    assert_eq!(
        changes(&before, &snapshot(&f)),
        (owned(&["new.txt"]), false)
    );
}
