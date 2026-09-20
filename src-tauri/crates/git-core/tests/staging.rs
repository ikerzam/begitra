//! `Git2Engine::stage_paths`, `unstage_paths`, `discard_paths`, `apply_selection`, `commit`
//! and `commit_context` against `git status --porcelain=v2`, `git diff` and the files on
//! disk.

mod support;

use std::fs;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    ChangeKind, CommitRequest, DiffOptions, DiffTarget, LineKind, PatchSelection, SelectedHunk,
    SelectedLine, SelectionTarget, WorkingTreeBase,
};
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

/// `XY path` per record of `git status --porcelain=v2` (`?` and `!` records as `?? path`).
fn status(f: &Fixture) -> Vec<String> {
    f.git(&[
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
    ])
    .lines()
    .filter_map(|line| {
        let mut fields = line.split(' ');
        match fields.next()? {
            "1" => {
                let xy = fields.next()?;
                let path = line.splitn(9, ' ').nth(8)?;
                Some(format!("{xy} {path}"))
            }
            "2" => {
                let xy = fields.next()?;
                let rest = line.splitn(10, ' ').nth(9)?;
                let path = rest.split('\t').next()?;
                Some(format!("{xy} {path}"))
            }
            "?" => Some(format!("?? {}", &line[2..])),
            _ => None,
        }
    })
    .collect()
}

fn strings(paths: &[&str]) -> Vec<String> {
    paths.iter().map(|p| (*p).to_owned()).collect()
}

/// The selection of `path` in `target`'s diff, every changed line selected where `pick`
/// says so (hunk index, changed-line index within the hunk).
fn selection(
    engine: &Git2Engine,
    target: &DiffTarget,
    path: &str,
    pick: impl Fn(usize, usize) -> bool,
) -> PatchSelection {
    let set = engine
        .diff(target, &DiffOptions::default(), &Cancel::never())
        .expect("diff");
    let file = set
        .files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("{path} not in the diff: {:?}", set.files));
    let hunks = file
        .hunks
        .iter()
        .enumerate()
        .map(|(h, hunk)| {
            let mut changed = 0;
            let lines = hunk
                .lines
                .iter()
                .map(|line| {
                    let selected = if line.kind == LineKind::Context {
                        false
                    } else {
                        let chosen = pick(h, changed);
                        changed += 1;
                        chosen
                    };
                    SelectedLine {
                        kind: line.kind,
                        text: line.text.clone(),
                        no_newline: line.no_newline,
                        selected,
                    }
                })
                .collect();
            SelectedHunk {
                old_start: hunk.old_start,
                old_lines: hunk.old_lines,
                new_start: hunk.new_start,
                new_lines: hunk.new_lines,
                lines,
            }
        })
        .collect();
    PatchSelection {
        path: path.to_owned(),
        status: file.status,
        hunks,
    }
}

const UNSTAGED: DiffTarget = DiffTarget::WorkingTree {
    base: WorkingTreeBase::Index,
};
const STAGED: DiffTarget = DiffTarget::Index;

fn read(f: &Fixture, relative: &str) -> String {
    fs::read_to_string(f.root.join(relative)).expect("read")
}

fn index_content(f: &Fixture, path: &str) -> String {
    f.git(&["show", &format!(":{path}")])
}

// ---------------------------------------------------------------------------- paths

#[test]
fn stages_a_modification_a_deletion_and_an_untracked_file() {
    let f = Fixture::basic();
    f.append("README.md", "more\n");
    f.remove("src/lib.rs");
    f.write("new.txt", "new\n");
    let e = engine(&f);
    e.stage_paths(
        &strings(&["README.md", "src/lib.rs", "new.txt"]),
        &Cancel::never(),
    )
    .expect("stage");
    let mut listed = status(&f);
    listed.sort();
    assert_eq!(listed, ["A. new.txt", "D. src/lib.rs", "M. README.md"]);
    assert_eq!(read(&f, "README.md"), "# Fixture\nmore\n");
    assert!(!f.root.join("src/lib.rs").exists());
}

#[test]
fn unstages_and_leaves_the_working_tree_alone() {
    let f = Fixture::basic();
    f.append("README.md", "more\n");
    f.write("new.txt", "new\n");
    f.git(&["add", "-A"]);
    let e = engine(&f);
    e.unstage_paths(&strings(&["README.md", "new.txt"]), &Cancel::never())
        .expect("unstage");
    let mut listed = status(&f);
    listed.sort();
    assert_eq!(listed, [".M README.md", "?? new.txt"]);
    assert_eq!(read(&f, "README.md"), "# Fixture\nmore\n");
}

