//! `Git2Engine::read_blob` against `git show` and the working tree.

mod support;

use std::fs;

use git_core::engine::GitEngine;
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::BlobAt;
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn at(rev: &str) -> BlobAt {
    BlobAt::Revision {
        rev: rev.to_owned(),
    }
}

#[test]
fn text_and_binary_blobs_match_git_show() {
    let mut f = Fixture::basic();
    let png: Vec<u8> = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3].to_vec();
    fs::write(f.root.join("docs/icon.png"), &png).expect("write binary");
    f.commit("add icon");
    let engine = engine(&f);

    // The git helper trims the output; the blob keeps its final newline.
    let text = engine.read_blob(&at("HEAD"), "src/lib.rs").expect("text");
    assert!(!text.is_binary && text.bytes.is_none());
    let shown = f.git(&["show", "HEAD:src/lib.rs"])
        + "
";
    assert_eq!(text.text.as_deref(), Some(shown.as_str()));
    assert_eq!(text.size, shown.len() as u64);

    let image = engine
        .read_blob(&at("HEAD"), "docs/icon.png")
        .expect("binary");
    assert!(image.is_binary && image.text.is_none());
    assert_eq!(image.size, png.len() as u64);
    assert_eq!(image.bytes.as_deref(), Some("iVBORw0KGgoAAQID"));

    // At an older revision the file is another version, or absent.
    let older = engine
        .read_blob(&at("v1"), "src/lib.rs")
        .expect("older text");
    let shown = f.git(&["show", "v1:src/lib.rs"])
        + "
";
    assert_eq!(older.text.as_deref(), Some(shown.as_str()));
    let missing = engine
        .read_blob(&at("v1"), "docs/icon.png")
        .expect_err("absent at v1");
    assert_eq!(missing.code(), "refs.not_found");
    let directory = engine.read_blob(&at("HEAD"), "src").expect_err("a tree");
    assert_eq!(directory.code(), "refs.not_found");
    let unknown = engine
        .read_blob(&at("no-such-rev"), "src/lib.rs")
        .expect_err("rev");
    assert_eq!(unknown.code(), "refs.not_found");
}

#[test]
fn working_tree_reads_stay_inside_the_repository() {
    let f = Fixture::basic();
    f.write("notes.txt", "unstaged\n");
    let engine = engine(&f);
    let file = engine
        .read_blob(&BlobAt::WorkingTree, "notes.txt")
        .expect("read");
    assert_eq!(file.text.as_deref(), Some("unstaged\n"));
    for path in [
        "../outside.txt",
        "/etc/hosts",
        "src",
        "missing.txt",
        ".git/config",
        ".git/HEAD",
        "",
    ] {
        let error = engine
            .read_blob(&BlobAt::WorkingTree, path)
            .expect_err(path);
        assert_eq!(error.code(), "refs.not_found", "{path}");
    }
    // A symlink that leaves the working tree is refused (where the platform allows links).
    let outside = f.sibling("outside.txt");
    fs::write(&outside, "secret\n").expect("outside file");
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&outside, f.root.join("leak.txt")).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&outside, f.root.join("leak.txt")).is_ok();
    if linked {
        let error = engine
            .read_blob(&BlobAt::WorkingTree, "leak.txt")
            .expect_err("symlink out of the tree");
        assert_eq!(error.code(), "refs.not_found");
    }
}

#[test]
fn files_over_the_limit_are_refused_with_the_size() {
    let f = Fixture::basic();
    let big = vec![b'x'; 21 * 1024 * 1024];
    fs::write(f.root.join("big.bin"), &big).expect("write big file");
    let engine = engine(&f);
    match engine.read_blob(&BlobAt::WorkingTree, "big.bin") {
        Err(GitError::BlobTooLarge { size, limit }) => {
            assert_eq!(size, big.len() as u64);
            assert_eq!(limit, 20 * 1024 * 1024);
        }
        other => panic!("expected blob.too_large, got {other:?}"),
    }
}

#[test]
fn files_over_the_limit_at_a_revision_are_refused_without_being_read() {
    let mut f = Fixture::basic();
    let big = vec![b'x'; 21 * 1024 * 1024];
    fs::write(f.root.join("big.bin"), &big).expect("write big file");
    f.commit("add a big file");
    let engine = engine(&f);
    match engine.read_blob(&at("HEAD"), "big.bin") {
        Err(GitError::BlobTooLarge { size, limit }) => {
            assert_eq!(size, big.len() as u64);
            assert_eq!(limit, 20 * 1024 * 1024);
        }
        other => panic!("expected blob.too_large, got {other:?}"),
    }
}

#[test]
fn binary_detection_agrees_on_both_sides_and_text_decodes_lossily() {
    let mut f = Fixture::basic();
    // Control characters without a NUL are text for git; a NUL makes a file binary.
    fs::write(f.root.join("ctrl.txt"), vec![1u8; 40]).expect("ctrl");
    fs::write(f.root.join("zero.bin"), b"ab\0cd").expect("nul");
    // Latin-1 bytes are not UTF-8: the text keeps a replacement character.
    fs::write(f.root.join("latin1.txt"), b"caf\xe9\n").expect("latin1");
    f.commit("odd files");
    let engine = engine(&f);
    for (path, binary) in [
        ("ctrl.txt", false),
        ("zero.bin", true),
        ("latin1.txt", false),
    ] {
        let committed = engine.read_blob(&at("HEAD"), path).expect(path);
        let on_disk = engine.read_blob(&BlobAt::WorkingTree, path).expect(path);
        assert_eq!(committed.is_binary, binary, "{path} at HEAD");
        assert_eq!(on_disk.is_binary, binary, "{path} on disk");
        assert_eq!(committed.text, on_disk.text, "{path}");
        assert_eq!(committed.bytes, on_disk.bytes, "{path}");
    }
    let latin = engine
        .read_blob(&BlobAt::WorkingTree, "latin1.txt")
        .expect("latin1");
    assert_eq!(latin.text.as_deref(), Some("caf\u{FFFD}\n"));
    assert_eq!(latin.size, 5);
}
