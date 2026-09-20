//! Times the three-dot diff of a range piece by piece, to see where a comparison's file
//! summary spends its time: libgit2's tree diff, rename detection with and without copies,
//! the raw patches, and the engine's whole change set against its first page of 200 files.
//! `cargo run -p bench --release --example range_profile -- <repo> <a> <b> [rounds]`.

use std::path::PathBuf;
use std::time::Instant;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{DiffOptions, DiffTarget};

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(repo), Some(a), Some(b)) = (args.next(), args.next(), args.next()) else {
        eprintln!("usage: range_profile <repo> <a> <b> [rounds]");
        std::process::exit(2);
    };
    let rounds: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(3);
    raw_tree_diff(&repo, &a, &b, rounds);
    let engine = Git2Engine::open(&PathBuf::from(&repo)).expect("open");
    let target = DiffTarget::Range {
        from: a,
        to: b,
        three_dot: true,
    };
    let mut best = f64::MAX;
    let mut files = 0;
    for _ in 0..rounds {
        let start = Instant::now();
        let set = engine
            .diff(&target, &DiffOptions::default(), &Cancel::never())
            .expect("diff");
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
        files = set.files.len();
    }
    println!("engine, whole change set: best {best:.1} ms, {files} files");
    let mut best = f64::MAX;
    let mut best_start = f64::MAX;
    let mut first = 0;
    for _ in 0..rounds {
        let start = Instant::now();
        let mut walk = engine
            .diff_pages(&target, &DiffOptions::default(), 200, &Cancel::never())
            .expect("diff");
        best_start = best_start.min(start.elapsed().as_secs_f64() * 1e3);
        let page = walk.next_page(&Cancel::never()).expect("page");
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
        first = page.files.len();
    }
    println!(
        "engine, first page: best {best:.1} ms ({best_start:.1} ms to prepare), {first} files"
    );
}

fn raw_tree_diff(repo: &str, a: &str, b: &str, rounds: usize) {
    let repo = git2::Repository::open(repo).expect("open");
    let one = repo
        .revparse_single(a)
        .and_then(|o| o.peel_to_commit())
        .expect("a");
    let two = repo
        .revparse_single(b)
        .and_then(|o| o.peel_to_commit())
        .expect("b");
    let base = repo.merge_base(one.id(), two.id()).expect("base");
    let base = repo.find_commit(base).expect("base commit");
    let old = base.tree().expect("old tree");
    let new = two.tree().expect("new tree");
    let mut best = f64::MAX;
    let mut deltas = 0;
    for _ in 0..rounds {
        let start = Instant::now();
        let diff = repo
            .diff_tree_to_tree(Some(&old), Some(&new), None)
            .expect("diff");
        deltas = diff.deltas().len();
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
    }
    println!("raw tree diff: best {best:.1} ms, {deltas} deltas");
    for (label, copies) in [("renames and copies", true), ("renames only", false)] {
        let mut best = f64::MAX;
        for _ in 0..rounds {
            let start = Instant::now();
            let mut diff = repo
                .diff_tree_to_tree(Some(&old), Some(&new), None)
                .expect("diff");
            let mut find = git2::DiffFindOptions::new();
            find.renames(true)
                .copies(copies)
                .dont_ignore_whitespace(true);
            diff.find_similar(Some(&mut find)).expect("find similar");
            best = best.min(start.elapsed().as_secs_f64() * 1e3);
        }
        println!("tree diff + find_similar ({label}): best {best:.1} ms");
    }
    let diff = repo
        .diff_tree_to_tree(Some(&old), Some(&new), None)
        .expect("diff");
    let count = diff.deltas().len();
    let start = Instant::now();
    let mut changed = 0usize;
    for index in 0..count {
        if let Some(patch) = git2::Patch::from_diff(&diff, index).expect("patch") {
            let (_, add, del) = patch.line_stats().expect("stats");
            changed += add + del;
        }
    }
    println!(
        "raw patches with line_stats: {:.1} ms, {changed} changed lines",
        start.elapsed().as_secs_f64() * 1e3
    );
}
