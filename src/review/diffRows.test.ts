import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";

import {
  byteOffsets,
  displayColumns,
  firstChangedLine,
  hunkRange,
  hunkRowIndexes,
  newLineAt,
  newLineOfRow,
  hunkSymbol,
  lineKind,
  rowHeights,
  rowLineKeys,
  rowsOf,
  segments,
  selectableRowIndexes,
  sideBySideRows,
  unifiedRows,
  widestColumns,
  wrappedLines,
} from "./diffRows";

function line(n: number, kind: DiffLine["kind"] = "context", text = `line ${n}`): DiffLine {
  return {
    kind,
    oldNumber: kind === "added" ? null : n,
    newNumber: kind === "removed" ? null : n,
    text,
    spans: [],
    noNewline: false,
  };
}

function hunk(lines: DiffLine[], header = "@@ -1,3 +1,3 @@ fn main"): Hunk {
  return { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, header, lines };
}

describe("unifiedRows", () => {
  it("keeps a header row per hunk followed by its lines", () => {
    const rows = unifiedRows([hunk([line(1), line(2)]), hunk([line(3)])]);
    expect(rows.map((row) => row.key)).toEqual(["h0", "h0-l0", "h0-l1", "h1", "h1-l0"]);
    expect(rows[0]?.kind).toBe("hunk");
    expect(rows[1]?.kind === "line" && rows[1].line.text).toBe("line 1");
    expect(hunkRowIndexes(rows)).toEqual([0, 3]);
    expect(unifiedRows([])).toEqual([]);
  });
});

describe("sideBySideRows", () => {
  it("pairs removed and added runs index by index and leaves gaps on the shorter side", () => {
    const rows = sideBySideRows([
      hunk([
        line(1),
        line(2, "removed"),
        line(3, "removed"),
        line(2, "added"),
        line(3, "added"),
        line(4, "added"),
        line(5),
      ]),
    ]);
    expect(rows[0]?.kind).toBe("hunk");
    const pairs = rows.slice(1).map((row) => {
      if (row.kind !== "pair") throw new Error("pair expected");
      return [row.left?.text ?? null, row.right?.text ?? null];
    });
    expect(pairs).toEqual([
      ["line 1", "line 1"],
      ["line 2", "line 2"],
      ["line 3", "line 3"],
      [null, "line 4"],
      ["line 5", "line 5"],
    ]);
    // Added lines without a removed run stand alone on the right.
    const added = sideBySideRows([hunk([line(1, "added"), line(2, "added")])]);
    expect(added.slice(1).map((r) => r.kind === "pair" && [r.left, r.right?.text])).toEqual([
      [null, "line 1"],
      [null, "line 2"],
    ]);
  });
});

