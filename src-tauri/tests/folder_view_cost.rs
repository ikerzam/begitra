//! What the folder view costs on the synthetic repository's 20 linked worktrees (each a
//! checkout of the 50,000-file tree): both lists of every repository
//! read two at a time as the view loads them, each engine closed once its lists are read as the
//! view closes those of the repositories the selection is not in (timed with nothing else
//! running, then read again under a memory sampler); the active repository's lists read on an
//! engine that stays; a watcher each, without the index snapshot, started one after another as
//! `watch_folder` starts them; and the process's memory at each step. The `git status` each
//! working-tree list runs is a process of its own, not counted. Needs the benchmark repositories
//! (`cargo run -p bench --release -- generate`, beside the repository or in
//! `BEGITRA_BENCH_REPOS`); run by hand:
//! `cargo test -p begitra --release --test folder_view_cost -- --ignored --nocapture`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use begitra_lib::state::{AppState, FOLDER_WATCH_LIMIT};
use begitra_lib::watcher::RepoWatcher;
use git_core::engine::{Cancel, GitEngine};
use git_core::types::{DiffOptions, DiffTarget, WorkingTreeBase};

/// Loads at once, as the folder view's store runs them.
const LOADS_AT_ONCE: usize = 2;

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

/// The memory of this process in megabytes: its working set (resident pages, the mapped pack
/// files included) and its private bytes, as the platform reports them.
fn memory_mb() -> (f64, f64) {
    if cfg!(windows) {
        // A fixed script: the process id reaches it through the environment.
        let script = "$p = Get-Process -Id $env:BEGITRA_MEASURED_PID; \"$($p.WorkingSet64) $($p.PrivateMemorySize64)\"";
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .env("BEGITRA_MEASURED_PID", std::process::id().to_string())
            .output();
        let text = output
            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
            .unwrap_or_default();
        let mut numbers = text
            .split_whitespace()
            .filter_map(|n| n.parse::<f64>().ok())
            .map(|bytes| bytes / 1_048_576.0);
        (
            numbers.next().unwrap_or(f64::NAN),
            numbers.next().unwrap_or(f64::NAN),
        )
    } else {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        let field = |name: &str| {
            status
                .lines()
                .find(|line| line.starts_with(name))
                .map(|line| {
                    line.chars()
                        .filter(char::is_ascii_digit)
                        .collect::<String>()
                })
                .and_then(|kb| kb.parse::<f64>().ok())
                .map_or(f64::NAN, |kb| kb / 1024.0)
        };
        (field("VmRSS:"), field("RssAnon:"))
    }
}

/// Reads the Unstaged and Staged lists of `engine` whole; returns their files.
fn read_lists(engine: &dyn GitEngine) -> usize {
    let mut files = 0;
    for target in [
        DiffTarget::WorkingTree {
            base: WorkingTreeBase::Index,
        },
        DiffTarget::Index,
    ] {
        let options = DiffOptions {
            ignore_whitespace: false,
            ..DiffOptions::default()
        };
        let mut pages = engine
            .diff_pages(&target, &options, 200, &Cancel::never())
            .expect("diff");
        loop {
            let page = pages.next_page(&Cancel::never()).expect("page");
            files += page.files.len();
            if page.done {
                break;
            }
        }
    }
    files
}

