import { describe, expect, it } from "vitest";

import { rowAt, rowTops, visibleRowRange } from "./useVariableRows";

describe("variable rows", () => {
  const heights = [28, 20, 20, 40, 20, 28, 20];
  const tops = rowTops(heights);

  it("sums the heights into row tops", () => {
    expect(tops).toEqual([0, 28, 48, 68, 108, 128, 156, 176]);
    expect(rowTops([])).toEqual([0]);
  });

  it("finds the row at a position", () => {
    expect(rowAt(tops, 0)).toBe(0);
    expect(rowAt(tops, 27)).toBe(0);
    expect(rowAt(tops, 28)).toBe(1);
    expect(rowAt(tops, 100)).toBe(3);
    expect(rowAt(tops, 175)).toBe(6);
    expect(rowAt(tops, 10_000)).toBe(6);
    expect(rowAt([0], 5)).toBe(0);
  });

  it("covers the viewport plus the overscan, clamped", () => {
    expect(visibleRowRange(tops, 0, 50, 0)).toEqual({ start: 0, end: 3 });
    expect(visibleRowRange(tops, 30, 50, 1)).toEqual({ start: 0, end: 5 });
    expect(visibleRowRange(tops, 150, 100, 2)).toEqual({ start: 3, end: 7 });
    expect(visibleRowRange([0], 0, 100, 5)).toEqual({ start: 0, end: 0 });
  });
});
