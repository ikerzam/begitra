//! A conflicted file's blocks read with git's marker rules, one block rewritten with a side,
//! both sides or a text, and put back, against the files real merges leave behind.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{BlockResolution, BlockSide, ConflictText};
use support::Fixture;

const FILE: &str = "tiles.ts";

const BASE: &str = "const one = 1;\nconst a = \"base\";\nconst three = 3;\nconst four = 4;\nconst five = 5;\nconst six = 6;\nconst b = \"base\";\nconst eight = 8;\n";
const OURS: &str = "const one = 1;\nconst a = \"main\";\nconst three = 3;\nconst four = 4;\nconst five = 5;\nconst six = 6;\nconst b = \"main\";\nconst eight = 8;\n";
const THEIRS: &str = "const one = 1;\nconst a = \"feature\";\nconst a2 = \"feature\";\nconst three = 3;\nconst four = 4;\nconst five = 5;\nconst six = 6;\nconst b = \"feature\";\nconst eight = 8;\n";

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn never() -> Cancel {
    Cancel::never()
}

fn bytes(f: &Fixture) -> Vec<u8> {
    std::fs::read(f.root.join(FILE)).expect("read the file")
}

fn side(text: &ConflictText, side: &BlockSide) -> Vec<String> {
    text.lines[side.start as usize..side.end as usize].to_vec()
}

/// `tiles.ts` as `base`, then `ours` on `main` and `theirs` on `feature`, and the merge of
/// `feature` into `main`, which stops on it.
fn merged(f: &mut Fixture, base: &[u8], ours: &[u8], theirs: &[u8]) {
    std::fs::write(f.root.join(FILE), base).expect("write base");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "feature"]);
    std::fs::write(f.root.join(FILE), theirs).expect("write theirs");
    f.commit("feature");
    f.git(&["switch", "-q", "main"]);
    std::fs::write(f.root.join(FILE), ours).expect("write ours");
    f.commit("main");
    let (merged, _, _) = f.try_git(&["merge", "feature"]);
    assert!(!merged, "the merge did not stop on a conflict");
}

fn two_blocks() -> Fixture {
    let mut f = Fixture::empty();
    merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), THEIRS.as_bytes());
    f
}

#[test]
fn reads_the_blocks_git_wrote_with_their_sides_and_labels() {
    let f = two_blocks();
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
    assert!(text.paired && text.utf8 && !text.crlf);
    assert_eq!(text.blocks.len(), 2);
    let first = &text.blocks[0];
    assert_eq!(text.lines[first.start as usize], "<<<<<<< HEAD");
    assert_eq!(text.lines[first.end as usize - 1], ">>>>>>> feature");
    assert_eq!(
        (first.ours.label.as_str(), first.theirs.label.as_str()),
        ("HEAD", "feature")
    );
    assert_eq!(side(&text, &first.ours), ["const a = \"main\";"]);
    assert_eq!(
        side(&text, &first.theirs),
        ["const a = \"feature\";", "const a2 = \"feature\";"]
    );
    assert!(first.base.is_none());
    let second = &text.blocks[1];
    assert_eq!(side(&text, &second.ours), ["const b = \"main\";"]);
    assert_eq!(side(&text, &second.theirs), ["const b = \"feature\";"]);
    // The text between the blocks is the file's own.
    assert_eq!(text.lines[first.end as usize], "const three = 3;");
    assert_eq!(
        text.lines.len(),
        String::from_utf8(bytes(&f)).expect("utf-8").lines().count()
    );
}

#[test]
fn reads_the_base_of_diff3_blocks_and_a_shorter_run_as_text() {
    let mut f = Fixture::empty();
    f.git(&["config", "merge.conflictStyle", "diff3"]);
    f.write(".gitattributes", "tiles.ts conflict-marker-size=10\n");
    let theirs = THEIRS.replace("const a2 = \"feature\";\n", "=======\n");
    merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), theirs.as_bytes());
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
    assert!(text.paired);
    assert_eq!(text.blocks.len(), 2);
    let first = &text.blocks[0];
    assert!(text.lines[first.start as usize].starts_with("<<<<<<<<<< "));
    let base = first.base.as_ref().expect("a base under diff3");
    assert_eq!(side(&text, base), ["const a = \"base\";"]);
    assert_eq!(
        side(&text, &first.theirs),
        ["const a = \"feature\";", "======="]
    );
}

