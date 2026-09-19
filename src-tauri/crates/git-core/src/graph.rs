//! Incremental lane layout for the commit graph.
//!
//! The "active lanes" algorithm: a vector of lanes, each
//! holding the hash of the commit it expects next, updated one row at a time in walk order,
//! children before parents. The state belongs to the walk handle, so a page boundary is just
//! another row and the edges drawn across it connect.
//!
//! For each commit:
//! 1. its lane is the lane expecting it, or the leftmost free lane when no line leads to it;
//! 2. every parent gets one edge from that lane: to the lane already expecting the parent when
//!    a line to it exists (the commit's line joins it on the next row, the `|/` of
//!    `git log --graph`), otherwise to a lane opened for it, which is the commit's own lane for
//!    the first parent that needs one and the leftmost free lane for the others;
//! 3. every other lane that stays active passes straight through (`from_lane == to_lane`).
//!
//! A lane is opened for a parent only when no lane expects it yet, so at most one lane expects
//! any commit and an edge's `to_lane` is the lane the parent is drawn on when its row comes,
//! whatever page that is. (The design's wording has the first parent always inherit the
//! commit's lane; with a second lane expecting the same parent, `to_lane` could not name the
//! parent's lane, so a first parent that already has a line joins it instead.)
//!
//! Lanes at or beyond [`MAX_LANES`] are not drawn as columns: edges touching them are dropped
//! and the row reports how many such lanes stay active in `overflow`.

use crate::types::Edge;

/// Number of lanes drawn as columns. Lanes at or beyond this index are folded into the
/// `overflow` count of each row instead of adding columns.
pub const MAX_LANES: u32 = 12;

/// Where a commit landed: its lane, the edges leaving its row and the overflow count.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Placement {
    /// Lane holding the commit's dot.
    pub lane: u32,
    /// Edges leaving the row: one per drawable parent, in parent order, then one per lane
    /// passing through, in lane order. Edges touching lanes at or beyond [`MAX_LANES`] are
    /// left out.
    pub edges: Vec<Edge>,
    /// Active lanes at or beyond [`MAX_LANES`] once the row is placed.
    pub overflow: u32,
}

/// Lane state carried from one row to the next.
#[derive(Clone, Debug, Default)]
pub struct LaneLayout {
    /// Hash each lane expects next; `None` is a free lane. Trailing free lanes are trimmed.
    lanes: Vec<Option<String>>,
    /// Which lanes were active before the current row; reused between rows.
    was_active: Vec<bool>,
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

    /// Places `hash` on the next row and returns its lane, edges and overflow.
    ///
    /// `parents` are the parents that will appear on later rows, first parent first. Parents
    /// outside the walk (excluded by the scope) or already shown (possible in lazy order with
    /// skewed dates) must be left out: no line can lead to them.
    pub fn place(&mut self, hash: &str, parents: &[&str]) -> Placement {
        let lane = match self.expecting(hash) {
            Some(lane) => lane,
            None => self.allocate(),
        };
        self.was_active.clear();
        self.was_active
            .extend(self.lanes.iter().map(Option::is_some));
        for slot in &mut self.lanes {
            if slot.as_deref() == Some(hash) {
                *slot = None;
            }
        }

        let drawn = MAX_LANES as usize;
        let mut edges = Vec::with_capacity(parents.len() + self.lanes.len().min(drawn));
        let mut own_lane_taken = false;
        for parent in parents {
            let to_lane = match self.expecting(parent) {
                Some(existing) => existing,
                None => {
                    let opened = if own_lane_taken {
                        self.allocate()
                    } else {
                        own_lane_taken = true;
                        lane
                    };
                    self.expect(opened, parent);
                    opened
                }
            };
            // Edges touching undrawn lanes are counted in the overflow, never built.
            if lane < drawn && to_lane < drawn {
                edges.push(Edge {
                    from_lane: index(lane),
                    to_lane: index(to_lane),
                    parent: (*parent).to_owned(),
                });
            }
        }
        for (i, slot) in self.lanes.iter().enumerate().take(drawn) {
            if i == lane || self.was_active.get(i).copied() != Some(true) {
                continue;
            }
            if let Some(expected) = slot {
                edges.push(Edge {
                    from_lane: index(i),
                    to_lane: index(i),
                    parent: expected.clone(),
                });
            }
        }

        while self.lanes.last().is_some_and(|slot| slot.is_none()) {
            self.lanes.pop();
        }
        let overflow = self
            .lanes
            .iter()
            .skip(drawn)
            .filter(|slot| slot.is_some())
            .count();
        Placement {
            lane: index(lane),
            edges,
            overflow: index(overflow),
        }
    }

    /// The lane expecting `hash`, if a line leads to it.
    fn expecting(&self, hash: &str) -> Option<usize> {
        self.lanes
            .iter()
            .position(|slot| slot.as_deref() == Some(hash))
    }

    /// Leftmost free lane, opening a new one when every lane is busy.
    fn allocate(&mut self) -> usize {
        match self.lanes.iter().position(Option::is_none) {
            Some(free) => free,
            None => {
                self.lanes.push(None);
                self.lanes.len() - 1
            }
        }
    }

