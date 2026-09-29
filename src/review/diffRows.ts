// Pure helpers of the diff viewer: the row models of a file in both layouts (a header row
// per hunk, then its lines, or its removed and added lines paired side by side, and around
// the hunks the unchanged lines, folded into gap rows or shown as context rows), the row
// heights with and without wrapping as prefix sums for the virtual list, the intra-line
// segments of a line merged with its token classes, and the pieces of a hunk header.

import type { DiffLineKind } from "@/components/types";
import type { DiffLine, Hunk, LineRange, Token, TokenClass } from "@/ipc/schemas";

import { mergeRanges, unchangedRuns, type UnchangedRun } from "./unchanged";

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

/** Unchanged lines outside the hunks that stay folded: `newStart` to `newEnd` on the new side. */
export interface GapRowModel {
  kind: "gap";
  key: string;
  newStart: number;
  newEnd: number;
  /** The old side's number of `newStart`. */
  oldStart: number;
  /** The run it belongs to: before the first hunk, between two, or after the last. */
  place: UnchangedRun["place"];
}

/** An unchanged line outside the hunks, shown: a context line built from the new side. */
export interface ContextRowModel {
  kind: "context";
  key: string;
  line: DiffLine;
}

export type DiffRowModel =
  HunkRowModel | LineRowModel | PairRowModel | GapRowModel | ContextRowModel;

/** How many lines a gap's step controls show. */
export const EXPAND_STEP = 20;

/** What the viewer shows of the lines outside the hunks. */
export interface Unchanged {
  /** The new side's lines, or null while they are unread or do not match the hunks. */
  lines: readonly string[] | null;
  /** The new-side ranges shown, inclusive, in any order. */
  revealed: readonly LineRange[];
  /** Every unchanged line shown. */
  whole: boolean;
}

/** The rows of one hunk in unified layout. */
function unifiedHunk(rows: DiffRowModel[], hunk: Hunk, h: number): void {
  rows.push({ kind: "hunk", key: `h${h}`, hunkIndex: h, hunk });
  for (const [l, line] of hunk.lines.entries()) {
    rows.push({ kind: "line", key: `h${h}-l${l}`, hunkIndex: h, lineIndex: l, line });
  }
}

/** The rows of `hunks` in unified layout. */
export function unifiedRows(hunks: Hunk[]): DiffRowModel[] {
  const rows: DiffRowModel[] = [];
  for (const [h, hunk] of hunks.entries()) unifiedHunk(rows, hunk, h);
  return rows;
}

/**
 * The rows of one hunk side by side: context lines on both sides; a run of removed lines
 * followed by a run of added lines is paired index by index, the longer run leaving gaps.
 */
