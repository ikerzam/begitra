//! The paged commit walk against the git CLI on fixture repositories.
//!
//! `git log --date-order` is the yardstick for [`WalkOrder::DateTopo`]. `git log --topo-order
//! --date-order` produces the same list: both flags request a topological walk and the sort
//! key is the one given last, so the tests assert that equivalence on every fixture rather than
//! assume it. Plain `git log` (newest commit date first, parents entering the queue as their
//! children are shown) is the yardstick for [`WalkOrder::Lazy`].

mod support;

use std::collections::HashMap;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{CommitNode, Page, WalkOptions, WalkOrder, WalkScope};
use support::Fixture;

const PAGE_SIZES: [usize; 3] = [2, 3, 500];

fn open(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

/// Requests pages until `done`, checking that every page but the last is full and that a
/// finished walk keeps answering empty done pages.
fn walk_pages(
    engine: &Git2Engine,
    scope: &WalkScope,
    page_size: usize,
    order: WalkOrder,
) -> Vec<Page> {
    let options = WalkOptions { page_size, order };
    let mut walk = engine
        .walk(scope, &options, &Cancel::never())
        .expect("start walk");
    let mut pages = Vec::new();
    loop {
        let page = walk.next_page(&Cancel::never()).expect("next page");
        let done = page.done;
        pages.push(page);
        if done {
            break;
        }
    }
    let expected_size = page_size.clamp(1, 500);
    for page in &pages[..pages.len() - 1] {
        assert_eq!(
            page.commits.len(),
            expected_size,
            "every page but the last is full"
        );
    }
    assert!(pages
        .last()
        .is_some_and(|page| page.commits.len() <= expected_size));
    let after = walk.next_page(&Cancel::never()).expect("page after done");
    assert!(
        after.commits.is_empty() && after.done,
        "a finished walk keeps answering empty done pages"
    );
    pages
}

fn walk_all(
    engine: &Git2Engine,
    scope: &WalkScope,
    page_size: usize,
    order: WalkOrder,
) -> Vec<CommitNode> {
    walk_pages(engine, scope, page_size, order)
        .into_iter()
        .flat_map(|page| page.commits)
        .collect()
}

fn hashes(nodes: &[CommitNode]) -> Vec<String> {
    nodes.iter().map(|node| node.hash.clone()).collect()
}

/// `git log <flags> --format=%H <scope>`.
fn git_log(f: &Fixture, flags: &[&str], scope: &str) -> Vec<String> {
    let mut args = vec!["log"];
    args.extend_from_slice(flags);
    args.push("--format=%H");
    args.push(scope);
    f.git(&args).lines().map(str::to_owned).collect()
}

/// The scopes under test with the matching `git log` argument.
fn scopes() -> Vec<(WalkScope, &'static str)> {
    vec![
        (WalkScope::All, "--all"),
        (
            WalkScope::Ref {
                name: "main".to_owned(),
            },
            "main",
        ),
        (
            WalkScope::Ref {
                name: "develop".to_owned(),
            },
            "develop",
        ),
        (
            WalkScope::Ref {
                name: "v1".to_owned(),
            },
            "v1",
        ),
        (
            WalkScope::Range {
                exclude: "v1".to_owned(),
                include: "main".to_owned(),
            },
            "v1..main",
        ),
    ]
}

fn fixtures() -> Vec<(&'static str, Fixture)> {
    vec![
        ("basic", Fixture::basic()),
        ("octopus", Fixture::basic().with_octopus()),
        (
            "remote and stash",
            Fixture::basic().with_remote().with_stash(),
        ),
    ]
}

/// One record of `git log --format=...`, for the field checks.
#[derive(Debug, PartialEq, Eq)]
struct GitCommit {
    parents: Vec<String>,
    subject: String,
    body: String,
    author: (String, String, i64),
    committer: (String, String, i64),
}

/// Every commit of `git log --all`, keyed by hash. `%b` keeps the message's trailing newline,
/// which the engine trims, so the body is trimmed here too.
fn git_commits(f: &Fixture) -> HashMap<String, GitCommit> {
    let format = "--format=%H%x00%P%x00%s%x00%b%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x01";
    let output = f.git(&["log", "--all", format]);
    let mut commits = HashMap::new();
    for record in output.split('\u{1}') {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\u{0}').collect();
        assert_eq!(fields.len(), 10, "unexpected record {record:?}");
        let time = |field: &str| field.parse::<i64>().expect("unix time");
        commits.insert(
            fields[0].to_owned(),
            GitCommit {
                parents: fields[1]
                    .split(' ')
                    .filter(|p| !p.is_empty())
                    .map(str::to_owned)
                    .collect(),
                subject: fields[2].to_owned(),
                body: fields[3].trim_end_matches('\n').to_owned(),
                author: (fields[4].to_owned(), fields[5].to_owned(), time(fields[6])),
                committer: (fields[7].to_owned(), fields[8].to_owned(), time(fields[9])),
            },
        );
    }
    commits
}

/// The decorations of `git log --all --format=%D`, mapped to the engine's short names and
/// sorted: `HEAD -> main` gives `HEAD` and `main`, `tag: v1` gives `v1`, `refs/stash` gives
/// `stash@{0}`.
fn git_decorations(f: &Fixture) -> HashMap<String, Vec<String>> {
    let output = f.git(&["log", "--all", "--format=%H%x00%D"]);
    let mut map = HashMap::new();
    for line in output.lines() {
        let (hash, decorations) = line.split_once('\u{0}').expect("hash and decorations");
        let mut names = Vec::new();
        for item in decorations.split(", ").filter(|item| !item.is_empty()) {
            if let Some(branch) = item.strip_prefix("HEAD -> ") {
                names.push("HEAD".to_owned());
                names.push(branch.to_owned());
            } else if let Some(tag) = item.strip_prefix("tag: ") {
                names.push(tag.to_owned());
            } else if item == "refs/stash" {
                names.push("stash@{0}".to_owned());
            } else {
                names.push(item.to_owned());
            }
        }
        names.sort();
        map.insert(hash.to_owned(), names);
    }
    map
}

/// `basic()` plus a commit on `develop` dated ten days before its parent, merged into `main`.
fn skewed() -> Fixture {
    let mut f = Fixture::basic();
    let now = f.now();
    f.git(&["checkout", "-q", "develop"]);
    f.set_clock(now - 10 * 24 * 3600);
    f.write("skew.txt", "committed with a clock ten days behind\n");
    f.commit("d3: clock skew");
    f.set_clock(now);
    f.git(&["checkout", "-q", "main"]);
    f.tick();
    f.git(&[
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "m2: merge skewed develop",
        "develop",
    ]);
    f
}

/// A repository with `count` commits in one line, written with libgit2 (no processes).
fn chain(count: usize) -> Fixture {
    let f = Fixture::empty();
    let repo = git2::Repository::open(&f.root).expect("open with git2");
    let tree_id = repo
        .treebuilder(None)
        .expect("tree builder")
        .write()
        .expect("empty tree");
    let tree = repo.find_tree(tree_id).expect("empty tree object");
    let mut parent: Option<git2::Oid> = None;
    for i in 0..count {
        let time = git2::Time::new(1_704_067_200 + 60 * i as i64, 0);
        let signature =
            git2::Signature::new("Chain", "chain@example.com", &time).expect("signature");
        let parent_commit = parent.map(|oid| repo.find_commit(oid).expect("parent commit"));
        let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
        let oid = repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                &format!("commit {i}"),
                &tree,
                &parents,
            )
            .expect("commit");
        parent = Some(oid);
    }
    f
}

