// Pure helpers of the diff panel: the rows of a file (a header per hunk, then its lines, cut
// after MAX_LINES lines so a huge file never stalls the panel), the intra-line segments of a
// line, and the pieces of a hunk header.

import type { DiffLineKind } from "@/components/types";
import type { DiffLine, Hunk } from "@/ipc/schemas";

/** Lines rendered before the diff is cut. */
export const MAX_LINES = 1_500;

export interface Row {
  key: string;
  hunk?: Hunk;
  line?: DiffLine;
}

export interface DiffRows {
  rows: Row[];
  /** The file has more lines than the rows hold. */
  truncated: boolean;
}

/**
 * The rows of `hunks`: a header row per hunk followed by its lines, stopping after `maxLines`
 * lines counted across hunks. A hunk none of whose lines fit gets no header either.
 */
export function buildRows(hunks: Hunk[], maxLines = MAX_LINES): DiffRows {
  const rows: Row[] = [];
  let left = maxLines;
  for (const [h, hunk] of hunks.entries()) {
    if (left === 0 && hunk.lines.length > 0) break;
    rows.push({ key: `h${h}`, hunk });
    for (const [l, line] of hunk.lines.slice(0, left).entries()) {
      rows.push({ key: `h${h}-l${l}`, line });
    }
    left -= Math.min(left, hunk.lines.length);
  }
  const total = hunks.reduce((n, hunk) => n + hunk.lines.length, 0);
  return { rows, truncated: total > maxLines };
}

export interface Segment {
  text: string;
  emphasis: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Splits a line into plain and emphasised segments from its spans, which are UTF-8 byte offsets. */
export function segments(line: DiffLine): Segment[] {
  if (line.spans.length === 0) return [{ text: line.text, emphasis: false }];
  const bytes = encoder.encode(line.text);
  const result: Segment[] = [];
  let at = 0;
  for (const span of line.spans) {
    const start = Math.max(span.start, at);
    if (span.end <= start) continue;
    if (start > at)
      result.push({ text: decoder.decode(bytes.subarray(at, start)), emphasis: false });
    result.push({ text: decoder.decode(bytes.subarray(start, span.end)), emphasis: true });
    at = span.end;
  }
  if (at < bytes.length) result.push({ text: decoder.decode(bytes.subarray(at)), emphasis: false });
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