#[test]
fn writes_one_side_and_puts_the_block_back() {
    let f = two_blocks();
    let before = bytes(&f);
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    let resolved = engine
        .resolve_conflict_block(
            FILE,
            &text.fingerprint,
            0,
            &BlockResolution::Theirs,
            &never(),
        )
        .expect("resolve");
    let after = String::from_utf8(bytes(&f)).expect("utf-8");
    assert!(after.starts_with(
        "const one = 1;\nconst a = \"feature\";\nconst a2 = \"feature\";\nconst three = 3;\n"
    ));
    assert_eq!(after.matches("<<<<<<< HEAD").count(), 1, "{after}");
    assert_eq!(resolved.file.blocks.len(), 1);
    assert_ne!(resolved.file.fingerprint, text.fingerprint);
    // The file stays conflicted until it is marked resolved.
    assert!(!f.git(&["ls-files", "-u", "--", FILE]).is_empty());
    let back = engine
        .undo_conflict_block(FILE, &resolved.undo, &never())
        .expect("undo");
    assert_eq!(bytes(&f), before);
    assert_eq!(back.blocks.len(), 2);
    assert_eq!(back.fingerprint, text.fingerprint);
}

#[test]
fn writes_both_sides_in_order_and_an_edit_with_the_files_line_ending() {
    let mut f = Fixture::empty();
    f.write(".gitattributes", "*.ts text eol=crlf\n");
    merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), THEIRS.as_bytes());
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    assert!(text.crlf);
    let both = engine
        .resolve_conflict_block(FILE, &text.fingerprint, 0, &BlockResolution::Both, &never())
        .expect("both");
    let after = String::from_utf8(bytes(&f)).expect("utf-8");
    assert!(after.starts_with(
        "const one = 1;\r\nconst a = \"main\";\r\nconst a = \"feature\";\r\nconst a2 = \"feature\";\r\nconst three = 3;\r\n"
    ));
    let edit = BlockResolution::Text {
        text: "const b = \"edited\";\nconst c = \"edited\";\n".to_owned(),
    };
    engine
        .resolve_conflict_block(FILE, &both.file.fingerprint, 0, &edit, &never())
        .expect("edit");
    let after = String::from_utf8(bytes(&f)).expect("utf-8");
    assert!(
        after.ends_with("const six = 6;\r\nconst b = \"edited\";\r\nconst c = \"edited\";\r\nconst eight = 8;\r\n"),
        "{after:?}"
    );
    assert!(
        !after.replace("\r\n", "").contains('\n'),
        "a line lost its CR: {after:?}"
    );
}

#[test]
fn an_empty_edit_removes_the_block() {
    let f = two_blocks();
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    let empty = BlockResolution::Text {
        text: String::new(),
    };
    engine
        .resolve_conflict_block(FILE, &text.fingerprint, 1, &empty, &never())
        .expect("edit");
    let after = String::from_utf8(bytes(&f)).expect("utf-8");
    assert!(
        after.ends_with("const six = 6;\nconst eight = 8;\n"),
        "{after:?}"
    );
}

#[test]
fn copies_the_bytes_of_a_file_that_is_not_utf8() {
    let mut f = Fixture::empty();
    let base = b"caf\xe9 = 1\nbase\nend\n".to_vec();
    let ours = b"caf\xe9 = 1\nm\xe9in\nend\n".to_vec();
    let theirs = b"caf\xe9 = 1\nfeat\xfcre\nend\n".to_vec();
    merged(&mut f, &base, &ours, &theirs);
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    assert!(!text.utf8);
    assert_eq!(text.blocks.len(), 1);
    engine
        .resolve_conflict_block(FILE, &text.fingerprint, 0, &BlockResolution::Ours, &never())
        .expect("ours");
    assert_eq!(bytes(&f), ours);
}

