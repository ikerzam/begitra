//! `Git2Engine::diff` against the git CLI on fixture repositories and its error mapping on
//! damaged object stores.

mod support;

use std::fs;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    ChangeKind, ChangeSet, DiffOptions, DiffTarget, FileChange, LineKind, Span, WorkingTreeBase,
};
use support::Fixture;

/// `(status letter, path, old path)` as `git diff --name-status` prints them.
type NameStatus = (String, String, Option<String>);

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open")
}

fn diff_with(f: &Fixture, target: &DiffTarget, options: &DiffOptions) -> ChangeSet {
    engine(f)
        .diff(target, options, &Cancel::never())
        .expect("diff")
}

fn diff(f: &Fixture, target: &DiffTarget) -> ChangeSet {
    diff_with(f, target, &DiffOptions::default())
}

fn commit(hash: &str) -> DiffTarget {
    DiffTarget::Commit {
        hash: hash.to_owned(),
    }
}

fn commits(from: &str, to: &str) -> DiffTarget {
    DiffTarget::Commits {
        from: from.to_owned(),
        to: to.to_owned(),
    }
}

fn range(from: &str, to: &str, three_dot: bool) -> DiffTarget {
    DiffTarget::Range {
        from: from.to_owned(),
        to: to.to_owned(),
        three_dot,
    }
}

fn letter(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::Added => "A",
        ChangeKind::Modified => "M",
        ChangeKind::Deleted => "D",
        ChangeKind::Renamed => "R",
        ChangeKind::Copied => "C",
        ChangeKind::TypeChanged => "T",
        ChangeKind::Unmerged => "U",
    }
}

/// Parses `git diff --name-status` output: `M<TAB>path` or `R090<TAB>old<TAB>new`.
fn parse_name_status(output: &str) -> Vec<NameStatus> {
    output
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut fields = line.split('\t');
            let status = fields.next().expect("status");
            let code: String = status.chars().take(1).collect();
            let first = fields.next().expect("path").to_owned();
            match fields.next() {
                Some(second) => (code, second.to_owned(), Some(first)),
                None => (code, first, None),
            }
        })
        .collect()
}

fn git_name_status(f: &Fixture, args: &[&str]) -> Vec<NameStatus> {
    parse_name_status(&f.git(args))
}

fn engine_name_status(set: &ChangeSet) -> Vec<NameStatus> {
    set.files
        .iter()
        .map(|file| {
            (
                letter(file.status).to_owned(),
                file.path.clone(),
                file.old_path.clone(),
            )
        })
        .collect()
}

fn file<'a>(set: &'a ChangeSet, path: &str) -> &'a FileChange {
    set.files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("no entry for {path} in {:?}", paths(set)))
}

fn paths(set: &ChangeSet) -> Vec<&str> {
    set.files.iter().map(|file| file.path.as_str()).collect()
}

/// Rebuilds the hunk part of a unified diff from a [`FileChange`].
fn unified(file: &FileChange) -> String {
    let mut out = String::new();
    for hunk in &file.hunks {
        out.push_str(&hunk.header);
        out.push('\n');
        for line in &hunk.lines {
            out.push(match line.kind {
                LineKind::Context => ' ',
                LineKind::Added => '+',
                LineKind::Removed => '-',
            });
            out.push_str(&line.text);
            out.push('\n');
            if line.no_newline {
                out.push_str("\\ No newline at end of file\n");
            }
        }
    }
    out.trim_end().to_owned()
}

/// The hunk part of `git diff` output: everything from the first `@@` line on.
fn git_hunks(f: &Fixture, args: &[&str]) -> String {
    let output = f.git(args);
    let start = output.find("\n@@").map_or(0, |at| at + 1);
    output[start..].trim_end().to_owned()
}

/// Sum of `git diff --numstat` additions and deletions (binary files count zero).
fn numstat_totals(f: &Fixture, args: &[&str]) -> (u32, u32) {
    f.git(args).lines().fold((0, 0), |(adds, dels), line| {
        let mut fields = line.split('\t');
        let a: u32 = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let d: u32 = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        (adds + a, dels + d)
    })
}

/// A 40-line file edited in two places, the second edit dropping the final newline.
fn with_multi_hunk_edit() -> Fixture {
    let mut f = Fixture::basic();
    let lines: Vec<String> = (1..=40).map(|i| format!("line {i}")).collect();
    f.write("notes.txt", &(lines.join("\n") + "\n"));
    f.commit("add notes");
    let mut edited = lines;
    edited[4] = "line five".to_owned();
    edited.insert(20, "inserted after twenty".to_owned());
    edited.remove(36);
    edited.push("tail without newline".to_owned());
    f.write("notes.txt", &edited.join("\n"));
    f.commit("edit notes");
    f
}

#[test]
fn rename_matches_git_diff_m() {
    let f = Fixture::basic().with_rename();
    let set = diff(&f, &commits("HEAD~1", "HEAD"));
    assert_eq!(
        engine_name_status(&set),
        git_name_status(&f, &["diff", "-M", "--name-status", "HEAD~1", "HEAD"])
    );
    assert_eq!(set.files.len(), 1);
    let renamed = &set.files[0];
    assert_eq!(renamed.status, ChangeKind::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some("src/lib.rs"));
    assert_eq!(renamed.path, "src/core.rs");
    assert!(
        renamed.similarity.is_some_and(|s| s >= 90),
        "{:?}",
        renamed.similarity
    );
    assert_eq!((renamed.additions, renamed.deletions), (2, 2));
}

#[test]
fn renames_can_be_switched_off() {
    let f = Fixture::basic().with_rename();
    let options = DiffOptions {
        renames: false,
        ..DiffOptions::default()
    };
    let set = diff_with(&f, &commits("HEAD~1", "HEAD"), &options);
    assert_eq!(
        engine_name_status(&set),
        git_name_status(
            &f,
            &["diff", "--no-renames", "--name-status", "HEAD~1", "HEAD"]
        )
    );
    assert_eq!(
        engine_name_status(&set),
        [
            ("A".to_owned(), "src/core.rs".to_owned(), None),
            ("D".to_owned(), "src/lib.rs".to_owned(), None),
        ]
    );
}

#[test]
fn rename_threshold_is_applied() {
    let f = Fixture::basic().with_rename();
    let options = DiffOptions {
        similarity: 95,
        ..DiffOptions::default()
    };
    let set = diff_with(&f, &commits("HEAD~1", "HEAD"), &options);
    assert_eq!(
        engine_name_status(&set),
        git_name_status(&f, &["diff", "-M95%", "--name-status", "HEAD~1", "HEAD"])
    );
    assert_eq!(set.files.len(), 2, "{:?}", paths(&set));
}

#[test]
fn three_dot_range_matches_git_and_differs_from_two_dot() {
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "feature", "v1"]);
    f.write("feature.txt", "feature\n");
    f.commit("feature work");
    f.git(&["checkout", "-q", "main"]);

    let three = diff(&f, &range("main", "feature", true));
    assert_eq!(
        engine_name_status(&three),
        git_name_status(&f, &["diff", "main...feature", "--name-status"])
    );
    assert_eq!(paths(&three), ["feature.txt"]);

    let two = diff(&f, &range("main", "feature", false));
    assert_eq!(
        engine_name_status(&two),
        git_name_status(&f, &["diff", "main..feature", "--name-status"])
    );
    assert_eq!(
        engine_name_status(&two),
        engine_name_status(&diff(&f, &commits("main", "feature")))
    );
    assert_ne!(engine_name_status(&two), engine_name_status(&three));
}