#[test]
fn unstages_on_an_unborn_branch() {
    let f = Fixture::unborn();
    f.write("first.txt", "one\n");
    f.git(&["add", "first.txt"]);
    assert_eq!(status(&f), ["A. first.txt"]);
    engine(&f)
        .unstage_paths(&strings(&["first.txt"]), &Cancel::never())
        .expect("unstage");
    assert_eq!(status(&f), ["?? first.txt"]);
    assert_eq!(read(&f, "first.txt"), "one\n");
}

#[test]
fn odd_paths_are_staged_literally_and_many_at_once() {
    let f = Fixture::basic();
    f.write("dir with space/ünïcödé.txt", "x\n");
    f.write("-leading-dash.txt", "x\n");
    f.write("star[1].txt", "x\n");
    f.write("star1.txt", "x\n");
    let many: Vec<String> = (0..3000).map(|i| format!("many/file-{i:04}.txt")).collect();
    for path in &many {
        f.write(path, "m\n");
    }
    let e = engine(&f);
    let mut chosen = strings(&[
        "dir with space/ünïcödé.txt",
        "-leading-dash.txt",
        "star[1].txt",
    ]);
    chosen.extend(many.iter().cloned());
    e.stage_paths(&chosen, &Cancel::never()).expect("stage");
    let listed = status(&f);
    assert!(
        listed.contains(&"A. -leading-dash.txt".to_owned()),
        "{listed:?}"
    );
    assert!(listed.contains(&"A. dir with space/ünïcödé.txt".to_owned()));
    assert!(listed.contains(&"A. star[1].txt".to_owned()));
    // The glob `star[1].txt` would also match `star1.txt`; literal pathspecs do not.
    assert!(listed.contains(&"?? star1.txt".to_owned()), "{listed:?}");
    assert_eq!(
        listed.iter().filter(|l| l.starts_with("A. many/")).count(),
        3000
    );
}

#[test]
fn discards_a_modification_a_deletion_and_an_untracked_file() {
    let f = Fixture::basic();
    f.append("README.md", "more\n");
    f.remove("src/lib.rs");
    f.write("new.txt", "new\n");
    f.write("ignored.log", "log\n");
    f.write(".gitignore", "*.log\n");
    let e = engine(&f);
    e.discard_paths(
        &strings(&["README.md", "src/lib.rs"]),
        &strings(&["new.txt", "ignored.log"]),
        &Cancel::never(),
    )
    .expect("discard");
    assert_eq!(read(&f, "README.md"), "# Fixture\n");
    assert!(f.root.join("src/lib.rs").exists());
    assert!(!f.root.join("new.txt").exists());
    // `git clean -f` never removes an ignored file.
    assert!(f.root.join("ignored.log").exists());
    assert_eq!(status(&f), ["?? .gitignore"]);
}

#[test]
fn discarding_keeps_the_staged_part() {
    let f = Fixture::basic();
    f.append("README.md", "staged\n");
    f.git(&["add", "README.md"]);
    f.append("README.md", "unstaged\n");
    engine(&f)
        .discard_paths(&strings(&["README.md"]), &[], &Cancel::never())
        .expect("discard");
    assert_eq!(read(&f, "README.md"), "# Fixture\nstaged\n");
    assert_eq!(status(&f), ["M. README.md"]);
}

#[test]
fn empty_lists_run_nothing_and_a_missing_path_is_git_s_error() {
    let f = Fixture::basic();
    let e = engine(&f);
    e.stage_paths(&[], &Cancel::never()).expect("nothing");
    e.discard_paths(&[], &[], &Cancel::never())
        .expect("nothing");
    let error = e
        .discard_paths(&strings(&["no-such-file.txt"]), &[], &Cancel::never())
        .expect_err("git refuses");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert!(error.to_string().contains("no-such-file.txt"), "{error}");
}

// ------------------------------------------------------------------------ selections

/// Twenty numbered lines.
fn numbered() -> String {
    (1..=20).map(|i| format!("line {i}\n")).collect()
}

