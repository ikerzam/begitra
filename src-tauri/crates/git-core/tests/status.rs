//! `Git2Engine::status` against `git status --porcelain=v2` on fixture repositories.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{ChangeKind, StatusEntry, StatusOptions};
use support::Fixture;

/// One path of `git status --porcelain=v2`, reduced to what [`StatusEntry`] carries.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Expected {
    path: String,
    old_path: Option<String>,
    staged: Option<ChangeKind>,
    unstaged: Option<ChangeKind>,
    untracked: bool,
    ignored: bool,
    conflicted: bool,
}

impl Expected {
    fn plain(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            old_path: None,
            staged: None,
            unstaged: None,
            untracked: false,
            ignored: false,
            conflicted: false,
        }
    }

    fn from_entry(entry: &StatusEntry) -> Self {
        Self {
            path: entry.path.clone(),
            old_path: entry.old_path.clone(),
            staged: entry.staged,
            unstaged: entry.unstaged,
            untracked: entry.untracked,
            ignored: entry.ignored,
            conflicted: entry.conflicted,
        }
    }
}

fn kind(letter: char) -> Option<ChangeKind> {
    match letter {
        'A' => Some(ChangeKind::Added),
        'M' => Some(ChangeKind::Modified),
        'D' => Some(ChangeKind::Deleted),
        'R' => Some(ChangeKind::Renamed),
        'C' => Some(ChangeKind::Copied),
        'T' => Some(ChangeKind::TypeChanged),
        'U' => Some(ChangeKind::Unmerged),
        '.' => None,
        other => panic!("unexpected status letter {other:?}"),
    }
}

/// Parses one porcelain v2 line (`1`, `2`, `u`, `?` and `!` records).
fn parse_line(line: &str) -> Expected {
    let (record, rest) = line.split_once(' ').expect("record type");
    match record {
        "1" => {
            // XY sub mH mI mW hH hI path
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            let mut xy = fields[0].chars();
            let mut expected = Expected::plain(fields[7]);
            expected.staged = kind(xy.next().expect("x"));
            expected.unstaged = kind(xy.next().expect("y"));
            expected
        }
        "2" => {
            // XY sub mH mI mW hH hI Xscore path<TAB>origPath
            let fields: Vec<&str> = rest.splitn(9, ' ').collect();
            let (path, orig) = fields[8].split_once('\t').expect("rename paths");
            let mut xy = fields[0].chars();
            let mut expected = Expected::plain(path);
            expected.old_path = Some(orig.to_owned());
            expected.staged = kind(xy.next().expect("x"));
            expected.unstaged = kind(xy.next().expect("y"));
            expected
        }
        "u" => {
            // XY sub m1 m2 m3 mW h1 h2 h3 path
            let fields: Vec<&str> = rest.splitn(10, ' ').collect();
            let mut expected = Expected::plain(fields[9]);
            expected.unstaged = Some(ChangeKind::Unmerged);
            expected.conflicted = true;
            expected
        }
        "?" => {
            let mut expected = Expected::plain(rest);
            expected.untracked = true;
            expected
        }
        "!" => {
            let mut expected = Expected::plain(rest);
            expected.ignored = true;
            expected
        }
        other => panic!("unexpected porcelain record {other:?}: {line}"),
    }
}

/// `git status --porcelain=v2 --untracked-files=all [--ignored]`, sorted by path.
fn porcelain(f: &Fixture, ignored: bool) -> Vec<Expected> {
    let mut args = vec!["status", "--porcelain=v2", "--untracked-files=all"];
    if ignored {
        args.push("--ignored");
    }
    let output = f.git(&args);
    let mut expected: Vec<Expected> = output
        .lines()
        .filter(|line| !line.is_empty())
        .map(parse_line)
        .collect();
    expected.sort_by(|a, b| a.path.cmp(&b.path));
    expected
}

fn engine_status(f: &Fixture, options: &StatusOptions) -> Vec<StatusEntry> {
    Git2Engine::open(&f.root)
        .expect("open")
        .status(options, &Cancel::never())
        .expect("status")
}

fn observed(f: &Fixture, options: &StatusOptions) -> Vec<Expected> {
    let entries = engine_status(f, options);
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    assert_eq!(paths, sorted, "entries must be sorted by path bytes");
    let mut result: Vec<Expected> = entries.iter().map(Expected::from_entry).collect();
    result.sort_by(|a, b| a.path.cmp(&b.path));
    result
}