#[test]
fn single_commits_match_git_show_including_merge_and_root() {
    let f = Fixture::basic().with_rename();
    let hashes = f.git(&["rev-list", "HEAD"]);
    let mut checked = 0;
    for hash in hashes.lines() {
        let set = diff(&f, &commit(hash));
        let expected = git_name_status(
            &f,
            &[
                "show",
                "--name-status",
                "--format=",
                "-M",
                "--diff-merges=first-parent",
                hash,
            ],
        );
        assert_eq!(engine_name_status(&set), expected, "commit {hash}");
        checked += 1;
    }
    assert_eq!(checked, 8);

    let merge = f.rev("main~2");
    assert_eq!(
        f.git(&["rev-list", "--parents", "-n", "1", &merge])
            .split(' ')
            .count(),
        3
    );
    assert_eq!(paths(&diff(&f, &commit(&merge))), ["src/dev.rs"]);
    let root = f.git(&["rev-list", "--max-parents=0", "HEAD"]);
    let root_set = diff(&f, &commit(&root));
    assert_eq!(paths(&root_set), ["README.md"]);
    assert_eq!(root_set.files[0].status, ChangeKind::Added);
    assert_eq!(root_set.additions, 1);
}

#[test]
fn every_file_carries_the_ids_of_its_blobs() {
    let mut f = Fixture::basic();
    f.write("src/lib.rs", "pub fn one() -> u32 {\n    2\n}\n");
    f.write("docs/new.md", "new\n");
    f.remove("README.md");
    let head = f.commit("c5: edit, add and delete");
    let set = diff(&f, &commit(&head));
    let id = |spec: &str| Some(f.git(&["rev-parse", spec]));

    let edited = file(&set, "src/lib.rs");
    assert_eq!(edited.old_id, id(&format!("{head}^:src/lib.rs")));
    assert_eq!(edited.new_id, id(&format!("{head}:src/lib.rs")));
    let added = file(&set, "docs/new.md");
    assert_eq!(added.old_id, None);
    assert_eq!(added.new_id, id(&format!("{head}:docs/new.md")));
    let deleted = file(&set, "README.md");
    assert_eq!(deleted.old_id, id(&format!("{head}^:README.md")));
    assert_eq!(deleted.new_id, None);

    // The working tree's side is the blob `git add` would write, which the patch hashed.
    f.write("src/lib.rs", "pub fn one() -> u32 {\n    3\n}\n");
    f.write("notes.txt", "untracked\n");
    let hashed = |path: &str| Some(f.git(&["hash-object", path]));
    for base in [WorkingTreeBase::Index, WorkingTreeBase::Head] {
        let set = diff(&f, &DiffTarget::WorkingTree { base: base.clone() });
        let changed = file(&set, "src/lib.rs");
        assert_eq!(changed.old_id, id(":src/lib.rs"), "{base:?}");
        assert_eq!(changed.new_id, hashed("src/lib.rs"), "{base:?}");
        if base == WorkingTreeBase::Index {
            let untracked = file(&set, "notes.txt");
            assert_eq!(untracked.old_id, None);
            assert_eq!(untracked.new_id, hashed("notes.txt"));
        }
    }
    // The index against HEAD: both sides are blobs of the object store.
    f.git(&["add", "src/lib.rs"]);
    let staged = diff(&f, &DiffTarget::Index);
    let staged = file(&staged, "src/lib.rs");
    assert_eq!(staged.old_id, id("HEAD:src/lib.rs"));
    assert_eq!(staged.new_id, id(":src/lib.rs"));
}

/// A submodule's working side is the commit checked out in it, which `git diff` prints as
/// `+Subproject commit <new>`: hashing the folder gives no id, and every state of the
/// submodule would share one, keeping a mark it was not given for.
#[test]
fn a_submodules_working_side_is_its_checked_out_commit() {
    let mut f = Fixture::basic();
    let source = f.sibling("subsrc");
    let source_path = source.to_str().expect("utf-8 temp path").to_owned();
    f.git(&["init", "-q", "-b", "main", &source_path]);
    for i in 1..=3 {
        fs::write(source.join("s.txt"), format!("s{i}\n")).expect("write");
        f.git_in(&source, &["add", "s.txt"]);
        f.git_in(&source, &["commit", "-q", "-m", &format!("s{i}")]);
    }
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
    let sub = f.root.join("sub");
    let mut seen = Vec::new();
    for _ in 0..2 {
        f.git_in(&sub, &["checkout", "-q", "HEAD~1"]);
        let checked_out = f.git_in(&sub, &["rev-parse", "HEAD"]);
        for base in [
            WorkingTreeBase::Index,
            WorkingTreeBase::Head,
            WorkingTreeBase::Revision {
                rev: "HEAD".to_owned(),
            },
        ] {
            let set = diff(&f, &DiffTarget::WorkingTree { base: base.clone() });
            let entry = file(&set, "sub");
            let old = if base == WorkingTreeBase::Index {
                ":sub"
            } else {
                "HEAD:sub"
            };
            assert_eq!(entry.old_id, Some(f.rev(old)), "{base:?}");
            assert_eq!(
                entry.new_id.as_deref(),
                Some(checked_out.as_str()),
                "{base:?}"
            );
        }
        seen.push(checked_out);
    }
    assert_ne!(seen[0], seen[1]);

    // Back on the recorded commit with a file of its own changed: git lists the submodule as
    // dirty, with the same commit on both sides.
    let recorded = f.rev(":sub");
    f.git_in(&sub, &["checkout", "-q", &recorded]);
    fs::write(sub.join("s.txt"), "dirty\n").expect("write");
    let set = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
    );
    assert_eq!(
        engine_name_status(&set),
        git_name_status(&f, &["diff", "--name-status"])
    );
    let dirty = file(&set, "sub");
    assert_eq!(dirty.old_id, dirty.new_id);
}

/// An intent-to-add file is an addition for `git diff` (`index 0000000..`): the index's
/// empty blob is a placeholder, not an old side, so `git add -N` keeps the file's ids.
#[test]
fn an_intent_to_add_file_has_no_old_blob() {
    let f = Fixture::basic();
    f.write("ita.txt", "new\n");
    let target = DiffTarget::WorkingTree {
        base: WorkingTreeBase::Index,
    };
    let untracked = diff(&f, &target);
    f.git(&["add", "-N", "ita.txt"]);
    let intent = diff(&f, &target);
    let added = file(&intent, "ita.txt");
    assert_eq!(added.status, ChangeKind::Added);
    assert_eq!(added.old_id, None);
    assert_eq!(added.new_id, Some(f.git(&["hash-object", "ita.txt"])));
    let before = file(&untracked, "ita.txt");
    assert_eq!(
        (&added.old_id, &added.new_id),
        (&before.old_id, &before.new_id)
    );
}

