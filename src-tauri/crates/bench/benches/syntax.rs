//! Criterion benches of the `syntax` crate on synthetic sources: highlighting a 10,000-line
//! Rust file (the budget scenario of the viewer) and listing the symbols of a 500-line
//! TypeScript file. No repository is needed.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

/// A Rust file of `lines` lines: functions with comments, strings, numbers and a struct.
fn rust_source(lines: usize) -> String {
    let mut text = String::new();
    let mut n = 0;
    while text.lines().count() < lines {
        text.push_str(&format!(
            "/// Item {n} of the synthetic module.\npub struct Item{n} {{\n    pub name: String,\n    pub count: u32,\n}}\n\nimpl Item{n} {{\n    /// Builds one with \"{n}\" as its name.\n    pub fn new() -> Self {{\n        Self {{ name: \"item {n}\".to_owned(), count: {n} }} // trailing\n    }}\n}}\n\n"
        ));
        n += 1;
    }
    text
}

/// A TypeScript file of about `lines` lines: classes with methods and arrow functions.
fn typescript_source(lines: usize) -> String {
    let mut text = String::new();
    let mut n = 0;
    while text.lines().count() < lines {
        text.push_str(&format!(
            "export class Service{n} {{\n  private cache = new Map<string, number>();\n  get(key: string): number | undefined {{\n    return this.cache.get(key); // lookup\n  }}\n}}\n\nexport const handler{n} = (input: string) => input.length + {n};\n\n"
        ));
        n += 1;
    }
    text
}

fn never() -> bool {
    false
}

fn highlight_large_file(c: &mut Criterion) {
    let mut group = c.benchmark_group("syntax");
    group.sample_size(10);
    let source = rust_source(10_000);
    group.bench_with_input(
        BenchmarkId::from_parameter("highlight_large_file"),
        &source,
        |b, text| {
            b.iter(|| syntax::highlight("src/lib.rs", text, &never).expect("highlight"));
        },
    );
    group.finish();
}

fn symbols_typical(c: &mut Criterion) {
    let mut group = c.benchmark_group("syntax");
    group.sample_size(20);
    let source = typescript_source(500);
    group.bench_with_input(
        BenchmarkId::from_parameter("symbols_typical"),
        &source,
        |b, text| {
            b.iter(|| syntax::symbols("src/service.ts", text, &never).expect("symbols"));
        },
    );
    group.finish();
}

criterion_group!(benches, highlight_large_file, symbols_typical);
criterion_main!(benches);