/// Reads both lists of every root, [`LOADS_AT_ONCE`] at a time, each engine closed once its
/// lists are read; answers when the first repository's lists ended, when the last's did, and
/// the files listed.
fn load_all(state: &AppState, roots: &[PathBuf]) -> (Duration, Duration, usize) {
    let started = Instant::now();
    let queue = Arc::new(Mutex::new(roots.iter().rev().cloned().collect::<Vec<_>>()));
    let first = Arc::new(Mutex::new(None::<Duration>));
    let files = Arc::new(Mutex::new(0usize));
    let loaders: Vec<_> = (0..LOADS_AT_ONCE)
        .map(|_| {
            let queue = Arc::clone(&queue);
            let first = Arc::clone(&first);
            let files = Arc::clone(&files);
            let state = state.clone();
            std::thread::spawn(move || loop {
                let next = queue.lock().expect("queue").pop();
                let Some(root) = next else { break };
                let engine = state.open(&root).expect("engine");
                *files.lock().expect("files") += read_lists(engine.as_ref());
                first
                    .lock()
                    .expect("first")
                    .get_or_insert(started.elapsed());
                // The engine's own spelling of its root, which is what it is kept under.
                let key = engine.repo().root.clone();
                drop(engine);
                drop(state.close(&key));
            })
        })
        .collect();
    for loader in loaders {
        loader.join().expect("loader");
    }
    let all = started.elapsed();
    let first = first.lock().expect("first").unwrap_or(all);
    let files = *files.lock().expect("files");
    (first, all, files)
}

#[test]
#[ignore = "needs the benchmark repositories; run by hand"]
fn folder_view_on_the_synthetic_worktrees() {
    let folder = bench_repos().join("synthetic-worktrees");
    let mut roots: Vec<PathBuf> = std::fs::read_dir(&folder)
        .expect("the synthetic worktrees (cargo run -p bench -- generate)")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.join(".git").exists())
        .collect();
    roots.sort();
    roots.truncate(FOLDER_WATCH_LIMIT);
    println!("repositories: {}", roots.len());
    let state = AppState::default();
    let before = memory_mb();

    // The lists timed, with nothing else running.
    let (first, all, files) = load_all(&state, &roots);
    assert_eq!(state.open_count(), 0);

    // The same loads again under a sampler that keeps the highest memory.
    let loading = Arc::new(AtomicBool::new(true));
    let peak = Arc::new(Mutex::new((0.0f64, 0.0f64)));
    let sampler = {
        let loading = Arc::clone(&loading);
        let peak = Arc::clone(&peak);
        std::thread::spawn(move || {
            while loading.load(Ordering::Relaxed) {
                let (working, private) = memory_mb();
                {
                    let mut highest = peak.lock().expect("peak");
                    highest.0 = highest.0.max(working);
                    highest.1 = highest.1.max(private);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })
    };
    load_all(&state, &roots);
    loading.store(false, Ordering::Relaxed);
    sampler.join().expect("sampler");
    let highest = *peak.lock().expect("peak");
    std::thread::sleep(Duration::from_millis(500));
    let after_loads = memory_mb();

    // The active repository's lists, on the engine that stays open.
    let first_root = roots.first().expect("a worktree");
    let active = state.open(first_root).expect("engine");
    read_lists(active.as_ref());
    let with_active = memory_mb();

    // A watcher each, one after another.
    let started = Instant::now();
    let sync = state.begin_folder_sync(&roots);
    state.run_folder_starts(sync.start, |bases| {
        RepoWatcher::start_without_snapshot(bases, |_| {})
    });
    let watchers = started.elapsed();
    std::thread::sleep(Duration::from_millis(500));
    let at_rest = memory_mb();
    let watched = state.folder_watched().len();

    println!("files listed: {files}");
    println!(
        "lists, {LOADS_AT_ONCE} at a time: the first repository's in {:.2} s, all in {:.2} s",
        first.as_secs_f64(),
        all.as_secs_f64()
    );
    // Fewer than the repositories where the platform refused (the inotify limit on Linux).
    println!(
        "watchers started: {watched} of {} in {:.2} s",
        roots.len(),
        watchers.as_secs_f64()
    );
    for (label, (working, private)) in [
        ("before", before),
        ("at the highest while the lists load", highest),
        ("after the loads, every engine closed", after_loads),
        ("with the active repository's engine", with_active),
        ("at rest, with the watchers too", at_rest),
    ] {
        println!("memory {label}: {working:.0} MB working set, {private:.0} MB private");
    }
    drop(state.stop_folder_watchers());
}