/// Under `core.autocrlf` the working side is the blob git would store (the lines after the
/// clean filters), which the patch hashed from what it read: a rewrite of line endings alone
/// keeps the id, as `git diff` shows the same lines.
#[test]
fn the_working_side_under_autocrlf_is_gits_blob() {
    let mut f = Fixture::basic();
    f.git(&["config", "core.autocrlf", "true"]);
    f.write("crlf.txt", "one\r\ntwo\r\n");
    f.commit("crlf");
    let target = DiffTarget::WorkingTree {
        base: WorkingTreeBase::Index,
    };
    f.write("crlf.txt", "one\r\nTWO\r\n");
    let crlf = file(&diff(&f, &target), "crlf.txt").new_id.clone();
    let filtered = f.git(&["hash-object", "crlf.txt"]);
    assert_eq!(crlf.as_deref(), Some(filtered.as_str()));
    assert_ne!(
        filtered,
        f.git(&["hash-object", "--no-filters", "crlf.txt"])
    );
    f.write("crlf.txt", "one\nTWO\n");
    assert_eq!(file(&diff(&f, &target), "crlf.txt").new_id, crlf);
}

/// A file the patch does not read (binary by attribute) is hashed from its bytes on disk,
/// without the filters: here `-diff` leaves the CRLF conversion on, so the id is not the
/// blob git would store, and only has to change with the file.
#[test]
fn a_working_file_the_patch_does_not_read_is_hashed_from_disk() {
    let mut f = Fixture::basic();
    f.git(&["config", "core.autocrlf", "true"]);
    f.write(".gitattributes", "*.dat -diff\n");
    f.write("table.dat", "one\r\n");
    f.commit("table");
    for content in ["two\r\n", "three\r\n"] {
        f.write("table.dat", content);
        let raw = f.git(&["hash-object", "--no-filters", "table.dat"]);
        assert_ne!(raw, f.git(&["hash-object", "table.dat"]));
        for base in [WorkingTreeBase::Index, WorkingTreeBase::Head] {
            let set = diff(&f, &DiffTarget::WorkingTree { base: base.clone() });
            let changed = file(&set, "table.dat");
            assert!(changed.is_binary, "{base:?}");
            assert_eq!(changed.new_id.as_deref(), Some(raw.as_str()), "{base:?}");
        }
    }
}

/// A file the patch does not read, rewritten with the bytes of the blob it had (here only
/// its line endings changed under `core.autocrlf`), is no change: git lists nothing.
#[test]
fn a_working_file_with_the_old_sides_id_is_not_listed() {
    let mut f = Fixture::basic();
    f.git(&["config", "core.autocrlf", "true"]);
    f.write(".gitattributes", "*.dat -diff\n");
    f.write("table.dat", "one\r\ntwo\r\n");
    f.commit("table");
    f.write("table.dat", "one\ntwo\n");
    for base in [WorkingTreeBase::Index, WorkingTreeBase::Head] {
        let set = diff(&f, &DiffTarget::WorkingTree { base: base.clone() });
        assert_eq!(
            engine_name_status(&set),
            git_name_status(&f, &["diff", "HEAD", "--name-status"]),
            "{base:?}"
        );
        assert!(set.files.is_empty(), "{base:?} {:?}", paths(&set));
    }
}

/// A working file larger than libgit2 reads (512 MiB) is not read at all: it is binary and
/// named by its size and time, which any write changes.
#[test]
fn a_working_file_over_libgit2s_limit_is_named_by_its_size_and_time() {
    let f = Fixture::basic();
    let size = 600_u64 << 20;
    fs::File::create(f.root.join("big.bin"))
        .and_then(|big| big.set_len(size))
        .expect("big file");
    let set = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
    );
    let big = file(&set, "big.bin");
    assert!(big.is_binary);
    let id = big.new_id.as_deref().expect("id");
    assert!(id.starts_with(&format!("stat:{size}:")), "{id}");
}

/// At 4 GiB and more libgit2 keeps a working file's size in 32 bits and its patch fails: the
/// file is listed as binary, named by its size and time, and the rest of the page stays.
#[test]
fn a_working_file_of_4_gib_and_more_leaves_the_page_working() {
    let mut f = Fixture::basic();
    f.write("grown.bin", "small\n");
    f.commit("small file");
    let size = (4_u64 << 30) + 16;
    fs::OpenOptions::new()
        .write(true)
        .open(f.root.join("grown.bin"))
        .and_then(|grown| grown.set_len(size))
        .expect("grown file");
    f.write("src/lib.rs", "changed\n");
    for base in [WorkingTreeBase::Index, WorkingTreeBase::Head] {
        let set = diff(&f, &DiffTarget::WorkingTree { base: base.clone() });
        assert_eq!(paths(&set), ["grown.bin", "src/lib.rs"], "{base:?}");
        let grown = file(&set, "grown.bin");
        assert!(grown.is_binary, "{base:?}");
        let id = grown.new_id.as_deref().expect("id");
        assert!(id.starts_with(&format!("stat:{size}:")), "{base:?} {id}");
    }
}

/// A `core.attributesfile` that is not UTF-8 (a configuration saved in another code page)
/// leaves the diff working: git2 panics on such a path on Windows, where it is left out.
#[test]
fn an_attributes_file_setting_that_is_not_utf8_leaves_the_diff_working() {
    let f = Fixture::basic();
    f.write("src/lib.rs", "changed\n");
    let config = f.root.join(".git").join("config");
    let mut bytes = fs::read(&config).expect("config");
    bytes.extend_from_slice(b"[core]\n\tattributesfile = C:/Users/Jos\xe9/attributes\n");
    fs::write(&config, bytes).expect("config");
    let set = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
    );
    assert_eq!(paths(&set), ["src/lib.rs"]);
}

/// An index entry whose name is not UTF-8 (an index written on Linux) is listed under its
/// lossy name, and its flags are read from the bytes git stores: git2's `path()` and
/// `get_path` cannot take such a name on Windows, where no file can carry it.
#[test]
fn an_index_entry_with_a_non_utf8_name_is_listed_with_its_flags() {
    let f = Fixture::basic();
    let repo = git2::Repository::open(&f.root).expect("open");
    let mut index = repo.index().expect("index");
    let mut add = |name: &[u8], content: &[u8], flags_extended: git2::IndexEntryExtendedFlag| {
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o100_644,
            uid: 0,
            gid: 0,
            file_size: u32::try_from(content.len()).expect("small"),
            id: repo.blob(content).expect("blob"),
            flags: 0,
            flags_extended: flags_extended.bits(),
            path: name.to_vec(),
        };
        index.add(&entry).expect("add");
    };
    add(
        b"caf\xe9.txt",
        b"one\n",
        git2::IndexEntryExtendedFlag::empty(),
    );
    // Off the disk on purpose (a sparse checkout), and recorded by `git add -N`: git lists
    // neither against the index, nor the second as staged.
    add(
        b"sparse\xe9.txt",
        b"two\n",
        git2::IndexEntryExtendedFlag::SKIP_WORKTREE,
    );
    add(
        b"intent\xe9.txt",
        b"",
        git2::IndexEntryExtendedFlag::INTENT_TO_ADD,
    );
    index.write().expect("write index");
    let lossy = "caf\u{fffd}.txt";

    let working = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
    );
    let listed: Vec<&str> = paths(&working)
        .into_iter()
        .filter(|path| !path.starts_with("intent"))
        .collect();
    assert_eq!(listed, [lossy]);
    assert_eq!(file(&working, lossy).status, ChangeKind::Deleted);
    let staged = diff(&f, &DiffTarget::Index);
    let staged_paths = paths(&staged);
    assert!(staged_paths.contains(&lossy), "{staged_paths:?}");
    assert!(
        !staged_paths.iter().any(|path| path.starts_with("intent")),
        "{staged_paths:?}"
    );
    assert_eq!(file(&staged, lossy).status, ChangeKind::Added);
    for base in [
        WorkingTreeBase::Head,
        WorkingTreeBase::Revision {
            rev: "HEAD".to_owned(),
        },
    ] {
        diff(&f, &DiffTarget::WorkingTree { base });
    }
}

