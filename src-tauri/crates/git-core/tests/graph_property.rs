//! Property test for the lane layout: on random DAGs built with libgit2, the order,
//! lanes, edges and overflow of every commit are the same whatever the page size, in both walk
//! orders, and the date-topo order equals `git log --date-order`.

mod support;

use std::collections::HashMap;

use git2::{Commit, Oid, Repository, Signature, Time};
use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::graph::MAX_LANES;
use git_core::types::{CommitNode, WalkOptions, WalkOrder, WalkScope};
use support::Fixture;

/// 2024-01-01T00:00:00Z.
const BASE_TIME: i64 = 1_704_067_200;
const COMMITS: usize = 80;

/// Deterministic xorshift64 generator, so a failure names its seed.
struct XorShift(u64);

impl XorShift {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next_u64() % bound as u64).expect("fits")
    }
}

/// A random DAG of [`COMMITS`] commits with one to three parents each and a few extra roots,
/// written with libgit2 into a fixture repository. With `ties`, three consecutive commits share
/// a commit time so the tie-breaking of the queue is exercised too. Every childless commit gets
/// a branch; the last commit is `main`.
fn build_dag(seed: u64, ties: bool) -> Fixture {
    let f = Fixture::empty();
    let repo = Repository::open(&f.root).expect("open with git2");
    let tree_id = repo
        .treebuilder(None)
        .expect("tree builder")
        .write()
        .expect("empty tree");
    let tree = repo.find_tree(tree_id).expect("empty tree object");
    let mut rng = XorShift::new(seed);
    let mut commits: Vec<Oid> = Vec::with_capacity(COMMITS);
    let mut has_child = [false; COMMITS];
    for i in 0..COMMITS {
        let minute = if ties { i / 3 } else { i };
        let time = Time::new(BASE_TIME + 60 * minute as i64, 120);
        let signature = Signature::new("Prop", "prop@example.com", &time).expect("signature");
        let mut parents: Vec<usize> = Vec::new();
        if i > 0 && rng.below(25) != 0 {
            parents.push(i - 1 - rng.below(i.min(6)));
            let extra = match rng.below(10) {
                0..=5 => 0,
                6..=8 => 1,
                _ => 2,
            };
            for _ in 0..extra {
                let parent = rng.below(i);
                if !parents.contains(&parent) {
                    parents.push(parent);
                }
            }
        }
        let parent_commits: Vec<Commit> = parents
            .iter()
            .map(|&parent| repo.find_commit(commits[parent]).expect("parent commit"))
            .collect();
        let parent_refs: Vec<&Commit> = parent_commits.iter().collect();
        let message = format!("commit {i}\n\nbody of commit {i}\n");
        let oid = repo
            .commit(None, &signature, &signature, &message, &tree, &parent_refs)
            .expect("commit");
        for &parent in &parents {
            has_child[parent] = true;
        }
        commits.push(oid);
    }
    for (i, oid) in commits.iter().enumerate() {
        if has_child[i] {
            continue;
        }
        let name = if i + 1 == COMMITS {
            "refs/heads/main".to_owned()
        } else {
            format!("refs/heads/tip-{i}")
        };
        repo.reference(&name, *oid, true, "dag tip")
            .expect("create ref");
    }
    f
}

fn walk_all(engine: &Git2Engine, page_size: usize, order: WalkOrder) -> Vec<CommitNode> {
    let options = WalkOptions {
        page_size: u32::try_from(page_size).expect("page size"),
        order,
        filter: None,
    };
    let mut walk = engine
        .walk(&WalkScope::All, &options, &Cancel::never())
        .expect("start walk");
    let mut nodes = Vec::new();
    loop {
        let page = walk.next_page(&Cancel::never()).expect("next page");
        nodes.extend(page.commits);
        if page.done {
            break;
        }
    }
    nodes
}

fn hashes(nodes: &[CommitNode]) -> Vec<String> {
    nodes.iter().map(|node| node.hash.clone()).collect()
}

fn git_log(f: &Fixture, flags: &[&str]) -> Vec<String> {
    let mut args = vec!["log", "--all", "--format=%H"];
    args.extend_from_slice(flags);
    f.git(&args).lines().map(str::to_owned).collect()
}

/// Every edge leads to a later row drawn on the edge's `to_lane`, and every parent still ahead
/// has an edge unless the overflow hides it.
fn check_edges(nodes: &[CommitNode], context: &str) {
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
                "{context}: {} has an edge up to {}",
                node.hash,
                edge.parent
            );
            assert_eq!(
                nodes[target].lane, edge.to_lane,
                "{context}: {} edge to {}",
                node.hash, edge.parent
            );
            assert!(
                edge.from_lane < MAX_LANES && edge.to_lane < MAX_LANES,
                "{context}: {}",
                node.hash
            );
        }
        for parent in &node.parents {
            let target = row[parent.as_str()];
            let drawn = node.edges.iter().any(|edge| &edge.parent == parent);
            let hidden = node.lane >= MAX_LANES || nodes[target].lane >= MAX_LANES;
            assert!(
                drawn || hidden || target < index,
                "{context}: {} lacks the edge to {parent}",
                node.hash
            );
        }
    }
}

#[test]
fn every_page_size_gives_the_same_order_lanes_and_edges() {
    for (seed, ties) in [(42, false), (7, false), (2024, true)] {
        let context = format!("seed {seed} ties {ties}");
        let f = build_dag(seed, ties);
        let engine = Git2Engine::open(&f.root).expect("open");
        let date_order = git_log(&f, &["--date-order"]);
        let plain = git_log(&f, &[]);
        assert_eq!(date_order.len(), COMMITS, "{context}");
        for order in [WalkOrder::DateTopo, WalkOrder::Lazy] {
            let context = format!("{context} {order:?}");
            let small = walk_all(&engine, 5, order);
            let big = walk_all(&engine, 500, order);
            assert_eq!(small, big, "{context}: pages of 5 and of 500 differ");
            assert_eq!(big.len(), COMMITS, "{context}");
            match order {
                WalkOrder::DateTopo => assert_eq!(hashes(&big), date_order, "{context}"),
                WalkOrder::Lazy => assert_eq!(hashes(&big), plain, "{context}"),
            }
            check_edges(&big, &context);
            assert!(
                big.iter().all(|node| node.author.offset_minutes == 120
                    && node.committer.offset_minutes == 120),
                "{context}: time zone offsets survive"
            );
            assert!(
                big.iter().any(|node| node.parents.len() > 1),
                "{context}: the DAG has merges"
            );
            assert!(
                big.iter().any(|node| node.lane > 0),
                "{context}: the DAG uses several lanes"
            );
        }
    }
}
