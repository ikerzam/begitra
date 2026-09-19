//! Criterion benches of the engine operations on the two benchmark repositories.
//!
//! Each group runs on every repository that exists under `bench/repos` (or
//! `BEGIRA_BENCH_REPOS`); a missing repository is skipped with the command that creates it.
//! Results are read by `cargo run -p bench -- report` and pasted into a results table.

use std::path::{Path, PathBuf};
use std::time::Duration;

use bench::repos;
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use git_core::cli::run_git;
use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{DiffOptions, DiffTarget, StatusOptions, WalkOptions, WalkOrder, WalkScope};

/// A benchmark repository that is present on disk.
struct Target {
    name: &'static str,
    path: PathBuf,
    /// Two revisions with shared history, for `merge_base`.
    merge_base_pair: (String, String),
    /// Two commits whose diff is dominated by one very large file.
    large_diff: Option<(String, String)>,
}

fn present() -> Vec<Target> {
    let mut targets = Vec::new();
    for (name, path, create) in [
        (
            "synthetic",
            repos::synthetic(),
            "cargo run -p bench --release -- generate",
        ),
        ("real", repos::real(), "cargo run -p bench -- fetch-real"),
    ] {
        if !repos::is_repository(&path) {
            eprintln!(
                "skipping {name}: {} is missing, run `{create}`",
                path.display()
            );
            continue;
        }
        let merge_base_pair = merge_base_pair(name, &path);
        let large_diff = large_diff(name, &path);
        targets.push(Target {
            name,
            path,
            merge_base_pair,
            large_diff,
        });
    }
    targets
}

fn merge_base_pair(name: &str, path: &Path) -> (String, String) {
    match name {
        "real" => ("v6.6".to_owned(), "master".to_owned()),
        _ => {
            let branch = run_git(
                path,
                &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
            )
            .ok()
            .and_then(|out| {
                out.stdout
                    .lines()
                    .find(|line| *line != "main")
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "main".to_owned());
            ("main".to_owned(), branch)
        }
    }
}

/// Finds the two most recent commits that touched a very large file.
fn large_diff(name: &str, path: &Path) -> Option<(String, String)> {
    let file = match name {
        "real" => "MAINTAINERS".to_owned(),
        _ => {
            let listing = run_git(path, &["ls-files", "--", "*_all.*"]).ok()?;
            listing.stdout.lines().next()?.to_owned()
        }
    };
    let log = run_git(path, &["log", "-n", "2", "--format=%H", "--", &file]).ok()?;
    let mut hashes = log.stdout.lines();
    let newer = hashes.next()?.to_owned();
    let older = hashes.next()?.to_owned();
    Some((older, newer))
}

fn engine(path: &Path) -> Git2Engine {
    Git2Engine::open(path).expect("benchmark repository opens")
}

fn open(c: &mut Criterion) {
    let mut group = c.benchmark_group("open");
    for target in present() {
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &target, |b, t| {
            b.iter(|| engine(&t.path));
        });
    }
    group.finish();
}

fn refs(c: &mut Criterion) {
    let mut group = c.benchmark_group("refs");
    for target in present() {
        let engine = engine(&target.path);
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| e.refs(&Cancel::never()).expect("refs"));
        });
    }
    group.finish();
}

fn walk_first_page(c: &mut Criterion) {
    let mut group = c.benchmark_group("walk_first_page");
    group.sample_size(10);
    for target in present() {
        let engine = engine(&target.path);
        let options = WalkOptions {
            page_size: 500,
            order: WalkOrder::Lazy,
        };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                let mut walk = e
                    .walk(&WalkScope::All, &options, &Cancel::never())
                    .expect("walk");
                walk.next_page(&Cancel::never()).expect("page")
            });
        });
    }
    group.finish();
}

fn walk_ten_pages(c: &mut Criterion) {
    let mut group = c.benchmark_group("walk_ten_pages");
    group.sample_size(10);
    for target in present() {
        let engine = engine(&target.path);
        let options = WalkOptions {
            page_size: 500,
            order: WalkOrder::Lazy,
        };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                let mut walk = e
                    .walk(&WalkScope::All, &options, &Cancel::never())
                    .expect("walk");
                for _ in 0..10 {
                    let page = walk.next_page(&Cancel::never()).expect("page");
                    if page.done {
                        break;
                    }
                }
            });
        });
    }
    group.finish();
}

fn status(c: &mut Criterion) {
    let mut group = c.benchmark_group("status");
    group.sample_size(10);
    group.measurement_time(Duration::from_secs(20));
    for target in present() {
        let engine = engine(&target.path);
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                e.status(&StatusOptions::default(), &Cancel::never())
                    .expect("status")
            });
        });
    }
    group.finish();
}

fn diff_large_file(c: &mut Criterion) {
    let mut group = c.benchmark_group("diff_large_file");
    group.sample_size(10);
    for target in present() {
        let Some((from, to)) = target.large_diff.clone() else {
            eprintln!(
                "skipping diff_large_file/{}: no large file found",
                target.name
            );
            continue;
        };
        let engine = engine(&target.path);
        let diff_target = DiffTarget::Commits { from, to };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                e.diff(&diff_target, &DiffOptions::default(), &Cancel::never())
                    .expect("diff")
            });
        });
    }
    group.finish();
}

fn merge_base(c: &mut Criterion) {
    let mut group = c.benchmark_group("merge_base");
    for target in present() {
        let engine = engine(&target.path);
        let (a, b_rev) = target.merge_base_pair.clone();
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| e.merge_base(&a, &b_rev).expect("merge base"));
        });
    }
    group.finish();
}

fn worktrees(c: &mut Criterion) {
    let mut group = c.benchmark_group("worktrees");
    for target in present() {
        let engine = engine(&target.path);
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| e.worktrees(&Cancel::never()).expect("worktrees"));
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    open,
    refs,
    walk_first_page,
    walk_ten_pages,
    status,
    diff_large_file,
    merge_base,
    worktrees
);
criterion_main!(benches);
