// The unchanged lines of a file outside its hunks: the runs before the first hunk, between two
// and after the last, on the new side with the old line of each run's first, and the check
// that the new side read whole still matches the hunks it is shown beside.

import type { Hunk } from "@/ipc/schemas";

/** A run of unchanged lines, `newStart` to `newEnd` on the new side, inclusive. */
export interface UnchangedRun {
  newStart: number;
  newEnd: number;
  /** The old side's number of `newStart`: an unchanged run has one length on both sides. */
  oldStart: number;
  /** Before the first hunk, between two, or after the last. */
  place: "top" | "middle" | "bottom";
  /** The index of the hunk the run comes before; the hunks' count for the last run. */
  before: number;
}

/** The first and last line a hunk holds on each side. */
function hunkSpan(hunk: Hunk): { newFirst: number; newLast: number; oldLast: number } {
  let newFirst = Infinity;
  let newLast = -Infinity;
  let oldLast = -Infinity;
  for (const line of hunk.lines) {
    if (line.newNumber !== null) {
      newFirst = Math.min(newFirst, line.newNumber);
      newLast = Math.max(newLast, line.newNumber);
    }
    if (line.oldNumber !== null) oldLast = Math.max(oldLast, line.oldNumber);
  }
  // A side the hunk holds no line of sits after its start, as unified diffs write a side of
  // length zero: "@@ -5,2 +4,0 @@" removes old lines 5 and 6 after new line 4.
  if (newFirst === Infinity) {
    newFirst = hunk.newStart + 1;
    newLast = hunk.newStart;
  }
  if (oldLast === -Infinity) oldLast = hunk.oldStart;
  return { newFirst, newLast, oldLast };
}

/**
 * The unchanged runs of a file around `hunks`: before the first and between two from the
 * hunks' own numbers, after the last only with the new side's `lineCount`. Empty runs are
 * left out, and a file without hunks has none.
 */
export function unchangedRuns(hunks: readonly Hunk[], lineCount: number | null): UnchangedRun[] {
  const runs: UnchangedRun[] = [];
  let nextNew = 1;
  let nextOld = 1;
  hunks.forEach((hunk, index) => {
    const span = hunkSpan(hunk);
    if (span.newFirst > nextNew) {
      runs.push({
        newStart: nextNew,
        newEnd: span.newFirst - 1,
        oldStart: nextOld,
        place: index === 0 ? "top" : "middle",
        before: index,
      });
    }
    nextNew = span.newLast + 1;
    nextOld = span.oldLast + 1;
  });
  if (hunks.length > 0 && lineCount !== null && lineCount >= nextNew) {
    runs.push({
      newStart: nextNew,
      newEnd: lineCount,
      oldStart: nextOld,
      place: "bottom",
      before: hunks.length,
    });
  }
  return runs;
}

const squeeze = (text: string): string => text.replace(/\s+/g, "");

/**
 * Whether the new side's `lines` are the ones the hunks were computed from: every hunk line
 * with a new number is there with the same text, whitespace aside (`-w` may print a context
 * line from the old side, and a working file under `core.autocrlf` differs in `\r`). A
 * working file edited since the diff fails it until the reload brings new hunks.
 */
export function matchesHunks(hunks: readonly Hunk[], lines: readonly string[]): boolean {
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newNumber === null) continue;
      const text = lines[line.newNumber - 1];
      if (text === undefined || squeeze(text) !== squeeze(line.text)) return false;
    }
  }
  return true;
}

/** A text's lines: each ends at a newline, which a last line may lack; `\r` stays. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
