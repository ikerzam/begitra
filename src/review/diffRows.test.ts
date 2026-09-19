import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";

import { MAX_LINES, buildRows, hunkRange, hunkSymbol, lineKind, segments } from "./diffRows";

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

function hunk(count: number, header = "@@ -1,3 +1,3 @@ fn main"): Hunk {
  return {
    oldStart: 1,
    oldLines: count,
    newStart: 1,
    newLines: count,
    header,
    lines: Array.from({ length: count }, (_, i) => line(i + 1)),
  };
}

describe("buildRows", () => {
  it("keeps a header row per hunk followed by its lines", () => {
    const { rows, truncated } = buildRows([hunk(2), hunk(1)]);
    expect(rows.map((row) => row.key)).toEqual(["h0", "h0-l0", "h0-l1", "h1", "h1-l0"]);
    expect(rows[0]?.hunk).toBeDefined();
    expect(rows[1]?.line?.text).toBe("line 1");
    expect(truncated).toBe(false);
  });

  it("renders exactly MAX_LINES lines across hunks without truncating", () => {
    const { rows, truncated } = buildRows([hunk(1_000), hunk(500)]);
    expect(rows.filter((row) => row.line)).toHaveLength(MAX_LINES);
    expect(rows.filter((row) => row.hunk)).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  it("cuts after MAX_LINES lines and reports the truncation", () => {
    const { rows, truncated } = buildRows([hunk(1_000), hunk(501)]);
    expect(rows.filter((row) => row.line)).toHaveLength(MAX_LINES);
    expect(rows.at(-1)?.key).toBe("h1-l499");
    expect(truncated).toBe(true);
  });

  it("does not start a hunk none of whose lines fit", () => {
    const { rows, truncated } = buildRows([hunk(3), hunk(2)], 3);
    expect(rows.map((row) => row.key)).toEqual(["h0", "h0-l0", "h0-l1", "h0-l2"]);
    expect(truncated).toBe(true);
  });

  it("is empty for a file without hunks", () => {
    expect(buildRows([])).toEqual({ rows: [], truncated: false });
  });
});

describe("segments", () => {
  it("returns the whole line as plain text without spans", () => {
    expect(segments(line(1))).toEqual([{ text: "line 1", emphasis: false }]);
  });

  it("splits the line at its byte spans, counting multibyte characters in UTF-8", () => {
    // "año" is 4 bytes: the ñ takes two, so the span {1, 3} covers just that letter.
    const text = "año → été";
    const bytes = new TextEncoder().encode(text);
    const arrow = new TextEncoder().encode("año ").length;
    expect(bytes.length).toBe(text.length + 5);
    const result = segments({
      ...line(1),
      text,
      spans: [
        { start: 1, end: 3 },
        { start: arrow, end: bytes.length },
      ],
    });
    expect(result).toEqual([
      { text: "a", emphasis: false },
      { text: "ñ", emphasis: true },
      { text: "o ", emphasis: false },
      { text: "→ été", emphasis: true },
    ]);
  });

  it("keeps the text before, between and after the spans", () => {
    const result = segments({
      ...line(1),
      text: "abcdef",
      spans: [
        { start: 1, end: 2 },
        { start: 3, end: 5 },
      ],
    });
    expect(result.map((segment) => segment.text).join("")).toBe("abcdef");
    expect(result.map((segment) => segment.emphasis)).toEqual([false, true, false, true, false]);
  });

  it("ignores empty spans", () => {
    expect(segments({ ...line(1), text: "ab", spans: [{ start: 1, end: 1 }] })).toEqual([
      { text: "ab", emphasis: false },
    ]);
  });
});

describe("hunk helpers", () => {
  it("splits the range and the symbol of a header", () => {
    const h = hunk(1, "@@ -12,7 +12,9 @@ fn main()");
    expect(hunkRange(h)).toBe("@@ -12,7 +12,9 @@");
    expect(hunkSymbol(h)).toBe("fn main()");
    expect(hunkSymbol(hunk(1, "@@ -1 +1 @@"))).toBe("");
  });

  it("maps line kinds to the row kinds of DiffRow", () => {
    expect(lineKind(line(1, "added"))).toBe("add");
    expect(lineKind(line(1, "removed"))).toBe("del");
    expect(lineKind(line(1))).toBe("context");
  });
});
