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
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    BlobAt, DiffOptions, DiffTarget, StatusOptions, WalkFilter, WalkOptions, WalkOrder, WalkScope,
    WorktreeAdd, WorktreeBranch,
};

/// A benchmark repository that is present on disk.
struct Target {
    name: &'static str,
    path: PathBuf,
    /// Two revisions diverged by about 2,000 commits, for `merge_base`; `None` when the
    /// repository has no such pair (the group is skipped rather than measuring a wrong one).
    merge_base_pair: Option<(String, String)>,
    /// The commit whose diff is dominated by one very large file.
    large_diff: Option<String>,
    /// A typical small commit.
    typical: Option<String>,
    /// The path changed most often among the newest 200 commits, for `path_history`.
    frequent_path: Option<String>,
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
        let frequent_path = frequent_path(&path);
        targets.push(Target {
            name,
            path,
            merge_base_pair,
            large_diff,
            typical,
            frequent_path,
        });
    }
    targets
}

/// Two revisions whose histories diverge by about 2,000 commits (the budget scenario of the
/// branch comparison): on the real repository two release candidates of one cycle, on the
/// synthetic one the branch whose distance to `main` is closest to that. `None`, with a
/// message, when no candidate can be measured (missing tags, a git without `ahead-behind`).
fn merge_base_pair(name: &str, path: &Path) -> Option<(String, String)> {
    const WANTED: i64 = 2_000;
    let pair = match name {
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
            candidates
                .iter()
                .filter_map(|tag| {
                    let range = format!("v6.11-rc1...{tag}");
                    let out = run_git(path, &["rev-list", "--count", &range]).ok()?;
                    let count: i64 = out.stdout.trim().parse().ok()?;
                    Some(((count - WANTED).abs(), (*tag).to_owned()))
                })
                .min_by_key(|(distance, _)| *distance)
                .map(|(_, tag)| ("v6.11-rc1".to_owned(), tag))
        }
        _ => run_git(
            path,
            &[
                "for-each-ref",
                "--format=%(refname:short) %(ahead-behind:main)",
                "refs/heads",
            ],
        )
        .ok()
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
                .map(|(_, branch)| ("main".to_owned(), branch))
        }),
    };
    if pair.is_none() {
        eprintln!("merge_base/{name}: no pair diverged by about 2,000 commits (tags missing, or git older than 2.41)");
    }
    pair
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

/// The path the newest 200 commits change most often: a file whose history git can list
/// quickly, the scenario of the path filter (a rarely changed file walks the whole history).
fn frequent_path(path: &Path) -> Option<String> {
    let out = run_git(path, &["log", "-200", "--format=", "--name-only", "HEAD"]).ok()?;
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for line in out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        *counts.entry(line).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))
        .map(|(file, _)| file.to_owned())
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
            filter: None,
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
            filter: None,
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

/// The first page of a text-filtered walk: "fix" matches a fair share of the commits of both
/// repositories, so 500 matches need a few thousand commits parsed and matched.
fn walk_first_page_filtered(c: &mut Criterion) {
    let mut group = c.benchmark_group("walk_first_page_filtered");
    group.sample_size(10);
    for target in present() {
        let engine = engine(&target.path);
        let options = WalkOptions {
            page_size: 500,
            order: WalkOrder::Lazy,
            filter: Some(WalkFilter {
                text: Some("fix".to_owned()),
                ..WalkFilter::default()
            }),
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

/// The first page of a path history (`git rev-list --all -- <path>` hydrated with libgit2)
/// for the path the newest commits change most often; the child process is killed when the
/// handle drops.
fn path_history(c: &mut Criterion) {
    let mut group = c.benchmark_group("path_history");
    group.sample_size(10);
    for target in present() {
        let Some(file) = target.frequent_path.clone() else {
            eprintln!(
                "path_history/{}: no path found in the newest commits",
                target.name
            );
            continue;
        };
        let engine = engine(&target.path);
        let options = WalkOptions {
            page_size: 500,
            order: WalkOrder::Lazy,
            filter: Some(WalkFilter {
                paths: vec![file],
                ..WalkFilter::default()
            }),
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
            filter: None,
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

/// Reading the large text file whole at the large-file commit (the image diff and "Show new
/// file" read at most two such blobs).
fn read_blob(c: &mut Criterion) {
    let mut group = c.benchmark_group("read_blob");
    group.sample_size(20);
    for target in present() {
        let Some(commit) = target.large_diff.clone() else {
            continue;
        };
        let file = match run_git(
            &target.path,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", &commit],
        ) {
            Ok(out) => out.stdout.lines().next().unwrap_or("").trim().to_owned(),
            Err(_) => continue,
        };
        if file.is_empty() {
            continue;
        }
        let engine = engine(&target.path);
        let at = BlobAt::Revision {
            rev: commit.clone(),
        };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| e.read_blob(&at, &file).expect("blob"));
        });
    }
    group.finish();
}

fn merge_base(c: &mut Criterion) {
    let mut group = c.benchmark_group("merge_base");
    for target in present() {
        let Some((a, b_rev)) = target.merge_base_pair.clone() else {
            eprintln!("skipping merge_base/{}: no pair", target.name);
            continue;
        };
        let engine = engine(&target.path);
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| e.merge_base(&a, &b_rev).expect("merge base"));
        });
    }
    group.finish();
}