#[test]
fn date_topo_order_equals_git_log_date_order_for_every_scope_and_page_size() {
    for (name, f) in fixtures() {
        let engine = open(&f);
        for (scope, arg) in scopes() {
            let expected = git_log(&f, &["--date-order"], arg);
            assert!(!expected.is_empty(), "{name} {arg}");
            assert_eq!(
                git_log(&f, &["--topo-order", "--date-order"], arg),
                expected,
                "{name} {arg}: --topo-order --date-order selects date order (the last flag wins)"
            );
            for page_size in PAGE_SIZES {
                let nodes = walk_all(&engine, &scope, page_size, WalkOrder::DateTopo);
                assert_eq!(
                    hashes(&nodes),
                    expected,
                    "{name} {arg} page size {page_size}"
                );
            }
        }
    }
}

#[test]
fn lazy_order_equals_plain_git_log_and_date_topo_when_dates_are_monotone() {
    for (name, f) in fixtures() {
        let engine = open(&f);
        for (scope, arg) in scopes() {
            let expected = git_log(&f, &[], arg);
            for page_size in PAGE_SIZES {
                let lazy = walk_all(&engine, &scope, page_size, WalkOrder::Lazy);
                assert_eq!(
                    hashes(&lazy),
                    expected,
                    "{name} {arg} page size {page_size}"
                );
                let topo = walk_all(&engine, &scope, page_size, WalkOrder::DateTopo);
                assert_eq!(
                    lazy, topo,
                    "{name} {arg} page size {page_size}: same nodes in both orders"
                );
            }
        }
    }
}