describe("unchanged lines around the hunks", () => {
  /** A hunk whose lines carry both numbers as given: [kind, old, new]. */
  function numbered(lines: [DiffLine["kind"], number | null, number | null][]): Hunk {
    const diffLines = lines.map(([kind, oldNumber, newNumber]) => ({
      kind,
      oldNumber,
      newNumber,
      text: `line ${newNumber ?? oldNumber}`,
      spans: [],
      noNewline: false,
    }));
    const first = lines.find(([, , n]) => n !== null)?.[2] ?? 1;
    const firstOld = lines.find(([, o]) => o !== null)?.[1] ?? 1;
    return {
      oldStart: firstOld,
      oldLines: lines.filter(([, o]) => o !== null).length,
      newStart: first,
      newLines: lines.filter(([, , n]) => n !== null).length,
      header: "@@",
      lines: diffLines,
    };
  }
  // New line 11 added after 10; old line 43 removed after new 43.
  const hunks = [
    numbered([
      ["context", 10, 10],
      ["added", null, 11],
      ["context", 11, 12],
    ]),
    numbered([
      ["context", 42, 43],
      ["removed", 43, null],
      ["context", 44, 44],
    ]),
  ];
  const file = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);

  it("folds every run into a gap row until the lines are known, the last run unknown", () => {
    const rows = rowsOf(hunks, "unified", { lines: null, revealed: [], whole: false });
    expect(rows.map((row) => row.key)).toEqual([
      "g1",
      "h0",
      "h0-l0",
      "h0-l1",
      "h0-l2",
      "g13",
      "h1",
      "h1-l0",
      "h1-l1",
      "h1-l2",
    ]);
    const middle = rows[5];
    expect(middle?.kind === "gap" && [middle.newStart, middle.newEnd, middle.oldStart]).toEqual([
      13, 42, 12,
    ]);
    // Without `unchanged`, the rows are the hunks' alone, as before.
    expect(rowsOf(hunks, "unified").map((row) => row.key)[0]).toBe("h0");
  });

  it("shows the revealed lines as context rows with both numbers and folds the rest", () => {
    const rows = rowsOf(hunks, "unified", {
      lines: file,
      revealed: [
        { start: 13, end: 17 },
        { start: 16, end: 20 },
      ],
      whole: false,
    });
    const keys = rows.map((row) => row.key);
    expect(keys.slice(5, 14)).toEqual([
      "c13",
      "c14",
      "c15",
      "c16",
      "c17",
      "c18",
      "c19",
      "c20",
      "g21",
    ]);
    const shown = rows[5];
    expect(shown?.kind === "context" && shown.line).toMatchObject({
      kind: "context",
      oldNumber: 12,
      newNumber: 13,
      text: "line 13",
    });
    const rest = rows[13];
    expect(rest?.kind === "gap" && [rest.newStart, rest.newEnd, rest.oldStart]).toEqual([
      21, 42, 20,
    ]);
    // The run after the last hunk, now that the file's length is known.
    expect(keys.at(-1)).toBe("g45");
    // The selection never lands on them, and they open where they sit.
    expect(rowLineKeys(shown!)).toEqual([]);
    expect(selectableRowIndexes(rows).every((index) => rows[index]?.kind === "line")).toBe(true);
    expect(newLineOfRow(shown!, hunks)).toBe(13);
    expect(newLineOfRow(rest!, hunks)).toBe(21);
  });

  it("shows the whole file in both layouts, the hunks' keys unchanged", () => {
    for (const layout of ["unified", "side-by-side"] as const) {
      const rows = rowsOf(hunks, layout, { lines: file, revealed: [], whole: true });
      expect(rows.some((row) => row.kind === "gap")).toBe(false);
      const numbers = rows.flatMap((row) => (row.kind === "context" ? [row.line.newNumber] : []));
      expect(numbers).toEqual([
        ...Array.from({ length: 9 }, (_, i) => i + 1),
        ...Array.from({ length: 30 }, (_, i) => i + 13),
        ...Array.from({ length: 6 }, (_, i) => i + 45),
      ]);
      expect(rows.filter((row) => row.kind === "hunk").map((row) => row.key)).toEqual(["h0", "h1"]);
    }
  });

  it("gives a gap a hunk header's height and a shown line a line's", () => {
    const rows = rowsOf(hunks, "unified", { lines: file, revealed: [], whole: false });
    const heights = rowHeights(rows, false, 80);
    expect(heights[0]).toBe(28);
    const wrapped = rowsOf(hunks, "unified", {
      lines: file.map((text, i) => (i === 0 ? "x".repeat(100) : text)),
      revealed: [{ start: 1, end: 1 }],
      whole: false,
    });
    expect(rowHeights(wrapped, true, 40)[0]).toBe(60);
  });
});