/// A symbolic link's working side is the blob of its link text, as git stores it, not the
/// file it points to (which can change while the link does not, and the other way round).
#[cfg(unix)]
#[test]
fn a_working_tree_symlink_is_hashed_as_its_link_text() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::basic();
    f.git(&["config", "core.symlinks", "true"]);
    f.write("a.txt", "same\n");
    f.write("b.txt", "same\n");
    symlink("a.txt", f.root.join("link")).expect("symlink");
    f.commit("link");
    let blob_of = |text: &str| {
        let probe = f.sibling("blob-probe");
        fs::write(&probe, text).expect("probe");
        Some(f.git(&[
            "hash-object",
            "--no-filters",
            probe.to_str().expect("utf-8 temp path"),
        ]))
    };
    let target = DiffTarget::WorkingTree {
        base: WorkingTreeBase::Index,
    };
    for text in ["b.txt", "missing", "src"] {
        fs::remove_file(f.root.join("link")).expect("remove link");
        symlink(text, f.root.join("link")).expect("symlink");
        let set = diff(&f, &target);
        let changed = file(&set, "link");
        assert_eq!(changed.old_id, blob_of("a.txt"), "-> {text}");
        assert_eq!(changed.new_id, blob_of(text), "-> {text}");
    }
}

/// A working file whose name is not UTF-8 is hashed from its own name, not from the lossy
/// path the change set shows, which names no file.
#[cfg(target_os = "linux")]
#[test]
fn a_working_file_with_a_non_utf8_name_is_hashed() {
    use std::os::unix::ffi::OsStrExt;
    let mut f = Fixture::basic();
    let name = std::ffi::OsStr::from_bytes(b"caf\xe9.txt");
    fs::write(f.root.join(name), "one\n").expect("write");
    f.commit("latin-1 name");
    let target = DiffTarget::WorkingTree {
        base: WorkingTreeBase::Index,
    };
    for content in ["two\n", "three\n"] {
        fs::write(f.root.join(name), content).expect("write");
        let set = diff(&f, &target);
        assert_eq!(set.files.len(), 1);
        let probe = f.sibling("blob-probe");
        fs::write(&probe, content).expect("probe");
        let expected = f.git(&[
            "hash-object",
            "--no-filters",
            probe.to_str().expect("utf-8 temp path"),
        ]);
        assert_eq!(set.files[0].new_id.as_deref(), Some(expected.as_str()));
    }
}

#[test]
fn working_tree_and_index_diffs_match_git() {
    let f = Fixture::basic().with_mixed_status();
    f.remove("docs/guide.md");
    f.git(&["rm", "-q", "src/dev.rs"]);

    // Against the index the untracked file is listed as added (git's own diff leaves it out;
    // `git status` shows it as `??`), the ignored one is not.
    let index = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
    );
    let mut expected = git_name_status(&f, &["diff", "--name-status"]);
    let porcelain = f.git(&["status", "--porcelain"]);
    for line in porcelain.lines().filter(|line| line.starts_with("?? ")) {
        expected.push(("A".to_owned(), line[3..].to_owned(), None));
    }
    expected.sort();
    let mut listed = engine_name_status(&index);
    listed.sort();
    assert_eq!(listed, expected);
    assert_eq!(
        paths(&index),
        ["README.md", "docs/guide.md", "untracked.txt"]
    );
    let untracked = file(&index, "untracked.txt");
    assert_eq!(untracked.status, ChangeKind::Added);
    assert_eq!(untracked.additions, 1);
    assert!(untracked.hunks[0]
        .lines
        .iter()
        .any(|line| line.kind == LineKind::Added && line.text == "untracked"));

    let head = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Head,
        },
    );
    assert_eq!(
        engine_name_status(&head),
        git_name_status(&f, &["diff", "HEAD", "--name-status"])
    );
    assert_eq!(
        paths(&head),
        ["README.md", "docs/guide.md", "src/dev.rs", "staged.txt"]
    );

    let cached = diff(&f, &DiffTarget::Index);
    assert_eq!(
        engine_name_status(&cached),
        git_name_status(&f, &["diff", "--cached", "--name-status"])
    );
    assert_eq!(paths(&cached), ["src/dev.rs", "staged.txt"]);

    let modified = file(&index, "README.md");
    assert_eq!(modified.additions, 1);
    assert_eq!(modified.hunks.len(), 1);
    assert!(modified.hunks[0]
        .lines
        .iter()
        .any(|line| line.kind == LineKind::Added && line.text == "modified"));

    // The working tree against a revision, like `git diff v1`.
    let against_tag = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Revision {
                rev: "v1".to_owned(),
            },
        },
    );
    assert_eq!(
        engine_name_status(&against_tag),
        git_name_status(&f, &["diff", "v1", "--name-status"])
    );
    // `docs/guide.md` exists at neither side (added after v1, removed here): not listed.
    assert!(paths(&against_tag).contains(&"README.md"));
    assert!(!paths(&against_tag).contains(&"docs/guide.md"));
}

/// A `.gitattributes` staged after the engine opened is honoured by the next diff, like
/// `git check-attr`: the attributes are read from the index as it is on disk, not from the
/// copy the handle loaded when it opened.
#[test]
fn a_gitattributes_staged_after_opening_marks_generated_files() {
    let f = Fixture::basic();
    f.write("openapi.ts", "export type Api = { ok: boolean };\n");
    f.git(&["add", "openapi.ts"]);
    f.git(&["commit", "-q", "-m", "add openapi"]);
    let engine = Git2Engine::open(&f.root).expect("open");
    let generated = |engine: &Git2Engine| {
        let set = engine
            .diff(&commit("HEAD"), &DiffOptions::default(), &Cancel::never())
            .expect("diff");
        file(&set, "openapi.ts").is_generated
    };
    assert!(!generated(&engine));
    f.write(".gitattributes", "openapi.ts linguist-generated\n");
    f.git(&["add", ".gitattributes"]);
    assert_eq!(
        f.git(&["check-attr", "linguist-generated", "--", "openapi.ts"]),
        "openapi.ts: linguist-generated: set"
    );
    assert!(generated(&engine));
    // And the other way: the rule unstaged again.
    f.git(&["rm", "-q", "--cached", ".gitattributes"]);
    fs::remove_file(f.root.join(".gitattributes")).expect("remove");
    assert!(!generated(&engine));
}

