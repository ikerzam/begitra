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
const to = (fromLane: number, toLane: number): Edge => ({ fromLane, toLane, parent: "p" });

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
  it("places dots on lane centres and pass-through edges as straight segments", () => {
    const commits = [node(0, [through(0), through(1)]), node(1, [to(1, 0)]), node(0, [])];
    const geometry = graphGeometry({ commits, start: 0, end: 3, scrollTop: 0 });
    expect(geometry.dots.map((d) => [d.x, d.y, d.lane])).toEqual([
      [12, 14, 0],
      [28, 42, 1],
      [12, 70, 0],
    ]);
    expect(geometry.segments).toEqual([
      { fromX: 12, fromY: 14, toX: 12, toY: 42, lane: 0, curved: false },
      { fromX: 28, fromY: 14, toX: 28, toY: 42, lane: 1, curved: false },
      { fromX: 28, fromY: 42, toX: 12, toY: 70, lane: 1, curved: true },
    ]);
    expect(geometry.overflows).toEqual([]);
  });

  it("subtracts the scroll position and includes the row above the range for its edges", () => {
    const commits = [node(0, [through(0)]), node(0, [through(0)]), node(0, [])];
    const geometry = graphGeometry({ commits, start: 1, end: 3, scrollTop: 28 });
    expect(geometry.dots.map((d) => d.index)).toEqual([1, 2]);
    expect(geometry.dots.map((d) => d.y)).toEqual([14, 42]);
    // Row 0 is above the range: its segment reaches into row 1, so it is drawn (from y = -14).
    expect(geometry.segments.map((s) => [s.fromY, s.toY])).toEqual([
      [-14, 14],
      [14, 42],
    ]);
  });

  it("counts the lanes beyond the drawn columns in the overflow marker", () => {
    const commits = [node(7, [through(7)], 2), node(2, [to(2, 6), through(2)])];
    const geometry = graphGeometry({ commits, start: 0, end: 2, scrollTop: 0 });
    // Lane 7 is not drawn: no dot, no segment, its own lane plus its edge plus the engine's 2.
    expect(geometry.dots.map((d) => d.index)).toEqual([1]);
    expect(geometry.segments).toHaveLength(1);
    expect(geometry.overflows).toEqual([
      { index: 0, y: 14, count: 4 },
      { index: 1, y: 42, count: 1 },
    ]);
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
    const rail = { laneWidth: 8, offset: 8, drawn: 5 };
    expect(laneX(3, rail)).toBe(32);
    expect(laneX(3)).toBe(12 + 3 * PANEL_LAYOUT.laneWidth);
    const geometry = graphGeometry({
      commits: [node(4, [through(4)]), node(5, [])],
      start: 0,
      end: 2,
      scrollTop: 0,
      layout: rail,
      rowHeight: ROW_HEIGHT,
    });
    expect(geometry.dots).toEqual([{ x: 40, y: 14, lane: 4, index: 0 }]);
    expect(geometry.overflows).toEqual([{ index: 1, y: 42, count: 1 }]);
  });
});
