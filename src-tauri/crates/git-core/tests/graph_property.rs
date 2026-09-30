//! Property test for the lane layout: on random DAGs built with libgit2, the order,
//! lanes, edges and overflow of every commit are the same whatever the page size, in both walk
//! orders, the date-topo order equals `git log --date-order`, and every row's edges lead into it
//! from the row above as the layout promises: lines meet only in the dot they lead to.

mod support;

use std::collections::{HashMap, HashSet};

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
/// a commit time so the tie-breaking of the queue is exercised too. A merge's other parents
/// are among the twelve commits before it, as in most histories, or, with `far`, anywhere
/// before it, whose lines run past the drawn lanes. Every childless commit gets a branch; the
/// last commit is `main`.
fn build_dag(seed: u64, ties: bool, far: bool) -> Fixture {
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
                let parent = if far {
                    rng.below(i)
                } else {
                    i - 1 - rng.below(i.min(12))
                };
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

/// Every row's edges lead into it from the row above. The lines that lead to the row's commit
/// end in its dot; the others go on, straight but for a parent line leaving the commit right
/// above, one line per lane. Each line that goes on arrives on the next row from where it left
/// this one, every parent still ahead gets a line from its commit's lane, and every line into
/// the next row comes from one of these; the first parent's line goes on from the commit's own
/// lane, and a commit sits on the leftmost lane of the lines that meet in it. Rows next to lanes
/// past the drawn columns are not checked for continuity, their edges being dropped; the number
/// of row pairs checked is returned.
fn check_edges(nodes: &[CommitNode], context: &str) -> usize {
    let row: HashMap<&str, usize> = nodes
        .iter()
        .enumerate()
        .map(|(i, node)| (node.hash.as_str(), i))
        .collect();
    let wide = |i: usize| {
        nodes
            .get(i)
            .is_some_and(|node| node.overflow > 0 || node.lane >= MAX_LANES)
    };
    let mut checked = 0;
    for (index, node) in nodes.iter().enumerate() {
        if index == 0 {
            assert!(
                node.edges.is_empty(),
                "{context}: a line above the first row"
            );
        }
        let above = index.checked_sub(1).map(|i| &nodes[i]);
        let mut going_on = HashSet::new();
        for edge in &node.edges {
            assert!(
                edge.from_lane < MAX_LANES && edge.to_lane < MAX_LANES,
                "{context}: {}",
                node.hash
            );
            assert!(
                row[edge.parent.as_str()] >= index,
                "{context}: a line into {} leads up to {}",
                node.hash,
                edge.parent
            );
            if edge.parent == node.hash {
                assert_eq!(
                    edge.to_lane, node.lane,
                    "{context}: a line to {} ends beside its dot",
                    node.hash
                );
                // A line that ran on its own lane into the row (not one the commit above just
                // opened) arrives from that lane, never left of the commit's.
                let opened_above = above.is_some_and(|commit| edge.from_lane == commit.lane);
                assert!(
                    opened_above || edge.from_lane >= node.lane,
                    "{context}: {} is not on the leftmost lane of its lines",
                    node.hash
                );
                continue;
            }
            let split = above.is_some_and(|commit| {
                edge.from_lane == commit.lane && commit.parents.contains(&edge.parent)
            });
            assert!(
                edge.from_lane == edge.to_lane || split,
                "{context}: the line to {} bends on {}'s row",
                edge.parent,
                node.hash
            );
            assert!(
                going_on.insert(edge.to_lane),
                "{context}: two lines on lane {} at {}",
                edge.to_lane,
                node.hash
            );
            assert_ne!(
                edge.to_lane, node.lane,
                "{context}: the line to {} crosses {}'s dot",
                edge.parent, node.hash
            );
        }
        let Some(next) = nodes.get(index + 1) else {
            continue;
        };
        if wide(index) || wide(index + 1) {
            continue;
        }
        checked += 1;
        if let Some(first) = node.parents.first() {
            if row
                .get(first.as_str())
                .is_some_and(|&target| target > index + 1)
            {
                assert!(
                    next.edges.iter().any(|later| later.from_lane == node.lane
                        && later.to_lane == node.lane
                        && &later.parent == first),
                    "{context}: {}'s first parent line leaves its lane",
                    node.hash
                );
            }
        }
        for edge in node.edges.iter().filter(|edge| edge.parent != node.hash) {
            assert!(
                next.edges
                    .iter()
                    .any(|later| later.from_lane == edge.to_lane && later.parent == edge.parent),
                "{context}: the line to {} stops on lane {} after {}",
                edge.parent,
                edge.to_lane,
                node.hash
            );
        }
        for parent in &node.parents {
            if row
                .get(parent.as_str())
                .is_some_and(|&target| target > index)
            {
                assert!(
                    next.edges
                        .iter()
                        .any(|later| later.from_lane == node.lane && &later.parent == parent),
                    "{context}: {} lacks the line to {parent}",
                    node.hash
                );
            }
        }
        for later in &next.edges {
            let went_on = node.edges.iter().any(|edge| {
                edge.parent != node.hash
                    && edge.to_lane == later.from_lane
                    && edge.parent == later.parent
            });
            let leaves = later.from_lane == node.lane && node.parents.contains(&later.parent);
            assert!(
                went_on || leaves,
                "{context}: a line into {} comes from nowhere",
                next.hash
            );
        }
    }
    checked
}

#[test]
fn every_page_size_gives_the_same_order_lanes_and_edges() {
    for (seed, ties, far) in [
        (42, false, false),
        (7, false, false),
        (2024, true, false),
        (99, false, true),
    ] {
        let context = format!("seed {seed} ties {ties} far {far}");
        let f = build_dag(seed, ties, far);
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
            let checked = check_edges(&big, &context);
            // Most rows stay within the drawn lanes, so the continuity checks run on them.
            assert!(
                far || checked * 2 >= big.len(),
                "{context}: only {checked} of {} rows checked",
                big.len()
            );
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
