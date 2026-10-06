//! `Git2Engine::stage_paths`, `unstage_paths`, `discard_paths`, `apply_selection`, `commit`
//! and `commit_context` against `git status --porcelain=v2`, `git diff` and the files on
//! disk.

mod support;

use std::fs;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    ChangeKind, CommitRequest, DiffOptions, DiffTarget, LineKind, OperationState, OtherOperation,
    PatchSelection, SelectedHunk, SelectedLine, SelectionTarget, WorkingTreeBase,
};
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

/// The parents of `rev` as git reads them: `git rev-list --parents -n 1`, the commit dropped.
fn parents_of(f: &Fixture, cwd: &std::path::Path, rev: &str) -> Vec<String> {
    f.git_in(cwd, &["rev-list", "--parents", "-n", "1", rev])
        .split_whitespace()
        .skip(1)
        .map(str::to_owned)
        .collect()
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
        lossy: file.is_lossy,
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
fn half_of_an_end_of_file_change_is_refused_and_the_pair_stages_alone() {
    let mut f = Fixture::basic();
    f.write("tail.txt", "a\nb");
    f.commit("no trailing newline");
    f.write("tail.txt", "a\nb\nc");
    let e = engine(&f);
    // Changed lines: -b (no newline), +b, +c (no newline). Only +c: refused, nothing staged.
    let only_c = selection(&e, &UNSTAGED, "tail.txt", |_, i| i == 2);
    let error = e
        .apply_selection(&only_c, SelectionTarget::Stage, &Cancel::never())
        .expect_err("half of the end-of-file change");
    assert!(
        error.to_string().contains("select the last line"),
        "{error}"
    );
    assert_eq!(f.git(&["diff", "--cached", "--stat"]), "");
    // The pair alone: the index gets `a\nb\n`.
    let pair = selection(&e, &UNSTAGED, "tail.txt", |_, i| i < 2);
    e.apply_selection(&pair, SelectionTarget::Stage, &Cancel::never())
        .expect("the pair");
    // The fixture's git output is trimmed, so the size tells the trailing newline apart.
    assert_eq!(f.git(&["show", ":tail.txt"]), "a\nb");
    assert_eq!(
        f.git(&["cat-file", "-s", &f.git(&["rev-parse", ":tail.txt"])]),
        "4",
        "a, newline, b, newline"
    );
    assert_eq!(read(&f, "tail.txt"), "a\nb\nc");
}

#[test]
fn odd_paths_round_trip_through_git_apply() {
    let mut f = Fixture::basic();
    for path in ["dir with space/file.txt", "ünïcödé/näme.txt"] {
        f.write(path, "one\ntwo\n");
    }
    f.commit("odd paths");
    for path in ["dir with space/file.txt", "ünïcödé/näme.txt"] {
        f.write(path, "one\nTWO\nthree\n");
    }
    let e = engine(&f);
    for path in ["dir with space/file.txt", "ünïcödé/näme.txt"] {
        // Changed lines: -two, +TWO, +three; stage the first pair.
        let chosen = selection(&e, &UNSTAGED, path, |_, i| i < 2);
        e.apply_selection(&chosen, SelectionTarget::Stage, &Cancel::never())
            .expect("stage lines of an odd path");
        assert_eq!(index_content(&f, path), "one\nTWO");
        let staged = selection(&e, &STAGED, path, |_, _| true);
        e.apply_selection(&staged, SelectionTarget::Unstage, &Cancel::never())
            .expect("unstage them again");
        assert_eq!(index_content(&f, path), "one\ntwo");
    }
}

#[test]
fn a_linked_worktree_stages_into_its_own_index() {
    let f = Fixture::basic().with_linked_worktree();
    let worktree = f.worktree_path();
    std::fs::write(worktree.join("README.md"), "# In the worktree\n").expect("write");
    let e = Git2Engine::open(&worktree).expect("open the worktree");
    e.stage_paths(&strings(&["README.md"]), &Cancel::never())
        .expect("stage");
    assert_eq!(
        f.git_in(&worktree, &["diff", "--cached", "--name-only"]),
        "README.md"
    );
    assert_eq!(
        f.git(&["diff", "--cached", "--name-only"]),
        "",
        "the main index is untouched"
    );
    let hash = e
        .commit(
            &CommitRequest {
                message: "worktree commit".to_owned(),
                amend: false,
                signoff: false,
            },
            &Cancel::never(),
        )
        .expect("commit in the worktree");
    assert_eq!(f.git_in(&worktree, &["rev-parse", "HEAD"]), hash);
    assert_eq!(f.git(&["rev-parse", "feature/wt"]), hash);
    assert_ne!(f.head(), hash, "main's HEAD stays");
}

#[test]
fn comment_lines_are_kept_as_git_commit_m_keeps_them() {
    let f = Fixture::basic();
    f.write("a.txt", "a\n");
    f.git(&["add", "a.txt"]);
    engine(&f)
        .commit(
            &CommitRequest {
                message: "#123 fix the thing\n\n# a heading in the body\nbody line\n\n\n"
                    .to_owned(),
                amend: false,
                signoff: false,
            },
            &Cancel::never(),
        )
        .expect("commit");
    assert_eq!(
        f.git(&["log", "-1", "--format=%B"]),
        "#123 fix the thing\n\n# a heading in the body\nbody line"
    );
}

#[test]
fn a_file_with_bytes_that_are_not_utf8_is_flagged_and_only_staged_whole() {
    let mut f = Fixture::basic();
    fs::write(f.root.join("latin.txt"), b"hello\nend\n").expect("write");
    f.commit("latin");
    fs::write(f.root.join("latin.txt"), b"hello\nend\nna\xefve\nmore\n").expect("write");
    let e = engine(&f);
    let chosen = selection(&e, &UNSTAGED, "latin.txt", |_, i| i == 0);
    assert!(chosen.lossy, "the diff flags the file");
    let error = e
        .apply_selection(&chosen, SelectionTarget::Stage, &Cancel::never())
        .expect_err("a partial selection would write replacement characters");
    assert!(error.to_string().contains("UTF-8"), "{error}");
    assert_eq!(f.git(&["diff", "--cached", "--stat"]), "");
    // Whole: the path operation keeps the bytes.
    let whole = selection(&e, &UNSTAGED, "latin.txt", |_, _| true);
    e.apply_selection(&whole, SelectionTarget::Stage, &Cancel::never())
        .expect("whole file through git add");
    let blob = f.git(&["rev-parse", ":latin.txt"]);
    let shown = git_core::cli::command(&f.root, &["cat-file", "-p", &blob])
        .output()
        .expect("cat-file");
    assert_eq!(shown.stdout, b"hello\nend\nna\xefve\nmore\n");
    assert_eq!(status(&f), ["M. latin.txt"]);
}

#[test]
fn hunks_sent_out_of_order_still_apply_where_they_belong() {
    let mut f = Fixture::basic();
    let block: String = "x\ny\nz\n".repeat(10);
    f.write("amb.txt", &block);
    f.commit("ambiguous");
    let mut lines: Vec<String> = block.lines().map(str::to_owned).collect();
    lines[4] = "Y2".to_owned();
    lines[22] = "Y8".to_owned();
    lines.insert(23, "added 1".to_owned());
    lines.insert(24, "added 2".to_owned());
    let edited = lines.join("\n") + "\n";
    f.write("amb.txt", &edited);
    let e = engine(&f);
    let mut chosen = selection(&e, &UNSTAGED, "amb.txt", |_, _| true);
    assert_eq!(chosen.hunks.len(), 2);
    chosen.hunks.reverse();
    e.apply_selection(&chosen, SelectionTarget::Stage, &Cancel::never())
        .expect("stage");
    assert_eq!(index_content(&f, "amb.txt"), edited.trim_end());
    assert_eq!(status(&f), ["M. amb.txt"]);
}

#[test]
fn an_empty_index_is_refused_with_git_s_own_words() {
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
    assert!(error.to_string().contains("nothing to commit"), "{error}");
}

#[test]
fn partial_selections_create_the_file_where_the_target_side_has_none() {
    let mut f = Fixture::basic();
    // Part of an untracked file into the index.
    f.write("fresh.txt", "a\nb\nc\n");
    let e = engine(&f);
    let chosen = selection(&e, &UNSTAGED, "fresh.txt", |_, i| i != 1);
    assert_eq!(chosen.status, ChangeKind::Added);
    e.apply_selection(&chosen, SelectionTarget::Stage, &Cancel::never())
        .expect("stage two lines of an untracked file");
    assert_eq!(index_content(&f, "fresh.txt"), "a\nc");
    assert_eq!(status(&f), ["AM fresh.txt"]);
    // Part of a staged deletion back into the index.
    f.git(&["reset", "-q", "fresh.txt"]);
    f.git(&["add", "fresh.txt"]);
    f.commit("fresh");
    f.git(&["rm", "-q", "fresh.txt"]);
    let staged = selection(&e, &STAGED, "fresh.txt", |_, i| i == 2);
    assert_eq!(staged.status, ChangeKind::Deleted);
    e.apply_selection(&staged, SelectionTarget::Unstage, &Cancel::never())
        .expect("unstage one line of a staged deletion");
    assert_eq!(index_content(&f, "fresh.txt"), "c");
    assert_eq!(status(&f), ["MD fresh.txt"]);
    // A partial discard of a deleted or untracked file is refused.
    f.write("loose.txt", "a\nb\n");
    let loose = selection(&e, &UNSTAGED, "loose.txt", |_, i| i == 0);
    let error = e
        .apply_selection(&loose, SelectionTarget::Discard, &Cancel::never())
        .expect_err("discard whole");
    assert!(error.to_string().contains("discard it whole"), "{error}");
    assert!(f.root.join("loose.txt").exists());
}

#[test]
fn the_context_names_the_merge_in_progress_and_its_prepared_message() {
    let mut f = Fixture::basic();
    f.git(&["switch", "-q", "-c", "other", "main"]);
    f.write("README.md", "# Other\n");
    f.commit("other readme");
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    f.commit("main readme");
    let (ok, _, _) = f.try_git(&["merge", "other"]);
    assert!(!ok, "the merge stops on the conflict");
    let e = engine(&f);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.operation, git_core::types::OperationState::Merge);
    let prepared = context.prepared_message.expect("MERGE_MSG");
    assert!(prepared.starts_with("Merge branch 'other'"), "{prepared}");
    assert!(prepared.contains("README.md"), "{prepared}");
    f.git(&["merge", "--abort"]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.operation, git_core::types::OperationState::None);
    assert_eq!(context.prepared_message, None);
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
    assert_eq!(context.head.as_deref(), Some(f.head().as_str()));
    assert_eq!(context.head_parents, parents_of(&f, &f.root, "HEAD"));
    assert_eq!(
        context.head_parents.len(),
        2,
        "HEAD is the merge of develop"
    );
    assert_eq!(context.other_operation, None);
    f.write(".gitmessage", "# subject\n\n# body\n");
    f.git(&["config", "commit.template", ".gitmessage"]);
    f.commit("d3: body\n\nWith a body.");
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.template.as_deref(), Some("# subject\n\n# body\n"));
    assert_eq!(
        context.head_message.as_deref(),
        Some("d3: body\n\nWith a body.")
    );
    assert_eq!(context.head.as_deref(), Some(f.head().as_str()));
    assert_eq!(context.head_parents, parents_of(&f, &f.root, "HEAD"));
    assert_eq!(context.head_parents.len(), 1);
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
    assert_eq!(context.head, None);
    assert!(context.head_parents.is_empty());
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
    // The first commit has no parent: nothing to undo it to.
    let context = engine(&f)
        .commit_context(&Cancel::never())
        .expect("context");
    assert!(!context.unborn);
    assert_eq!(context.head.as_deref(), Some(hash.as_str()));
    assert!(context.head_parents.is_empty());
}

