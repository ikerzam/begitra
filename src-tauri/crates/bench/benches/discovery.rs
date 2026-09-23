//! Criterion benches of the scanner on the generated tree (`bench generate-tree`): the time to
//! the first repository found and the full scan of 5,000 directories.

use std::ops::ControlFlow;
use std::time::{Duration, Instant};

use bench::repos;
use criterion::{criterion_group, criterion_main, Criterion};
use repo_index::scanner::scan;
use repo_index::{Cancel, ScanEvent, ScanOptions};

fn tree_present() -> Option<std::path::PathBuf> {
    let path = repos::discovery();
    if path.join(".begitra-bench-tree").exists() {
        Some(path)
    } else {
        eprintln!(
            "skipping discovery: {} is missing, run `cargo run -p bench -- generate-tree`",
            path.display()
        );
        None
    }
}

fn scan_full(c: &mut Criterion) {
    let Some(root) = tree_present() else { return };
    let mut group = c.benchmark_group("discovery");
    group.sample_size(10);
    group.measurement_time(Duration::from_secs(15));
    group.bench_function("scan_full", |b| {
        b.iter(|| {
            let mut found = 0u64;
            scan(
                std::slice::from_ref(&root),
                &ScanOptions::default(),
                &Cancel::never(),
                |event| {
                    if matches!(event, ScanEvent::Found(_)) {
                        found += 1;
                    }
                    ControlFlow::Continue(())
                },
            );
            assert!(found > 0, "the tree holds repositories");
            found
        });
    });
    group.finish();
}

fn scan_first_result(c: &mut Criterion) {
    let Some(root) = tree_present() else { return };
    let mut group = c.benchmark_group("discovery");
    group.sample_size(10);
    group.bench_function("scan_first_result", |b| {
        b.iter_custom(|iterations| {
            let mut total = Duration::ZERO;
            for _ in 0..iterations {
                let started = Instant::now();
                let mut first: Option<Duration> = None;
                scan(
                    std::slice::from_ref(&root),
                    &ScanOptions::default(),
                    &Cancel::never(),
                    |event| {
                        if matches!(event, ScanEvent::Found(_)) {
                            first = Some(started.elapsed());
                            return ControlFlow::Break(());
                        }
                        ControlFlow::Continue(())
                    },
                );
                total += first.expect("a repository is found");
            }
            total
        });
    });
    group.finish();
}

criterion_group!(benches, scan_first_result, scan_full);
criterion_main!(benches);