    fn expect(&mut self, lane: usize, hash: &str) {
        if let Some(slot) = self.lanes.get_mut(lane) {
            *slot = Some(hash.to_owned());
        }
    }
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
        assert_eq!(
            layout.place("c3", &["c2"]),
            placement(0, vec![edge(0, 0, "c2")])
        );
        assert_eq!(
            layout.place("c2", &["c1"]),
            placement(0, vec![edge(0, 0, "c1")])
        );
        assert_eq!(layout.place("c1", &[]), placement(0, vec![]));
        assert_eq!(layout.active_lanes(), 0);
    }

    #[test]
    fn a_branch_and_its_merge_use_two_lanes_and_free_the_second() {
        // m1 merges d2 into c3; c3 and d1 both descend from c2.
        let mut layout = LaneLayout::new();
        assert_eq!(
            layout.place("m1", &["c3", "d2"]),
            placement(0, vec![edge(0, 0, "c3"), edge(0, 1, "d2")])
        );
        assert_eq!(
            layout.place("c3", &["c2"]),
            placement(0, vec![edge(0, 0, "c2"), edge(1, 1, "d2")])
        );
        assert_eq!(
            layout.place("d2", &["d1"]),
            placement(1, vec![edge(1, 1, "d1"), edge(0, 0, "c2")])
        );
        // d1's parent already has a line on lane 0: d1's line joins it and lane 1 is freed.
        assert_eq!(
            layout.place("d1", &["c2"]),
            placement(1, vec![edge(1, 0, "c2"), edge(0, 0, "c2")])
        );
        assert_eq!(layout.active_lanes(), 1);
        assert_eq!(
            layout.place("c2", &["c1"]),
            placement(0, vec![edge(0, 0, "c1")])
        );
    }

    #[test]
    fn an_octopus_merge_opens_three_lanes() {
        let mut layout = LaneLayout::new();
        assert_eq!(
            layout.place("o", &["m", "a", "b", "c"]),
            placement(
                0,
                vec![
                    edge(0, 0, "m"),
                    edge(0, 1, "a"),
                    edge(0, 2, "b"),
                    edge(0, 3, "c")
                ]
            )
        );
        assert_eq!(layout.active_lanes(), 4);
        assert_eq!(
            layout.place("c", &["m"]),
            placement(
                3,
                vec![
                    edge(3, 0, "m"),
                    edge(0, 0, "m"),
                    edge(1, 1, "a"),
                    edge(2, 2, "b")
                ]
            )
        );
        assert_eq!(
            layout.place("b", &["m"]),
            placement(2, vec![edge(2, 0, "m"), edge(0, 0, "m"), edge(1, 1, "a")])
        );
        assert_eq!(
            layout.place("a", &["m"]),
            placement(1, vec![edge(1, 0, "m"), edge(0, 0, "m")])
        );
        assert_eq!(layout.place("m", &[]), placement(0, vec![]));
        assert_eq!(layout.active_lanes(), 0);
    }

    #[test]
    fn a_branch_end_frees_its_lane_for_reuse() {
        let mut layout = LaneLayout::new();
        layout.place("a", &["b", "x"]);
        // x is a root: its lane ends here and only b's line passes through.
        assert_eq!(layout.place("x", &[]), placement(1, vec![edge(0, 0, "b")]));
        assert_eq!(layout.active_lanes(), 1);
        // b's second parent reuses the freed lane 1.
        assert_eq!(
            layout.place("b", &["c", "d"]),
            placement(0, vec![edge(0, 0, "c"), edge(0, 1, "d")])
        );
    }

    #[test]
    fn a_commit_no_line_leads_to_takes_the_leftmost_free_lane() {
        let mut layout = LaneLayout::new();
        layout.place("a", &["b", "x", "c"]);
        layout.place("x", &[]);
        assert_eq!(
            layout.place("t", &["u"]),
            placement(1, vec![edge(1, 1, "u"), edge(0, 0, "b"), edge(2, 2, "c")])
        );
    }

    #[test]
    fn a_first_parent_with_a_line_joins_it_and_the_second_parent_keeps_the_lane() {
        let mut layout = LaneLayout::new();
        layout.place("a", &["b", "x"]);
        assert_eq!(
            layout.place("x", &["b", "y"]),
            placement(1, vec![edge(1, 0, "b"), edge(1, 1, "y"), edge(0, 0, "b")])
        );
        assert_eq!(layout.active_lanes(), 2);
    }

    #[test]
    fn lanes_beyond_the_drawn_columns_are_counted_as_overflow() {
        let mut layout = LaneLayout::new();
        let names: Vec<String> = (0..14).map(|i| format!("p{i}")).collect();
        let parents: Vec<&str> = names.iter().map(String::as_str).collect();
        let wide = layout.place("w", &parents);
        assert_eq!(wide.lane, 0);
        assert_eq!(wide.overflow, 2);
        assert_eq!(wide.edges.len(), 12);
        assert!(wide.edges.iter().all(|edge| edge.to_lane < MAX_LANES));
        assert_eq!(layout.active_lanes(), 14);
        // p13 sits beyond the columns: no edge leaves it; the twelve drawn lanes pass through.
        let far = layout.place("p13", &["q"]);
        assert_eq!(far.lane, 13);
        assert_eq!(far.overflow, 2);
        assert_eq!(far.edges.len(), 12);
        assert!(far
            .edges
            .iter()
            .all(|edge| edge.from_lane == edge.to_lane && edge.from_lane < MAX_LANES));
    }
}
