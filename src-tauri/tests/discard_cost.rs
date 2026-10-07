//! What the copy a discard keeps for its Undo costs (ADR-0020): `Discards::keep` before git,
//! `seal` right after it and `undo`, beside git's own discard of the same files, on a temporary
//! repository of 10,000 edited files of 4 KiB five levels deep (the most paths a discard takes)
//! and on one edited file of 256 MiB (the most a copy holds). Run by hand:
//! `cargo test -p begitra --release --test discard_cost -- --ignored --nocapture`.

use std::path::Path;
use std::time::Instant;

use begitra_lib::discards::Discards;
use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;

fn git(root: &Path, args: &[&str]) {
    let output = git_core::cli::command(root, args)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// A repository at `root` with `files` committed, the file at `index` holding `text(index)`.
fn committed(root: &Path, files: &[String], text: &dyn Fn(usize) -> Vec<u8>) {
    std::fs::create_dir_all(root).expect("working tree");
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["config", "user.email", "t@x"]);
    git(root, &["config", "user.name", "t"]);
    git(root, &["config", "core.autocrlf", "false"]);
    for (index, path) in files.iter().enumerate() {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().expect("a parent")).expect("folders");
        std::fs::write(full, text(index)).expect("file");
    }
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "files"]);
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

/// Discards every one of `files`, edited, keeping a copy under `data`, then undoes it, and
/// prints a row of what each step took.
fn measure(name: &str, repository: &Path, data: &Path, files: &[String]) {
    let store = Discards::default();
    store.open(data).expect("copies' folder");
    let engine = Git2Engine::open(repository).expect("open");
    let root = engine.repo().root.clone();

    let start = Instant::now();
    let pending = store
        .keep(&root, files.iter().map(String::as_str))
        .expect("kept");
    let keep = ms(start);
    let start = Instant::now();
    engine
        .discard_paths(files, &[], &Cancel::never())
        .expect("discarded");
    let discard = ms(start);
    let start = Instant::now();
    let copy = store.seal(pending);
    let seal = ms(start);
    let start = Instant::now();
    let outcome = store.undo(&copy, &root).expect("undone");
    let undo = ms(start);
    assert_eq!(outcome.restored.len(), files.len());
    println!(
        "| discard_copy_{name} | keep {keep:.0} ms | git {discard:.0} ms | seal {seal:.0} ms | undo {undo:.0} ms |"
    );
}

#[test]
#[ignore = "a measurement, run by hand"]
fn discard_copy_costs() {
    let dir = tempfile::tempdir().expect("temporary folder");

    let many: Vec<String> = (0..10_000)
        .map(|i| {
            format!(
                "d{}/d{}/d{}/d{}/f{i}.txt",
                i % 10,
                (i / 10) % 10,
                (i / 100) % 10,
                (i / 1000) % 10
            )
        })
        .collect();
    let letter = |i: usize, base: u8| base + u8::try_from(i % 26).unwrap_or(0);
    let root = dir.path().join("many");
    committed(&root, &many, &|i| vec![letter(i, b'a'); 4096]);
    for (i, path) in many.iter().enumerate() {
        std::fs::write(root.join(path), vec![letter(i, b'A'); 4096]).expect("edit");
    }
    measure("10k_files", &root, &dir.path().join("copies-many"), &many);

    let big = vec!["big.bin".to_owned()];
    let root = dir.path().join("big");
    committed(&root, &big, &|_| vec![b'a'; 256 * 1024 * 1024]);
    std::fs::write(root.join("big.bin"), vec![b'b'; 256 * 1024 * 1024]).expect("edit");
    measure("256mb_file", &root, &dir.path().join("copies-big"), &big);
}
