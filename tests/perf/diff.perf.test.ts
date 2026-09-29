// The diff viewer's budgets on a 10,000-line file with 2,000 changed lines: the row models
// of both layouts must build in under 50 ms each, the wrapped heights and their prefix sums
// in under 50 ms, and the visible range of a 40-row viewport at 1,000 scroll positions in
// under 4 ms per position; the same file shown whole (its new side split, checked against
// the hunks, its rows and heights built) under 50 ms a step. Rendering is not measured here
// (jsdom paints nothing); the first
// screen through the store is checked by hand in the app. Numbers are printed so
// a run can be recorded.

import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";
import { HUNK_HEIGHT, LINE_HEIGHT, rowHeights, rowsOf, unifiedRows } from "@/review/diffRows";
import { matchesHunks, splitLines } from "@/review/unchanged";
import { rowTops, visibleRowRange } from "@/review/useVariableRows";

const LINES = 10_000;
const CHANGED = 2_000;
const HUNKS = 100;
const VIEWPORT_ROWS = 40;
const POSITIONS = 1_000;
const OVERSCAN = 10;
/** Milliseconds to build the rows of one layout, or the heights and their prefix sums. */
const BUILD_BUDGET_MS = 50;
/** Milliseconds per scroll position for the visible range. */
const RANGE_BUDGET_MS = 4;
/** Characters per line in the wrapped measurement, a narrow pane. */
const COLUMNS = 60;

/**
 * A file of `LINES` lines in `HUNKS` hunks: every hunk carries context, a run of removed
 * lines and a run of added lines, so 2,000 lines change in total. One line in ten is long
 * enough to wrap on 60 columns; one in fifty carries a tab.
 */
function synthetic(): Hunk[] {
  const perHunk = LINES / HUNKS;
  const changedPerHunk = CHANGED / HUNKS;
  const hunks: Hunk[] = [];
  let oldNumber = 1;
  let newNumber = 1;
  for (let h = 0; h < HUNKS; h += 1) {
    const lines: DiffLine[] = [];
    const oldStart = oldNumber;
    const newStart = newNumber;
    const text = (i: number) => {
      const base = `    const value${i} = compute(${i}, options.retry, options.timeout);`;
      if (i % 50 === 0) return `\tif (value${i} === null) {`;
      return i % 10 === 0 ? base + base : base;
    };
    for (let i = 0; i < perHunk; i += 1) {
      const n = h * perHunk + i;
      if (i < changedPerHunk / 2) {
        lines.push({
          kind: "removed",
          oldNumber,
          newNumber: null,
          text: text(n),
          spans: [{ start: 10, end: 16 }],
          noNewline: false,
        });
        oldNumber += 1;
      } else if (i < changedPerHunk) {
        lines.push({
          kind: "added",
          oldNumber: null,
          newNumber,
          text: text(n),
          spans: [{ start: 10, end: 16 }],
          noNewline: false,
        });
        newNumber += 1;
      } else {
        lines.push({
          kind: "context",
          oldNumber,
          newNumber,
          text: text(n),
          spans: [],
          noNewline: false,
        });
        oldNumber += 1;
        newNumber += 1;
      }
    }
    hunks.push({
      oldStart,
      oldLines: oldNumber - oldStart,
      newStart,
      newLines: newNumber - newStart,
      header: `@@ -${oldStart},${oldNumber - oldStart} +${newStart},${newNumber - newStart} @@ fn f${h}`,
      lines,
    });
  }
  return hunks;
}

/**
 * The fastest of three runs of `build`, with its result: a single run can land on a garbage
 * collection or on a machine busy with the suite's other files, and the budget is about the
 * code's own cost.
 */
function timed<T>(build: () => T): { result: T; ms: number } {
  let started = performance.now();
  let result = build();
  let best = performance.now() - started;
  for (let run = 1; run < 3; run += 1) {
    started = performance.now();
    result = build();
    best = Math.min(best, performance.now() - started);
  }
  return { result, ms: best };
}

/**
 * A `LINES`-line file changed in `HUNKS` places, one line added in each with its three lines
 * of context: the new side's text and its hunks, the rest of the file unchanged.
 */
function sparse(): { text: string; hunks: Hunk[] } {
  const code = (n: number) =>
    `    const value${n} = compute(${n}, options.retry, options.timeout);`;
  const lines = Array.from({ length: LINES }, (_, i) => code(i + 1));
  const hunks: Hunk[] = [];
  for (let h = 0; h < HUNKS; h += 1) {
    const added = h * (LINES / HUNKS) + 50;
    lines[added - 1] = `    retry(${h});`;
    const hunkLines: DiffLine[] = [];
    for (let n = added - 3; n <= added + 3; n += 1) {
      const kind = n === added ? "added" : "context";
      const oldNumber = n === added ? null : n < added ? n - h : n - h - 1;
      hunkLines.push({
        kind,
        oldNumber,
        newNumber: n,
        text: lines[n - 1] ?? "",
        spans: [],
        noNewline: false,
      });
    }
    hunks.push({
      oldStart: added - 3 - h,
      oldLines: 6,
      newStart: added - 3,
      newLines: 7,
      header: `@@ -${added - 3 - h},6 +${added - 3},7 @@`,
      lines: hunkLines,
    });
  }
  return { text: `${lines.join("\n")}\n`, hunks };
}