/// A working-tree diff in a linked worktree reads that worktree's files and index: the
/// pages run on a handle reopened from the worktree's gitdir (`.git/worktrees/<name>`),
/// which libgit2 resolves to the linked working directory.
#[test]
fn working_tree_diff_in_a_linked_worktree_matches_git() {
    let f = Fixture::basic().with_linked_worktree();
    let path = f.worktree_path();
    let mut readme = std::fs::read_to_string(path.join("README.md")).expect("read");
    readme.push_str("from the linked worktree\n");
    std::fs::write(path.join("README.md"), readme).expect("write");
    std::fs::write(path.join("only-here.txt"), "wt\n").expect("write");
    let engine = Git2Engine::open(&path).expect("open the worktree");
    let against_head = engine
        .diff(
            &DiffTarget::WorkingTree {
                base: WorkingTreeBase::Head,
            },
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect("diff");
    assert_eq!(
        engine_name_status(&against_head),
        parse_name_status(&f.git_in(&path, &["diff", "HEAD", "--name-status"]))
    );
    assert_eq!(paths(&against_head), ["README.md"]);
    let modified = file(&against_head, "README.md");
    assert!(modified.hunks[0]
        .lines
        .iter()
        .any(|line| line.kind == LineKind::Added && line.text == "from the linked worktree"));
    // Against the index the untracked file of the worktree is listed too; the main
    // worktree, untouched, shows nothing.
    let against_index = engine
        .diff(
            &DiffTarget::WorkingTree {
                base: WorkingTreeBase::Index,
            },
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect("diff");
    assert_eq!(paths(&against_index), ["README.md", "only-here.txt"]);
    let main = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Head,
        },
    );
    assert!(main.files.is_empty());
}

/// `ignoreWhitespace` drops the lines and files that only changed in whitespace, like
/// `git diff -w`.
#[test]
fn ignore_whitespace_matches_git_diff_w() {
    let mut f = Fixture::basic();
    f.write(
        "src/lib.rs",
        "pub fn one() -> u32 {
        1
}
",
    );
    f.write(
        "docs/guide.md",
        "# Guide

real change
",
    );
    f.commit("reindent and edit");
    let head = f.head();
    let plain = diff(&f, &commit(&head));
    assert_eq!(paths(&plain), ["docs/guide.md", "src/lib.rs"]);
    let options = DiffOptions {
        ignore_whitespace: true,
        ..DiffOptions::default()
    };
    let ignoring = diff_with(&f, &commit(&head), &options);
    let expected: Vec<String> = f
        .git(&["diff", "-w", "--name-only", &format!("{head}~1"), &head])
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(paths(&ignoring), expected);
    assert_eq!(paths(&ignoring), ["docs/guide.md"]);
    let (additions, deletions) = numstat_totals(
        &f,
        &["diff", "-w", "--numstat", &format!("{head}~1"), &head],
    );
    assert_eq!(
        (ignoring.additions, ignoring.deletions),
        (additions, deletions)
    );
}

#[test]
fn hunks_reconstruct_the_unified_diff() {
    let f = with_multi_hunk_edit();
    let set = diff(&f, &commits("HEAD~1", "HEAD"));
    let notes = file(&set, "notes.txt");
    assert!(notes.hunks.len() >= 2, "{:?}", notes.hunks);
    assert_eq!(
        unified(notes),
        git_hunks(
            &f,
            &[
                "diff",
                "--no-color",
                "-U3",
                "HEAD~1",
                "HEAD",
                "--",
                "notes.txt"
            ]
        )
    );
    let last = notes
        .hunks
        .last()
        .and_then(|hunk| hunk.lines.last())
        .expect("last line");
    assert!(last.no_newline);
    assert_eq!(last.text, "tail without newline");

    let first = &notes.hunks[0];
    assert_eq!((first.old_start, first.new_start), (2, 2));
    assert!(
        first.header.starts_with("@@ -2,7 +2,7 @@"),
        "{}",
        first.header
    );
    let removed = first
        .lines
        .iter()
        .find(|line| line.kind == LineKind::Removed)
        .expect("removed line");
    assert_eq!((removed.old_number, removed.new_number), (Some(5), None));
    let added = first
        .lines
        .iter()
        .find(|line| line.kind == LineKind::Added)
        .expect("added line");
    assert_eq!((added.old_number, added.new_number), (None, Some(5)));
    let context = &first.lines[0];
    assert_eq!((context.old_number, context.new_number), (Some(2), Some(2)));
}

#[test]
fn context_option_matches_git_u() {
    let f = with_multi_hunk_edit();
    for context in [0, 1, 6] {
        let options = DiffOptions {
            context,
            ..DiffOptions::default()
        };
        let set = diff_with(&f, &commits("HEAD~1", "HEAD"), &options);
        let flag = format!("-U{context}");
        assert_eq!(
            unified(file(&set, "notes.txt")),
            git_hunks(
                &f,
                &[
                    "diff",
                    "--no-color",
                    &flag,
                    "HEAD~1",
                    "HEAD",
                    "--",
                    "notes.txt"
                ]
            ),
            "context {context}"
        );
    }
}

#[test]
fn added_and_deleted_files_reconstruct_the_unified_diff() {
    let mut f = Fixture::basic();
    f.write("new.txt", "one\ntwo\n");
    f.remove("docs/guide.md");
    f.commit("add and delete");
    let set = diff(&f, &commit("HEAD"));
    for path in ["new.txt", "docs/guide.md"] {
        assert_eq!(
            unified(file(&set, path)),
            git_hunks(&f, &["diff", "--no-color", "HEAD~1", "HEAD", "--", path]),
            "{path}"
        );
    }
    assert_eq!(file(&set, "new.txt").status, ChangeKind::Added);
    assert_eq!(file(&set, "docs/guide.md").status, ChangeKind::Deleted);
}

#[test]
fn intra_line_spans_mark_the_changed_word() {
    let mut f = Fixture::basic();
    f.write("code.rs", "let value = one;\nother line\n");
    f.commit("add code");
    f.write("code.rs", "let value = two;\nother line\n");
    f.commit("change a word");
    let set = diff(&f, &commits("HEAD~1", "HEAD"));
    let hunk = &file(&set, "code.rs").hunks[0];
    let removed = hunk
        .lines
        .iter()
        .find(|line| line.kind == LineKind::Removed)
        .expect("removed");
    let added = hunk
        .lines
        .iter()
        .find(|line| line.kind == LineKind::Added)
        .expect("added");
    assert_eq!(removed.spans, [Span { start: 12, end: 15 }]);
    assert_eq!(added.spans, [Span { start: 12, end: 15 }]);
    assert!(hunk
        .lines
        .iter()
        .filter(|line| line.kind == LineKind::Context)
        .all(|line| line.spans.is_empty()));

    let options = DiffOptions {
        intra_line: false,
        ..DiffOptions::default()
    };
    let plain = diff_with(&f, &commits("HEAD~1", "HEAD"), &options);
    assert!(file(&plain, "code.rs").hunks[0]
        .lines
        .iter()
        .all(|line| line.spans.is_empty()));
}

