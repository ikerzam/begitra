//! `Git2Engine::ignore_path` against `git check-ignore` and the files on disk: the line each
//! rule writes, where it goes, what git then ignores, and what is refused.

mod support;

use std::fs;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{IgnoreOutcome, IgnorePlace, IgnoreRule, KeptBy};
use support::Fixture;

fn engine_at(path: &std::path::Path) -> Git2Engine {
    Git2Engine::open(path).expect("open fixture")
}

/// A repository with one commit, `README.md`, and nothing ignored.
fn fixture() -> Fixture {
    let mut f = Fixture::empty();
    f.write("README.md", "# fixture\n");
    f.git(&["add", "README.md"]);
    f.commit("initial");
    f
}

fn ignore(f: &Fixture, path: &str, rule: IgnoreRule, place: IgnorePlace) -> IgnoreOutcome {
    engine_at(&f.root)
        .ignore_path(path, rule, place, &Cancel::never())
        .unwrap_or_else(|error| panic!("{path}: {error}"))
}

/// Whether git ignores `path` in `cwd` (`git check-ignore -q`).
fn ignored_in(f: &Fixture, cwd: &std::path::Path, path: &str) -> bool {
    f.try_git_in(cwd, &["check-ignore", "-q", "--", path]).0
}

fn ignored(f: &Fixture, path: &str) -> bool {
    ignored_in(f, &f.root, path)
}

