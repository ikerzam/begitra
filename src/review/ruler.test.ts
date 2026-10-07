import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";

import { rowsOf } from "./diffRows";
import {
  ADDED,
  CURRENT,
  MATCH,
  REMOVED,
  rowFlags,
  rulerTicks,
  scrollForDrag,
  scrollForRulerPoint,
  sliderBox,
  type RulerTick,
} from "./ruler";
import { rowTops } from "./useVariableRows";

function line(n: number, kind: DiffLine["kind"] = "context"): DiffLine {
  return {
    kind,
    oldNumber: kind === "added" ? null : n,
    newNumber: kind === "removed" ? null : n,
    text: `line ${n}`,
    spans: [],
    noNewline: false,
  };
}

function hunk(lines: DiffLine[]): Hunk {
  return { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, header: "@@ -1,3 +1,3 @@", lines };
}

const HUNK = hunk([line(1), line(2, "removed"), line(2, "added"), line(3, "added"), line(4)]);

function ofKind(ticks: RulerTick[], kind: RulerTick["kind"]): [number, number][] {
  return ticks.filter((tick) => tick.kind === kind).map((tick) => [tick.top, tick.height]);
}

describe("rowFlags", () => {
  it("flags removed and added lines in unified rows, and nothing else", () => {
    const rows = rowsOf([HUNK], "unified");
    expect([...rowFlags(rows, [])]).toEqual([0, 0, REMOVED, ADDED, ADDED, 0]);
  });

  it("flags both sides of a side-by-side pair", () => {
    const rows = rowsOf([HUNK], "side-by-side");
    // The header, the context pair, removed with added, a lone added line, the context pair.
    expect([...rowFlags(rows, [])]).toEqual([0, 0, REMOVED | ADDED, ADDED, 0]);
  });

  it("leaves folded and shown unchanged lines out", () => {
    const late = hunk([line(5), line(6, "removed"), line(6, "added"), line(7)]);
    const file = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const rows = rowsOf([late], "unified", {
      lines: file,
      revealed: [{ start: 1, end: 2 }],
      whole: false,
    });
    expect(rows.map((row) => row.kind)).toEqual([
      "context",
      "context",
      "gap",
      "hunk",
      "line",
      "line",
      "line",
      "line",
      "gap",
    ]);
    expect([...rowFlags(rows, [])]).toEqual([0, 0, 0, 0, 0, REMOVED, ADDED, 0, 0]);
  });

  it("flags the lines holding a match of the find, and the current one", () => {
    const unified = rowsOf([HUNK], "unified");
    const flags = rowFlags(unified, [
      { hunk: 0, line: 0, current: false },
      { hunk: 0, line: 1, current: true },
    ]);
    expect([...flags]).toEqual([0, MATCH, REMOVED | MATCH | CURRENT, ADDED, ADDED, 0]);

    const pairs = rowsOf([HUNK], "side-by-side");
    // Line 3 of the hunk is the second added line, alone on the right of the fourth row.
    expect(rowFlags(pairs, [{ hunk: 0, line: 3, current: false }])[3]).toBe(ADDED | MATCH);
    expect(rowFlags(pairs, [{ hunk: 0, line: 2, current: false }])[2]).toBe(
      REMOVED | ADDED | MATCH,
    );
  });
});

