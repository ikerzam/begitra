//! Incremental lane layout for the commit graph.
//!
//! The "active lanes" algorithm: a vector of lanes, each carrying the line of the
//! commit it leads to, updated one row at a time in walk order, children before parents. The
//! state belongs to the walk handle, so a page boundary is just another row and the edges drawn
//! across it connect.
//!
//! Each row carries the edges that lead into it from the lanes of the row above, so a line ends
//! in its commit's dot on that commit's own row with no look-ahead. For each commit:
//! 1. the lanes whose lines lead to it meet in its dot, on the leftmost of them; when no line
//!    leads to it, it takes a free lane (below);
//! 2. every active lane draws one edge into the row: from the lane its line left on the row
//!    above, to the commit's lane when the line leads to the commit, else straight on;
//! 3. the meeting lanes are freed; the first parent's line goes on from the commit's lane, and
//!    every other parent's opens a lane of its own (below), even when another line already leads
//!    to that parent: lines meet only in the dot of the commit they lead to, so a branch reads as
//!    one line down to its parent.
//!
//! A free lane is the leftmost one, preferring a lane that no line left just now: a new tip
//! skips the lanes left on the row above, which would seem to lead from that row's dot to it, and
//! a merge's other lines skip the lanes the lines meeting in it left, which would seem to pass
//! through its dot. When every free lane inside the graph is such a lane, the leftmost of them is
//! taken rather than a new one past the graph, whose lines would fall behind the drawn columns.
//!
//! Lanes at or beyond [`MAX_LANES`] are not drawn as columns: edges touching them are dropped
//! and the row counts them in `overflow`.

use crate::types::Edge;

/// Number of lanes drawn as columns. Lanes at or beyond this index are not drawn: the edges
/// touching them are counted in the `overflow` of their row instead.
pub const MAX_LANES: u32 = 12;

/// Where a commit landed: its lane, the edges leading into its row and the overflow count.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Placement {
    /// Lane holding the commit's dot.
    pub lane: u32,
    /// Edges leading into the row from the row above: one per line active there, in lane
    /// order. Edges touching lanes at or beyond [`MAX_LANES`] are left out.
    pub edges: Vec<Edge>,
    /// Lines into the row left out of `edges` because they touch lanes at or beyond
    /// [`MAX_LANES`].
    pub overflow: u32,
}

/// The line a lane carries: the commit it leads to and the lane it left on the row above.
#[derive(Clone, Debug)]
struct Line {
    leads_to: String,
    from: usize,
}

/// Lane state carried from one row to the next.
#[derive(Clone, Debug, Default)]
pub struct LaneLayout {
    /// The line each lane carries; `None` is a free lane. Trailing free lanes are trimmed.
    lanes: Vec<Option<Line>>,
    /// Lanes the lines of the last row placed left: while that row is placed, its merge's other
    /// lines prefer other lanes; on the next row, a new tip does.
    freed: Vec<usize>,
}

impl LaneLayout {
    /// An empty layout: the next commit lands on lane 0.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of lanes carrying a line into the next row.
    #[cfg(test)]
    pub(crate) fn active_lanes(&self) -> usize {
        self.lanes.iter().filter(|lane| lane.is_some()).count()
    }