#[test]
fn a_marker_without_its_pair_reads_unpaired() {
    let f = two_blocks();
    let mut text = bytes(&f);
    text.extend_from_slice(b"<<<<<<< stray\nleft over\n");
    std::fs::write(f.root.join(FILE), text).expect("write");
    let read = engine(&f).conflict_blocks(FILE, &never()).expect("read");
    assert!(!read.paired);
    assert!(read.blocks.is_empty());
}

#[test]
fn refuses_a_path_without_a_conflict() {
    let f = two_blocks();
    f.write("clean.ts", "clean\n");
    let engine = engine(&f);
    for path in ["clean.ts", "missing.ts", "../outside.ts"] {
        match engine.conflict_blocks(path, &never()) {
            Err(GitError::NotConflicted(named)) => assert_eq!(named, path),
            other => panic!("{path}: expected not conflicted, got {other:?}"),
        }
    }
}

#[test]
fn refuses_a_file_changed_since_it_was_read() {
    let f = two_blocks();
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    let mut edited = bytes(&f);
    edited.extend_from_slice(b"// saved in the editor\n");
    std::fs::write(f.root.join(FILE), &edited).expect("write");
    match engine.resolve_conflict_block(
        FILE,
        &text.fingerprint,
        0,
        &BlockResolution::Ours,
        &never(),
    ) {
        Err(GitError::ConflictFileChanged(path)) => assert_eq!(path, FILE),
        other => panic!("expected the file changed, got {other:?}"),
    }
    assert_eq!(bytes(&f), edited);
}

#[test]
fn a_file_over_four_mebibytes_has_no_blocks_to_read() {
    let mut f = Fixture::empty();
    let filler = "x".repeat(4 * 1024 * 1024);
    let base = format!("{filler}\nbase\n");
    let ours = format!("{filler}\nmain\n");
    let theirs = format!("{filler}\nfeature\n");
    merged(&mut f, base.as_bytes(), ours.as_bytes(), theirs.as_bytes());
    match engine(&f).conflict_blocks(FILE, &never()) {
        Err(GitError::ConflictUnreadable(path)) => assert_eq!(path, FILE),
        other => panic!("expected unreadable, got {other:?}"),
    }
}

#[test]
fn a_block_at_the_end_of_a_file_without_a_last_newline() {
    // Both sides end without a newline; git ends each side and marker with one in the
    // conflict, and the side taken ends as its own file does, as `git checkout --theirs`.
    let mut f = Fixture::empty();
    merged(&mut f, b"x\nbase", b"x\nmain", b"x\nfeature");
    let before = bytes(&f);
    assert!(before.ends_with(b">>>>>>> feature\n"));
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    assert_eq!(text.blocks.len(), 1);
    let resolved = engine
        .resolve_conflict_block(
            FILE,
            &text.fingerprint,
            0,
            &BlockResolution::Theirs,
            &never(),
        )
        .expect("theirs");
    assert_eq!(bytes(&f), b"x\nfeature");
    engine
        .undo_conflict_block(FILE, &resolved.undo, &never())
        .expect("undo");
    assert_eq!(bytes(&f), before);
}

#[test]
fn a_last_marker_edited_without_its_newline_round_trips() {
    // The block ends the file and its `>>>>>>>` line lost its newline by hand: the side taken
    // ends without one too, whatever its own file does.
    let mut f = Fixture::empty();
    merged(&mut f, b"x\nbase\n", b"x\nmain\n", b"x\nfeature\n");
    let mut edited = bytes(&f);
    assert!(edited.ends_with(b">>>>>>> feature\n"));
    edited.pop();
    std::fs::write(f.root.join(FILE), &edited).expect("write");
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    assert_eq!(text.blocks.len(), 1);
    let resolved = engine
        .resolve_conflict_block(FILE, &text.fingerprint, 0, &BlockResolution::Ours, &never())
        .expect("ours");
    assert_eq!(bytes(&f), b"x\nmain");
    engine
        .undo_conflict_block(FILE, &resolved.undo, &never())
        .expect("undo");
    assert_eq!(bytes(&f), edited);
}