#[test]
fn the_context_reads_heads_parents_as_git_does() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    let parent = f.head();
    let v1 = f.rev("v1^{commit}");
    f.write("graft.txt", "grafted\n");
    let tip = f.commit("g1: a commit to graft");
    // A replace ref that drops the parents: git reads a first commit, and so does the context.
    f.git(&["replace", "--graft", &tip]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.head.as_deref(), Some(tip.as_str()));
    assert_eq!(context.head_parents, parents_of(&f, &f.root, "HEAD"));
    assert!(context.head_parents.is_empty());
    // One that adds a parent: a merge, as git reads it.
    f.git(&["replace", "-d", &tip]);
    f.git(&["replace", "--graft", &tip, &parent, &v1]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.head_parents, vec![parent.clone(), v1]);
    f.git(&["replace", "-d", &tip]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.head_parents, vec![parent]);
    assert_eq!(
        context.head_message.as_deref(),
        Some("g1: a commit to graft")
    );
}

#[test]
fn the_context_of_a_shallow_clone_follows_an_unshallow() {
    let f = Fixture::basic();
    let clone = f.sibling("shallow");
    let clone_str = clone.to_str().expect("utf-8 temp path");
    let root = f.root.to_str().expect("utf-8 temp path");
    f.git(&["clone", "-q", "--no-local", "--depth", "1", root, clone_str]);
    f.git_in(&clone, &["config", "user.name", "Fixture"]);
    f.git_in(&clone, &["config", "user.email", "fixture@example.com"]);
    let e = Git2Engine::open(&clone).expect("open the clone");
    let context = e.commit_context(&Cancel::never()).expect("context");
    // The history stops at HEAD: git reads no parent.
    assert!(
        context.head_parents.is_empty(),
        "{:?}",
        context.head_parents
    );
    f.git_in(&clone, &["fetch", "-q", "--unshallow"]);
    // The same engine, after the history grew under it: the parents git reads now.
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.head_parents, parents_of(&f, &clone, "HEAD"));
    assert_eq!(context.head_parents.len(), 2);
}