    /// Places `hash` on the next row and returns its lane, the edges leading into its row and
    /// the overflow.
    ///
    /// `parents` are the parents that will appear on later rows, first parent first, each once.
    /// Parents outside the walk (excluded by the scope) or already shown (possible in lazy order
    /// with skewed dates) must be left out: no line can lead to them.
    pub fn place(&mut self, hash: &str, parents: &[&str]) -> Placement {
        let drawn = MAX_LANES as usize;
        let lane = self
            .lanes
            .iter()
            .position(|slot| leads_to(slot, hash))
            .unwrap_or_else(|| free_lane(&self.lanes, &self.freed));

        let mut edges = Vec::with_capacity(self.lanes.len().min(drawn));
        let mut hidden = 0;
        for (i, slot) in self.lanes.iter().enumerate() {
            let Some(line) = slot else {
                continue;
            };
            let to_lane = if line.leads_to == hash { lane } else { i };
            if line.from < drawn && to_lane < drawn {
                edges.push(Edge {
                    from_lane: index(line.from),
                    to_lane: index(to_lane),
                    parent: line.leads_to.clone(),
                });
            } else {
                hidden += 1;
            }
        }

        self.freed.clear();
        for (i, slot) in self.lanes.iter_mut().enumerate() {
            if let Some(line) = slot.as_ref().filter(|line| line.leads_to == hash) {
                // A line opened on the row above never ran on its lane: nothing seems to lead
                // from there.
                if i != lane && line.from == i {
                    self.freed.push(i);
                }
                *slot = None;
            } else if let Some(line) = slot {
                line.from = i;
            }
        }
        match parents.split_first() {
            Some((first, others)) => {
                self.carry(lane, first, lane);
                for parent in others {
                    let opened = free_lane(&self.lanes, &self.freed);
                    self.carry(opened, parent, lane);
                }
            }
            // A root's line ends in its dot: a tip right under it would seem to go on from it.
            None => self.freed.push(lane),
        }

        while self.lanes.last().is_some_and(Option::is_none) {
            self.lanes.pop();
        }
        Placement {
            lane: index(lane),
            edges,
            overflow: hidden,
        }
    }

    /// Puts on `lane` a line to `parent` that the next row draws from `from`.
    fn carry(&mut self, lane: usize, parent: &str, from: usize) {
        if self.lanes.len() <= lane {
            self.lanes.resize_with(lane + 1, || None);
        }
        if let Some(slot) = self.lanes.get_mut(lane) {
            *slot = Some(Line {
                leads_to: parent.to_owned(),
                from,
            });
        }
    }
}

/// Whether the lane's line leads to `hash`.
fn leads_to(slot: &Option<Line>, hash: &str) -> bool {
    slot.as_ref().is_some_and(|line| line.leads_to == hash)
}

/// The leftmost free lane not in `left` (the lanes lines just left); when the only free lanes
/// inside the graph are in `left`, the leftmost of those rather than a new lane past the graph.
fn free_lane(lanes: &[Option<Line>], left: &[usize]) -> usize {
    let free = |lane: usize| lanes.get(lane).is_none_or(Option::is_none);
    let mut lane = 0;
    while !free(lane) || left.contains(&lane) {
        lane += 1;
    }
    if lane < lanes.len() {
        return lane;
    }
    left.iter()
        .copied()
        .filter(|&candidate| free(candidate))
        .min()
        .unwrap_or(lane)
}

