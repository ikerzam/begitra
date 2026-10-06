import { describe, expect, it } from "vitest";

import type { DiffLine, Hunk } from "@/ipc/schemas";

import { foldCase, matchFile, type FindFile } from "./find";

function line(kind: DiffLine["kind"], text: string): DiffLine {
  return { kind, oldNumber: null, newNumber: null, text, spans: [], noNewline: false };
}

function hunk(...lines: DiffLine[]): Hunk {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@", lines };
}

function file(...hunks: Hunk[]): FindFile {
  return { key: "src/tile-cache.ts", path: "src/tile-cache.ts", hunks };
}

describe("find", () => {
  it("finds a query in removed, context and added lines, ignoring case", () => {
    const f = file(
      hunk(
        line("context", "import { Tile } from './tile';"),
        line("removed", "  const tile = decodeTile(bytes);"),
        line("added", "  const tile = await this.pool.decode(bytes);"),
      ),
      hunk(line("added", "export { decodeTile as legacyDecode };")),
    );
    expect(matchFile(f, "decodetile", false)).toMatchObject([
      { key: "src/tile-cache.ts", hunk: 0, line: 1, start: 15, end: 25 },
      { key: "src/tile-cache.ts", hunk: 1, line: 0, start: 9, end: 19 },
    ]);
    expect(matchFile(f, "tile", false).map((m) => [m.hunk, m.line, m.start])).toEqual([
      [0, 0, 9],
      [0, 0, 24],
      [0, 1, 8],
      [0, 1, 21],
      [0, 2, 8],
      [1, 0, 15],
    ]);
  });

  it("matches case when asked, and as often as the query occurs without overlapping", () => {
    const f = file(hunk(line("added", "Tile tile TILE"), line("added", "aaaa")));
    expect(matchFile(f, "Tile", true).map((m) => m.start)).toEqual([0]);
    expect(matchFile(f, "tile", false).map((m) => m.start)).toEqual([0, 5, 10]);
    expect(matchFile(f, "aa", false).map((m) => [m.line, m.start])).toEqual([
      [1, 0],
      [1, 2],
    ]);
    expect(matchFile(f, "", false)).toEqual([]);
  });

  it("keeps offsets right around text whose case folds to another length", () => {
    // "İ" folds to two code units; it is kept, so the offsets stay those of the line.
    const f = file(hunk(line("added", "İstanbul and ÉCOLE and 日本語 and 😀 emoji")));
    expect(foldCase("İX").length).toBe(2);
    const [ecole] = matchFile(f, "école", false);
    expect(ecole && f.hunks[0]?.lines[0]?.text.slice(ecole.start, ecole.end)).toBe("ÉCOLE");
    const [emoji] = matchFile(f, "emoji", false);
    expect(emoji && f.hunks[0]?.lines[0]?.text.slice(emoji.start, emoji.end)).toBe("emoji");
    const [japanese] = matchFile(f, "日本", false);
    expect(japanese?.start).toBe(23);
  });
});