#[test]
fn commit_fields_and_refs_match_git_log() {
    for (name, f) in fixtures() {
        let engine = open(&f);
        let expected = git_commits(&f);
        let decorations = git_decorations(&f);
        let nodes = walk_all(&engine, &WalkScope::All, 500, WalkOrder::DateTopo);
        assert_eq!(nodes.len(), expected.len(), "{name}");
        for node in &nodes {
            let want = expected
                .get(&node.hash)
                .unwrap_or_else(|| panic!("{name}: {} unknown to git", node.hash));
            assert_eq!(node.parents, want.parents, "{name} {}", node.hash);
            assert_eq!(node.subject, want.subject, "{name} {}", node.hash);
            assert_eq!(node.body, want.body, "{name} {}", node.hash);
            let author = (
                node.author.name.clone(),
                node.author.email.clone(),
                node.author.time,
            );
            let committer = (
                node.committer.name.clone(),
                node.committer.email.clone(),
                node.committer.time,
            );
            assert_eq!(author, want.author, "{name} {}", node.hash);
            assert_eq!(committer, want.committer, "{name} {}", node.hash);
            assert_eq!(
                (node.author.offset_minutes, node.committer.offset_minutes),
                (0, 0)
            );
            let mut refs = node.refs.clone();
            refs.sort();
            let want_refs = decorations.get(&node.hash).cloned().unwrap_or_default();
            assert_eq!(refs, want_refs, "{name} {}", node.hash);
        }
        assert!(
            nodes
                .iter()
                .any(|node| node.body == "Second paragraph of the body."),
            "{name}"
        );
        assert!(
            nodes
                .iter()
                .any(|node| node.refs.contains(&"HEAD".to_owned())),
            "{name}"
        );
    }
}

#[test]
fn multi_line_subjects_are_folded_like_git() {
    let mut f = Fixture::basic();
    f.tick();
    f.git(&[
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "first line\nsecond line",
        "-m",
        "body one\n\nbody two",
    ]);
    let engine = open(&f);
    let head = walk_all(
        &engine,
        &WalkScope::Ref {
            name: "HEAD".to_owned(),
        },
        1,
        WalkOrder::Lazy,
    )
    .into_iter()
    .next()
    .expect("head commit");
    assert_eq!(head.subject, f.git(&["log", "-1", "--format=%s"]));
    assert_eq!(head.subject, "first line second line");
    assert_eq!(head.body, f.git(&["log", "-1", "--format=%b"]));
    assert_eq!(head.body, "body one\n\nbody two");
}

#[test]
fn skewed_dates_keep_date_topo_equal_to_git_and_lazy_complete() {
    let f = skewed();
    let engine = open(&f);
    for (scope, arg) in scopes() {
        let expected = git_log(&f, &["--date-order"], arg);
        let topo = walk_all(&engine, &scope, 3, WalkOrder::DateTopo);
        assert_eq!(hashes(&topo), expected, "{arg}");
        let lazy = walk_all(&engine, &scope, 3, WalkOrder::Lazy);
        let mut lazy_sorted = hashes(&lazy);
        lazy_sorted.sort();
        let mut expected_sorted = expected.clone();
        expected_sorted.sort();
        assert_eq!(
            lazy_sorted, expected_sorted,
            "{arg}: lazy order shows every commit exactly once"
        );
        assert_eq!(
            hashes(&lazy),
            git_log(&f, &[], arg),
            "{arg}: lazy order is the order of plain git log"
        );
    }
    // In lazy order the skewed commit comes after its parent: it still lists the parent but
    // draws no line to it.
    let d3 = f.rev("develop");
    let d2 = f.rev("develop~1");
    let lazy = walk_all(&engine, &WalkScope::All, 500, WalkOrder::Lazy);
    let row = |hash: &str| {
        lazy.iter()
            .position(|node| node.hash == hash)
            .expect("present")
    };
    assert!(
        row(&d3) > row(&d2),
        "lazy order shows the skewed commit after its parent"
    );
    let skewed = &lazy[row(&d3)];
    assert_eq!(skewed.parents, vec![d2.clone()]);
    assert!(skewed.edges.iter().all(|edge| edge.parent != d2));
    assert!(skewed.refs.contains(&"develop".to_owned()));
}

