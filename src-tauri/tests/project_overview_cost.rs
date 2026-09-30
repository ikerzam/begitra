//! What the project view's Overview and a bulk fetch cost.
//!
//! The Overview of a project of the synthetic repository's 20 linked worktrees: its rows from
//! the index (the listing and the projects, the first thing the view shows), then every
//! member's summary read again four at a time as the Overview reads them (HEAD, the upstream
//! counts and the tip, without the working tree's status), the median of five rounds, and the
//! process's private memory around them. A bulk fetch: 20 small repositories, each 30 commits
//! behind its own bare remote on disk, fetched 1, 2, 4 and 8 at a time with nothing allowed to
//! prompt, and the process's memory once every engine the fetches opened is closed again.
//! Needs the benchmark repositories (`cargo run -p bench --release -- generate`, beside the
//! repository or in `BEGITRA_BENCH_REPOS`); run by hand, one test at a time so neither times
//! the other:
//! `cargo test -p begitra --release --test project_overview_cost -- --ignored --nocapture --test-threads=1`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::summary::describe_head;
use git_core::types::Prompts;
use repo_index::{Found, Index, RepoKind, RepoSummary, Upserted};

/// Summaries read at once, as the Overview reads them.
const READS_AT_ONCE: usize = 4;
/// Rounds of the Overview's reads; the median is reported.
const ROUNDS: usize = 5;

fn bench_repos() -> PathBuf {
    std::env::var_os("BEGITRA_BENCH_REPOS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("begitra-bench-repos")
        })
}

/// This process's private memory in megabytes.
fn private_mb() -> f64 {
    if cfg!(windows) {
        let script = "(Get-Process -Id $env:BEGITRA_MEASURED_PID).PrivateMemorySize64";
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .env("BEGITRA_MEASURED_PID", std::process::id().to_string())
            .output();
        output
            .ok()
            .and_then(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<f64>()
                    .ok()
            })
            .map_or(f64::NAN, |bytes| bytes / 1_048_576.0)
    } else {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        status
            .lines()
            .find(|line| line.starts_with("RssAnon:"))
            .and_then(|line| {
                line.chars()
                    .filter(char::is_ascii_digit)
                    .collect::<String>()
                    .parse::<f64>()
                    .ok()
            })
            .map_or(f64::NAN, |kb| kb / 1024.0)
    }
}

/// Runs `work` on every item, `at_once` at a time; the wall time.
fn at_once<T: Sync>(items: &[T], at_once: usize, work: impl Fn(&T) + Sync) -> Duration {
    let queue = Mutex::new(items.iter());
    let started = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..at_once {
            scope.spawn(|| loop {
                let next = queue.lock().expect("queue").next();
                match next {
                    Some(item) => work(item),
                    None => break,
                }
            });
        }
    });
    started.elapsed()
}

fn index_summary(summary: &git_core::summary::RepoSummary) -> RepoSummary {
    RepoSummary {
        current_branch: summary.current_branch.clone(),
        detached: summary.detached,
        ahead: summary.ahead,
        behind: summary.behind,
        last_commit_at: summary.last_commit_at,
        last_commit_subject: summary.last_commit_subject.clone(),
        fetched_at: summary.fetched_at,
        dirty: summary.dirty,
        ..RepoSummary::default()
    }
}