/// The merge base with the counts of both sides on the pair diverged by about 2,000 commits.
fn compare(c: &mut Criterion) {
    let mut group = c.benchmark_group("compare");
    for target in present() {
        let Some((a, b_rev)) = target.merge_base_pair.clone() else {
            eprintln!("skipping compare/{}: no pair", target.name);
            continue;
        };
        let engine = engine(&target.path);
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| e.compare(&a, &b_rev, &Cancel::never()).expect("compare"));
        });
    }
    group.finish();
}

/// The first page of `b..a` on the pair: the "Only in a" list, bounded by the divergence.
fn walk_range_first_page(c: &mut Criterion) {
    let mut group = c.benchmark_group("walk_range_first_page");
    group.sample_size(10);
    for target in present() {
        let Some((a, b_rev)) = target.merge_base_pair.clone() else {
            eprintln!("skipping walk_range_first_page/{}: no pair", target.name);
            continue;
        };
        let engine = engine(&target.path);
        let scope = WalkScope::Range {
            exclude: b_rev,
            include: a,
        };
        let options = WalkOptions {
            page_size: 500,
            order: WalkOrder::Lazy,
            filter: None,
        };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                let mut walk = e.walk(&scope, &options, &Cancel::never()).expect("walk");
                walk.next_page(&Cancel::never()).expect("page")
            });
        });
    }
    group.finish();
}

/// A range count on a long history: `HEAD~50..HEAD` must cost 50 commits, not the history.
fn count_range(c: &mut Criterion) {
    let mut group = c.benchmark_group("count_range");
    group.sample_size(10);
    for target in present() {
        let engine = engine(&target.path);
        let scope = WalkScope::Range {
            exclude: "HEAD~50".to_owned(),
            include: "HEAD".to_owned(),
        };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| e.count_commits(&scope, &Cancel::never()).expect("count"));
        });
    }
    group.finish();
}

/// The file summary of the comparison: the first page of 200 files of `git diff a...b` on the
/// pair, the way the app streams it.
fn diff_three_dot_first_page(c: &mut Criterion) {
    let mut group = c.benchmark_group("diff_three_dot_first_page");
    group.sample_size(10);
    for target in present() {
        let Some((a, b_rev)) = target.merge_base_pair.clone() else {
            eprintln!(
                "skipping diff_three_dot_first_page/{}: no pair",
                target.name
            );
            continue;
        };
        let engine = engine(&target.path);
        let diff_target = DiffTarget::Range {
            from: a,
            to: b_rev,
            three_dot: true,
        };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                let mut walk = e
                    .diff_pages(&diff_target, &DiffOptions::default(), 200, &Cancel::never())
                    .expect("diff");
                walk.next_page(&Cancel::never()).expect("page")
            });
        });
    }
    group.finish();
}

/// The same diff whole, for the record: no budget, since the app never waits for it.
fn diff_three_dot(c: &mut Criterion) {
    let mut group = c.benchmark_group("diff_three_dot");
    group.sample_size(10);
    for target in present() {
        let Some((a, b_rev)) = target.merge_base_pair.clone() else {
            eprintln!("skipping diff_three_dot/{}: no pair", target.name);
            continue;
        };
        let engine = engine(&target.path);
        let diff_target = DiffTarget::Range {
            from: a,
            to: b_rev,
            three_dot: true,
        };
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                e.diff(&diff_target, &DiffOptions::default(), &Cancel::never())
                    .expect("diff")
            });
        });
    }
    group.finish();
}