describe("the widest line, the sideways scroll's reach", () => {
  it("counts tabs to the next stop and wide characters as two columns", () => {
    expect(displayColumns("abc", 4)).toBe(3);
    expect(displayColumns("\tx", 4)).toBe(5);
    expect(displayColumns("ab\tx", 4)).toBe(5);
    expect(displayColumns("abcd\tx", 4)).toBe(9);
    expect(displayColumns("a\tb", 2)).toBe(3);
    // CJK, full-width forms and emoji take two columns; accented Latin one.
    expect(displayColumns("漢字", 4)).toBe(4);
    expect(displayColumns("ＡＢ", 4)).toBe(4);
    expect(displayColumns("🚀x", 4)).toBe(3);
    // Symbols fonts draw as emoji count wide too.
    expect(displayColumns("✅ ok", 4)).toBe(5);
    expect(displayColumns("⭐", 4)).toBe(2);
    expect(displayColumns("café", 4)).toBe(4);
  });

  it("takes the widest line of either side, context rows included, folded lines not", () => {
    const long = "x".repeat(120);
    const hunks = [hunk([line(1), line(2, "removed", long), line(2, "added", "short")])];
    expect(widestColumns(rowsOf(hunks, "unified"), 4)).toBe(120);
    expect(widestColumns(rowsOf(hunks, "side-by-side"), 4)).toBe(120);
    const shown = rowsOf(hunks, "unified", {
      lines: ["line 1", "short", "y".repeat(200)],
      revealed: [],
      whole: true,
    });
    expect(widestColumns(shown, 4)).toBe(200);
    // Thirty unchanged lines after the hunk fold into a gap row, the long one with them.
    const folded = rowsOf(hunks, "unified", {
      lines: ["line 1", "short", ...Array.from({ length: 30 }, () => "z"), "y".repeat(200)],
      revealed: [],
      whole: false,
    });
    expect(folded.some((row) => row.kind === "gap")).toBe(true);
    expect(widestColumns(folded, 4)).toBe(120);
    expect(widestColumns([], 4)).toBe(0);
  });
});

describe("rowHeights and wrapping", () => {
  it("gives headers 28px and lines 20px, more when wrapped on the column width", () => {
    const rows = unifiedRows([hunk([line(1, "context", "x".repeat(50)), line(2)])]);
    expect(rowHeights(rows, false, 40)).toEqual([28, 20, 20]);
    expect(rowHeights(rows, true, 40)).toEqual([28, 40, 20]);
    expect(wrappedLines("", 40)).toBe(1);
    expect(wrappedLines("\t".repeat(11), 40)).toBe(2);
    expect(wrappedLines("abc", 0)).toBe(1);
    const pairs = sideBySideRows([
      hunk([line(1, "removed", "x".repeat(90)), line(1, "added", "y".repeat(10))]),
    ]);
    expect(rowHeights(pairs, true, 40)).toEqual([28, 60]);
  });
});

describe("segments", () => {
  it("splits at span and token boundaries and merges equal neighbours", () => {
    const text = "const x = 'text';";
    const spans = [{ start: 6, end: 7 }];
    const tokens = [
      { start: 0, end: 5, class: "keyword" as const },
      { start: 10, end: 16, class: "string" as const },
    ];
    const result = segments({ ...line(1), text, spans }, tokens);
    expect(result).toEqual([
      { text: "const", emphasis: false, class: "keyword" },
      { text: " ", emphasis: false, class: "plain" },
      { text: "x", emphasis: true, class: "plain" },
      { text: " = ", emphasis: false, class: "plain" },
      { text: "'text'", emphasis: false, class: "string" },
      { text: ";", emphasis: false, class: "plain" },
    ]);
    expect(segments(line(1))).toEqual([{ text: "line 1", emphasis: false, class: "plain" }]);
  });

  it("uses byte offsets, so multi-byte characters keep their emphasis", () => {
    const text = "añade x";
    const result = segments({ ...line(1), text, spans: [{ start: 0, end: 6 }] });
    expect(result).toEqual([
      { text: "añade", emphasis: true, class: "plain" },
      { text: " x", emphasis: false, class: "plain" },
    ]);
  });

  it("turns the text's offsets into byte offsets in one pass, surrogates included", () => {
    // a (1 byte), ñ (2), an emoji (4, two UTF-16 units), b (1).
    expect(byteOffsets("añ😀b", [0, 1, 2, 4, 5])).toEqual([0, 1, 3, 7, 8]);
    // A lone surrogate is the encoder's replacement character, three bytes.
    expect(byteOffsets("\ud800x", [0, 1, 2])).toEqual([0, 3, 4]);
    expect(new TextEncoder().encode("\ud800x").length).toBe(4);
  });

  it("cuts at the find's marks, given in the text's own offsets, the current one apart", () => {
    const text = "añade decodeTile(x) y decodeTile(y)";
    const first = text.indexOf("decodeTile");
    const second = text.indexOf("decodeTile", first + 1);
    const marks = [
      { start: first, end: first + 10, current: true },
      { start: second, end: second + 10, current: false },
    ];
    // An emphasis span over the second match: the mark takes its place there.
    const spans = [{ start: 20, end: 36 }];
    expect(segments({ ...line(1), text, spans }, [], marks)).toEqual([
      { text: "añade ", emphasis: false, class: "plain" },
      { text: "decodeTile", emphasis: false, class: "plain", find: "current" },
      { text: "(x)", emphasis: false, class: "plain" },
      { text: " y ", emphasis: true, class: "plain" },
      { text: "decodeTile", emphasis: true, class: "plain", find: "match" },
      { text: "(y)", emphasis: true, class: "plain" },
    ]);
  });
});