#[test]
fn a_conflict_without_markers_is_not_read() {
    // Modified on main, deleted on feature: the file holds main's version, no marker.
    let mut f = Fixture::empty();
    std::fs::write(f.root.join(FILE), BASE).expect("write base");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "feature"]);
    f.git(&["rm", "-q", FILE]);
    f.commit("feature deletes");
    f.git(&["switch", "-q", "main"]);
    std::fs::write(f.root.join(FILE), OURS).expect("write ours");
    f.commit("main changes");
    let (stopped_clean, _, _) = f.try_git(&["merge", "feature"]);
    assert!(!stopped_clean);
    match engine(&f).conflict_blocks(FILE, &never()) {
        Err(GitError::ConflictUnreadable(path)) => assert_eq!(path, FILE),
        other => panic!("expected unreadable, got {other:?}"),
    }
    // A binary file both sides changed: git keeps ours' bytes and writes no marker.
    let mut f = Fixture::empty();
    merged(&mut f, b"a\0base\n", b"a\0main\n", b"a\0feature\n");
    match engine(&f).conflict_blocks(FILE, &never()) {
        Err(GitError::ConflictUnreadable(path)) => assert_eq!(path, FILE),
        other => panic!("expected unreadable, got {other:?}"),
    }
}

#[test]
fn undo_holds_to_the_file_its_write_left() {
    let f = two_blocks();
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    let resolved = engine
        .resolve_conflict_block(FILE, &text.fingerprint, 0, &BlockResolution::Ours, &never())
        .expect("ours");
    let mut later = bytes(&f);
    later.extend_from_slice(b"// saved in the editor\n");
    std::fs::write(f.root.join(FILE), &later).expect("write");
    match engine.undo_conflict_block(FILE, &resolved.undo, &never()) {
        Err(GitError::ConflictFileChanged(path)) => assert_eq!(path, FILE),
        other => panic!("expected the file changed, got {other:?}"),
    }
    assert_eq!(bytes(&f), later);
    // A token whose lines run past the file is refused the same way.
    let mut token = resolved.undo.clone();
    let current = engine.conflict_blocks(FILE, &never()).expect("blocks");
    token.fingerprint = current.fingerprint;
    token.start = 1_000;
    assert!(matches!(
        engine.undo_conflict_block(FILE, &token, &never()),
        Err(GitError::ConflictFileChanged(_))
    ));
}

#[test]
fn a_crlf_file_comes_back_byte_for_byte() {
    let mut f = Fixture::empty();
    f.write(".gitattributes", "*.ts text eol=crlf\n");
    merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), THEIRS.as_bytes());
    let before = bytes(&f);
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    let resolved = engine
        .resolve_conflict_block(FILE, &text.fingerprint, 1, &BlockResolution::Both, &never())
        .expect("both");
    engine
        .undo_conflict_block(FILE, &resolved.undo, &never())
        .expect("undo");
    assert_eq!(bytes(&f), before);
}

#[test]
fn a_nested_path_with_spaces_and_unicode() {
    let mut f = Fixture::with_odd_path();
    let folder = "src/teselas ñ";
    let path = format!("{folder}/caché de tiles.ts");
    std::fs::create_dir_all(f.root.join(folder)).expect("folder");
    std::fs::write(f.root.join(&path), BASE).expect("write base");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "feature"]);
    std::fs::write(f.root.join(&path), THEIRS).expect("write theirs");
    f.commit("feature");
    f.git(&["switch", "-q", "main"]);
    std::fs::write(f.root.join(&path), OURS).expect("write ours");
    f.commit("main");
    let (merged, _, _) = f.try_git(&["merge", "feature"]);
    assert!(!merged);
    let engine = engine(&f);
    let text = engine.conflict_blocks(&path, &never()).expect("blocks");
    assert_eq!(text.blocks.len(), 2);
    engine
        .resolve_conflict_block(
            &path,
            &text.fingerprint,
            0,
            &BlockResolution::Theirs,
            &never(),
        )
        .expect("theirs");
    let after = std::fs::read_to_string(f.root.join(&path)).expect("read");
    assert!(after.contains("const a2 = \"feature\";"), "{after}");
}

