// The overview ruler's budget: the ticks of a file of 100,000 rows on a 900px ruler, computed
// within one frame (16 ms), with every tenth line changed (the find closed, then with 5,000
// matches) and with a change every 330 rows, ticks a few pixels apart that never join; never
// more than one tick of a kind for every three pixels. The numbers are printed so a run can
// be recorded.

import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";
import { rowHeights, rowsOf } from "@/review/diffRows";
import { rowFlags, rulerTicks, type RulerMatch } from "@/review/ruler";
import { rowTops } from "@/review/useVariableRows";

const HUNKS = 10_000;
/** Lines of a hunk: the fifth may be changed, the rest are context, under the header row. */
const LINES = 9;
const RULER = 900;
/** Milliseconds for the flags and the ticks together: one frame. */
const BUDGET_MS = 16;

function line(n: number, kind: DiffLine["kind"]): DiffLine {
  return {
    kind,
    oldNumber: kind === "added" ? null : n,
    newNumber: kind === "removed" ? null : n,
    text: `    const tile${n} = await this.pool.decode(bytes);`,
    spans: [],
    noNewline: false,
  };
}

/** Hunks whose fifth line is changed in every `every`th hunk, removed and added in turn. */
function hunks(every: number): Hunk[] {
  return Array.from({ length: HUNKS }, (_, h) => {
    const changed = h % every === 0 ? ((h / every) % 2 === 0 ? "removed" : "added") : "context";
    const lines = Array.from({ length: LINES }, (_, l) =>
      line(h * LINES + l + 1, l === 4 ? changed : "context"),
    );
    return { oldStart: 1, oldLines: LINES, newStart: 1, newLines: LINES, header: "@@", lines };
  });
}

/** The fastest of five runs of `work`, with its result. */
function timed<T>(work: () => T): { result: T; ms: number } {
  let started = performance.now();
  let result = work();
  let best = performance.now() - started;
  for (let run = 1; run < 5; run += 1) {
    started = performance.now();
    result = work();
    best = Math.min(best, performance.now() - started);
  }
  return { result, ms: best };
}

/** A match on every other hunk's fifth line: 5,000, one of them current. */
const MATCHES: RulerMatch[] = Array.from({ length: HUNKS / 2 }, (_, i) => ({
  hunk: i * 2,
  line: 4,
  current: i === 1_000,
}));

describe("overview ruler performance", () => {
  it.each([
    ["every tenth line changed, the find closed", 1, [] as RulerMatch[]],
    ["every tenth line changed, 5,000 matches", 1, MATCHES],
    ["a change every 330 rows", 33, [] as RulerMatch[]],
  ])("computes the ticks of 100,000 rows within a frame: %s", (name, every, open) => {
    const rows = rowsOf(hunks(every), "unified");
    const tops = rowTops(rowHeights(rows, false, 120));
    expect(rows.length).toBe(HUNKS * (LINES + 1));
    const { result, ms } = timed(() => rulerTicks(rowFlags(rows, open), tops, RULER));
    console.log(`overview ruler, ${name}: ${result.length} ticks, ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
    for (const kind of ["removed", "added", "match", "current"] as const) {
      const count = result.filter((tick) => tick.kind === kind).length;
      expect(count).toBeLessThanOrEqual(Math.floor((RULER + 1) / 3));
    }
  });
});
