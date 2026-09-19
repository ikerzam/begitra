//! Times one commit diff with and without intra-line spans, to see where the diff engine spends
//! its time: `cargo run -p bench --release --example diff_profile -- <repo> <commit> [rounds]`.

use std::path::PathBuf;
use std::time::Instant;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{DiffOptions, DiffTarget};

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(repo), Some(hash)) = (args.next(), args.next()) else {
        eprintln!("usage: diff_profile <repo> <commit> [rounds]");
        std::process::exit(2);
    };
    let rounds: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(5);
    let engine = Git2Engine::open(&PathBuf::from(&repo)).expect("open");
    raw_tree_diff(&repo, &hash, rounds);
    let target = DiffTarget::Commit { hash };
    for intra_line in [true, false] {
        let options = DiffOptions {
            intra_line,
            ..DiffOptions::default()
        };
        let mut best = f64::MAX;
        let mut files = 0;
        let mut lines = 0;
        for _ in 0..rounds {
            let start = Instant::now();
            let set = engine
                .diff(&target, &options, &Cancel::never())
                .expect("diff");
            best = best.min(start.elapsed().as_secs_f64() * 1e3);
            files = set.files.len();
            lines = set
                .files
                .iter()
                .flat_map(|f| f.hunks.iter())
                .map(|h| h.lines.len())
                .sum();
        }
        println!("intra_line={intra_line}: best {best:.1} ms over {rounds} rounds, {files} files, {lines} lines");
    }
}

/// Times libgit2's own tree-to-tree diff of `hash` against its first parent, without any of
/// the engine's work, plus the same diff restricted to the changed paths.
fn raw_tree_diff(repo: &str, hash: &str, rounds: usize) {
    let repo = git2::Repository::open(repo).expect("open");
    let commit = repo
        .revparse_single(hash)
        .and_then(|o| o.peel_to_commit())
        .expect("commit");
    let parent = commit.parent(0).expect("parent");
    let old = parent.tree().expect("old tree");
    let new = commit.tree().expect("new tree");
    let mut best = f64::MAX;
    let mut deltas = 0;
    for _ in 0..rounds {
        let start = Instant::now();
        let diff = repo
            .diff_tree_to_tree(Some(&old), Some(&new), None)
            .expect("diff");
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
        deltas = diff.deltas().len();
    }
    println!("libgit2 diff_tree_to_tree: best {best:.1} ms, {deltas} deltas");
    let mut best = f64::MAX;
    for _ in 0..rounds {
        let start = Instant::now();
        let mut options = git2::DiffOptions::new();
        options.pathspec("src/nothing-here");
        let _ = repo
            .diff_tree_to_tree(Some(&old), Some(&new), Some(&mut options))
            .expect("diff");
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
    }
    println!("libgit2 diff_tree_to_tree with a pathspec: best {best:.1} ms");
    let mut best = f64::MAX;
    for _ in 0..rounds {
        let start = Instant::now();
        let count = changed_paths(&repo, &old, &new);
        best = best.min(start.elapsed().as_secs_f64() * 1e3);
        if count > 0 {
            deltas = count;
        }
    }
    println!("own recursive tree walk skipping equal subtrees: best {best:.1} ms, {deltas} changed entries");
}

/// Counts differing blob entries between two trees, descending only into subtrees whose ids
/// differ.
fn changed_paths(repo: &git2::Repository, old: &git2::Tree<'_>, new: &git2::Tree<'_>) -> usize {
    use std::collections::BTreeMap;
    let mut count = 0;
    let mut old_entries: BTreeMap<Vec<u8>, (git2::Oid, Option<git2::ObjectType>)> = BTreeMap::new();
    for entry in old.iter() {
        old_entries.insert(entry.name_bytes().to_vec(), (entry.id(), entry.kind()));
    }
    for entry in new.iter() {
        let name = entry.name_bytes().to_vec();
        match old_entries.remove(&name) {
            Some((id, _)) if id == entry.id() => {}
            Some((id, Some(git2::ObjectType::Tree)))
                if entry.kind() == Some(git2::ObjectType::Tree) =>
            {
                let old_sub = repo.find_tree(id).expect("old subtree");
                let new_sub = repo.find_tree(entry.id()).expect("new subtree");
                count += changed_paths(repo, &old_sub, &new_sub);
            }
            _ => count += 1,
        }
    }
    count + old_entries.len()
}