#[test]
fn zdiff3_blocks_pair_with_their_base() {
    let mut f = Fixture::empty();
    f.git(&["config", "merge.conflictStyle", "zdiff3"]);
    merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), THEIRS.as_bytes());
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
    assert!(text.paired);
    assert_eq!(text.blocks.len(), 2);
    assert!(text.blocks.iter().all(|block| block.base.is_some()));
}

/// `tiles.ts` as BASE on `main`, THEIRS on `feature` with `feature_attributes` beside it, OURS
/// on `main`, and `git merge <args> feature`, which stops on the file.
fn merged_with(f: &mut Fixture, feature_attributes: Option<&str>, args: &[&str]) {
    std::fs::write(f.root.join(FILE), BASE).expect("write base");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "feature"]);
    if let Some(attributes) = feature_attributes {
        f.write(".gitattributes", attributes);
    }
    std::fs::write(f.root.join(FILE), THEIRS).expect("write theirs");
    f.commit("feature");
    f.git(&["switch", "-q", "main"]);
    std::fs::write(f.root.join(FILE), OURS).expect("write ours");
    f.commit("main");
    let mut merge = vec!["merge"];
    merge.extend_from_slice(args);
    merge.push("feature");
    let (merged, _, _) = f.try_git(&merge);
    assert!(!merged, "the merge did not stop on a conflict");
}

#[test]
fn markers_written_with_the_size_before_the_merge_still_read() {
    // The attribute arrives with the merge, which wrote its markers at the size before it.
    let mut f = Fixture::empty();
    merged_with(&mut f, Some("tiles.ts conflict-marker-size=9\n"), &[]);
    let written = String::from_utf8(bytes(&f)).expect("utf-8");
    assert!(written.contains("\n<<<<<<< HEAD\n"), "{written}");
    let repo = engine(&f);
    let text = repo.conflict_blocks(FILE, &never()).expect("blocks");
    assert!(text.paired);
    assert_eq!(text.blocks.len(), 2);
    // Both blocks written, then the last one put back: it reads again at the file's size.
    let first = repo
        .resolve_conflict_block(FILE, &text.fingerprint, 0, &BlockResolution::Ours, &never())
        .expect("ours");
    let last = repo
        .resolve_conflict_block(
            FILE,
            &first.file.fingerprint,
            0,
            &BlockResolution::Theirs,
            &never(),
        )
        .expect("theirs");
    assert!(last.file.blocks.is_empty());
    let back = repo
        .undo_conflict_block(FILE, &last.undo, &never())
        .expect("undo");
    assert_eq!(back.blocks.len(), 1);
    // A `resolve` merge reads no attribute: markers of 7 under an attribute of 9.
    let mut f = Fixture::empty();
    f.write(".gitattributes", "tiles.ts conflict-marker-size=9\n");
    merged_with(&mut f, None, &["-s", "resolve"]);
    let written = String::from_utf8(bytes(&f)).expect("utf-8");
    assert!(!written.contains("<<<<<<<<<"), "{written}");
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
    assert!(text.paired);
    assert_eq!(text.blocks.len(), 2);
}

#[test]
fn marker_sizes_git_takes_and_refuses_read_alike() {
    for value in ["12", "+9", "10abc", "9.5"] {
        let mut f = Fixture::empty();
        f.write(
            ".gitattributes",
            &format!("tiles.ts conflict-marker-size={value}\n"),
        );
        merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), THEIRS.as_bytes());
        let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
        assert!(text.paired, "{value}");
        assert_eq!(text.blocks.len(), 2, "{value}");
    }
}

