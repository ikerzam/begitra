//! A partial clone: a code search needs blobs, and a path history trees, that the clone may
//! leave to its promisor remote, which git would fetch. A walk is a read: it reaches no network
//! and asks for no credentials, and stops at the first object the clone lacks, after the rows
//! before it, as `diff.blob_missing`. A test binary of its own, since it traces git through the
//! process's environment.

mod support;

use std::path::{Path, PathBuf};

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{ContentFilter, WalkFilter, WalkOptions, WalkOrder, WalkScope};
use support::Fixture;

/// A history whose newest commit adds a file of its own, cloned with `filter` into `name`:
/// the checkout fetches what the tip needs, the older contents stay on the remote.
fn clone_with(f: &mut Fixture, filter: &str, name: &str) -> (PathBuf, String) {
    for i in 1..=3 {
        f.append("a.txt", &format!("line {i} retryLimit{i}\n"));
        f.commit(&format!("a{i}"));
    }
    f.write("b.txt", "retryLimit9\n");
    let newest = f.commit("b");
    let origin = f.sibling(&format!("{name}-origin.git"));
    let origin_text = origin.to_string_lossy().into_owned();
    f.git(&["init", "-q", "--bare", "-b", "main", &origin_text]);
    f.git_in(&origin, &["config", "uploadpack.allowFilter", "true"]);
    f.git_in(
        &origin,
        &["config", "uploadpack.allowAnySHA1InWant", "true"],
    );
    f.git(&["push", "-q", &origin_text, "main"]);
    let url = format!(
        "file://{}",
        origin_text.replace(std::path::MAIN_SEPARATOR, "/")
    );
    let clone = f.sibling(name);
    let clone_text = clone.to_string_lossy().into_owned();
    f.git(&[
        "clone",
        "-q",
        &format!("--filter={filter}"),
        &url,
        &clone_text,
    ]);
    (clone, newest)
}

fn content_search() -> WalkOptions {
    filtered(WalkFilter {
        content: Some(ContentFilter {
            text: "retryLimit".to_owned(),
            lines: false,
        }),
        ..WalkFilter::default()
    })
}

fn filtered(filter: WalkFilter) -> WalkOptions {
    WalkOptions {
        filter: Some(filter),
        order: WalkOrder::Lazy,
        ..WalkOptions::default()
    }
}

/// The rows of every page, then the error the walk ends with, if any.
fn rows_then_error(clone: &Path, options: &WalkOptions) -> (Vec<String>, Option<GitError>) {
    let engine = Git2Engine::open(clone).expect("open");
    let mut walk = engine
        .walk(&WalkScope::All, options, &Cancel::never())
        .expect("walk");
    let mut rows = Vec::new();
    loop {
        match walk.next_page(&Cancel::never()) {
            Ok(page) => {
                let done = page.done;
                rows.extend(page.commits.into_iter().map(|c| c.hash));
                if done {
                    // One more call surfaces an error parked behind the last page.
                    return (rows, walk.next_page(&Cancel::never()).err());
                }
            }
            Err(error) => return (rows, Some(error)),
        }
    }
}

fn packs(clone: &Path) -> usize {
    std::fs::read_dir(clone.join(".git").join("objects").join("pack"))
        .expect("pack folder")
        .count()
}

#[test]
fn a_walk_of_a_partial_clone_fetches_nothing() {
    let mut f = Fixture::empty();
    let (clone, newest) = clone_with(&mut f, "blob:none", "blobless");
    let packs_before = packs(&clone);
    let trace = f.sibling("trace.txt");
    std::env::set_var("GIT_TRACE", &trace);
    let (rows, error) = rows_then_error(&clone, &content_search());
    std::env::remove_var("GIT_TRACE");
    // The rows before the first blob the clone lacks, then that blob's error.
    assert_eq!(rows, vec![newest]);
    assert_eq!(
        error.as_ref().map(GitError::code),
        Some("diff.blob_missing"),
        "{error:?}"
    );
    let traced = std::fs::read_to_string(&trace).unwrap_or_default();
    assert!(
        traced.contains("log --stdin"),
        "the trace saw the search: {traced}"
    );
    let fetches: Vec<&str> = traced
        .lines()
        .filter(|line| line.contains("git fetch") || line.contains("fetch-pack"))
        .collect();
    assert!(fetches.is_empty(), "the search fetched: {fetches:?}");
    assert_eq!(packs(&clone), packs_before, "the search wrote no pack");

    // A clone without the older trees: the path history reads them too, and neither walk
    // calls the clone corrupt.
    let mut f = Fixture::empty();
    let (clone, _) = clone_with(&mut f, "tree:0", "treeless");
    let packs_before = packs(&clone);
    let by_path = filtered(WalkFilter {
        paths: vec!["a.txt".to_owned()],
        ..WalkFilter::default()
    });
    for options in [content_search(), by_path] {
        let (_, error) = rows_then_error(&clone, &options);
        assert_eq!(
            error.as_ref().map(GitError::code),
            Some("diff.blob_missing"),
            "{error:?}"
        );
    }
    assert_eq!(packs(&clone), packs_before, "the walks wrote no pack");
}
