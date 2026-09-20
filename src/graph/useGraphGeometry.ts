// The geometry of the lane area: where each visible row's dot sits, the segments its edges
// draw down to the next row, and the lanes that did not fit. A pure function of the commits
// and the viewport, shared by the canvas, the review-focus rail and the performance spec.

import type { CommitNode } from "@/ipc/schemas";

/** Row height of the graph's rows (`GraphRow`) and of the rail. */
export const ROW_HEIGHT = 28;
/** Width of the lane area of the graph panel: 108px, 16px per lane. */
export const LANE_AREA_WIDTH = 108;
export const LANE_WIDTH = 16;
/** Lanes drawn as columns in the panel; the rest count in the overflow marker. */
export const DRAWN_LANES = 6;
/** Commit dots are 8px. */
export const DOT_RADIUS = 4;
/** Edges are 2px. */
export const EDGE_WIDTH = 2;

export interface LaneLayout {
  /** Horizontal distance between lane centres. */
  laneWidth: number;
  /** Centre of lane 0 from the left edge. */
  offset: number;
  /** Lanes drawn as columns. */
  drawn: number;
}

/** The panel's layout: lane 0 centred at 12px, six 16px lanes inside the 108px area. */
export const PANEL_LAYOUT: LaneLayout = { laneWidth: LANE_WIDTH, offset: 12, drawn: DRAWN_LANES };

export interface Dot {
  x: number;
  y: number;
  /** Engine lane (from zero); the colour token is `laneColour(lane)`. */
  lane: number;
  index: number;
}

export interface Segment {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** Lane whose colour the segment takes. */
  lane: number;
  /** Whether the segment changes lane and is drawn as a curve. */
  curved: boolean;
}

export interface Overflow {
  index: number;
  y: number;
  count: number;
}

export interface GraphGeometry {
  dots: Dot[];
  segments: Segment[];
  overflows: Overflow[];
}

export interface GeometryInput {
  commits: readonly CommitNode[];
  /** First row rendered. */
  start: number;
  /** One past the last row rendered. */
  end: number;
  /** Scroll position of the viewport; row `i` starts at `i * rowHeight - scrollTop`. */
  scrollTop: number;
  rowHeight?: number;
  layout?: LaneLayout;
  /**
   * A filtered walk: every row is in lane 0 with no edges, so consecutive rows are joined
   * with a straight segment instead, so the walk reads as one line.
   */
  flat?: boolean;
}

/** Centre x of a lane. */
export function laneX(lane: number, layout: LaneLayout = PANEL_LAYOUT): number {
  return layout.offset + lane * layout.laneWidth;
}

/**
 * Dots, segments and overflow markers for the rows `start..end`. The row before `start` is
 * included for its segments, which reach into the first rendered row.
 */
export function graphGeometry(input: GeometryInput): GraphGeometry {
  const rowHeight = input.rowHeight ?? ROW_HEIGHT;
  const layout = input.layout ?? PANEL_LAYOUT;
  const { commits, scrollTop } = input;
  const dots: Dot[] = [];
  const segments: Segment[] = [];
  const overflows: Overflow[] = [];
  const first = Math.max(0, Math.min(input.start, commits.length) - 1);
  const last = Math.min(input.end, commits.length);
  for (let i = first; i < last; i += 1) {
    const commit = commits[i];
    if (!commit) continue;
    const y = i * rowHeight - scrollTop + rowHeight / 2;
    if (i >= input.start && commit.lane < layout.drawn) {
      dots.push({ x: laneX(commit.lane, layout), y, lane: commit.lane, index: i });
    }
    let dropped = commit.lane >= layout.drawn ? 1 : 0;
    if (input.flat) {
      if (i + 1 < commits.length) {
        const x = laneX(0, layout);
        segments.push({ fromX: x, fromY: y, toX: x, toY: y + rowHeight, lane: 0, curved: false });
      }
    } else {
      for (const edge of commit.edges) {
        if (edge.fromLane >= layout.drawn || edge.toLane >= layout.drawn) {
          dropped += 1;
          continue;
        }
        segments.push({
          fromX: laneX(edge.fromLane, layout),
          fromY: y,
          toX: laneX(edge.toLane, layout),
          toY: y + rowHeight,
          lane: Math.max(edge.fromLane, edge.toLane),
          curved: edge.fromLane !== edge.toLane,
        });
      }
    }
    const count = commit.overflow + dropped;
    if (count > 0 && i >= input.start) overflows.push({ index: i, y, count });
  }
  return { dots, segments, overflows };
}