/// The merge preview of the pair through `git merge-tree`.
fn merge_preview(c: &mut Criterion) {
    let mut group = c.benchmark_group("merge_preview");
    group.sample_size(10);
    for target in present() {
        let Some((a, b_rev)) = target.merge_base_pair.clone() else {
            eprintln!("skipping merge_preview/{}: no pair", target.name);
            continue;
        };
        let engine = engine(&target.path);
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                e.merge_preview(&a, &b_rev, &Cancel::never())
                    .expect("preview")
            });
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

/// The dashboard's read: the listing plus one comparison of every linked worktree's branch
/// with the main worktree's, which is what the screen waits for.
fn worktree_dashboard(c: &mut Criterion) {
    let mut group = c.benchmark_group("worktree_dashboard");
    group.sample_size(10);
    for target in present() {
        let engine = engine(&target.path);
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                let listed = e.worktrees(&Cancel::never()).expect("worktrees");
                let main = listed
                    .iter()
                    .find(|worktree| worktree.is_main)
                    .and_then(|worktree| worktree.branch.clone())
                    .expect("a main branch");
                let mut compared = 0;
                for worktree in listed.iter().filter(|worktree| !worktree.is_main) {
                    let Some(rev) = worktree.branch.as_deref().or(worktree.head.as_deref()) else {
                        continue;
                    };
                    if e.compare(&main, rev, &Cancel::never()).is_ok() {
                        compared += 1;
                    }
                }
                compared
            });
        });
    }
    group.finish();
}

/// One add of a worktree on a fresh branch and its removal: a checkout of the whole tree, a
/// user action that shows its progress, recorded without a budget.
fn worktree_add_remove(c: &mut Criterion) {
    let mut group = c.benchmark_group("worktree_add_remove");
    group.sample_size(10);
    for target in present() {
        let engine = engine(&target.path);
        let folder = std::env::temp_dir().join(format!("begira-bench-wt-{}", target.name));
        let folder_text = folder.to_string_lossy().into_owned();
        // A killed run leaves the entry locked "initializing": unlock and force it away.
        let _ = run_git(&target.path, &["worktree", "unlock", "--", &folder_text]);
        let _ = run_git(
            &target.path,
            &[
                "worktree",
                "remove",
                "--force",
                "--force",
                "--",
                &folder_text,
            ],
        );
        let _ = std::fs::remove_dir_all(&folder);
        let _ = run_git(&target.path, &["worktree", "prune"]);
        let _ = run_git(&target.path, &["branch", "-D", "begira-bench-wt"]);
        group.bench_with_input(BenchmarkId::from_parameter(target.name), &engine, |b, e| {
            b.iter(|| {
                let request = WorktreeAdd {
                    path: folder.clone(),
                    branch: WorktreeBranch::New {
                        name: "begira-bench-wt".to_owned(),
                        start: "HEAD".to_owned(),
                    },
                };
                e.worktree_add(&request, &Cancel::never()).expect("add");
                // The kernel has paths that differ only in case, which a Windows checkout
                // leaves modified; the forced removal is the fallback for that case only.
                match e.worktree_remove(&folder, false, &Cancel::never()) {
                    Ok(()) => {}
                    Err(GitError::WorktreeDirty(_)) => e
                        .worktree_remove(&folder, true, &Cancel::never())
                        .expect("forced remove"),
                    Err(error) => panic!("remove failed: {error}"),
                }
                run_git(&target.path, &["branch", "-D", "begira-bench-wt"]).expect("branch");
            });
        });
        let _ = std::fs::remove_dir_all(&folder);
    }
    group.finish();
}

criterion_group!(
    benches,
    open,
    refs,
    walk_first_page,
    walk_first_page_date_topo,
    walk_first_page_filtered,
    path_history,
    walk_ten_pages,
    status,
    diff_large_file,
    diff_typical,
    read_blob,
    merge_base,
    compare,
    walk_range_first_page,
    count_range,
    diff_three_dot_first_page,
    diff_three_dot,
    merge_preview,
    worktrees,
    worktree_dashboard,
    worktree_add_remove
);
criterion_main!(benches);