#[test]
fn a_closing_marker_inside_the_incoming_side_is_not_a_block_end() {
    // The incoming side holds a `>>>>>>>` line of its own: the block git wrote ends one line
    // later than the marker rules end it, so the file reads unpaired rather than misread.
    let mut f = Fixture::empty();
    let theirs = THEIRS.replace("const a2 = \"feature\";\n", ">>>>>>> quoted\n");
    merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), theirs.as_bytes());
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("read");
    assert!(!text.paired);
    assert!(text.blocks.is_empty());
}

#[test]
fn a_block_nested_in_a_side_reads_unpaired() {
    let mut f = Fixture::empty();
    let theirs = THEIRS.replace("const a2 = \"feature\";\n", "<<<<<<< nested\n");
    merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), theirs.as_bytes());
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("read");
    assert!(!text.paired);
    assert!(text.blocks.is_empty());
}

#[test]
fn a_text_file_git_does_not_merge_by_lines_is_not_read() {
    for (attributes, config) in [
        ("tiles.ts binary\n", None),
        ("tiles.ts -merge\n", None),
        ("tiles.ts merge=binary\n", None),
        (
            "tiles.ts merge=mine\n",
            Some(("merge.mine.driver", "false")),
        ),
        ("", Some(("merge.default", "binary"))),
    ] {
        let mut f = Fixture::empty();
        if !attributes.is_empty() {
            f.write(".gitattributes", attributes);
        }
        if let Some((key, value)) = config {
            f.git(&["config", key, value]);
        }
        merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), THEIRS.as_bytes());
        match engine(&f).conflict_blocks(FILE, &never()) {
            Err(GitError::ConflictUnreadable(path)) => assert_eq!(path, FILE),
            other => panic!("{attributes:?} {config:?}: expected unreadable, got {other:?}"),
        }
    }
    // A driver the configuration does not hold: git merges the file as text.
    let mut f = Fixture::empty();
    f.write(".gitattributes", "tiles.ts merge=nowhere\n");
    merged(&mut f, BASE.as_bytes(), OURS.as_bytes(), THEIRS.as_bytes());
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
    assert_eq!(text.blocks.len(), 2);
}

/// A page that shows git's markers as an example, kept by both sides, and one line both
/// changed.
const EXAMPLE: &str = "= Merging\nAn example:\n<<<<<<< yours:sample.txt\nConflict resolution is hard;\nlet's go shopping.\n=======\nGit makes conflict resolution easy.\n>>>>>>> theirs:sample.txt\n";

#[test]
fn a_documentation_example_is_not_read_as_a_block() {
    let mut f = Fixture::empty();
    f.write(".gitattributes", "tiles.ts conflict-marker-size=32\n");
    let side = |line: &str| format!("{EXAMPLE}Line to change: {line}\n");
    merged(
        &mut f,
        side("base").as_bytes(),
        side("main").as_bytes(),
        side("feature").as_bytes(),
    );
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    assert_eq!(text.blocks.len(), 1);
    assert_eq!(text.blocks[0].ours.label, "HEAD");
    // The last block written: the example stays text.
    let resolved = engine
        .resolve_conflict_block(FILE, &text.fingerprint, 0, &BlockResolution::Ours, &never())
        .expect("ours");
    assert_eq!(bytes(&f), side("main").into_bytes());
    assert!(resolved.file.paired && resolved.file.blocks.is_empty());
    // The same file left by `git checkout --ours`.
    engine
        .undo_conflict_block(FILE, &resolved.undo, &never())
        .expect("undo");
    f.git(&["checkout", "--ours", "--", FILE]);
    let text = engine.conflict_blocks(FILE, &never()).expect("read");
    assert!(text.blocks.is_empty());
}

