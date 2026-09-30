// The geometry of the lane area: where each visible row's dot sits, the segments its edges
// draw into it from the row above, and the lanes that did not fit. A pure function of the
// commits and the viewport, shared by the canvas, the review-focus rail and the performance
// spec.

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
  /**
   * Lane whose colour the segment takes: the one its line runs on, which is the lane it arrives
   * from when it ends in the row's dot and the lane it goes on in otherwise.
   */
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

/**
 * A lane as a bit of a row's undrawn lanes. The engine sends lanes below twelve only; a dot's
 * lane past 31 has no bit and goes uncounted.
 */
function bit(lane: number): number {
  return lane < 32 ? 1 << lane : 0;
}

function bitCount(mask: number): number {
  let count = 0;
  for (let rest = mask >>> 0; rest !== 0; rest &= rest - 1) count += 1;
  return count;
}

/** Centre x of a lane. */
export function laneX(lane: number, layout: LaneLayout = PANEL_LAYOUT): number {
  return layout.offset + lane * layout.laneWidth;
}

/**
 * Dots, segments and overflow markers for the rows `start..end`. Each row's edges lead into it
 * from the row above, so the row after `end` is included for its segments, which leave the
 * last rendered row.
 */
export function graphGeometry(input: GeometryInput): GraphGeometry {
  const rowHeight = input.rowHeight ?? ROW_HEIGHT;
  const layout = input.layout ?? PANEL_LAYOUT;
  const { commits, scrollTop } = input;
  const dots: Dot[] = [];
  const segments: Segment[] = [];
  const overflows: Overflow[] = [];
  const first = Math.min(input.start, commits.length);
  const last = Math.min(input.end + 1, commits.length);
  for (let i = first; i < last; i += 1) {
    const commit = commits[i];
    if (!commit) continue;
    const y = i * rowHeight - scrollTop + rowHeight / 2;
    const rendered = i < input.end;
    if (rendered && commit.lane < layout.drawn) {
      dots.push({ x: laneX(commit.lane, layout), y, lane: commit.lane, index: i });
    }
    // The undrawn lanes of the row, each counted once: the dot's own and those its lines touch.
    let undrawn = commit.lane >= layout.drawn ? bit(commit.lane) : 0;
    if (input.flat) {
      if (i > 0) {
        const x = laneX(0, layout);
        segments.push({ fromX: x, fromY: y - rowHeight, toX: x, toY: y, lane: 0, curved: false });
      }
    } else {
      for (const edge of commit.edges) {
        if (edge.fromLane >= layout.drawn || edge.toLane >= layout.drawn) {
          if (edge.fromLane >= layout.drawn) undrawn |= bit(edge.fromLane);
          if (edge.toLane >= layout.drawn) undrawn |= bit(edge.toLane);
          continue;
        }
        segments.push({
          fromX: laneX(edge.fromLane, layout),
          fromY: y - rowHeight,
          toX: laneX(edge.toLane, layout),
          toY: y,
          lane: edge.parent === commit.hash ? edge.fromLane : edge.toLane,
          curved: edge.fromLane !== edge.toLane,
        });
      }
    }
    const count = commit.overflow + bitCount(undrawn);
    if (count > 0 && rendered) overflows.push({ index: i, y, count });
  }
  return { dots, segments, overflows };
}
