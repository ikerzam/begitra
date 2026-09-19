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
    /// The commit whose diff is dominated by one very large file.
    large_diff: Option<String>,
    /// A typical small commit.
    typical: Option<String>,
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
        let typical = typical_commit(&path);
        targets.push(Target {
            name,
            path,
            merge_base_pair,
            large_diff,
            typical,
        });
    }
    targets
}

/// Two revisions whose histories diverge by about 2,000 commits (the budget scenario of the
/// branch comparison): on the real repository two release candidates of one cycle, on the
/// synthetic one the branch whose distance to `main` is closest to that.
fn merge_base_pair(name: &str, path: &Path) -> (String, String) {
    const WANTED: i64 = 2_000;
    match name {
        "real" => {
            let candidates = [
                "v6.11-rc2",
                "v6.11-rc3",
                "v6.11-rc4",
                "v6.11-rc5",
                "v6.11-rc6",
                "v6.11-rc7",
                "v6.11",
            ];
            let best = candidates
                .iter()
                .filter_map(|tag| {
                    let range = format!("v6.11-rc1...{tag}");
                    let out = run_git(path, &["rev-list", "--count", &range]).ok()?;
                    let count: i64 = out.stdout.trim().parse().ok()?;
                    Some(((count - WANTED).abs(), (*tag).to_owned()))
                })
                .min_by_key(|(distance, _)| *distance)
                .map(|(_, tag)| tag)
                .unwrap_or_else(|| "master".to_owned());
            ("v6.11-rc1".to_owned(), best)
        }
        _ => {
            let out = run_git(
                path,
                &[
                    "for-each-ref",
                    "--format=%(refname:short) %(ahead-behind:main)",
                    "refs/heads",
                ],
            )
            .ok();
            let best = out
                .and_then(|out| {
                    out.stdout
                        .lines()
                        .filter_map(|line| {
                            let mut parts = line.split_whitespace();
                            let branch = parts.next()?;
                            let ahead: i64 = parts.next()?.parse().ok()?;
                            let behind: i64 = parts.next()?.parse().ok()?;
                            let total = ahead + behind;
                            (branch != "main" && total > 0)
                                .then(|| ((total - WANTED).abs(), branch.to_owned()))
                        })
                        .min_by_key(|(distance, _)| *distance)
                        .map(|(_, branch)| branch)
                })
                .unwrap_or_else(|| "main".to_owned());
            ("main".to_owned(), best)
        }
    }
}

/// The commit that rewrites a large text file (about 10,000 changed lines of `MAINTAINERS` on
/// the real repository, of the largest source file on the synthetic one); see
/// [`repos::ensure_large_file_branch`].
fn large_diff(name: &str, path: &Path) -> Option<String> {
    let file = (name == "real").then_some("MAINTAINERS");
    match repos::ensure_large_file_branch(path, file) {
        Ok((_, commit)) => Some(commit),
        Err(error) => {
            eprintln!("large file branch of {name}: {error}");
            None
        }
    }
}

/// The newest non-merge commit, for the typical select-to-diff scenario.
fn typical_commit(path: &Path) -> Option<String> {
    let out = run_git(path, &["rev-list", "--no-merges", "-n", "1", "HEAD"]).ok()?;
    let hash = out.stdout.trim();
    (!hash.is_empty()).then(|| hash.to_owned())
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

/// The first page in `DateTopo` order, which counts the children of the whole history before
/// it can emit a row; no budget of its own (the app walks lazily by default), recorded to show
/// the cost of the exact order.
fn walk_first_page_date_topo(c: &mut Criterion) {
    let mut group = c.benchmark_group("walk_first_page_date_topo");
    group.sample_size(10);
    for target in present() {
        let engine = engine(&target.path);
        let options = WalkOptions {
            page_size: 500,
            order: WalkOrder::DateTopo,
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
        let Some(hash) = target.large_diff.clone() else {
            eprintln!(
                "skipping diff_large_file/{}: no large file branch",
                target.name
            );
            continue;
        };
        let engine = engine(&target.path);
        let diff_target = DiffTarget::Commit { hash };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                e.diff(&diff_target, &DiffOptions::default(), &Cancel::never())
                    .expect("diff")
            });
        });
    }
    group.finish();
}

fn diff_typical(c: &mut Criterion) {
    let mut group = c.benchmark_group("diff_typical");
    group.sample_size(20);
    for target in present() {
        let Some(hash) = target.typical.clone() else {
            eprintln!("skipping diff_typical/{}: no commit", target.name);
            continue;
        };
        let engine = engine(&target.path);
        let diff_target = DiffTarget::Commit { hash };
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
    walk_first_page_date_topo,
    walk_ten_pages,
    status,
    diff_large_file,
    diff_typical,
    merge_base,
    worktrees
);
criterion_main!(benches);