#[test]
fn lanes_and_edges_do_not_depend_on_the_page_size() {
    let f = Fixture::basic().with_octopus();
    let engine = open(&f);
    let small = walk_pages(&engine, &WalkScope::All, 2, WalkOrder::DateTopo);
    let big = walk_pages(&engine, &WalkScope::All, 500, WalkOrder::DateTopo);
    assert!(small.len() > 1 && big.len() == 1);
    let nodes: Vec<CommitNode> = small.iter().flat_map(|page| page.commits.clone()).collect();
    assert_eq!(
        nodes, big[0].commits,
        "pages of 2 and of 500 give the same lanes and edges"
    );

    // Every edge points at a later row, drawn on the edge's `to_lane`, across page boundaries too.
    let row: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, node)| (node.hash.as_str(), i))
        .collect();
    for (index, node) in nodes.iter().enumerate() {
        for edge in &node.edges {
            let target = row[edge.parent.as_str()];
            assert!(
                target > index,
                "{}: edge to {} points up",
                node.hash,
                edge.parent
            );
            assert_eq!(
                nodes[target].lane, edge.to_lane,
                "{}: edge to {}",
                node.hash, edge.parent
            );
        }
    }
    let boundary_rows = small
        .iter()
        .take(small.len() - 1)
        .map(|page| page.commits.last().expect("page"));
    let crossing: Vec<_> = boundary_rows.flat_map(|node| node.edges.clone()).collect();
    assert!(!crossing.is_empty(), "some edge crosses a page boundary");

    let octopus = nodes
        .iter()
        .find(|node| node.parents.len() == 4)
        .expect("octopus merge");
    assert_eq!(octopus.lane, 0);
    let to_lanes: Vec<u32> = octopus.edges.iter().map(|edge| edge.to_lane).collect();
    assert_eq!(to_lanes, vec![0, 1, 2, 3]);
    assert!(nodes.iter().all(|node| node.overflow == 0));
}

#[test]
fn page_size_is_clamped() {
    let f = Fixture::basic();
    let engine = open(&f);
    let single = walk_pages(&engine, &WalkScope::All, 0, WalkOrder::DateTopo);
    assert!(single.iter().all(|page| page.commits.len() <= 1));
    assert_eq!(
        single.iter().map(|page| page.commits.len()).sum::<usize>(),
        6
    );
    let huge = walk_pages(&engine, &WalkScope::All, 10_000, WalkOrder::DateTopo);
    assert_eq!(huge.len(), 1);
    assert_eq!(huge[0].commits.len(), 6);
}

#[test]
fn unborn_repository_yields_one_empty_done_page() {
    let f = Fixture::unborn();
    let engine = open(&f);
    let pages = walk_pages(&engine, &WalkScope::All, 500, WalkOrder::DateTopo);
    assert_eq!(pages.len(), 1);
    assert!(pages[0].commits.is_empty() && pages[0].done);
    let lazy = walk_pages(&engine, &WalkScope::All, 500, WalkOrder::Lazy);
    assert!(lazy.len() == 1 && lazy[0].commits.is_empty() && lazy[0].done);
}

#[test]
fn unknown_revisions_fail_with_refs_not_found() {
    let f = Fixture::basic();
    let engine = open(&f);
    let options = WalkOptions::default();
    for scope in [
        WalkScope::Ref {
            name: "nope".to_owned(),
        },
        WalkScope::Range {
            exclude: "nope".to_owned(),
            include: "main".to_owned(),
        },
        WalkScope::Range {
            exclude: "v1".to_owned(),
            include: "nope".to_owned(),
        },
        WalkScope::Ref {
            name: "v1^{tree}".to_owned(),
        },
    ] {
        let error = match engine.walk(&scope, &options, &Cancel::never()) {
            Err(error) => error,
            Ok(mut walk) => walk.next_page(&Cancel::never()).expect_err("must fail"),
        };
        assert_eq!(error.code(), "refs.not_found", "{scope:?}: {error}");
    }
}

