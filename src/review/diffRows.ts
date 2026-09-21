// Pure helpers of the diff viewer: the row models of a file in both layouts (a header row
// per hunk, then its lines, or its removed and added lines paired side by side), the row
// heights with and without wrapping as prefix sums for the virtual list, the intra-line
// segments of a line merged with its token classes, and the pieces of a hunk header.

import type { DiffLineKind } from "@/components/types";
import type { DiffLine, Hunk, Token, TokenClass } from "@/ipc/schemas";

/** Height of a line row (`--row-diff`). */
export const LINE_HEIGHT = 20;
/** Height of a hunk header row (`--row-hunk`). */
export const HUNK_HEIGHT = 28;

export type DiffLayout = "unified" | "side-by-side";

export interface HunkRowModel {
  kind: "hunk";
  key: string;
  hunkIndex: number;
  hunk: Hunk;
}

export interface LineRowModel {
  kind: "line";
  key: string;
  hunkIndex: number;
  /** Index of the line inside its hunk (the selection's key with `hunkIndex`). */
  lineIndex: number;
  line: DiffLine;
}

/** A side-by-side row: a context line on both sides, or a removed and an added line paired. */
export interface PairRowModel {
  kind: "pair";
  key: string;
  hunkIndex: number;
  left: DiffLine | null;
  right: DiffLine | null;
  /** Indexes of the two lines inside their hunk; null on the side without a line. */
  leftIndex: number | null;
  rightIndex: number | null;
}

export type DiffRowModel = HunkRowModel | LineRowModel | PairRowModel;

/** The rows of `hunks` in unified layout. */
export function unifiedRows(hunks: Hunk[]): DiffRowModel[] {
  const rows: DiffRowModel[] = [];
  for (const [h, hunk] of hunks.entries()) {
    rows.push({ kind: "hunk", key: `h${h}`, hunkIndex: h, hunk });
    for (const [l, line] of hunk.lines.entries()) {
      rows.push({ kind: "line", key: `h${h}-l${l}`, hunkIndex: h, lineIndex: l, line });
    }
  }
  return rows;
}

/**
 * The rows of `hunks` side by side: context lines on both sides; a run of removed lines
 * followed by a run of added lines is paired index by index, the longer run leaving gaps.
 */
export function sideBySideRows(hunks: Hunk[]): DiffRowModel[] {
  const rows: DiffRowModel[] = [];
  for (const [h, hunk] of hunks.entries()) {
    rows.push({ kind: "hunk", key: `h${h}`, hunkIndex: h, hunk });
    let i = 0;
    let n = 0;
    const lines = hunk.lines;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.kind === "context") {
        rows.push({
          kind: "pair",
          key: `h${h}-p${n}`,
          hunkIndex: h,
          left: line,
          right: line,
          leftIndex: i,
          rightIndex: i,
        });
        n += 1;
        i += 1;
        continue;
      }
      const removed: number[] = [];
      const added: number[] = [];
      while (i < lines.length && lines[i]!.kind === "removed") removed.push(i++);
      while (i < lines.length && lines[i]!.kind === "added") added.push(i++);
      const count = Math.max(removed.length, added.length);
      for (let k = 0; k < count; k += 1) {
        const leftIndex = removed[k] ?? null;
        const rightIndex = added[k] ?? null;
        rows.push({
          kind: "pair",
          key: `h${h}-p${n}`,
          hunkIndex: h,
          left: leftIndex === null ? null : lines[leftIndex]!,
          right: rightIndex === null ? null : lines[rightIndex]!,
          leftIndex,
          rightIndex,
        });
        n += 1;
      }
    }
  }
  return rows;
}

export function rowsOf(hunks: Hunk[], layout: DiffLayout): DiffRowModel[] {
  return layout === "unified" ? unifiedRows(hunks) : sideBySideRows(hunks);
}

/** Lines a text takes in a column `columns` characters wide (at least one). */
export function wrappedLines(text: string, columns: number): number {
  if (columns <= 0) return 1;
  // Tabs count as four columns, like the viewer renders them.
  let width = 0;
  for (const char of text) width += char === "\t" ? 4 : 1;
  return Math.max(1, Math.ceil(width / columns));
}

