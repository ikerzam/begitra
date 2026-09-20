import { describe, expect, it } from "vitest";

import type { FileChange } from "@/ipc/schemas";

import { textColumnWidth } from "./useColumns";
import { hunkRanges } from "./useHighlight";
import { base64OfText } from "./useImageSides";

const file = {
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
    { oldStart: 40, oldLines: 0, newStart: 41, newLines: 2 },
  ],
} as unknown as FileChange;

describe("hunkRanges", () => {
  it("lists the lines each hunk shows on one side, at least one per hunk", () => {
    expect(hunkRanges(file, "new")).toEqual([
      { start: 1, end: 4 },
      { start: 41, end: 42 },
    ]);
    expect(hunkRanges(file, "old")).toEqual([
      { start: 1, end: 3 },
      { start: 40, end: 40 },
    ]);
  });
});

describe("textColumnWidth", () => {
  it("takes the gutters off once for unified and per side for side by side", () => {
    expect(textColumnWidth(1000, "unified")).toBe(1000 - 110);
    expect(textColumnWidth(1000, "side-by-side")).toBe((1000 - 132) / 2);
    expect(textColumnWidth(50, "unified")).toBe(0);
  });
});

describe("base64OfText", () => {
  it("encodes UTF-8, which btoa alone cannot", () => {
    expect(base64OfText("abc")).toBe(btoa("abc"));
    expect(() => btoa("a→")).toThrow();
    expect(base64OfText("a→")).toBe("YeKGkg==");
    expect(base64OfText("añ")).toBe("YcOx");
  });
});