#[test]
fn flags_mark_generated_test_large_and_binary_files() {
    let mut f = Fixture::basic();
    f.write(".gitattributes", "openapi.ts linguist-generated\n");
    f.write("openapi.ts", "export type Api = { ok: boolean };\n");
    f.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    f.write("app.min.js", "var a=1;\n");
    f.write("tests/unit.rs", "#[test]\nfn it_works() {}\n");
    f.write("src/service.rs", "pub fn service() {}\n");
    let many: Vec<String> = (1..=6_000).map(|i| format!("entry {i}")).collect();
    f.write("many.txt", &(many.join("\n") + "\n"));
    let wide = "x".repeat(4_000) + "\n";
    f.write("wide.txt", &wide.repeat(300));
    fs::write(
        f.root.join("blob.bin"),
        [0u8, 1, 2, 3, 255, 0, 10, 13, 7, 8, 200, 0],
    )
    .expect("write binary");
    f.commit("flags");

    let set = diff(&f, &commit("HEAD"));

    let generated = file(&set, "openapi.ts");
    assert!(generated.is_generated);
    assert!(!generated.is_test);
    assert!(file(&set, "pnpm-lock.yaml").is_generated);
    assert!(file(&set, "app.min.js").is_generated);
    assert!(!file(&set, ".gitattributes").is_generated);

    let test = file(&set, "tests/unit.rs");
    assert!(test.is_test);
    assert!(!test.is_generated);
    let plain = file(&set, "src/service.rs");
    assert!(!plain.is_test && !plain.is_generated && !plain.is_large && !plain.is_binary);

    let many = file(&set, "many.txt");
    assert!(many.is_large);
    assert_eq!(many.additions, 6_000);
    let wide = file(&set, "wide.txt");
    assert!(wide.is_large, "1.2 MB on the new side");
    assert_eq!(wide.additions, 300);

    let binary = file(&set, "blob.bin");
    assert!(binary.is_binary);
    assert!(binary.hunks.is_empty());
    assert_eq!((binary.additions, binary.deletions), (0, 0));
    assert!(!binary.is_large);
}

#[test]
fn linguist_generated_false_overrides_the_name_heuristics() {
    let mut f = Fixture::basic();
    f.write(".gitattributes", "yarn.lock -linguist-generated\n");
    f.write("yarn.lock", "# yarn lockfile v1\n");
    f.commit("lockfile opted out");
    let set = diff(&f, &commit("HEAD"));
    assert!(!file(&set, "yarn.lock").is_generated);
}

#[test]
fn totals_match_git_numstat() {
    let f = with_multi_hunk_edit();
    let mut f = f;
    f.write("extra.txt", "a\nb\nc\n");
    f.remove("README.md");
    fs::write(f.root.join("blob.bin"), [0u8, 159, 1, 0, 2]).expect("write binary");
    f.commit("more changes");
    let set = diff(&f, &commits("HEAD~2", "HEAD"));
    let (adds, dels) = numstat_totals(&f, &["diff", "--numstat", "HEAD~2", "HEAD"]);
    assert_eq!((set.additions, set.deletions), (adds, dels));
    assert!(adds > 0 && dels > 0);
    let per_file: (u32, u32) = set.files.iter().fold((0, 0), |(a, d), file| {
        (a + file.additions, d + file.deletions)
    });
    assert_eq!((set.additions, set.deletions), per_file);
}

#[test]
fn files_are_ordered_by_new_path_like_git() {
    let mut f = Fixture::basic().with_rename();
    f.write("aaa.txt", "first\n");
    f.write("zzz.txt", "last\n");
    f.commit("more files");
    let set = diff(&f, &commits("HEAD~2", "HEAD"));
    assert_eq!(
        engine_name_status(&set),
        git_name_status(&f, &["diff", "-M", "--name-status", "HEAD~2", "HEAD"])
    );
    assert_eq!(paths(&set), ["aaa.txt", "src/core.rs", "zzz.txt"]);
}

#[test]
fn binary_changes_never_panic_and_carry_no_hunks() {
    let mut f = Fixture::basic();
    fs::write(f.root.join("image.bin"), [0u8, 1, 2, 3]).expect("write binary");
    f.commit("add binary");
    fs::write(f.root.join("image.bin"), [0u8, 9, 8, 7, 6, 5]).expect("write binary");
    f.commit("change binary");
    let set = diff(&f, &commits("HEAD~1", "HEAD"));
    let image = file(&set, "image.bin");
    assert_eq!(image.status, ChangeKind::Modified);
    assert!(image.is_binary);
    assert!(image.hunks.is_empty());
    assert_eq!(
        numstat_totals(&f, &["diff", "--numstat", "HEAD~1", "HEAD"]),
        (0, 0)
    );

    fs::write(f.root.join("image.bin"), [0u8, 0, 0]).expect("write binary");
    let workdir = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
    );
    assert!(file(&workdir, "image.bin").is_binary);
}

#[test]
fn unknown_revision_is_ref_not_found() {
    let f = Fixture::basic();
    let error = engine(&f)
        .diff(
            &commits("no-such-branch", "HEAD"),
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect_err("must fail");
    assert!(matches!(&error, GitError::RefNotFound(name) if name == "no-such-branch"));
    assert_eq!(error.code(), "refs.not_found");
}

#[test]
fn three_dot_on_unrelated_histories_fails_with_the_typed_error() {
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "--orphan", "lonely"]);
    f.git(&["rm", "-q", "-r", "--cached", "."]);
    f.write("alone.txt", "alone\n");
    f.commit("orphan root");
    f.git(&["checkout", "-q", "-f", "main"]);
    let error = engine(&f)
        .diff(
            &range("main", "lonely", true),
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect_err("must fail");
    assert_eq!(error.code(), "refs.unrelated_histories");
    assert!(
        matches!(&error, GitError::UnrelatedHistories { a, b } if a == "main" && b == "lonely")
    );
}

#[test]
fn missing_blob_is_reported_with_its_hash() {
    let mut f = Fixture::basic();
    f.append("README.md", "more\n");
    f.commit("edit readme");
    let missing = f.delete_object("HEAD~1:README.md");
    let error = engine(&f)
        .diff(&commit("HEAD"), &DiffOptions::default(), &Cancel::never())
        .expect_err("must fail");
    assert_eq!(error.code(), "diff.blob_missing");
    assert!(matches!(&error, GitError::BlobMissing(hash) if *hash == missing));
}

#[test]
fn truncated_blob_is_a_corrupt_object() {
    let mut f = Fixture::basic();
    f.append("README.md", "more\n");
    f.commit("edit readme");
    let corrupt = f.truncate_object("HEAD~1:README.md");
    let error = engine(&f)
        .diff(&commit("HEAD"), &DiffOptions::default(), &Cancel::never())
        .expect_err("must fail");
    assert_eq!(error.code(), "repo.corrupt_object", "{error:?}");
    assert!(matches!(&error, GitError::CorruptObject { hash, .. } if *hash == corrupt));
}

#[test]
fn truncated_tree_is_a_corrupt_object() {
    let f = Fixture::basic();
    let corrupt = f.truncate_object("HEAD~1^{tree}");
    let error = engine(&f)
        .diff(&commit("HEAD"), &DiffOptions::default(), &Cancel::never())
        .expect_err("must fail");
    assert_eq!(error.code(), "repo.corrupt_object", "{error:?}");
    assert!(matches!(&error, GitError::CorruptObject { hash, .. } if *hash == corrupt));
}

#[test]
fn truncated_commit_is_a_corrupt_object() {
    let f = Fixture::basic();
    f.truncate_object("HEAD~1");
    let error = engine(&f)
        .diff(
            &commits("HEAD~1", "HEAD"),
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect_err("must fail");
    assert_eq!(error.code(), "repo.corrupt_object", "{error:?}");
}

#[test]
fn cancelled_diff_stops_with_cancelled() {
    let f = Fixture::basic().with_rename();
    let cancel = Cancel::new();
    cancel.cancel();
    let error = engine(&f)
        .diff(&commits("HEAD~1", "HEAD"), &DiffOptions::default(), &cancel)
        .expect_err("must be cancelled");
    assert!(matches!(error, GitError::Cancelled), "{error:?}");
}

#[test]
fn unborn_head_diffs_against_the_empty_tree() {
    let f = Fixture::unborn();
    f.write("first.txt", "first\n");
    f.git(&["add", "first.txt"]);
    let cached = diff(&f, &DiffTarget::Index);
    assert_eq!(
        engine_name_status(&cached),
        git_name_status(&f, &["diff", "--cached", "--name-status"])
    );
    assert_eq!(paths(&cached), ["first.txt"]);
    let head = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Head,
        },
    );
    assert_eq!(paths(&head), ["first.txt"]);
}

