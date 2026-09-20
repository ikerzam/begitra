// The graph's budgets on 100,000 rows: the visible range and the lane geometry of a 40-row
// viewport at 1,000 scroll positions must each stay under 4 ms per position on the benchmark
// machine, and appending pages must not touch the rows already listed. Painting is not
// measured here (jsdom has no canvas): the first paint is checked by hand in the app. The
// numbers are printed so a run can be recorded.

import { describe, expect, it } from "vitest";

import type { CommitNode, Edge } from "@/ipc/schemas";
import { graphGeometry, ROW_HEIGHT } from "@/graph/useGraphGeometry";
import { visibleRange } from "@/graph/useVirtualRows";

const ROWS = 100_000;
const VIEWPORT_ROWS = 40;
const POSITIONS = 1_000;
const OVERSCAN = 10;
/** Milliseconds per scroll position, for the range and the geometry together. */
const BUDGET_MS = 4;

/** A history with eight lanes: every row keeps six lanes alive and merges every ninth row. */
function synthetic(count: number): CommitNode[] {
  const who = { name: "agent", email: "agent@x", time: 1_700_000_000, offsetMinutes: 0 };
  const commits: CommitNode[] = new Array<CommitNode>(count);
  for (let i = 0; i < count; i += 1) {
    const lane = i % 8;
    const edges: Edge[] = [];
    for (let l = 0; l < 6; l += 1) edges.push({ fromLane: l, toLane: l, parent: "p" });
    if (i % 9 === 0) edges.push({ fromLane: lane, toLane: (lane + 3) % 8, parent: "m" });
    commits[i] = {
      hash: i.toString(16).padStart(40, "0"),
      parents: ["p"],
      author: who,
      committer: who,
      subject: `commit ${i}`,
      body: "",
      refs: [],
      lane,
      edges,
      overflow: i % 50 === 0 ? 2 : 0,
    };
  }
  return commits;
}

describe("graph performance", () => {
  const commits = synthetic(ROWS);
  const viewport = VIEWPORT_ROWS * ROW_HEIGHT;
  const maxScroll = ROWS * ROW_HEIGHT - viewport;

  it(`ranges and geometry of ${POSITIONS} scroll positions stay under ${BUDGET_MS} ms each`, () => {
    let dots = 0;
    let segments = 0;
    let worst = 0;
    const started = performance.now();
    for (let p = 0; p < POSITIONS; p += 1) {
      const scrollTop = Math.floor((maxScroll * p) / (POSITIONS - 1));
      const before = performance.now();
      const range = visibleRange(scrollTop, viewport, ROW_HEIGHT, ROWS, OVERSCAN);
      const geometry = graphGeometry({ commits, start: range.start, end: range.end, scrollTop });
      const took = performance.now() - before;
      worst = Math.max(worst, took);
      dots += geometry.dots.length;
      segments += geometry.segments.length;
    }
    const total = performance.now() - started;
    const perPosition = total / POSITIONS;
    console.log(
      `graph.perf: ${POSITIONS} positions over ${ROWS} rows: ${perPosition.toFixed(3)} ms per position (worst ${worst.toFixed(3)} ms), ${dots} dots, ${segments} segments`,
    );
    expect(dots).toBeGreaterThan(POSITIONS * VIEWPORT_ROWS);
    expect(perPosition).toBeLessThan(BUDGET_MS);
  });

  it("renders under 100 rows at any position", () => {
    for (let p = 0; p < POSITIONS; p += 1) {
      const scrollTop = Math.floor((maxScroll * p) / (POSITIONS - 1));
      const range = visibleRange(scrollTop, viewport, ROW_HEIGHT, ROWS, OVERSCAN);
      expect(range.end - range.start).toBeLessThan(100);
      expect(range.end - range.start).toBeGreaterThanOrEqual(VIEWPORT_ROWS);
    }
  });

  it("appends pages of 500 without touching the rows already listed", () => {
    const pages = 200;
    let listed: CommitNode[] = [];
    const first = commits.slice(0, 500);
    const started = performance.now();
    for (let page = 0; page < pages; page += 1) {
      listed = listed.concat(commits.slice(page * 500, (page + 1) * 500));
    }
    const took = performance.now() - started;
    console.log(`graph.perf: ${pages} pages appended in ${took.toFixed(1)} ms`);
    expect(listed).toHaveLength(ROWS);
    expect(listed[0]).toBe(first[0]);
    expect(took).toBeLessThan(500);
  });
});
