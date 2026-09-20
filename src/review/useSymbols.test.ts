import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk, Symbol as FileSymbol } from "@/ipc/schemas";

import { sideBySideRows, unifiedRows } from "./diffRows";
import { changedSymbols } from "./useSymbols";

function line(
  kind: DiffLine["kind"],
  oldNumber: number | null,
  newNumber: number | null,
): DiffLine {
  return { kind, oldNumber, newNumber, text: "x", spans: [], noNewline: false };
}

const hunks: Hunk[] = [
  {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
    header: "@@ -1,3 +1,4 @@",
    lines: [
      line("context", 1, 1),
      line("added", null, 2),
      line("context", 2, 3),
      line("context", 3, 4),
    ],
  },
  {
    oldStart: 20,
    oldLines: 3,
    newStart: 21,
    newLines: 2,
    header: "@@ -20,3 +21,2 @@",
    lines: [line("context", 20, 21), line("removed", 21, null), line("context", 22, 22)],
  },
];

const symbols: FileSymbol[] = [
  { kind: "function", name: "first", startLine: 1, endLine: 5 },
  { kind: "function", name: "untouched", startLine: 8, endLine: 15 },
  { kind: "class", name: "Later", startLine: 18, endLine: 30 },
  { kind: "method", name: "inside", startLine: 21, endLine: 23 },
];

describe("changedSymbols", () => {
  it("pairs every declaration the diff touches with its first changed row, in order", () => {
    const rows = unifiedRows(hunks);
    const changed = changedSymbols(symbols, rows);
    expect(changed.map((c) => [c.symbol.name, c.row])).toEqual([
      ["first", 2],
      ["Later", 7],
      ["inside", 7],
    ]);
  });

  it("works on side-by-side rows and a removal counts where it left the new side", () => {
    const rows = sideBySideRows(hunks);
    const changed = changedSymbols(symbols, rows);
    expect(changed.map((c) => c.symbol.name)).toEqual(["first", "Later", "inside"]);
    expect(rows[changed[1]!.row]?.kind).toBe("pair");
  });

  it("is empty without symbols or without changes", () => {
    expect(changedSymbols([], unifiedRows(hunks))).toEqual([]);
    expect(changedSymbols(symbols, [])).toEqual([]);
  });
});