#[test]
fn an_accepted_marker_size_reads_past_a_shorter_example() {
    for value in ["12", "+9"] {
        let mut f = Fixture::empty();
        f.write(
            ".gitattributes",
            &format!("tiles.ts conflict-marker-size={value}\n"),
        );
        let base = format!("{EXAMPLE}{BASE}");
        let ours = format!("{EXAMPLE}{OURS}");
        let theirs = format!("{EXAMPLE}{THEIRS}");
        merged(&mut f, base.as_bytes(), ours.as_bytes(), theirs.as_bytes());
        let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
        assert_eq!(text.blocks.len(), 2, "{value}");
        assert!(
            text.blocks.iter().all(|block| block.ours.label == "HEAD"),
            "{value}"
        );
    }
}

#[test]
fn a_base_marker_inside_the_current_side_reads_unpaired() {
    // git writes every block of a file in one style: one with a base among blocks without
    // reads as a side holding a `|||||||` line.
    let mut f = Fixture::empty();
    let ours = OURS.replace(
        "const a = \"main\";\n",
        "const a = \"main\";\n|||||||\nconst a1 = \"main\";\n",
    );
    merged(&mut f, BASE.as_bytes(), ours.as_bytes(), THEIRS.as_bytes());
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("read");
    assert!(!text.paired);
    assert!(text.blocks.is_empty());
}

#[test]
fn an_example_reads_as_text_when_the_merge_removes_the_attribute() {
    // The base sets the size to 12 and the merged branch removes it: git wrote 12-character
    // markers, and the example at 7 is the page's own text.
    let mut f = Fixture::empty();
    f.write(".gitattributes", "tiles.ts conflict-marker-size=12\n");
    let side = |line: &str| format!("{EXAMPLE}Status: {line}\n");
    std::fs::write(f.root.join(FILE), side("base")).expect("write base");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "feature"]);
    f.git(&["rm", "-q", ".gitattributes"]);
    std::fs::write(f.root.join(FILE), side("feature")).expect("write theirs");
    f.commit("feature");
    f.git(&["switch", "-q", "main"]);
    std::fs::write(f.root.join(FILE), side("main")).expect("write ours");
    f.commit("main");
    let (merged, _, _) = f.try_git(&["merge", "feature"]);
    assert!(!merged);
    let engine = engine(&f);
    let text = engine.conflict_blocks(FILE, &never()).expect("blocks");
    assert_eq!(text.blocks.len(), 1);
    let block = &text.blocks[0];
    assert_eq!(block.ours.label, "HEAD");
    assert!(text.lines[block.start as usize].starts_with("<<<<<<<<<<<< "));
    let resolved = engine
        .resolve_conflict_block(FILE, &text.fingerprint, 0, &BlockResolution::Ours, &never())
        .expect("ours");
    assert!(resolved.file.paired && resolved.file.blocks.is_empty());
}

#[test]
fn the_inner_block_of_a_virtual_base_is_not_this_merges() {
    for style in ["diff3", "zdiff3"] {
        let mut f = Fixture::empty();
        f.git(&["config", "merge.conflictStyle", style]);
        let write = |f: &Fixture, x: &str| {
            std::fs::write(f.root.join(FILE), format!("one\nx = {x}\nthree\n")).expect("write");
        };
        write(&f, "0");
        f.commit("base");
        f.git(&["switch", "-q", "-c", "feature"]);
        write(&f, "2");
        f.commit("right");
        f.git(&["switch", "-q", "main"]);
        write(&f, "1");
        f.commit("left");
        let (merged, _, _) = f.try_git(&["merge", "feature"]);
        assert!(!merged);
        write(&f, "12");
        f.commit("merge right into left");
        f.git(&["switch", "-q", "feature"]);
        let (merged, _, _) = f.try_git(&["merge", "main~1"]);
        assert!(!merged);
        write(&f, "21");
        f.commit("merge left into right");
        // The attribute arrives with the merge: git writes the outer block at 7 and the
        // virtual base's own at 9.
        f.write(".gitattributes", "tiles.ts conflict-marker-size=9\n");
        f.commit("attributes");
        f.git(&["switch", "-q", "main"]);
        let (merged, _, _) = f.try_git(&["merge", "feature"]);
        assert!(!merged, "{style}");
        let written = String::from_utf8(bytes(&f)).expect("utf-8");
        assert!(written.contains("<<<<<<<<< "), "{style}: {written}");
        let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
        assert_eq!(text.blocks.len(), 1, "{style}: {written}");
        let block = &text.blocks[0];
        assert_eq!(
            (block.ours.label.as_str(), block.theirs.label.as_str()),
            ("HEAD", "feature"),
            "{style}"
        );
        assert!(block.base.is_some(), "{style}");
    }
}

