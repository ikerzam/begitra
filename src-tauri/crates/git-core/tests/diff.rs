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