describe("diff performance", () => {
  const hunks = synthetic();
  const lineCount = hunks.reduce((n, hunk) => n + hunk.lines.length, 0);

  it(`builds the rows of a ${LINES}-line file in both layouts under ${BUILD_BUDGET_MS} ms`, () => {
    expect(lineCount).toBe(LINES);
    const unified = timed(() => rowsOf(hunks, "unified"));
    const paired = timed(() => rowsOf(hunks, "side-by-side"));
    console.log(
      `diff.perf: unified rows ${unified.result.length} in ${unified.ms.toFixed(2)} ms, side-by-side rows ${paired.result.length} in ${paired.ms.toFixed(2)} ms`,
    );
    expect(unified.result).toHaveLength(LINES + HUNKS);
    // Each hunk pairs its removed and added runs: 10 rows fewer per hunk.
    expect(paired.result).toHaveLength(LINES + HUNKS - CHANGED / 2);
    expect(unified.ms).toBeLessThan(BUILD_BUDGET_MS);
    expect(paired.ms).toBeLessThan(BUILD_BUDGET_MS);
  });

  it(`measures the wrapped heights and their prefix sums under ${BUILD_BUDGET_MS} ms`, () => {
    const rows = unifiedRows(hunks);
    const plain = timed(() => rowTops(rowHeights(rows, false, COLUMNS)));
    const wrapped = timed(() => rowTops(rowHeights(rows, true, COLUMNS)));
    const plainHeight = plain.result[rows.length] ?? 0;
    const wrappedHeight = wrapped.result[rows.length] ?? 0;
    console.log(
      `diff.perf: heights without wrap in ${plain.ms.toFixed(2)} ms (${plainHeight}px), with wrap on ${COLUMNS} columns in ${wrapped.ms.toFixed(2)} ms (${wrappedHeight}px)`,
    );
    expect(plainHeight).toBe(HUNKS * HUNK_HEIGHT + LINES * LINE_HEIGHT);
    expect(wrappedHeight).toBeGreaterThan(plainHeight);
    expect(plain.ms).toBeLessThan(BUILD_BUDGET_MS);
    expect(wrapped.ms).toBeLessThan(BUILD_BUDGET_MS);
  });

  it(`shows a ${LINES}-line file whole under ${BUILD_BUDGET_MS} ms a step`, () => {
    const file = sparse();
    const split = timed(() => splitLines(file.text));
    const checked = timed(() => matchesHunks(file.hunks, split.result));
    const unchanged = { lines: split.result, revealed: [], whole: true };
    const unified = timed(() => rowsOf(file.hunks, "unified", unchanged));
    const paired = timed(() => rowsOf(file.hunks, "side-by-side", unchanged));
    const heights = timed(() => rowTops(rowHeights(unified.result, true, COLUMNS)));
    console.log(
      `diff.perf: whole file of ${split.result.length} lines: split in ${split.ms.toFixed(2)} ms, checked in ${checked.ms.toFixed(2)} ms, unified rows ${unified.result.length} in ${unified.ms.toFixed(2)} ms, side-by-side rows ${paired.result.length} in ${paired.ms.toFixed(2)} ms, wrapped heights in ${heights.ms.toFixed(2)} ms`,
    );
    expect(split.result).toHaveLength(LINES);
    expect(checked.result).toBe(true);
    // Every line of the file once, and a header per hunk.
    expect(unified.result).toHaveLength(LINES + HUNKS);
    expect(paired.result).toHaveLength(LINES + HUNKS);
    for (const ms of [split.ms, checked.ms, unified.ms, paired.ms, heights.ms]) {
      expect(ms).toBeLessThan(BUILD_BUDGET_MS);
    }
  });

  it(`finds the visible range at ${POSITIONS} positions under ${RANGE_BUDGET_MS} ms each`, () => {
    const rows = unifiedRows(hunks);
    const tops = rowTops(rowHeights(rows, true, COLUMNS));
    const total = tops[rows.length] ?? 0;
    const viewport = VIEWPORT_ROWS * LINE_HEIGHT;
    const maxScroll = total - viewport;
    let rendered = 0;
    let worst = 0;
    const started = performance.now();
    for (let p = 0; p < POSITIONS; p += 1) {
      const scrollTop = Math.floor((maxScroll * p) / (POSITIONS - 1));
      const before = performance.now();
      const range = visibleRowRange(tops, scrollTop, viewport, OVERSCAN);
      worst = Math.max(worst, performance.now() - before);
      rendered += range.end - range.start;
      expect(range.end - range.start).toBeLessThan(VIEWPORT_ROWS + 2 * OVERSCAN + 2);
    }
    const perPosition = (performance.now() - started) / POSITIONS;
    console.log(
      `diff.perf: ${POSITIONS} positions over ${rows.length} rows: ${perPosition.toFixed(4)} ms per position (worst ${worst.toFixed(3)} ms), ${(rendered / POSITIONS).toFixed(1)} rows rendered on average`,
    );
    expect(perPosition).toBeLessThan(RANGE_BUDGET_MS);
  });
});