fn read(path: std::path::PathBuf) -> Vec<u8> {
    fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[test]
fn a_file_is_ignored_by_its_path_its_extension_or_its_folder() {
    let f = fixture();
    for path in [
        "logs/debug.log",
        "logs/trace.log",
        "src/app.log",
        "build/out/a.bin",
    ] {
        f.write(path, "x\n");
    }

    // The path alone, anchored at the root.
    let out = ignore(
        &f,
        "logs/debug.log",
        IgnoreRule::File,
        IgnorePlace::Gitignore,
    );
    assert_eq!(out.line, "/logs/debug.log");
    assert!(out.written && out.ignored, "{out:?}");
    assert_eq!(out.kept_by, None);
    assert_eq!(out.file, f.root.join(".gitignore"));
    assert!(ignored(&f, "logs/debug.log"));
    assert!(!ignored(&f, "logs/trace.log"));

    // Its extension, in every folder.
    let out = ignore(
        &f,
        "logs/trace.log",
        IgnoreRule::Extension,
        IgnorePlace::Gitignore,
    );
    assert_eq!(out.line, "*.log");
    assert!(ignored(&f, "src/app.log"));

    // Its folder and everything under it, in this clone only.
    let out = ignore(
        &f,
        "build/out/a.bin",
        IgnoreRule::Folder,
        IgnorePlace::Exclude,
    );
    assert_eq!(out.line, "/build/out/");
    assert_eq!(out.file, f.git_dir().join("info").join("exclude"));
    assert!(ignored(&f, "build/out/a.bin"));

    assert_eq!(read(f.root.join(".gitignore")), b"/logs/debug.log\n*.log\n");
    let exclude = String::from_utf8(read(out.file)).expect("utf-8");
    assert!(exclude.ends_with("\n/build/out/\n") || exclude == "/build/out/\n");
    assert!(!ignored(&f, "README.md"));
}

#[test]
fn names_that_read_as_patterns_match_only_themselves() {
    let f = fixture();
    for name in [
        "#notes.txt",
        "!bang.txt",
        "br[1].txt",
        "br1.txt",
        "two words.txt",
    ] {
        f.write(name, "x\n");
    }
    // Tracked, `br1.txt` is what `br[1].txt` matches as a glob: check-ignore must not skip the
    // untracked file for it.
    f.git(&["add", "br1.txt"]);
    for name in ["#notes.txt", "!bang.txt", "br[1].txt", "two words.txt"] {
        let out = ignore(&f, name, IgnoreRule::File, IgnorePlace::Exclude);
        assert!(out.ignored && out.kept_by.is_none(), "{name}: {out:?}");
    }
    // Its escaped line does not take `br1.txt` (tracked or not) along.
    assert!(
        !f.try_git(&["check-ignore", "-q", "--no-index", "--", "br1.txt"])
            .0
    );
    assert!(!ignored(&f, "README.md"));
}

#[test]
fn an_untracked_nested_repository_is_ignored_as_the_folder_git_lists() {
    let f = fixture();
    for folder in ["nested", "tools/clone"] {
        let path = f.root.join(folder);
        fs::create_dir_all(&path).expect("folder");
        f.git_in(&path, &["init", "-q"]);
    }
    let status = f.git(&["status", "--porcelain=v2", "--untracked-files=all"]);
    assert!(
        status.contains("? nested/") && status.contains("? tools/clone/"),
        "{status}"
    );

    let out = ignore(&f, "nested/", IgnoreRule::File, IgnorePlace::Gitignore);
    assert_eq!(out.line, "/nested/");
    assert!(out.ignored, "{out:?}");
    let out = ignore(
        &f,
        "tools/clone/",
        IgnoreRule::Folder,
        IgnorePlace::Gitignore,
    );
    assert_eq!(out.line, "/tools/");
    assert!(out.ignored, "{out:?}");
    let status = f.git(&["status", "--porcelain=v2", "--untracked-files=all"]);
    assert!(
        !status.contains("nested/") && !status.contains("tools/"),
        "{status}"
    );
}

#[cfg(unix)]
#[test]
fn glob_characters_backslashes_and_trailing_spaces_are_escaped() {
    let f = fixture();
    let names = ["star*.txt", "q?.txt", "back\\slash.txt", "trail ", "x.lo*"];
    for name in names {
        f.write(name, "x\n");
    }
    f.write("starry.txt", "x\n");
    f.write("qq.txt", "x\n");
    f.write("trail", "x\n");
    // Tracked, the files the names match as globs: check-ignore must not skip the others for them.
    f.git(&["add", "starry.txt", "qq.txt"]);
    for name in ["star*.txt", "q?.txt", "back\\slash.txt", "trail "] {
        let out = ignore(&f, name, IgnoreRule::File, IgnorePlace::Exclude);
        assert!(out.ignored && out.kept_by.is_none(), "{name}: {out:?}");
    }
    let out = ignore(&f, "x.lo*", IgnoreRule::Extension, IgnorePlace::Exclude);
    assert_eq!(out.line, "*.lo\\*");
    assert!(!ignored(&f, "trail"));
    for tracked in ["starry.txt", "qq.txt"] {
        let probe = ["check-ignore", "-q", "--no-index", "--", tracked];
        assert!(!f.try_git(&probe).0, "{tracked}");
    }
}

#[test]
fn the_line_follows_the_file_s_last_line_and_its_line_ending() {
    let f = fixture();
    f.write("a.log", "x\n");
    f.write("b.tmp", "x\n");
    // CRLF, and no newline after the last line.
    fs::write(f.root.join(".gitignore"), b"node_modules/\r\ntarget/").expect("write");
    ignore(&f, "a.log", IgnoreRule::Extension, IgnorePlace::Gitignore);
    assert_eq!(
        read(f.root.join(".gitignore")),
        b"node_modules/\r\ntarget/\r\n*.log\r\n"
    );
    ignore(&f, "b.tmp", IgnoreRule::Extension, IgnorePlace::Gitignore);
    assert_eq!(
        read(f.root.join(".gitignore")),
        b"node_modules/\r\ntarget/\r\n*.log\r\n*.tmp\r\n"
    );
    assert!(ignored(&f, "a.log") && ignored(&f, "b.tmp"));
}

#[test]
fn a_line_git_reads_as_the_same_is_not_written_again() {
    let f = fixture();
    f.write("a.log", "x\n");
    // A byte order mark first, and trailing spaces git drops.
    fs::write(f.root.join(".gitignore"), b"\xEF\xBB\xBF*.log  \n").expect("write");
    let out = ignore(&f, "a.log", IgnoreRule::Extension, IgnorePlace::Gitignore);
    assert!(!out.written && out.ignored, "{out:?}");
    assert_eq!(read(f.root.join(".gitignore")), b"\xEF\xBB\xBF*.log  \n");
}

#[test]
fn a_line_already_there_writes_nothing() {
    let f = fixture();
    f.write("a.log", "x\n");
    fs::write(f.root.join(".gitignore"), b"# logs\r\n*.log\r\n").expect("write");
    let out = ignore(&f, "a.log", IgnoreRule::Extension, IgnorePlace::Gitignore);
    assert!(!out.written && out.ignored, "{out:?}");
    assert_eq!(read(f.root.join(".gitignore")), b"# logs\r\n*.log\r\n");
}

#[test]
fn a_missing_exclude_file_and_its_folder_are_created() {
    let f = fixture();
    f.write(".env.local", "SECRET=1\n");
    let info = f.git_dir().join("info");
    if info.exists() {
        fs::remove_dir_all(&info).expect("remove info");
    }
    let out = ignore(&f, ".env.local", IgnoreRule::File, IgnorePlace::Exclude);
    assert_eq!(out.line, "/.env.local");
    assert_eq!(read(info.join("exclude")), b"/.env.local\n");
    assert!(out.ignored);
    assert!(!f.root.join(".gitignore").exists());
}

#[test]
fn a_rule_kept_by_a_nested_negation_is_reported() {
    let f = fixture();
    f.write("sub/keep.log", "x\n");
    f.write("sub/.gitignore", "!keep.log\n");
    let out = ignore(
        &f,
        "sub/keep.log",
        IgnoreRule::Extension,
        IgnorePlace::Gitignore,
    );
    assert!(out.written && !out.ignored, "{out:?}");
    assert_eq!(
        out.kept_by,
        Some(KeptBy {
            source: "sub/.gitignore".to_owned(),
            line: 1,
            pattern: "!keep.log".to_owned(),
        })
    );
    assert_eq!(read(f.root.join(".gitignore")), b"*.log\n");
}

#[test]
fn a_linked_worktree_writes_its_own_gitignore_and_the_shared_exclude() {
    let f = fixture().with_linked_worktree();
    let wt = f.worktree_path();
    fs::write(wt.join("w.log"), "x\n").expect("write");
    fs::write(wt.join("x.tmp"), "x\n").expect("write");
    let engine = engine_at(&wt);

    let out = engine
        .ignore_path(
            "w.log",
            IgnoreRule::File,
            IgnorePlace::Gitignore,
            &Cancel::never(),
        )
        .expect("gitignore");
    assert_eq!(read(wt.join(".gitignore")), b"/w.log\n");
    assert!(!f.root.join(".gitignore").exists());
    assert!(out.ignored);

    let out = engine
        .ignore_path(
            "x.tmp",
            IgnoreRule::File,
            IgnorePlace::Exclude,
            &Cancel::never(),
        )
        .expect("exclude");
    assert_eq!(out.file, f.git_dir().join("info").join("exclude"));
    assert!(ignored_in(&f, &wt, "x.tmp"));
}

#[test]
fn refused_paths_write_nothing() {
    let f = fixture();
    f.write(".env", "x\n");
    f.write("Makefile", "all:\n");
    let engine = engine_at(&f.root);
    let cases: [(&str, IgnoreRule); 8] = [
        // Tracked: a rule would not untrack it.
        ("README.md", IgnoreRule::File),
        // Not in the working tree.
        ("missing.log", IgnoreRule::File),
        ("../outside.log", IgnoreRule::File),
        ("/etc/hosts", IgnoreRule::File),
        ("C:/Windows/win.ini", IgnoreRule::File),
        ("", IgnoreRule::File),
        // No extension, and no folder.
        (".env", IgnoreRule::Extension),
        ("Makefile", IgnoreRule::Folder),
    ];
    for (path, rule) in cases {
        let error = engine
            .ignore_path(path, rule, IgnorePlace::Gitignore, &Cancel::never())
            .expect_err(path);
        assert_eq!(error.code(), "ignore.invalid_path", "{path}: {error}");
    }
    assert!(!f.root.join(".gitignore").exists());
}

#[test]
fn a_path_the_index_holds_is_refused_an_intent_to_add_too() {
    let f = fixture();
    f.write("planned.rs", "fn main() {}\n");
    f.git(&["add", "-N", "planned.rs"]);
    let error = engine_at(&f.root)
        .ignore_path(
            "planned.rs",
            IgnoreRule::File,
            IgnorePlace::Gitignore,
            &Cancel::never(),
        )
        .expect_err("an intent to add");
    assert_eq!(error.code(), "ignore.invalid_path");
    assert!(!f.root.join(".gitignore").exists());
}

#[test]
fn an_ignore_file_that_is_not_a_regular_file_is_refused() {
    let f = fixture();
    f.write("a.log", "x\n");
    fs::create_dir_all(f.root.join(".gitignore")).expect("a folder");
    let error = engine_at(&f.root)
        .ignore_path(
            "a.log",
            IgnoreRule::Extension,
            IgnorePlace::Gitignore,
            &Cancel::never(),
        )
        .expect_err("a folder");
    assert_eq!(error.code(), "ignore.write_failed");
}

#[test]
fn a_gitignore_a_sparse_checkout_leaves_out_is_not_replaced() {
    let mut f = fixture();
    f.write(".gitignore", "*.tmp\n");
    f.git(&["add", ".gitignore"]);
    f.commit("ignore tmp");
    f.git(&["sparse-checkout", "set", "--no-cone", "/*", "!/.gitignore"]);
    assert!(
        !f.root.join(".gitignore").exists(),
        "the checkout left it out"
    );
    f.write("a.log", "x\n");
    let error = engine_at(&f.root)
        .ignore_path(
            "a.log",
            IgnoreRule::Extension,
            IgnorePlace::Gitignore,
            &Cancel::never(),
        )
        .expect_err("held by the index");
    assert_eq!(error.code(), "ignore.write_failed");
    assert!(!f.root.join(".gitignore").exists());
}

#[cfg(unix)]
#[test]
fn an_info_folder_that_is_a_link_is_never_written_through() {
    let f = fixture();
    f.write("a.log", "x\n");
    let outside = f.sibling("outside-info");
    fs::create_dir_all(&outside).expect("folder");
    let info = f.git_dir().join("info");
    if info.exists() {
        fs::remove_dir_all(&info).expect("remove info");
    }
    std::os::unix::fs::symlink(&outside, &info).expect("symlink");
    let error = engine_at(&f.root)
        .ignore_path(
            "a.log",
            IgnoreRule::Extension,
            IgnorePlace::Exclude,
            &Cancel::never(),
        )
        .expect_err("a link");
    assert_eq!(error.code(), "ignore.write_failed");
    assert!(!outside.join("exclude").exists());
}

#[cfg(unix)]
#[test]
fn an_ignore_file_that_is_a_link_is_never_written_through() {
    let f = fixture();
    f.write("a.log", "x\n");
    let outside = f.sibling("outside-ignore");
    fs::write(&outside, b"keep\n").expect("write");
    std::os::unix::fs::symlink(&outside, f.root.join(".gitignore")).expect("symlink");
    let error = engine_at(&f.root)
        .ignore_path(
            "a.log",
            IgnoreRule::Extension,
            IgnorePlace::Gitignore,
            &Cancel::never(),
        )
        .expect_err("a link");
    assert_eq!(error.code(), "ignore.write_failed");
    assert_eq!(read(outside), b"keep\n");
}

#[cfg(windows)]
#[test]
fn an_info_folder_that_is_a_junction_is_never_written_through() {
    let f = fixture();
    f.write("a.log", "x\n");
    let outside = f.sibling("outside-info");
    fs::create_dir_all(&outside).expect("folder");
    let info = f.git_dir().join("info");
    if info.exists() {
        fs::remove_dir_all(&info).expect("remove info");
    }
    let made = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&info)
        .arg(&outside)
        .output()
        .expect("mklink");
    assert!(made.status.success(), "{made:?}");
    let error = engine_at(&f.root)
        .ignore_path(
            "a.log",
            IgnoreRule::Extension,
            IgnorePlace::Exclude,
            &Cancel::never(),
        )
        .expect_err("a junction");
    assert_eq!(error.code(), "ignore.write_failed");
    assert!(!outside.join("exclude").exists());
}