#[test]
fn stages_one_hunk_of_two() {
    let mut f = Fixture::basic();
    f.write("notes.txt", &numbered());
    f.commit("notes");
    let edited = numbered()
        .replace("line 3\n", "line 3 changed\n")
        .replace("line 17\n", "line 17 changed\n");
    f.write("notes.txt", &edited);
    let e = engine(&f);
    let first = selection(&e, &UNSTAGED, "notes.txt", |hunk, _| hunk == 0);
    assert_eq!(first.hunks.len(), 2);
    e.apply_selection(&first, SelectionTarget::Stage, &Cancel::never())
        .expect("stage hunk");
    assert_eq!(
        index_content(&f, "notes.txt"),
        numbered()
            .replace("line 3\n", "line 3 changed\n")
            .trim_end()
    );
    assert_eq!(read(&f, "notes.txt"), edited);
    assert_eq!(status(&f), ["MM notes.txt"]);
    let cached = f.git(&["diff", "--cached", "--", "notes.txt"]);
    assert!(
        cached.contains("+line 3 changed") && !cached.contains("line 17"),
        "{cached}"
    );
    let unstaged = f.git(&["diff", "--", "notes.txt"]);
    assert!(
        unstaged.contains("+line 17 changed") && !unstaged.contains("line 3"),
        "{unstaged}"
    );
}

#[test]
fn stages_three_lines_of_seven() {
    let mut f = Fixture::basic();
    f.write("notes.txt", &numbered());
    f.commit("notes");
    // One hunk: two removed lines (5 and 6) and five added ones.
    let edited = numbered().replace("line 5\nline 6\n", "five\nsix\nseven\neight\nnine\n");
    f.write("notes.txt", &edited);
    let e = engine(&f);
    // Changed lines in hunk order: -line 5, -line 6, +five, +six, +seven, +eight, +nine.
    let chosen = selection(&e, &UNSTAGED, "notes.txt", |_, i| matches!(i, 0 | 2 | 4));
    e.apply_selection(&chosen, SelectionTarget::Stage, &Cancel::never())
        .expect("stage lines");
    // The kept "line 6" stays where the hunk lists it, before the additions, as `git add
    // -p` would place it.
    assert_eq!(
        index_content(&f, "notes.txt"),
        numbered()
            .replace("line 5\nline 6\n", "line 6\nfive\nseven\n")
            .trim_end()
    );
    assert_eq!(read(&f, "notes.txt"), edited);
    assert_eq!(status(&f), ["MM notes.txt"]);
}

#[test]
fn unstages_lines_of_a_staged_hunk() {
    let mut f = Fixture::basic();
    f.write("notes.txt", &numbered());
    f.commit("notes");
    let edited = numbered().replace("line 10\n", "ten\neleven\n");
    f.write("notes.txt", &edited);
    f.git(&["add", "notes.txt"]);
    let e = engine(&f);
    // Changed lines: -line 10, +ten, +eleven; take the removal and "eleven" out of the index.
    let chosen = selection(&e, &STAGED, "notes.txt", |_, i| i != 1);
    e.apply_selection(&chosen, SelectionTarget::Unstage, &Cancel::never())
        .expect("unstage lines");
    // "line 10" returns where the hunk lists it, before the kept "ten".
    assert_eq!(
        index_content(&f, "notes.txt"),
        numbered().replace("line 10\n", "line 10\nten\n").trim_end()
    );
    assert_eq!(read(&f, "notes.txt"), edited);
}

#[test]
fn discards_selected_lines_in_the_working_tree() {
    let mut f = Fixture::basic();
    f.write("notes.txt", &numbered());
    f.commit("notes");
    let edited = numbered()
        .replace("line 2\n", "line 2\nextra a\nextra b\n")
        .replace("line 19\n", "nineteen\n");
    f.write("notes.txt", &edited);
    let e = engine(&f);
    // Hunk 0: +extra a, +extra b; hunk 1: -line 19, +nineteen. Discard the two extras.
    let chosen = selection(&e, &UNSTAGED, "notes.txt", |hunk, _| hunk == 0);
    e.apply_selection(&chosen, SelectionTarget::Discard, &Cancel::never())
        .expect("discard lines");
    assert_eq!(
        read(&f, "notes.txt"),
        numbered().replace("line 19\n", "nineteen\n")
    );
    assert_eq!(status(&f), [".M notes.txt"]);
}

