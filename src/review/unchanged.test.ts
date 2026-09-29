import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";

import { matchesHunks, splitLines, unchangedRuns } from "./unchanged";

function line(
  kind: DiffLine["kind"],
  oldNumber: number | null,
  newNumber: number | null,
  text = `line ${newNumber ?? oldNumber}`,
): DiffLine {
  return { kind, oldNumber, newNumber, text, spans: [], noNewline: false };
}

/** A hunk of `lines`, its header from their numbers or the given starts. */
function hunk(lines: DiffLine[], oldStart?: number, newStart?: number): Hunk {
  const olds = lines.flatMap((l) => (l.oldNumber === null ? [] : [l.oldNumber]));
  const news = lines.flatMap((l) => (l.newNumber === null ? [] : [l.newNumber]));
  const o = oldStart ?? olds[0] ?? 0;
  const n = newStart ?? news[0] ?? 0;
  return {
    oldStart: o,
    oldLines: olds.length,
    newStart: n,
    newLines: news.length,
    header: `@@ -${o},${olds.length} +${n},${news.length} @@`,
    lines,
  };
}

/** One line added after new line 10: context 8 to 10 and 12 to 14 around new line 11. */
const added = hunk([
  line("context", 8, 8),
  line("context", 9, 9),
  line("context", 10, 10),
  line("added", null, 11),
  line("context", 11, 12),
  line("context", 12, 13),
  line("context", 13, 14),
]);
/** Old line 43 removed: context 40 to 42 and 44 to 46 on the old side. */
const removed = hunk([
  line("context", 40, 41),
  line("context", 41, 42),
  line("context", 42, 43),
  line("removed", 43, null),
  line("context", 44, 44),
  line("context", 45, 45),
  line("context", 46, 46),
]);

describe("unchangedRuns", () => {
  it("finds the runs before, between and after the hunks, each with its old line", () => {
    expect(unchangedRuns([added, removed], 60)).toEqual([
      { newStart: 1, newEnd: 7, oldStart: 1, place: "top", before: 0 },
      // One line was added above: new 15 is old 14.
      { newStart: 15, newEnd: 40, oldStart: 14, place: "middle", before: 1 },
      // And one removed since: new 47 is old 47 again.
      { newStart: 47, newEnd: 60, oldStart: 47, place: "bottom", before: 2 },
    ]);
  });

  it("knows the run after the last hunk only with the line count, and only when it has lines", () => {
    expect(unchangedRuns([added, removed], null).map((run) => run.place)).toEqual([
      "top",
      "middle",
    ]);
    expect(unchangedRuns([added, removed], 46).map((run) => run.place)).toEqual(["top", "middle"]);
    expect(unchangedRuns([], 60)).toEqual([]);
  });

  it("places a side without lines after its start, as unified diffs write it", () => {
    // "@@ -5,2 +4,0 @@": old lines 5 and 6 removed after new line 4, without context.
    const deletion = hunk([line("removed", 5, null), line("removed", 6, null)], 5, 4);
    expect(unchangedRuns([deletion], 10)).toEqual([
      { newStart: 1, newEnd: 4, oldStart: 1, place: "top", before: 0 },
      { newStart: 5, newEnd: 10, oldStart: 7, place: "bottom", before: 1 },
    ]);
    // "@@ -3,0 +4,2 @@": new lines 4 and 5 added after old line 3.
    const addition = hunk([line("added", null, 4), line("added", null, 5)], 3, 4);
    expect(unchangedRuns([addition], 8)).toEqual([
      { newStart: 1, newEnd: 3, oldStart: 1, place: "top", before: 0 },
      { newStart: 6, newEnd: 8, oldStart: 4, place: "bottom", before: 1 },
    ]);
  });
});

describe("matchesHunks", () => {
  const file = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);

  it("accepts the new side the hunks were computed from", () => {
    expect(matchesHunks([added, removed], file)).toBe(true);
  });

  it("ignores whitespace, which -w and line-ending filters can change", () => {
    const crlf = file.map((text) => `${text}\r`);
    expect(matchesHunks([added, removed], crlf)).toBe(true);
    const indented = file.map((text) => `  ${text}`);
    expect(matchesHunks([added], indented)).toBe(true);
  });

  it("refuses a working file that moved since the diff, or ends before a hunk", () => {
    expect(matchesHunks([added, removed], ["// new first line", ...file])).toBe(false);
    expect(matchesHunks([added, removed], file.slice(0, 40))).toBe(false);
  });
});

describe("splitLines", () => {
  it("ends a line at each newline, the last one without a line after it", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a\r", "b\r"]);
    expect(splitLines("\n")).toEqual([""]);
    expect(splitLines("")).toEqual([]);
  });
});