#[test]
fn a_tree_tag_as_revision_is_not_found() {
    let f = Fixture::basic();
    f.git(&["tag", "treetag", "HEAD^{tree}"]);
    let error = engine(&f)
        .diff(
            &commits("treetag", "main"),
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect_err("a tree is not a commit");
    assert_eq!(error.code(), "refs.not_found");
}

#[test]
fn working_tree_diff_skips_files_that_only_differ_by_line_endings() {
    let mut f = Fixture::basic();
    f.write(".gitattributes", "* text=auto\n");
    f.write("auto.txt", "one\ntwo\nthree\n");
    f.commit("text auto");
    f.write("auto.txt", "one\r\ntwo\r\nthree\r\n");
    assert_eq!(f.git(&["diff", "--name-status"]), "");
    for base in [WorkingTreeBase::Index, WorkingTreeBase::Head] {
        let set = diff(&f, &DiffTarget::WorkingTree { base: base.clone() });
        assert!(set.files.is_empty(), "{base:?}: {:?}", set.files);
    }
}

#[test]
fn a_truncated_head_makes_working_tree_diffs_corrupt() {
    let f = Fixture::basic();
    let hash = f.truncate_object("HEAD");
    let error = engine(&f)
        .diff(
            &DiffTarget::WorkingTree {
                base: WorkingTreeBase::Head,
            },
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect_err("must fail");
    match error {
        GitError::CorruptObject { hash: reported, .. } => assert_eq!(reported, hash),
        other => panic!("unexpected error {other:?}"),
    }
}

/// The pruned tree diff must list exactly what git lists: changes deep in the tree, whole
/// directories added or removed, a directory rename, a mode change on an unchanged blob and a
/// blob replaced by a directory.
#[test]
fn pruned_tree_diffs_match_git_name_status() {
    let mut f = Fixture::basic();
    f.write("deep/a/b/c/d/e/leaf.txt", "leaf\n");
    f.write("deep/a/b/c/d/e/other.txt", "other\n");
    f.write("gone/one.txt", "1\n");
    f.write("gone/two.txt", "2\n");
    f.write("moved/x.txt", "x\n");
    f.write("moved/y.txt", "y\n");
    f.write("plain.txt", "plain\n");
    f.write("swap", "file\n");
    f.commit("layout");
    f.write("deep/a/b/c/d/e/leaf.txt", "leaf changed\n");
    f.write("added/p/q.txt", "q\n");
    f.write("added/r.txt", "r\n");
    f.git(&["rm", "-r", "-q", "gone"]);
    f.git(&["mv", "moved", "renamed"]);
    f.git(&["update-index", "--chmod=+x", "plain.txt"]);
    f.git(&["rm", "-q", "swap"]);
    f.write("swap/inner.txt", "inner\n");
    f.git(&["add", "-A"]);
    f.commit("everything at once");
    let set = diff(&f, &commit("HEAD"));
    assert_eq!(
        engine_name_status(&set),
        git_name_status(&f, &["diff", "-M", "--name-status", "HEAD~1", "HEAD"])
    );
    let range = diff(
        &f,
        &DiffTarget::Range {
            from: "HEAD~1".to_owned(),
            to: "HEAD".to_owned(),
            three_dot: false,
        },
    );
    assert_eq!(engine_name_status(&range), engine_name_status(&set));
}

/// A root commit (no parent) and two identical trees take the unpruned path.
#[test]
fn root_and_identical_trees_diff_like_git() {
    let f = Fixture::basic();
    let root = f.git(&["rev-list", "--max-parents=0", "HEAD"]);
    let set = diff(&f, &commit(&root));
    assert_eq!(
        engine_name_status(&set),
        git_name_status(&f, &["show", "--format=", "--name-status", &root])
    );
    let same = diff(&f, &commits("HEAD", "HEAD"));
    assert!(same.files.is_empty());
}

/// The UI addresses commits by hash: a truncated commit named by its raw hash, full or short,
/// is `repo.corrupt_object`, and so is a `~1` step from a ref whose tip is unreadable.
#[test]
fn a_truncated_commit_named_by_hash_is_a_corrupt_object() {
    let f = Fixture::basic();
    let hash = f.truncate_object("HEAD~1");
    let engine = engine(&f);
    for revision in [hash.clone(), hash[..7].to_owned(), "main~1".to_owned()] {
        let error = engine
            .diff(
                &commit(&revision),
                &DiffOptions::default(),
                &Cancel::never(),
            )
            .expect_err("must fail");
        assert_eq!(error.code(), "repo.corrupt_object", "{revision}: {error:?}");
    }
    let error = engine
        .diff(&commit("main~1"), &DiffOptions::default(), &Cancel::never())
        .expect_err("must fail");
    assert!(
        matches!(&error, GitError::CorruptObject { hash: reported, .. } if *reported == hash),
        "{error:?}"
    );
}

/// A revision with an absurd ancestor count fails as not found, without allocating or
/// walking anything the size of the count.
#[test]
fn an_absurd_ancestor_count_is_just_not_found() {
    let f = Fixture::basic();
    let error = engine(&f)
        .diff(
            &commit("HEAD~4000000000"),
            &DiffOptions::default(),
            &Cancel::never(),
        )
        .expect_err("must fail");
    assert_eq!(error.code(), "refs.not_found", "{error:?}");
}

/// Large files carry their hunks but no intra-line spans: the viewer collapses them, and the
/// span pass is the costly part of a diff.
#[test]
fn large_files_skip_the_intra_line_spans() {
    let mut f = Fixture::basic();
    let before: String = (0..6_000)
        .map(|i| {
            format!(
                "line {i} alpha
"
            )
        })
        .collect();
    f.write("big.txt", &before);
    f.commit("big");
    let after: String = (0..6_000)
        .map(|i| {
            format!(
                "line {i} omega
"
            )
        })
        .collect();
    f.write("big.txt", &after);
    f.commit("big changed");
    let set = diff(&f, &commit("HEAD"));
    let big = file(&set, "big.txt");
    assert!(big.is_large);
    assert_eq!(big.additions, 6_000);
    assert!(big
        .hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .all(|l| l.spans.is_empty()));
}

#[test]
fn sparse_checkout_files_off_the_disk_are_not_deletions() {
    let f = Fixture::basic();
    // A sparse checkout keeps only `src`; the docs stay in the index with `skip-worktree`
    // and off the disk, and git lists nothing.
    f.git(&["sparse-checkout", "set", "--no-cone", "src"]);
    assert!(f
        .git(&["ls-files", "-t"])
        .lines()
        .any(|line| line.starts_with("S ")));
    for base in [WorkingTreeBase::Index, WorkingTreeBase::Head] {
        let set = diff(&f, &DiffTarget::WorkingTree { base: base.clone() });
        assert_eq!(
            engine_name_status(&set),
            Vec::<NameStatus>::new(),
            "{base:?}"
        );
    }
    // An edit inside the checkout is still the only change.
    f.append("src/lib.rs", "// edited\n");
    let index = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
    );
    assert_eq!(
        engine_name_status(&index),
        git_name_status(&f, &["diff", "--name-status"])
    );
    assert_eq!(paths(&index), ["src/lib.rs"]);
}

#[test]
fn intent_to_add_is_an_addition_against_the_index() {
    let f = Fixture::basic();
    f.write("ita.txt", "new\n");
    f.git(&["add", "-N", "ita.txt"]);
    let index = diff(
        &f,
        &DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
    );
    assert_eq!(
        engine_name_status(&index),
        git_name_status(&f, &["diff", "--name-status"])
    );
    let added = file(&index, "ita.txt");
    assert_eq!(added.status, ChangeKind::Added);
    assert_eq!((added.additions, added.deletions), (1, 0));
    // Nothing of it is staged: `git diff --cached` leaves it out.
    let staged = diff(&f, &DiffTarget::Index);
    assert_eq!(
        engine_name_status(&staged),
        git_name_status(&f, &["diff", "--cached", "--name-status"])
    );
    assert!(staged.files.is_empty());
}

/// `git add -N` over a path HEAD has (after `git rm --cached`): against HEAD the file is
/// modified, with HEAD's blob as its old side, and as staged it is deleted, since the
/// placeholder stages nothing.
#[test]
fn intent_to_add_over_a_path_head_has_is_modified_against_head_and_deleted_as_staged() {
    let f = Fixture::basic();
    f.git(&["rm", "-q", "--cached", "src/lib.rs"]);
    f.git(&["add", "-N", "src/lib.rs"]);
    f.write("src/lib.rs", "pub fn one() -> u32 {\n    1\n}\n// added\n");
    for base in [
        WorkingTreeBase::Head,
        WorkingTreeBase::Revision {
            rev: "HEAD".to_owned(),
        },
    ] {
        let set = diff(&f, &DiffTarget::WorkingTree { base: base.clone() });
        assert_eq!(
            engine_name_status(&set),
            git_name_status(&f, &["diff", "HEAD", "--name-status"]),
            "{base:?}"
        );
        let changed = file(&set, "src/lib.rs");
        assert_eq!(changed.old_id, Some(f.rev("HEAD:src/lib.rs")), "{base:?}");
    }
    let staged = diff(&f, &DiffTarget::Index);
    assert_eq!(
        engine_name_status(&staged),
        git_name_status(&f, &["diff", "--cached", "--name-status"])
    );
    let deleted = file(&staged, "src/lib.rs");
    assert_eq!(deleted.status, ChangeKind::Deleted);
    assert_eq!(deleted.new_id, None);
}

/// A `git add -N` placeholder is not paired with a deleted empty file as a rename: git's
/// staged view shows the deletion alone.
#[test]
fn intent_to_add_is_not_a_rename_target_in_the_staged_view() {
    let mut f = Fixture::basic();
    f.write("empty.txt", "");
    f.commit("empty file");
    f.git(&["rm", "-q", "empty.txt"]);
    f.write("new.txt", "new\n");
    f.git(&["add", "-N", "new.txt"]);
    let staged = diff(&f, &DiffTarget::Index);
    assert_eq!(
        engine_name_status(&staged),
        git_name_status(&f, &["diff", "--cached", "-M", "--name-status"])
    );
    assert_eq!(paths(&staged), ["empty.txt"]);
}

#[test]
fn rename_similarity_counts_whitespace_like_git() {
    let mut f = Fixture::basic();
    let lines: Vec<String> = (1..=20)
        .map(|i| format!("pub fn f{i}() -> u32 {{ {i} }}"))
        .collect();
    f.write("src/lib.rs", &(lines.join("\n") + "\n"));
    f.write("src/util.rs", &(lines.join("\n") + "\n"));
    f.commit("grow");
    // A whole-file reindent under a new name: git sees an add and a delete, since its
    // similarity counts every byte.
    let reindented: Vec<String> = lines.iter().map(|line| format!("    {line}")).collect();
    f.remove("src/lib.rs");
    f.write("src/core.rs", &(reindented.join("\n") + "\n"));
    // Four lines reindented and one changed keeps enough in common for a rename.
    let mut partial = lines.clone();
    for line in partial.iter_mut().take(4) {
        *line = format!("    {line}");
    }
    partial[10] = "pub fn f11() -> u32 { 1100 }".to_owned();
    f.remove("src/util.rs");
    f.write("src/tools.rs", &(partial.join("\n") + "\n"));
    f.commit("move");
    let set = diff(&f, &commit("HEAD"));
    let mut listed = engine_name_status(&set);
    listed.sort();
    let mut expected = git_name_status(&f, &["diff", "-M", "--name-status", "HEAD~1", "HEAD"]);
    expected.sort();
    assert_eq!(listed, expected);
    assert_eq!(file(&set, "src/core.rs").status, ChangeKind::Added);
    assert_eq!(file(&set, "src/tools.rs").status, ChangeKind::Renamed);
}

#[test]
fn pages_carry_the_files_in_order_with_running_totals() {
    let mut f = with_multi_hunk_edit();
    f.write("extra.txt", "a\nb\nc\n");
    f.remove("README.md");
    f.commit("more changes");
    let whole = diff(&f, &commits("HEAD~2", "HEAD"));
    assert!(whole.files.len() >= 3, "{}", whole.files.len());
    let engine = engine(&f);
    let mut walk = engine
        .diff_pages(
            &commits("HEAD~2", "HEAD"),
            &DiffOptions::default(),
            1,
            &Cancel::never(),
        )
        .expect("start");
    let mut paged = Vec::new();
    let mut pages = 0;
    loop {
        let page = walk.next_page(&Cancel::never()).expect("page");
        pages += 1;
        assert_eq!(page.total_files as usize, whole.files.len());
        assert!(page.files.len() <= 1);
        paged.extend(page.files);
        let so_far: (u32, u32) = paged.iter().fold((0, 0), |(a, d), file| {
            (a + file.additions, d + file.deletions)
        });
        assert_eq!((page.additions, page.deletions), so_far);
        if page.done {
            break;
        }
    }
    assert_eq!(pages, whole.files.len());
    assert_eq!(paged, whole.files);
    // After the last page the handle keeps answering empty done pages.
    let after = walk.next_page(&Cancel::never()).expect("after done");
    assert!(after.files.is_empty() && after.done);
    assert_eq!(
        (after.additions, after.deletions),
        (whole.additions, whole.deletions)
    );

    // An unknown revision fails before any page; a cancelled handle stops.
    let error = engine
        .diff_pages(
            &commits("nope", "HEAD"),
            &DiffOptions::default(),
            200,
            &Cancel::never(),
        )
        .err()
        .expect("unknown revision");
    assert_eq!(error.code(), "refs.not_found");
    let cancel = Cancel::new();
    let mut walk = engine
        .diff_pages(
            &commits("HEAD~2", "HEAD"),
            &DiffOptions::default(),
            1,
            &cancel,
        )
        .expect("start");
    cancel.cancel();
    assert_eq!(
        walk.next_page(&cancel).expect_err("cancelled").code(),
        "op.cancelled"
    );
}