/**
 * The height of every row: hunk headers 28px, lines 20px, or a multiple of 20px when wrapping
 * on `columns` characters (a pair takes the taller side).
 */
export function rowHeights(rows: DiffRowModel[], wrap: boolean, columns: number): number[] {
  return rows.map((row) => {
    if (row.kind === "hunk") return HUNK_HEIGHT;
    if (!wrap) return LINE_HEIGHT;
    if (row.kind === "line") return LINE_HEIGHT * wrappedLines(row.line.text, columns);
    const left = row.left ? wrappedLines(row.left.text, columns) : 1;
    const right = row.right ? wrappedLines(row.right.text, columns) : 1;
    return LINE_HEIGHT * Math.max(left, right);
  });
}

/** Indices of the hunk header rows. */
export function hunkRowIndexes(rows: DiffRowModel[]): number[] {
  const indexes: number[] = [];
  for (const [index, row] of rows.entries()) if (row.kind === "hunk") indexes.push(index);
  return indexes;
}

/** The selection keys (`hunk:line`) of the changed lines a row holds; none for context. */
export function rowLineKeys(row: DiffRowModel): string[] {
  if (row.kind === "line") {
    return row.line.kind === "context" ? [] : [`${row.hunkIndex}:${row.lineIndex}`];
  }
  if (row.kind === "pair") {
    const keys: string[] = [];
    if (row.left && row.left.kind !== "context" && row.leftIndex !== null) {
      keys.push(`${row.hunkIndex}:${row.leftIndex}`);
    }
    if (row.right && row.right.kind !== "context" && row.rightIndex !== null) {
      keys.push(`${row.hunkIndex}:${row.rightIndex}`);
    }
    return keys;
  }
  return [];
}

/** Indices of the rows that hold a changed line: what the selection cursor moves over. */
export function selectableRowIndexes(rows: DiffRowModel[]): number[] {
  const indexes: number[] = [];
  for (const [index, row] of rows.entries()) if (rowLineKeys(row).length > 0) indexes.push(index);
  return indexes;
}

export interface Segment {
  text: string;
  emphasis: boolean;
  /** Token class from the highlighter; `plain` without one. */
  class: TokenClass;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Splits a line into segments at every intra-line span boundary (UTF-8 byte offsets) and
 * every token boundary, so each segment has one emphasis and one class.
 */
export function segments(line: DiffLine, tokens: Token[] = []): Segment[] {
  if (line.spans.length === 0 && tokens.length === 0) {
    return [{ text: line.text, emphasis: false, class: "plain" }];
  }
  const bytes = encoder.encode(line.text);
  const cuts = new Set<number>([0, bytes.length]);
  for (const span of line.spans) {
    cuts.add(Math.min(span.start, bytes.length));
    cuts.add(Math.min(span.end, bytes.length));
  }
  for (const token of tokens) {
    cuts.add(Math.min(token.start, bytes.length));
    cuts.add(Math.min(token.end, bytes.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const result: Segment[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;
    const emphasis = line.spans.some((span) => span.start <= start && span.end >= end);
    const token = tokens.find((t) => t.start <= start && t.end >= end);
    const text = decoder.decode(bytes.subarray(start, end));
    const cls = token?.class ?? "plain";
    const last = result.at(-1);
    if (last && last.emphasis === emphasis && last.class === cls) last.text += text;
    else result.push({ text, emphasis, class: cls });
  }
  return result;
}

/** The row kind of `DiffRow` for a diff line. */
export function lineKind(line: DiffLine): DiffLineKind {
  return line.kind === "added" ? "add" : line.kind === "removed" ? "del" : "context";
}

/** The "@@ -a,b +c,d @@" part of a hunk header. */
export function hunkRange(hunk: Hunk): string {
  const match = /^@@[^@]*@@/.exec(hunk.header);
  return match ? match[0] : hunk.header;
}

/** The enclosing symbol git printed after the range, if any. */
export function hunkSymbol(hunk: Hunk): string {
  return hunk.header.replace(/^@@[^@]*@@\s*/, "");
}