#[test]
fn mixed_status_matches_porcelain_v2_and_omits_ignored_by_default() {
    let f = Fixture::basic().with_mixed_status();
    let entries = observed(&f, &StatusOptions::default());
    assert_eq!(entries, porcelain(&f, false));
    assert!(entries.iter().all(|e| e.path != "ignored.log"));
    assert!(entries.iter().any(|e| e.path == "staged.txt"
        && e.staged == Some(ChangeKind::Added)
        && e.unstaged.is_none()));
    assert!(entries.iter().any(|e| e.path == "README.md"
        && e.staged.is_none()
        && e.unstaged == Some(ChangeKind::Modified)));
    assert!(entries
        .iter()
        .any(|e| e.path == "untracked.txt" && e.untracked && e.unstaged.is_none()));
}

#[test]
fn ignored_files_are_listed_when_requested() {
    let f = Fixture::basic().with_mixed_status();
    let options = StatusOptions {
        include_ignored: true,
        ..StatusOptions::default()
    };
    let entries = observed(&f, &options);
    assert_eq!(entries, porcelain(&f, true));
    assert!(entries
        .iter()
        .any(|e| e.path == "ignored.log" && e.ignored && !e.untracked));
}

#[test]
fn untracked_files_can_be_left_out() {
    let f = Fixture::basic().with_mixed_status();
    let options = StatusOptions {
        include_untracked: false,
        ..StatusOptions::default()
    };
    let entries = observed(&f, &options);
    assert!(entries.iter().all(|e| !e.untracked), "{entries:?}");
    assert_eq!(entries.len(), 2, "{entries:?}");
}

#[test]
fn untracked_directories_are_expanded_file_by_file() {
    let f = Fixture::basic();
    f.write("newdir/a.txt", "a\n");
    f.write("newdir/sub/b.txt", "b\n");
    let entries = observed(&f, &StatusOptions::default());
    assert_eq!(entries, porcelain(&f, false));
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, ["newdir/a.txt", "newdir/sub/b.txt"]);
}

#[test]
fn staged_rename_with_an_edit_matches_porcelain_v2() {
    let mut f = Fixture::basic();
    let lines: Vec<String> = (1..=20)
        .map(|i| format!("pub fn f{i}() -> u32 {{ {i} }}"))
        .collect();
    f.write("src/lib.rs", &(lines.join("\n") + "\n"));
    f.commit("grow lib");
    f.git(&["mv", "src/lib.rs", "src/core.rs"]);
    let mut renamed = lines;
    renamed[4] = "pub fn f5() -> u32 { 50 }".to_owned();
    f.write("src/core.rs", &(renamed.join("\n") + "\n"));
    f.git(&["add", "src/core.rs"]);

    let entries = observed(&f, &StatusOptions::default());
    assert_eq!(entries, porcelain(&f, false));
    let rename = entries
        .iter()
        .find(|e| e.path == "src/core.rs")
        .expect("renamed entry");
    assert_eq!(rename.staged, Some(ChangeKind::Renamed));
    assert_eq!(rename.old_path.as_deref(), Some("src/lib.rs"));
    assert_eq!(rename.unstaged, None);
}

#[test]
fn rename_detection_can_be_switched_off() {
    let mut f = Fixture::basic();
    let lines: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
    f.write("notes.txt", &(lines.join("\n") + "\n"));
    f.commit("add notes");
    f.git(&["mv", "notes.txt", "moved.txt"]);
    let options = StatusOptions {
        renames: false,
        ..StatusOptions::default()
    };
    let entries = observed(&f, &options);
    let paths: Vec<(&str, Option<ChangeKind>)> = entries
        .iter()
        .map(|e| (e.path.as_str(), e.staged))
        .collect();
    assert_eq!(
        paths,
        [
            ("moved.txt", Some(ChangeKind::Added)),
            ("notes.txt", Some(ChangeKind::Deleted)),
        ]
    );
}

#[test]
fn deletions_staged_and_unstaged_match_porcelain_v2() {
    let f = Fixture::basic();
    f.git(&["rm", "-q", "src/dev.rs"]);
    f.remove("docs/guide.md");
    let entries = observed(&f, &StatusOptions::default());
    assert_eq!(entries, porcelain(&f, false));
    assert!(entries
        .iter()
        .any(|e| e.path == "src/dev.rs" && e.staged == Some(ChangeKind::Deleted)));
    assert!(entries
        .iter()
        .any(|e| e.path == "docs/guide.md" && e.unstaged == Some(ChangeKind::Deleted)));
}

#[test]
fn staged_then_modified_file_carries_both_states() {
    let f = Fixture::basic();
    f.write("both.txt", "one\n");
    f.git(&["add", "both.txt"]);
    f.append("both.txt", "two\n");
    let entries = observed(&f, &StatusOptions::default());
    assert_eq!(entries, porcelain(&f, false));
    let both = entries
        .iter()
        .find(|e| e.path == "both.txt")
        .expect("entry");
    assert_eq!(both.staged, Some(ChangeKind::Added));
    assert_eq!(both.unstaged, Some(ChangeKind::Modified));
}