#[test]
#[ignore = "needs the benchmark repositories; run by hand"]
fn overview_of_the_synthetic_worktrees() {
    let folder = bench_repos().join("synthetic-worktrees");
    let mut roots: Vec<PathBuf> = std::fs::read_dir(&folder)
        .expect("the synthetic worktrees (cargo run -p bench -- generate)")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join(".git").exists())
        .collect();
    roots.sort();
    assert_eq!(roots.len(), 20, "20 linked worktrees");

    // The index as a scan leaves it: the folder's project, an entry and a summary each (read
    // without the status, which only this setup would pay), and a project of the 20.
    let index = Index::in_memory().expect("index");
    index
        .create_folder_project(&folder, 0)
        .expect("folder project");
    for root in &roots {
        let found = Found {
            path: root.clone(),
            name: root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            kind: RepoKind::Worktree,
            parent_path: Some(bench_repos().join("synthetic")),
            scan_root: folder.clone(),
        };
        assert_eq!(
            index.upsert_found(&found, 1).expect("insert"),
            Upserted::Stored
        );
        let summary = describe_head(root, &Cancel::never()).expect("summary");
        index
            .update_summary(root, &index_summary(&summary), 2)
            .expect("store");
    }
    index
        .create_project("synthetic", &roots, 3)
        .expect("project");
    let started = Instant::now();
    let listed = index.list().expect("list");
    let projects = index.projects().expect("projects");
    let first_rows = started.elapsed();
    assert_eq!(listed.len(), 20);
    // The folder's project and the list project hold the 20 each.
    assert!(projects.iter().all(|project| project.members.len() == 20));

    let before = private_mb();
    let times = Arc::new(Mutex::new(Vec::new()));
    let mut rounds: Vec<Duration> = (0..ROUNDS)
        .map(|_| {
            at_once(&roots, READS_AT_ONCE, |root| {
                let started = Instant::now();
                let summary = describe_head(root, &Cancel::never()).expect("summary");
                assert!(summary.upstream.is_some() || summary.current_branch.is_some());
                times.lock().expect("times").push(started.elapsed());
            })
        })
        .collect();
    let after = private_mb();
    rounds.sort();
    let summaries = rounds[rounds.len() / 2];
    let mut each = times.lock().expect("times").clone();
    each.sort();
    let median = each[each.len() / 2];

    println!(
        "project_overview_first_rows: {:.2} ms (the index's 20 entries and the project)",
        first_rows.as_secs_f64() * 1000.0
    );
    println!(
        "project_overview_summaries: {:.1} ms for 20, {READS_AT_ONCE} at a time (median of {ROUNDS} rounds; {:.1} ms a read)",
        summaries.as_secs_f64() * 1000.0,
        median.as_secs_f64() * 1000.0
    );
    println!(
        "project_overview_memory: {before:.0} MB before the reads, {after:.0} MB after (private)"
    );
}

fn git(cwd: &Path, args: &[&str]) {
    let mut command = Command::new("git");
    for var in git_core::cli::REDIRECTING_VARS {
        command.env_remove(var);
    }
    let output = command
        .current_dir(cwd)
        .args([
            "-c",
            "user.name=Bench",
            "-c",
            "user.email=bench@example.com",
        ])
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Pushes `count` new commits to the bare remote through its writer clone.
fn advance(writer: &Path, count: usize, round: usize) {
    for n in 0..count {
        std::fs::write(
            writer.join(format!("r{round}-{n}.txt")),
            format!("{round} {n}\n"),
        )
        .expect("write");
        git(writer, &["add", "-A"]);
        git(
            writer,
            &["commit", "-q", "-m", &format!("round {round} commit {n}")],
        );
    }
    git(writer, &["push", "-q", "origin", "main"]);
}

#[test]
#[ignore = "needs the benchmark repositories; run by hand"]
fn bulk_fetch() {
    // 20 small repositories, each 30 commits behind its own bare remote per round.
    let dir = tempfile::tempdir().expect("temp dir");
    let mut members = Vec::new();
    let mut writers = Vec::new();
    for i in 0..20 {
        let bare = dir.path().join(format!("remote-{i:02}.git"));
        let writer = dir.path().join(format!("writer-{i:02}"));
        let member = dir.path().join(format!("member-{i:02}"));
        git(
            dir.path(),
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                &bare.to_string_lossy(),
            ],
        );
        git(
            dir.path(),
            &[
                "clone",
                "-q",
                &bare.to_string_lossy(),
                &writer.to_string_lossy(),
            ],
        );
        git(&writer, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        advance(&writer, 5, 0);
        git(
            dir.path(),
            &[
                "clone",
                "-q",
                &bare.to_string_lossy(),
                &member.to_string_lossy(),
            ],
        );
        members.push(member);
        writers.push(writer);
    }
    let before = private_mb();
    for (round, limit) in [1usize, 2, 4, 8].into_iter().enumerate() {
        for writer in &writers {
            advance(writer, 30, round + 1);
        }
        let wall = at_once(&members, limit, |member| {
            let engine = Git2Engine::open(member).expect("open");
            engine
                .fetch(
                    Some("origin"),
                    false,
                    Prompts::Never,
                    &mut |_| {},
                    &Cancel::never(),
                )
                .expect("fetch");
        });
        println!(
            "project_bulk_fetch_20_at_{limit}: {:.2} s (30 new commits each, local bare remotes)",
            wall.as_secs_f64()
        );
    }
    println!(
        "project_bulk_fetch_memory: {before:.0} MB before the fetches, {:.0} MB after 80 fetches with their engines closed (private)",
        private_mb()
    );
}
