import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";

import {
  hunkRange,
  hunkRowIndexes,
  hunkSymbol,
  lineKind,
  rowHeights,
  segments,
  sideBySideRows,
  unifiedRows,
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