describe("rulerTicks", () => {
  it("draws rows taller than the ruler at the ruler's scale, at least 2px", () => {
    // 100 rows of 20px over a 200px ruler: a tenth of a pixel per pixel of rows.
    const flags = new Uint8Array(100);
    flags[50] = REMOVED;
    flags[99] = ADDED;
    const ticks = rulerTicks(flags, rowTops(new Array<number>(100).fill(20)), 200);
    expect(ofKind(ticks, "removed")).toEqual([[100, 2]]);
    // The last row's tick stays inside the ruler.
    expect(ofKind(ticks, "added")).toEqual([[198, 2]]);
  });

  it("puts the ticks of rows that fit beside their own lines", () => {
    const flags = new Uint8Array([0, REMOVED, ADDED, ADDED, 0]);
    const ticks = rulerTicks(flags, rowTops([28, 20, 20, 20, 20]), 400);
    expect(ofKind(ticks, "removed")).toEqual([[28, 20]]);
    expect(ofKind(ticks, "added")).toEqual([[48, 40]]);
  });

  it("joins the ticks of a kind that touch, and keeps apart those that do not", () => {
    const flags = new Uint8Array(1000);
    // Rows 100 to 104 are one change; rows 500 and 520 are two.
    for (let i = 100; i < 105; i += 1) flags[i] = ADDED;
    flags[500] = ADDED;
    flags[520] = ADDED;
    const ticks = rulerTicks(flags, rowTops(new Array<number>(1000).fill(20)), 500);
    // 20,000px of rows on 500px: 0.5px a row.
    expect(ofKind(ticks, "added")).toEqual([
      [50, 3],
      [250, 2],
      [260, 2],
    ]);
  });

  it("draws the current match at least 4px and keeps the kinds in drawing order", () => {
    const flags = new Uint8Array(1000);
    flags[10] = REMOVED | MATCH;
    flags[600] = ADDED | MATCH | CURRENT;
    const ticks = rulerTicks(flags, rowTops(new Array<number>(1000).fill(20)), 500);
    expect(ticks.map((tick) => tick.kind)).toEqual([
      "removed",
      "added",
      "match",
      "match",
      "current",
    ]);
    expect(ofKind(ticks, "current")).toEqual([[300, 4]]);
  });

  it("places ticks by the rows' tops when their heights vary", () => {
    const flags = new Uint8Array([REMOVED, 0, ADDED]);
    // A wrapped line of 60px between two of 20px, on a ruler as tall as the rows.
    const ticks = rulerTicks(flags, rowTops([20, 60, 20]), 100);
    expect(ofKind(ticks, "removed")).toEqual([[0, 20]]);
    expect(ofKind(ticks, "added")).toEqual([[80, 20]]);
  });

  it("draws at most one tick of a kind for every three pixels, whatever the rows", () => {
    // 0.3px a row and a change every seventh: ticks 2.1px apart, which join or keep 1px.
    const count = 1000;
    const flags = new Uint8Array(count);
    for (let i = 0; i < count; i += 7) flags[i] = REMOVED | ADDED | MATCH;
    const height = 300;
    const ticks = rulerTicks(flags, rowTops(new Array<number>(count).fill(20)), height);
    for (const kind of ["removed", "added", "match"] as const) {
      const list = ticks.filter((tick) => tick.kind === kind);
      expect(list.length).toBeGreaterThan(1);
      expect(list.length).toBeLessThanOrEqual(Math.floor((height + 1) / 3));
      for (const [index, tick] of list.entries()) {
        expect(tick.height).toBeGreaterThanOrEqual(2);
        expect(tick.top + tick.height).toBeLessThanOrEqual(height);
        const next = list[index + 1];
        if (next) expect(next.top).toBeGreaterThan(tick.top + tick.height);
      }
    }
  });

  it("draws nothing without rows or height", () => {
    expect(rulerTicks(new Uint8Array(0), [0], 300)).toEqual([]);
    expect(rulerTicks(new Uint8Array([ADDED]), [0, 20], 0)).toEqual([]);
  });
});

describe("the slider", () => {
  it("shows the viewport's share of the rows, at least 32px, only while they scroll", () => {
    expect(sliderBox(0, 400, 400)).toBeNull();
    expect(sliderBox(0, 800, 400)).toEqual({ top: 0, height: 200 });
    // 40,000px of rows: the share is 4px, so the slider keeps 32px and travels 368px.
    expect(sliderBox(0, 40_000, 400)).toEqual({ top: 0, height: 32 });
    expect(sliderBox(39_600, 40_000, 400)).toEqual({ top: 368, height: 32 });
    expect(sliderBox(19_800, 40_000, 400)?.top).toBeCloseTo(184);
  });

  it("brings a clicked place of the ruler to the middle of the view, within the rows", () => {
    // 4,000px of rows on a 400px ruler: ten pixels of rows per pixel of the ruler.
    expect(scrollForRulerPoint(200, 4000, 400)).toBe(1800);
    expect(scrollForRulerPoint(5, 4000, 400)).toBe(0);
    expect(scrollForRulerPoint(399, 4000, 400)).toBe(3600);
    // Rows that fit do not scroll.
    expect(scrollForRulerPoint(100, 300, 400)).toBe(0);
  });

  it("scrolls the rows by the slider's travel", () => {
    // The slider is 40px of a 400px ruler over 4,000px of rows: 360px of travel for 3,600px.
    expect(scrollForDrag(0, 36, 4000, 400, 40)).toBe(360);
    expect(scrollForDrag(1000, -500, 4000, 400, 40)).toBe(0);
    expect(scrollForDrag(1000, 500, 4000, 400, 40)).toBe(3600);
  });
});