#[test]
fn corrupt_object_in_lazy_order_returns_the_commits_read_so_far_then_the_error() {
    let f = Fixture::basic();
    let corrupt = f.truncate_object("HEAD~1");
    let head = f.head();
    let engine = open(&f);
    let options = WalkOptions {
        page_size: 500,
        order: WalkOrder::Lazy,
    };
    let mut walk = engine
        .walk(&WalkScope::All, &options, &Cancel::never())
        .expect("start walk");
    let page = walk
        .next_page(&Cancel::never())
        .expect("the first page carries the commits read so far");
    assert_eq!(hashes(&page.commits), vec![head]);
    assert!(page.done);
    match walk.next_page(&Cancel::never()) {
        Err(GitError::CorruptObject { hash, .. }) => assert_eq!(hash, corrupt),
        other => panic!("expected repo.corrupt_object, got {other:?}"),
    }
    let after = walk
        .next_page(&Cancel::never())
        .expect("empty done page after the error");
    assert!(after.commits.is_empty() && after.done);
}

#[test]
fn corrupt_object_in_date_topo_order_fails_the_first_page() {
    let f = Fixture::basic();
    let corrupt = f.truncate_object("HEAD~1");
    let engine = open(&f);
    let options = WalkOptions {
        page_size: 500,
        order: WalkOrder::DateTopo,
    };
    let mut walk = engine
        .walk(&WalkScope::All, &options, &Cancel::never())
        .expect("start walk");
    match walk.next_page(&Cancel::never()) {
        Err(error) => {
            assert_eq!(error.code(), "repo.corrupt_object");
            assert!(error.to_string().contains(&corrupt), "{error}");
        }
        Ok(page) => panic!("expected repo.corrupt_object, got {page:?}"),
    }
}

#[test]
fn cancellation_stops_within_100ms() {
    let f = chain(3_000);
    let engine = open(&f);
    let cancel = Cancel::new();
    let options = WalkOptions {
        page_size: 500,
        order: WalkOrder::Lazy,
    };
    let mut walk = engine
        .walk(&WalkScope::All, &options, &cancel)
        .expect("start walk");
    let (sender, receiver) = mpsc::channel();
    let trigger = cancel.clone();
    let canceller = thread::spawn(move || {
        thread::sleep(Duration::from_millis(5));
        trigger.cancel();
        sender.send(Instant::now()).expect("report the cancel time");
    });
    let outcome = loop {
        match walk.next_page(&cancel) {
            Ok(page) if page.done => break Ok(()),
            Ok(_) => {}
            Err(error) => break Err(error),
        }
    };
    let returned = Instant::now();
    canceller.join().expect("canceller thread");
    let cancelled_at = receiver.recv().expect("cancel time");
    assert!(
        matches!(outcome, Err(GitError::Cancelled)),
        "expected op.cancelled, got {outcome:?}"
    );
    let latency = returned.saturating_duration_since(cancelled_at);
    assert!(
        latency < Duration::from_millis(100),
        "cancellation took {latency:?}"
    );
    let after = walk
        .next_page(&cancel)
        .expect("a cancelled walk answers an empty done page");
    assert!(after.commits.is_empty() && after.done);
}

#[test]
fn first_page_of_a_long_history_reads_only_what_it_shows() {
    let f = chain(3_000);
    let engine = open(&f);
    let mut timings = Vec::new();
    for order in [WalkOrder::Lazy, WalkOrder::DateTopo] {
        let options = WalkOptions {
            page_size: 500,
            order,
        };
        let started = Instant::now();
        let mut walk = engine
            .walk(&WalkScope::All, &options, &Cancel::never())
            .expect("start walk");
        let page = walk.next_page(&Cancel::never()).expect("first page");
        let elapsed = started.elapsed();
        assert_eq!(page.commits.len(), 500);
        assert!(!page.done);
        timings.push((order, elapsed));
    }
    eprintln!("first page of 3,000 linear commits (start + page): {timings:?}");
    assert!(
        timings[0].1 < Duration::from_secs(2),
        "lazy first page took {:?}",
        timings[0].1
    );
}