#[test]
fn merge_conflict_is_reported_as_unmerged() {
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "conflict"]);
    f.write("README.md", "# Conflict A\n");
    f.commit("a: edit readme");
    f.git(&["checkout", "-q", "main"]);
    f.write("README.md", "# Conflict B\n");
    f.commit("b: edit readme");
    let (ok, _, _) = f.try_git(&["merge", "conflict"]);
    assert!(!ok, "the merge must conflict");

    let entries = observed(&f, &StatusOptions::default());
    assert_eq!(entries, porcelain(&f, false));
    let readme = entries
        .iter()
        .find(|e| e.path == "README.md")
        .expect("conflicted entry");
    assert!(readme.conflicted);
    assert_eq!(readme.unstaged, Some(ChangeKind::Unmerged));
    assert_eq!(readme.staged, None);
}

#[test]
fn clean_working_tree_has_no_entries() {
    let f = Fixture::basic();
    assert!(engine_status(&f, &StatusOptions::default()).is_empty());
}

#[test]
fn unborn_repository_reports_staged_and_untracked_files() {
    let f = Fixture::unborn();
    f.write("first.txt", "first\n");
    f.git(&["add", "first.txt"]);
    f.write("loose.txt", "loose\n");
    let entries = observed(&f, &StatusOptions::default());
    assert_eq!(entries, porcelain(&f, false));
    assert!(entries
        .iter()
        .any(|e| e.path == "first.txt" && e.staged == Some(ChangeKind::Added)));
    assert!(entries.iter().any(|e| e.path == "loose.txt" && e.untracked));
}

#[test]
fn paths_with_spaces_and_unicode_are_reported_as_git_prints_them() {
    let f = Fixture::basic();
    f.write("dir with space/ünïcödé.txt", "x\n");
    let entries = engine_status(&f, &StatusOptions::default());
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "dir with space/ünïcödé.txt");
    assert!(entries[0].untracked);
}

#[test]
fn a_deleted_file_reappearing_untracked_is_a_deletion_plus_an_untracked_path() {
    // `git status` never pairs a deleted tracked file with a similar untracked file (rename
    // detection only runs between HEAD and the index), so the engine reports `D` plus `??`
    // and the path set stays equal to git's.
    let mut f = Fixture::basic();
    let lines: Vec<String> = (1..=20).map(|i| format!("line {i}")).collect();
    f.write("notes.txt", &(lines.join("\n") + "\n"));
    f.commit("add notes");
    f.remove("notes.txt");
    f.write("moved.txt", &(lines.join("\n") + "\n"));
    let entries = engine_status(&f, &StatusOptions::default());
    let deleted = entries
        .iter()
        .find(|e| e.path == "notes.txt")
        .expect("deleted entry");
    assert_eq!(deleted.unstaged, Some(ChangeKind::Deleted));
    assert_eq!(deleted.old_path, None);
    let moved = entries
        .iter()
        .find(|e| e.path == "moved.txt")
        .expect("untracked entry");
    assert!(moved.untracked);
    assert_eq!(moved.unstaged, None);
    let porcelain = f.git(&["status", "--porcelain=v2", "--untracked-files=all"]);
    assert!(
        porcelain
            .lines()
            .any(|l| l.starts_with("1 .D") && l.ends_with("notes.txt")),
        "{porcelain}"
    );
    assert!(porcelain.lines().any(|l| l == "? moved.txt"), "{porcelain}");
    let ours: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(ours, vec!["moved.txt", "notes.txt"]);
}

#[test]
fn cancelled_status_stops_with_cancelled() {
    let f = Fixture::basic().with_mixed_status();
    let cancel = Cancel::new();
    cancel.cancel();
    let error = Git2Engine::open(&f.root)
        .expect("open")
        .status(&StatusOptions::default(), &cancel)
        .expect_err("must be cancelled");
    assert!(matches!(error, GitError::Cancelled), "{error:?}");
}

#[test]
fn a_truncated_head_is_reported_as_corrupt() {
    let f = Fixture::basic();
    let hash = f.truncate_object("HEAD");
    let engine = Git2Engine::open(&f.root).expect("open");
    match engine
        .status(&StatusOptions::default(), &Cancel::never())
        .expect_err("must fail")
    {
        GitError::CorruptObject { hash: reported, .. } => assert_eq!(reported, hash),
        other => panic!("unexpected error {other:?}"),
    }
}