/** Old and new numbers as git writes them: `removed` has only the old, `added` only the new. */
function numbered(kind: DiffLine["kind"], old: number | null, now: number | null): DiffLine {
  return { kind, oldNumber: old, newNumber: now, text: kind, spans: [], noNewline: false };
}

describe("the new side's line", () => {
  // @@ -10,4 +10,3 @@: context 10, removed 11 and 12, added 11, context 12, removed 14.
  const lines = [
    numbered("context", 10, 10),
    numbered("removed", 11, null),
    numbered("removed", 12, null),
    numbered("added", null, 11),
    numbered("context", 13, 12),
    numbered("removed", 14, null),
  ];
  const change: Hunk = {
    oldStart: 10,
    oldLines: 5,
    newStart: 10,
    newLines: 3,
    header: "@@ -10,5 +10,3 @@",
    lines,
  };

  it("is a line's own new number, or for a removed line the new line where it sat", () => {
    expect(newLineAt(change, 0)).toBe(10);
    expect(newLineAt(change, 1)).toBe(11);
    expect(newLineAt(change, 2)).toBe(11);
    expect(newLineAt(change, 3)).toBe(11);
    // A removal at the end of its hunk sits after the hunk's last new line.
    expect(newLineAt(change, 5)).toBe(13);
  });

  it("follows the rows of both layouts, a hunk's header its first new line", () => {
    const unified = unifiedRows([change]);
    expect(unified.map((row) => newLineOfRow(row, [change]))).toEqual([10, 10, 11, 11, 11, 12, 13]);
    const sides = sideBySideRows([change]);
    // Header, context, removed 11 paired with added 11, removed 12 alone, context, removed 14.
    expect(sides.map((row) => newLineOfRow(row, [change]))).toEqual([10, 10, 11, 11, 12, 13]);
  });

  it("has nothing to open for a deleted file, and a file's first change is where it opens", () => {
    const deleted: Hunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 0,
      newLines: 0,
      header: "@@ -1,2 +0,0 @@",
      lines: [numbered("removed", 1, null), numbered("removed", 2, null)],
    };
    expect(newLineOfRow(unifiedRows([deleted])[0]!, [deleted])).toBeNull();
    expect(newLineAt(deleted, 0)).toBeNull();
    expect(firstChangedLine([change])).toBe(11);
    expect(firstChangedLine([deleted])).toBeNull();
    expect(firstChangedLine([])).toBeNull();
  });
});

describe("hunk header pieces", () => {
  it("splits the range and the symbol", () => {
    const h = hunk([], "@@ -12,7 +14,9 @@ class TileCache");
    expect(hunkRange(h)).toBe("@@ -12,7 +14,9 @@");
    expect(hunkSymbol(h)).toBe("class TileCache");
    expect(hunkSymbol(hunk([], "@@ -1 +1 @@"))).toBe("");
    expect(lineKind(line(1, "added"))).toBe("add");
    expect(lineKind(line(1, "removed"))).toBe("del");
    expect(lineKind(line(1))).toBe("context");
  });
});