#[test]
fn a_closing_marker_line_of_a_side_outside_the_blocks_is_text() {
    // In every version, above the conflicts.
    let mut f = Fixture::empty();
    let quoted = |text: &str| format!(">>>>>>> quoted\n{text}");
    merged(
        &mut f,
        quoted(BASE).as_bytes(),
        quoted(OURS).as_bytes(),
        quoted(THEIRS).as_bytes(),
    );
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
    assert!(text.paired);
    assert_eq!(text.blocks.len(), 2);
    // Added by the merged branch alone, in a part only it changed.
    let mut f = Fixture::empty();
    let base = format!("{BASE}tail\n");
    let ours = format!("{OURS}tail\n");
    let theirs = format!("{THEIRS}tail\n>>>>>>> quoted\n");
    merged(&mut f, base.as_bytes(), ours.as_bytes(), theirs.as_bytes());
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
    assert!(text.paired);
    assert_eq!(text.blocks.len(), 2);
}

#[test]
fn binary_is_what_git_tells_from_the_three_versions() {
    // Each version's first NUL lies past byte 8000, and each side deletes a different stretch
    // above it: the merged file's NUL comes early, and git still merged its lines.
    let filler = |tag: &str| {
        (0..130)
            .map(|line| format!("{tag} filler line {line:03} with some words\n"))
            .collect::<String>()
    };
    let (a, b, c) = (filler("a"), filler("b"), filler("c"));
    // Lines both keep between the two stretches, so the deletions do not touch.
    let kept = "kept one\nkept two\nkept three\nkept four\n";
    let tail = "nul \0 here\n";
    let base = format!("{a}{kept}{b}{c}change: base\n{tail}");
    let ours = format!("{a}{kept}{c}change: main\n{tail}");
    let theirs = format!("{kept}{b}{c}change: feature\n{tail}");
    let early_nul = |bytes: &[u8]| bytes[..bytes.len().min(8000)].contains(&0);
    for version in [&base, &ours, &theirs] {
        assert!(!early_nul(version.as_bytes()));
    }
    let mut f = Fixture::empty();
    merged(&mut f, base.as_bytes(), ours.as_bytes(), theirs.as_bytes());
    assert!(early_nul(&bytes(&f)));
    let text = engine(&f).conflict_blocks(FILE, &never()).expect("blocks");
    assert_eq!(text.blocks.len(), 1);
    // A NUL near the start of the base alone: git merged it as binary and kept the current
    // side, without markers.
    let mut f = Fixture::empty();
    merged(
        &mut f,
        b"a\0base\nline\n",
        b"a base\nline main\n",
        b"a base\nline feature\n",
    );
    match engine(&f).conflict_blocks(FILE, &never()) {
        Err(GitError::ConflictUnreadable(path)) => assert_eq!(path, FILE),
        other => panic!("expected unreadable, got {other:?}"),
    }
}

#[test]
fn a_file_git_writes_in_another_encoding_is_not_read() {
    // `working-tree-encoding` writes git's markers in UTF-16: no marker pairs in its bytes.
    let utf16 = |text: &str| -> Vec<u8> {
        text.encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect()
    };
    let mut f = Fixture::empty();
    f.write(
        ".gitattributes",
        "tiles.ts working-tree-encoding=UTF-16LE\n",
    );
    merged(&mut f, &utf16(BASE), &utf16(OURS), &utf16(THEIRS));
    match engine(&f).conflict_blocks(FILE, &never()) {
        Err(GitError::ConflictUnreadable(path)) => assert_eq!(path, FILE),
        other => panic!("expected unreadable, got {other:?}"),
    }
}
