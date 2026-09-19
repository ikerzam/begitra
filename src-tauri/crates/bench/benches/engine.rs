//! Criterion benches for the engine operations: one placeholder group; this
//! file exists so `cargo bench -p bench` runs from the start.

use criterion::{criterion_group, criterion_main, Criterion};

fn placeholder(c: &mut Criterion) {
    c.bench_function("engine/placeholder", |b| {
        b.iter(|| std::hint::black_box(1 + 1))
    });
}

criterion_group!(benches, placeholder);
criterion_main!(benches);