#[test]
fn the_context_names_a_bisect_and_a_stopped_am() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    let first = f.git(&["rev-list", "--max-parents=0", "HEAD"]);
    f.git(&["bisect", "start", "HEAD", &first]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.other_operation, Some(OtherOperation::Bisect));
    assert_eq!(context.operation, OperationState::None);
    f.git(&["bisect", "reset"]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.other_operation, None);
    // A `git am` that stops: its patch edits a line the branch changed meanwhile.
    f.write("README.md", "# Patched\n");
    let patched = f.commit("p1: the patch");
    let patches = f.sibling("patches");
    let patch = f.git(&[
        "format-patch",
        "-1",
        "-o",
        patches.to_str().expect("utf-8 temp path"),
        &patched,
    ]);
    f.git(&["reset", "-q", "--hard", "HEAD~1"]);
    f.write("README.md", "# Changed meanwhile\n");
    f.commit("p2: a change the patch does not expect");
    let (applied, _, _) = f.try_git(&["am", patch.trim()]);
    assert!(!applied, "the patch must stop");
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.other_operation, Some(OtherOperation::Am));
    f.git(&["am", "--abort"]);
}

#[test]
fn the_context_reads_heads_message_as_utf8_whatever_the_log_encoding() {
    let f = Fixture::basic();
    let e = engine(&f);
    f.write("latin1.txt", "latin1\n");
    f.git(&["add", "latin1.txt"]);
    let message = f.sibling("latin1.msg");
    fs::write(&message, b"latin1: caf\xe9 cr\xe8me\n\nna\xefve body\n").expect("message");
    f.git(&[
        "-c",
        "i18n.commitEncoding=ISO-8859-1",
        "commit",
        "-q",
        "-F",
        message.to_str().expect("utf-8 temp path"),
    ]);
    f.git(&["config", "i18n.commitEncoding", "ISO-8859-1"]);
    f.git(&["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(
        context.head_message.as_deref(),
        Some("latin1: café crème\n\nnaïve body")
    );
}

#[test]
fn the_context_names_a_pick_sequence_whose_stop_was_committed_by_hand() {
    let mut f = Fixture::basic();
    let e = engine(&f);
    f.git(&["switch", "-q", "-c", "picks", "v1"]);
    for (i, text) in ["one", "two", "three"].iter().enumerate() {
        f.write("README.md", &format!("# {text}\n"));
        f.commit(&format!("p{i}: {text}"));
    }
    f.git(&["switch", "-q", "main"]);
    f.write("README.md", "# Main\n");
    f.commit("m2: main readme");
    let (picked, _, _) = f.try_git(&["cherry-pick", "picks~2", "picks~1", "picks"]);
    assert!(!picked, "the sequence must stop");
    f.write("README.md", "# resolved\n");
    f.git(&["add", "README.md"]);
    f.git(&["commit", "-q", "--no-edit"]);
    // `CHERRY_PICK_HEAD` is gone and libgit2 reads a clean state; `sequencer/todo` stays.
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.operation, OperationState::None);
    assert_eq!(context.other_operation, Some(OtherOperation::Sequence));
    f.git(&["cherry-pick", "--abort"]);
    let context = e.commit_context(&Cancel::never()).expect("context");
    assert_eq!(context.other_operation, None);
}