#[test]
fn a_stale_selection_is_refused_and_nothing_applied() {
    let mut f = Fixture::basic();
    f.write("notes.txt", &numbered());
    f.commit("notes");
    f.write("notes.txt", &numbered().replace("line 3\n", "three\n"));
    let e = engine(&f);
    let chosen = selection(&e, &UNSTAGED, "notes.txt", |_, _| true);
    // The index moves on before the selection is staged (a `git add` in a terminal), so
    // the context of the hunk no longer matches it.
    f.write(
        "notes.txt",
        &numbered().replace("line 2\nline 3\n", "two\nthree\n"),
    );
    f.git(&["add", "notes.txt"]);
    let staged_before = f.git(&["rev-parse", ":notes.txt"]);
    let error = e
        .apply_selection(&chosen, SelectionTarget::Stage, &Cancel::never())
        .expect_err("context no longer matches the index");
    match error {
        GitError::Cli { stderr, .. } => assert!(stderr.contains("patch"), "{stderr}"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(f.git(&["rev-parse", ":notes.txt"]), staged_before);
    // The same for the working tree: a discard of a hunk the file no longer holds.
    f.git(&["reset", "-q", "notes.txt"]);
    f.write("notes.txt", &numbered().replace("line 3\n", "three\n"));
    let chosen = selection(&e, &UNSTAGED, "notes.txt", |_, _| true);
    f.write("notes.txt", &numbered().replace("line 3\n", "THREE\n"));
    let error = e
        .apply_selection(&chosen, SelectionTarget::Discard, &Cancel::never())
        .expect_err("context no longer matches the file");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(
        read(&f, "notes.txt"),
        numbered().replace("line 3\n", "THREE\n")
    );
}

#[test]
fn a_file_without_a_trailing_newline_stages_as_git_adds_it() {
    let mut f = Fixture::basic();
    f.write("notes.txt", "a\nb\n");
    f.commit("notes");
    f.write("notes.txt", "a\nb\nc");
    let e = engine(&f);
    let chosen = selection(&e, &UNSTAGED, "notes.txt", |_, _| true);
    e.apply_selection(&chosen, SelectionTarget::Stage, &Cancel::never())
        .expect("stage");
    let staged = f.git(&["show", ":notes.txt"]);
    assert_eq!(staged, "a\nb\nc");
    let blob_via_add = {
        f.git(&["add", "notes.txt"]);
        f.git(&["rev-parse", ":notes.txt"])
    };
    let staged_hash = f.git(&["rev-parse", ":notes.txt"]);
    assert_eq!(staged_hash, blob_via_add);
    assert_eq!(status(&f), ["M. notes.txt"]);
}

#[test]
fn crlf_files_apply_byte_for_byte() {
    let mut f = Fixture::basic();
    f.write("win.txt", "one\r\ntwo\r\nthree\r\n");
    f.commit("crlf");
    f.write("win.txt", "one\r\n2\r\nthree\r\nfour\r\n");
    let e = engine(&f);
    // Changed lines: -two, +2, +four; stage the first pair only.
    let chosen = selection(&e, &UNSTAGED, "win.txt", |_, i| i < 2);
    e.apply_selection(&chosen, SelectionTarget::Stage, &Cancel::never())
        .expect("stage");
    assert_eq!(
        fs::read(f.root.join("win.txt")).expect("read"),
        b"one\r\n2\r\nthree\r\nfour\r\n"
    );
    let staged = f.git(&["show", ":win.txt"]);
    assert_eq!(staged, "one\r\n2\r\nthree");
}

#[test]
fn a_whole_new_file_is_created_in_the_index_and_removed_again() {
    let mut f = Fixture::basic();
    f.write("fresh.txt", "a\nb\n");
    f.git(&["add", "fresh.txt"]);
    f.tick();
    let e = engine(&f);
    let staged = selection(&e, &STAGED, "fresh.txt", |_, _| true);
    assert_eq!(staged.status, ChangeKind::Added);
    e.apply_selection(&staged, SelectionTarget::Unstage, &Cancel::never())
        .expect("unstage whole new file");
    assert_eq!(status(&f), ["?? fresh.txt"]);
    // Half of it back into the index: the file exists there with one line.
    let staged_again = {
        f.git(&["add", "fresh.txt"]);
        selection(&e, &STAGED, "fresh.txt", |_, i| i == 0)
    };
    e.apply_selection(&staged_again, SelectionTarget::Unstage, &Cancel::never())
        .expect("unstage one line of a new file");
    assert_eq!(index_content(&f, "fresh.txt"), "b");
}

// ---------------------------------------------------------------------------- commit

#[test]
fn commits_the_index_with_a_subject_and_a_body() {
    let f = Fixture::basic();
    f.write("a.txt", "a\n");
    f.write("b.txt", "b\n");
    f.git(&["add", "a.txt", "b.txt"]);
    let e = engine(&f);
    let before = f.head();
    let hash = e
        .commit(
            &CommitRequest {
                message: "feat: two files\n\nThe body.\n".to_owned(),
                amend: false,
                signoff: false,
            },
            &Cancel::never(),
        )
        .expect("commit");
    assert_eq!(hash, f.head());
    assert_ne!(hash, before);
    assert_eq!(
        f.git(&["log", "-1", "--format=%B"]),
        "feat: two files\n\nThe body."
    );
    let shown = f.git(&["show", "--stat", "--format=", "HEAD"]);
    assert!(
        shown.contains("a.txt") && shown.contains("b.txt"),
        "{shown}"
    );
    assert_eq!(f.git(&["rev-parse", "HEAD^"]), before);
}

#[test]
fn amends_with_sign_off_and_keeps_the_old_commit_in_the_reflog() {
    let f = Fixture::basic();
    let old = f.head();
    let parent = f.git(&["rev-parse", "HEAD^"]);
    let e = engine(&f);
    let hash = e
        .commit(
            &CommitRequest {
                message: "m1: merge develop, amended".to_owned(),
                amend: true,
                signoff: true,
            },
            &Cancel::never(),
        )
        .expect("amend");
    assert_eq!(hash, f.head());
    assert_eq!(f.git(&["rev-parse", "HEAD^"]), parent);
    let message = f.git(&["log", "-1", "--format=%B"]);
    assert!(
        message.starts_with("m1: merge develop, amended"),
        "{message}"
    );
    assert!(
        message.ends_with("Signed-off-by: Fixture <fixture@example.com>"),
        "{message}"
    );
    let reflog = f.git(&["reflog", "--format=%H"]);
    assert!(reflog.lines().any(|line| line == old), "{reflog}");
}

#[test]
fn a_failing_hook_is_reported_and_nothing_committed() {
    let f = Fixture::basic();
    let hooks = f.git_dir().join("hooks");
    fs::create_dir_all(&hooks).expect("hooks");
    fs::write(
        hooks.join("pre-commit"),
        "#!/bin/sh\necho refused by the hook >&2\nexit 1\n",
    )
    .expect("hook");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(hooks.join("pre-commit"), fs::Permissions::from_mode(0o755))
            .expect("chmod");
    }
    f.write("a.txt", "a\n");
    f.git(&["add", "a.txt"]);
    let before = f.head();
    let error = engine(&f)
        .commit(
            &CommitRequest {
                message: "blocked".to_owned(),
                amend: false,
                signoff: false,
            },
            &Cancel::never(),
        )
        .expect_err("the hook refuses");
    match error {
        GitError::Cli { stderr, status, .. } => {
            assert!(stderr.contains("refused by the hook"), "{stderr}");
            assert_ne!(status, Some(0));
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(f.head(), before);
    assert_eq!(status(&f), ["A. a.txt"]);
}

#[test]
fn an_empty_index_is_refused() {
    let f = Fixture::basic();
    let error = engine(&f)
        .commit(
            &CommitRequest {
                message: "nothing".to_owned(),
                amend: false,
                signoff: false,
            },
            &Cancel::never(),
        )
        .expect_err("nothing to commit");
    assert!(matches!(error, GitError::Cli { .. }), "{error:?}");
}

#[test]
fn the_context_has_the_author_the_template_and_the_head_message() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.author, "Fixture <fixture@example.com>");
    assert_eq!(context.template, None);
    assert!(!context.unborn);
    assert_eq!(context.head_message.as_deref(), Some("m1: merge develop"));
    f.write(".gitmessage", "# subject\n\n# body\n");
    f.git(&["config", "commit.template", ".gitmessage"]);
    f.commit("d3: body\n\nWith a body.");
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.template.as_deref(), Some("# subject\n\n# body\n"));
    assert_eq!(
        context.head_message.as_deref(),
        Some("d3: body\n\nWith a body.")
    );
    f.git(&["config", "commit.template", "missing-template"]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.template, None);
}

#[test]
fn the_context_of_an_unborn_branch() {
    let f = Fixture::unborn();
    let context = engine(&f)
        .commit_context(&Cancel::never())
        .expect("context");
    assert!(context.unborn);
    assert_eq!(context.head_message, None);
    assert_eq!(context.author, "Fixture <fixture@example.com>");
}

#[test]
fn commits_on_an_unborn_branch() {
    let f = Fixture::unborn();
    f.write("first.txt", "one\n");
    f.git(&["add", "first.txt"]);
    let hash = engine(&f)
        .commit(
            &CommitRequest {
                message: "first".to_owned(),
                amend: false,
                signoff: false,
            },
            &Cancel::never(),
        )
        .expect("commit");
    assert_eq!(hash, f.head());
    assert_eq!(f.git(&["rev-list", "--count", "HEAD"]), "1");
}
