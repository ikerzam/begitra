// The find in the diff's budgets on a change set of 1,000 files of 200 lines (200,000 lines):
// counting a query over all of them, case folded or not, under 250 ms of work in all, and the
// work of any one file under 8 ms, the slice the store's count never holds the main thread
// past. The numbers are printed so a run can be recorded.

import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";
import { matchFile, type FindFile } from "@/review/find";

const FILES = 1_000;
const LINES_PER_FILE = 200;
const HUNKS_PER_FILE = 10;
/** Milliseconds of work to count a query over the whole change set. */
const COUNT_BUDGET_MS = 250;
/** Milliseconds of work for one file: the store's slice. */
const SLICE_BUDGET_MS = 8;

function line(kind: DiffLine["kind"], text: string): DiffLine {
  return { kind, oldNumber: null, newNumber: null, text, spans: [], noNewline: false };
}

/** File `f`: ten hunks of twenty lines of code, a third of them changed, one in fifty non-ASCII. */
function file(f: number): FindFile {
  const hunks: Hunk[] = [];
  for (let h = 0; h < HUNKS_PER_FILE; h += 1) {
    const lines: DiffLine[] = [];
    for (let l = 0; l < LINES_PER_FILE / HUNKS_PER_FILE; l += 1) {
      const n = f * LINES_PER_FILE + h * 20 + l;
      const kind = l % 3 === 0 ? "removed" : l % 3 === 1 ? "added" : "context";
      const text =
        n % 50 === 0
          ? `    // Größe des Kachelspeichers ${n}: décodé à la volée`
          : `    const tile${n} = await this.pool.decode(bytes, { retry: options.retry, id: ${n} });`;
      lines.push(line(kind, text));
    }
    hunks.push({ oldStart: 1, oldLines: 20, newStart: 1, newLines: 20, header: "@@", lines });
  }
  return { key: `src/tiles/file-${f}.ts`, path: `src/tiles/file-${f}.ts`, hunks };
}

/** The fastest of three runs of `work`, with its result. */
function timed<T>(work: () => T): { result: T; ms: number } {
  let started = performance.now();
  let result = work();
  let best = performance.now() - started;
  for (let run = 1; run < 3; run += 1) {
    started = performance.now();
    result = work();
    best = Math.min(best, performance.now() - started);
  }
  return { result, ms: best };
}

describe("find performance", () => {
  const files = Array.from({ length: FILES }, (_, f) => file(f));

  it.each([
    // One line in fifty holds the rare name; every other line holds the common one twice.
    ["a rare name, case folded", "Kachelspeichers", false, 4_000],
    ["a common name, case folded", "RETRY", false, 392_000],
    ["a common name, matching case", "retry", true, 392_000],
  ])("counts %s over 200,000 lines within the budget", (_name, query, matchCase, expected) => {
    const { result, ms } = timed(() =>
      files.reduce((sum, entry) => sum + matchFile(entry, query, matchCase).length, 0),
    );
    console.log(
      `find "${query}" (case ${matchCase ? "kept" : "folded"}): ${result} matches, ${ms.toFixed(1)} ms`,
    );
    expect(result).toBeGreaterThanOrEqual(expected * 0.99);
    expect(ms).toBeLessThan(COUNT_BUDGET_MS);
  });

  it("keeps any one file's work within the store's slice", () => {
    let worst = 0;
    for (const entry of files.slice(0, 100)) {
      worst = Math.max(worst, timed(() => matchFile(entry, "retry", false)).ms);
    }
    console.log(`find: the slowest of 100 files took ${worst.toFixed(2)} ms`);
    expect(worst).toBeLessThan(SLICE_BUDGET_MS);
  });
});