fn index(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(from: u32, to: u32, parent: &str) -> Edge {
        Edge {
            from_lane: from,
            to_lane: to,
            parent: parent.to_owned(),
        }
    }

    fn placement(lane: u32, edges: Vec<Edge>) -> Placement {
        Placement {
            lane,
            edges,
            overflow: 0,
        }
    }

    #[test]
    fn linear_history_stays_on_lane_zero() {
        let mut layout = LaneLayout::new();
        assert_eq!(layout.place("c3", &["c2"]), placement(0, vec![]));
        assert_eq!(
            layout.place("c2", &["c1"]),
            placement(0, vec![edge(0, 0, "c2")])
        );
        assert_eq!(
            layout.place("c1", &[]),
            placement(0, vec![edge(0, 0, "c1")])
        );
        assert_eq!(layout.active_lanes(), 0);
    }

    #[test]
    fn a_fork_keeps_its_lanes_down_to_the_common_parent_and_meets_in_its_dot() {
        // a and b fork from p; t, a branch of its own, starts between them and p.
        let mut layout = LaneLayout::new();
        assert_eq!(layout.place("a", &["p"]), placement(0, vec![]));
        assert_eq!(
            layout.place("b", &["p"]),
            placement(1, vec![edge(0, 0, "p")])
        );
        assert_eq!(
            layout.place("t", &["u"]),
            placement(2, vec![edge(0, 0, "p"), edge(1, 1, "p")])
        );
        assert_eq!(
            layout.place("u", &[]),
            placement(2, vec![edge(0, 0, "p"), edge(1, 1, "p"), edge(2, 2, "u")])
        );
        // Both lines bend into p's dot on p's row.
        assert_eq!(
            layout.place("p", &[]),
            placement(0, vec![edge(0, 0, "p"), edge(1, 0, "p")])
        );
        assert_eq!(layout.active_lanes(), 0);
    }

    #[test]
    fn a_tip_prefers_a_free_lane_that_no_line_left_on_the_row_above() {
        let mut layout = LaneLayout::new();
        layout.place("a", &["b", "x", "y", "z"]);
        // y and x are roots on lanes 2 and 1: lane 2 is free, and lane 1 was left just now.
        layout.place("y", &[]);
        layout.place("x", &[]);
        assert_eq!(
            layout.place("t", &["u"]),
            placement(2, vec![edge(0, 0, "b"), edge(3, 3, "z")])
        );
    }

    #[test]
    fn a_tip_below_a_meeting_takes_the_lane_it_left_rather_than_widening_the_graph() {
        let mut layout = LaneLayout::new();
        layout.place("a", &["p"]);
        layout.place("b", &["p"]);
        assert_eq!(
            layout.place("p", &["q"]),
            placement(0, vec![edge(0, 0, "p"), edge(1, 0, "p")])
        );
        assert_eq!(
            layout.place("n", &["m"]),
            placement(1, vec![edge(0, 0, "q")])
        );
        assert_eq!(
            layout.place("o", &["m"]),
            placement(2, vec![edge(0, 0, "q"), edge(1, 1, "m")])
        );
    }

    #[test]
    fn a_merge_opens_its_own_line_to_a_parent_another_line_already_leads_to() {
        // x leads to d first; m merges d into c and draws its own line to d, meeting x's there.
        let mut layout = LaneLayout::new();
        assert_eq!(layout.place("x", &["d"]), placement(0, vec![]));
        assert_eq!(
            layout.place("m", &["c", "d"]),
            placement(1, vec![edge(0, 0, "d")])
        );
        assert_eq!(
            layout.place("c", &[]),
            placement(1, vec![edge(0, 0, "d"), edge(1, 1, "c"), edge(1, 2, "d")])
        );
        assert_eq!(
            layout.place("d", &[]),
            placement(0, vec![edge(0, 0, "d"), edge(2, 0, "d")])
        );
        assert_eq!(layout.active_lanes(), 0);
    }

    #[test]
    fn a_merge_whose_parent_is_the_next_line_down_meets_it_there() {
        // m merges d into c, whose parent is d too: two lines lead to d and meet on its row.
        let mut layout = LaneLayout::new();
        assert_eq!(layout.place("m", &["c", "d"]), placement(0, vec![]));
        // The row after the merge draws its split: straight on to c, a curve out to d's lane.
        assert_eq!(
            layout.place("c", &["d"]),
            placement(0, vec![edge(0, 0, "c"), edge(0, 1, "d")])
        );
        assert_eq!(
            layout.place("d", &[]),
            placement(0, vec![edge(0, 0, "d"), edge(1, 0, "d")])
        );
    }

    #[test]
    fn an_octopus_opens_a_lane_per_parent_and_they_meet_where_they_lead() {
        let mut layout = LaneLayout::new();
        assert_eq!(layout.place("o", &["m", "a", "b"]), placement(0, vec![]));
        assert_eq!(layout.active_lanes(), 3);
        assert_eq!(
            layout.place("b", &["m"]),
            placement(2, vec![edge(0, 0, "m"), edge(0, 1, "a"), edge(0, 2, "b")])
        );
        assert_eq!(
            layout.place("a", &["m"]),
            placement(1, vec![edge(0, 0, "m"), edge(1, 1, "a"), edge(2, 2, "m")])
        );
        assert_eq!(
            layout.place("m", &[]),
            placement(0, vec![edge(0, 0, "m"), edge(1, 0, "m"), edge(2, 0, "m")])
        );
        assert_eq!(layout.active_lanes(), 0);
    }

    #[test]
    fn a_root_ends_its_lane_and_a_merge_below_may_take_it() {
        let mut layout = LaneLayout::new();
        layout.place("a", &["b", "x"]);
        // x is a root: its line ends in its dot.
        assert_eq!(
            layout.place("x", &[]),
            placement(1, vec![edge(0, 0, "b"), edge(0, 1, "x")])
        );
        assert_eq!(layout.active_lanes(), 1);
        // b's second parent takes the free lane 1: no line met on b's row.
        assert_eq!(
            layout.place("b", &["c", "d"]),
            placement(0, vec![edge(0, 0, "b")])
        );
        assert_eq!(
            layout.place("d", &[]),
            placement(1, vec![edge(0, 0, "c"), edge(0, 1, "d")])
        );
    }

    #[test]
    fn a_merge_splits_onto_a_lane_no_meeting_line_left_when_the_graph_has_one() {
        let mut layout = LaneLayout::new();
        layout.place("a", &["x"]);
        layout.place("b", &["x"]);
        layout.place("c", &["w"]);
        layout.place("d", &["v"]);
        // w ends its line on lane 2, and e, a root, takes that lane on the next row: the only
        // free lane inside the graph, rather than a fifth one.
        layout.place("w", &[]);
        assert_eq!(
            layout.place("e", &[]),
            placement(2, vec![edge(0, 0, "x"), edge(1, 1, "x"), edge(3, 3, "v")])
        );
        // The lines of a and b meet in x, a merge: its line to pr goes out on lane 2, not on
        // lane 1, which b's line left.
        layout.place("x", &["m", "pr"]);
        assert_eq!(
            layout.place("m", &[]),
            placement(0, vec![edge(0, 0, "m"), edge(0, 2, "pr"), edge(3, 3, "v")])
        );
    }

    #[test]
    fn a_merge_takes_a_lane_a_meeting_line_left_rather_than_widening_the_graph() {
        let mut layout = LaneLayout::new();
        layout.place("a", &["m"]);
        layout.place("b", &["m"]);
        assert_eq!(
            layout.place("m", &["p", "q"]),
            placement(0, vec![edge(0, 0, "m"), edge(1, 0, "m")])
        );
        assert_eq!(
            layout.place("q", &[]),
            placement(1, vec![edge(0, 0, "p"), edge(0, 1, "q")])
        );
    }

    #[test]
    fn lanes_beyond_the_drawn_columns_are_counted_as_overflow() {
        let mut layout = LaneLayout::new();
        let names: Vec<String> = (0..14).map(|i| format!("p{i}")).collect();
        let parents: Vec<&str> = names.iter().map(String::as_str).collect();
        let wide = layout.place("w", &parents);
        assert_eq!(wide.lane, 0);
        assert_eq!(wide.overflow, 0);
        assert!(wide.edges.is_empty());
        assert_eq!(layout.active_lanes(), 14);
        // The row after draws the twelve splits it can and counts the two it cannot; p13 sits
        // beyond the columns.
        let far = layout.place("p13", &["q"]);
        assert_eq!(far.lane, 13);
        assert_eq!(far.overflow, 2);
        assert_eq!(far.edges.len(), 12);
        assert!(far
            .edges
            .iter()
            .all(|edge| edge.from_lane == 0 && edge.to_lane < MAX_LANES));
        // The next row: twelve drawn lines, lanes 12 and 13 counted.
        let next = layout.place("p0", &[]);
        assert_eq!(next.overflow, 2);
    }
}