function sideBySideHunk(rows: DiffRowModel[], hunk: Hunk, h: number): void {
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

/** The rows of `hunks` side by side (`sideBySideHunk`). */
export function sideBySideRows(hunks: Hunk[]): DiffRowModel[] {
  const rows: DiffRowModel[] = [];
  for (const [h, hunk] of hunks.entries()) sideBySideHunk(rows, hunk, h);
  return rows;
}

/** The parts of `run` that `unchanged` shows, clipped to it, sorted and merged. */
function shownParts(run: UnchangedRun, unchanged: Unchanged): LineRange[] {
  if (unchanged.lines === null) return [];
  if (unchanged.whole) return [{ start: run.newStart, end: run.newEnd }];
  const clipped = unchanged.revealed
    .map((range) => ({
      start: Math.max(range.start, run.newStart),
      end: Math.min(range.end, run.newEnd),
    }))
    .filter((range) => range.start <= range.end);
  return mergeRanges(clipped);
}

/** The rows of an unchanged run: its shown lines as context rows, the rest as gap rows. */
function runRows(rows: DiffRowModel[], run: UnchangedRun, unchanged: Unchanged): void {
  const oldOf = (newNumber: number) => run.oldStart + (newNumber - run.newStart);
  const gap = (newStart: number, newEnd: number): void => {
    rows.push({
      kind: "gap",
      key: `g${newStart}`,
      newStart,
      newEnd,
      oldStart: oldOf(newStart),
      place: run.place,
    });
  };
  let at = run.newStart;
  for (const part of shownParts(run, unchanged)) {
    if (part.start > at) gap(at, part.start - 1);
    for (let n = part.start; n <= part.end; n += 1) {
      rows.push({
        kind: "context",
        key: `c${n}`,
        line: {
          kind: "context",
          oldNumber: oldOf(n),
          newNumber: n,
          text: unchanged.lines?.[n - 1] ?? "",
          spans: [],
          noNewline: false,
        },
      });
    }
    at = part.end + 1;
  }
  if (at <= run.newEnd) gap(at, run.newEnd);
}

/**
 * The rows of a file in `layout`; with `unchanged`, the unchanged runs around the hunks too
 * (the run after the last hunk once the new side's lines are known). The keys of the hunk
 * rows do not depend on the runs, so a selection keyed on them survives a reveal.
 */
export function rowsOf(hunks: Hunk[], layout: DiffLayout, unchanged?: Unchanged): DiffRowModel[] {
  if (!unchanged) return layout === "unified" ? unifiedRows(hunks) : sideBySideRows(hunks);
  const runs = new Map(
    unchangedRuns(hunks, unchanged.lines?.length ?? null).map((run) => [run.before, run]),
  );
  const rows: DiffRowModel[] = [];
  for (const [h, hunk] of hunks.entries()) {
    const run = runs.get(h);
    if (run) runRows(rows, run, unchanged);
    if (layout === "unified") unifiedHunk(rows, hunk, h);
    else sideBySideHunk(rows, hunk, h);
  }
  const last = runs.get(hunks.length);
  if (last) runRows(rows, last, unchanged);
  return rows;
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
    if (row.kind === "hunk" || row.kind === "gap") return HUNK_HEIGHT;
    if (!wrap) return LINE_HEIGHT;
    if (row.kind === "line" || row.kind === "context") {
      return LINE_HEIGHT * wrappedLines(row.line.text, columns);
    }
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

/**
 * The new side's line of the line at `index` of `hunk`: its own new number, or for a removed
 * line the new line where it sat (the next one with a new number in its hunk, else the one
 * after the hunk's last); null when the hunk has no new side (a deleted file).
 */
export function newLineAt(hunk: Hunk, index: number): number | null {
  if (hunk.newStart === 0 && hunk.newLines === 0) return null;
  const own = hunk.lines[index]?.newNumber;
  if (own !== null && own !== undefined) return own;
  for (let i = index + 1; i < hunk.lines.length; i += 1) {
    const next = hunk.lines[i]?.newNumber;
    if (next !== null && next !== undefined) return next;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = hunk.lines[i]?.newNumber;
    if (previous !== null && previous !== undefined) return previous + 1;
  }
  return hunk.newStart;
}

/**
 * The new side's line of a row: a header's is its hunk's first new line, a gap's its first
 * folded line.
 */
export function newLineOfRow(row: DiffRowModel, hunks: Hunk[]): number | null {
  if (row.kind === "gap") return row.newStart;
  if (row.kind === "context") return row.line.newNumber;
  const hunk = hunks[row.hunkIndex];
  if (!hunk) return null;
  if (row.kind === "hunk") return newLineAt(hunk, 0);
  if (row.kind === "line") return newLineAt(hunk, row.lineIndex);
  const index = row.rightIndex ?? row.leftIndex;
  return index === null ? null : newLineAt(hunk, index);
}

/** Where a file opens from its header: the new side's line of its first change. */
export function firstChangedLine(hunks: Hunk[]): number | null {
  const first = hunks[0];
  if (!first) return null;
  const index = first.lines.findIndex((line) => line.kind !== "context");
  return newLineAt(first, index < 0 ? 0 : index);
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
