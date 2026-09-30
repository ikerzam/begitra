//! Criterion benches of the projects on an index on disk.
//!
//! `projects_listing` is the index's full listing with its projects, what Home and the palette
//! read: 500 entries, one folder project holding them all and 49 list projects of ten. The
//! budget is the repository index's, 50 ms for 500 entries, projects included.
//! `project_restore` is the launch's path to the first page: the projects listed (the open
//! project names the repository it showed last), that repository opened and its first page of
//! 500 commits walked, on every benchmark repository present (`bench/repos` or
//! `BEGITRA_BENCH_REPOS`), against "Open repository → first graph paint" (300 ms).

use std::path::PathBuf;

use bench::repos;
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{WalkOptions, WalkOrder, WalkScope};
use repo_index::{Found, Index, RepoKind};

/// Entries of the listing, the repository index's budget.
const ENTRIES: usize = 500;
/// List projects beside the folder project that holds every entry.
const LISTS: usize = 49;
/// Members of each list project.
const LIST_MEMBERS: usize = 10;

/// An index on disk with `ENTRIES` entries under the folder project of `/code` and `LISTS`
/// list projects of `LIST_MEMBERS` each; the temporary folder lives as long as the index.
fn index_on_disk() -> (tempfile::TempDir, Index) {
    let dir = tempfile::tempdir().expect("temporary folder");
    let index = Index::open(&dir.path().join("index.sqlite")).expect("index");
    let folder = PathBuf::from("/code");
    index
        .create_folder_project(&folder, 1)
        .expect("folder project");
    for i in 0..ENTRIES {
        let path = folder.join(format!("repo-{i:03}"));
        let found = Found {
            name: format!("repo-{i:03}"),
            path,
            kind: RepoKind::Main,
            parent_path: None,
            scan_root: folder.clone(),
        };
        let _stored = index.upsert_found(&found, 1).expect("entry");
    }
    for p in 0..LISTS {
        let members: Vec<PathBuf> = (0..LIST_MEMBERS)
            .map(|m| folder.join(format!("repo-{:03}", (p * LIST_MEMBERS + m) % ENTRIES)))
            .collect();
        index
            .create_project(&format!("project-{p:02}"), &members, 2)
            .expect("list project");
    }
    (dir, index)
}

fn projects_listing(c: &mut Criterion) {
    let (_dir, index) = index_on_disk();
    c.bench_function("projects_listing", |b| {
        b.iter(|| {
            let entries = index.list().expect("list");
            let projects = index.projects().expect("projects");
            assert_eq!((entries.len(), projects.len()), (ENTRIES, LISTS + 1));
        });
    });
}

/// The repository the open project showed last, as the launch finds it.
fn last_repository(index: &Index, name: &str) -> PathBuf {
    let projects = index.projects().expect("projects");
    let project = projects
        .into_iter()
        .find(|project| project.name == name)
        .expect("the open project");
    project.last_repository.expect("a last repository")
}

fn project_restore(c: &mut Criterion) {
    let mut group = c.benchmark_group("project_restore");
    group.sample_size(10);
    let options = WalkOptions {
        page_size: 500,
        order: WalkOrder::Lazy,
        filter: None,
    };
    for (name, path) in [("synthetic", repos::synthetic()), ("real", repos::real())] {
        if !repos::is_repository(&path) {
            eprintln!("skipping {name}: {} is missing", path.display());
            continue;
        }
        let (_dir, index) = index_on_disk();
        let open = index
            .create_project(name, std::slice::from_ref(&path), 3)
            .expect("the open project");
        index
            .record_project_open(open.id, Some(path.as_path()), 4)
            .expect("recorded");
        group.bench_with_input(BenchmarkId::from_parameter(name), &index, |b, index| {
            b.iter(|| {
                let shown = last_repository(index, name);
                let engine = Git2Engine::open(&shown).expect("benchmark repository opens");
                let mut walk = engine
                    .walk(&WalkScope::All, &options, &Cancel::never())
                    .expect("walk");
                walk.next_page(&Cancel::never()).expect("page")
            });
        });
    }
    group.finish();
}

criterion_group!(benches, projects_listing, project_restore);
criterion_main!(benches);
