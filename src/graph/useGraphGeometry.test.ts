import { describe, expect, it } from "vitest";

import type { CommitNode, Edge } from "@/ipc/schemas";

import { graphGeometry, laneX, PANEL_LAYOUT, ROW_HEIGHT } from "./useGraphGeometry";
import { visibleRange } from "./useVirtualRows";

function node(lane: number, edges: Edge[], overflow = 0): CommitNode {
  const who = { name: "a", email: "a@x", time: 0, offsetMinutes: 0 };
  return {
    hash: "h",
    parents: [],
    author: who,
    committer: who,
    subject: "s",
    body: "",
    refs: [],
    lane,
    edges,
    overflow,
  };
}

const through = (lane: number): Edge => ({ fromLane: lane, toLane: lane, parent: "p" });
/** A line into the row: to the row's own commit (`h`, ending in its dot) unless `parent` says. */
const to = (fromLane: number, toLane: number, parent = "h"): Edge => ({
  fromLane,
  toLane,
  parent,
});

describe("visibleRange", () => {
  it("covers the viewport plus the overscan, clamped to the list", () => {
    expect(visibleRange(0, 280, 28, 1_000, 5)).toEqual({ start: 0, end: 15 });
    expect(visibleRange(280, 280, 28, 1_000, 5)).toEqual({ start: 5, end: 25 });
    expect(visibleRange(27_720, 280, 28, 1_000, 5)).toEqual({ start: 985, end: 1_000 });
    expect(visibleRange(10, 280, 28, 1_000, 0)).toEqual({ start: 0, end: 11 });
  });

  it("is empty for an empty list and never negative", () => {
    expect(visibleRange(0, 280, 28, 0, 5)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(-50, 280, 28, 10, 0)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(100_000, 280, 28, 10, 2)).toEqual({ start: 10, end: 10 });
  });
});

describe("graphGeometry", () => {
  it("places dots on lane centres and draws each row's edges from the row above", () => {
    // a and b fork from p: b's line keeps lane 1 and bends into p's dot on p's row.
    const commits = [node(0, []), node(1, [through(0)]), node(0, [through(0), to(1, 0)])];
    const geometry = graphGeometry({ commits, start: 0, end: 3, scrollTop: 0 });
    expect(geometry.dots.map((d) => [d.x, d.y, d.lane])).toEqual([
      [12, 14, 0],
      [28, 42, 1],
      [12, 70, 0],
    ]);
    expect(geometry.segments).toEqual([
      { fromX: 12, fromY: 14, toX: 12, toY: 42, lane: 0, curved: false },
      { fromX: 12, fromY: 42, toX: 12, toY: 70, lane: 0, curved: false },
      { fromX: 28, fromY: 42, toX: 12, toY: 70, lane: 1, curved: true },
    ]);
    expect(geometry.overflows).toEqual([]);
  });

  it("subtracts the scroll position and includes the row after the range for its edges", () => {
    const commits = [node(0, []), node(0, [through(0)]), node(0, [through(0)])];
    const geometry = graphGeometry({ commits, start: 1, end: 2, scrollTop: 28 });
    expect(geometry.dots.map((d) => d.index)).toEqual([1]);
    expect(geometry.dots.map((d) => d.y)).toEqual([14]);
    // Row 1 draws its line from row 0 above the viewport; row 2, after the range, draws the
    // line that leaves row 1.
    expect(geometry.segments.map((s) => [s.fromY, s.toY])).toEqual([
      [-14, 14],
      [14, 42],
    ]);
  });

  it("counts the lanes beyond the drawn columns in the overflow marker, each once", () => {
    const commits = [node(0, []), node(7, [to(7, 7), through(6)], 2), node(2, [to(6, 2)])];
    const geometry = graphGeometry({ commits, start: 0, end: 3, scrollTop: 0 });
    // Row 1: the dot and its line share lane 7, lane 6 passes, and the engine hid 2 more.
    expect(geometry.dots.map((d) => d.index)).toEqual([0, 2]);
    expect(geometry.segments).toHaveLength(0);
    expect(geometry.overflows).toEqual([
      { index: 1, y: 42, count: 4 },
      { index: 2, y: 70, count: 1 },
    ]);
  });

  it("colours a line by the lane it runs on: where it arrives from, or where it goes on", () => {
    // Row 1 draws a merge's line out to lane 2 and a line on lane 3 ending in the dot on lane 0.
    const commits = [node(1, []), node(0, [to(1, 1, "p"), to(1, 2, "q"), to(3, 0)])];
    const geometry = graphGeometry({ commits, start: 0, end: 2, scrollTop: 0 });
    expect(geometry.segments.map((s) => s.lane)).toEqual([1, 2, 3]);
  });

  it("joins consecutive rows with one straight line in the flat layout", () => {
    const commits = [node(0, []), node(0, []), node(0, [])];
    const geometry = graphGeometry({ commits, start: 0, end: 3, scrollTop: 0, flat: true });
    expect(geometry.segments).toEqual([
      { fromX: 12, fromY: 14, toX: 12, toY: 42, lane: 0, curved: false },
      { fromX: 12, fromY: 42, toX: 12, toY: 70, lane: 0, curved: false },
    ]);
  });

  it("scales to another layout, such as the 48px rail", () => {
    // Three 12px lanes from x = 10: the review-focus rail's layout.
    const rail = { laneWidth: 12, offset: 10, drawn: 3 };
    expect(laneX(2, rail)).toBe(34);
    expect(laneX(3)).toBe(12 + 3 * PANEL_LAYOUT.laneWidth);
    const geometry = graphGeometry({
      commits: [node(1, []), node(3, [through(1)])],
      start: 0,
      end: 2,
      scrollTop: 0,
      layout: rail,
      rowHeight: ROW_HEIGHT,
    });
    expect(geometry.dots).toEqual([{ x: 22, y: 14, lane: 1, index: 0 }]);
    expect(geometry.segments.map((s) => [s.fromX, s.fromY, s.toX, s.toY])).toEqual([
      [22, 14, 22, 42],
    ]);
    expect(geometry.overflows).toEqual([{ index: 1, y: 42, count: 1 }]);
  });
});
