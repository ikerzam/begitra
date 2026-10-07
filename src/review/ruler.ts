// The overview ruler at the rows' right edge: what each row draws on it, the ticks at the
// ruler's scale and the slider that stands for the view. The ticks come from one pass over
// the rows, joined per kind wherever they touch in whole pixels, so a kind holds at most one
// tick for every three pixels of the ruler whatever the file's length.

import type { DiffRowModel } from "./diffRows";

/** A row's flags: what it draws on the ruler. */
export const REMOVED = 1;
export const ADDED = 2;
export const MATCH = 4;
export const CURRENT = 8;

/** The least height of a tick, and of the current match's, in px. */
export const MIN_TICK = 2;
export const MIN_CURRENT = 4;
/** The slider's least height, in px: the app's scrollbar thumb's (`--space-6`). */
export const MIN_SLIDER = 32;

export type TickKind = "removed" | "added" | "match" | "current";

/** A tick in the ruler's pixels. */
export interface RulerTick {
  kind: TickKind;
  top: number;
  height: number;
}

/** A match of the find in the open file: its hunk and line, and whether it is the current. */
export interface RulerMatch {
  hunk: number;
  line: number;
  current: boolean;
}

/** The kinds in drawing order, with their flag and least height. */
const KINDS: readonly [TickKind, number, number][] = [
  ["removed", REMOVED, MIN_TICK],
  ["added", ADDED, MIN_TICK],
  ["match", MATCH, MIN_TICK],
  ["current", CURRENT, MIN_CURRENT],
];

/** Absorbs the float error of a scaled position before it is rounded to a pixel. */
const EPSILON = 1e-6;

/** The flags of a hunk's line by its index, from the find's matches. */
function matchFlags(matches: readonly RulerMatch[]): Map<number, Map<number, number>> {
  const byHunk = new Map<number, Map<number, number>>();
  for (const match of matches) {
    let lines = byHunk.get(match.hunk);
    if (!lines) {
      lines = new Map();
      byHunk.set(match.hunk, lines);
    }
    lines.set(match.line, (lines.get(match.line) ?? 0) | MATCH | (match.current ? CURRENT : 0));
  }
  return byHunk;
}

/**
 * What each row draws: its removed and added lines (both sides of a side-by-side pair) and
 * the find's matches on them. Hunk headers and unchanged lines, folded or shown, draw nothing.
 */
export function rowFlags(
  rows: readonly DiffRowModel[],
  matches: readonly RulerMatch[],
): Uint8Array {
  const flags = new Uint8Array(rows.length);
  const byHunk = matches.length > 0 ? matchFlags(matches) : null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    let flag = 0;
    if (row.kind === "line") {
      if (row.line.kind === "removed") flag = REMOVED;
      else if (row.line.kind === "added") flag = ADDED;
      flag |= byHunk?.get(row.hunkIndex)?.get(row.lineIndex) ?? 0;
    } else if (row.kind === "pair") {
      if (row.left?.kind === "removed") flag |= REMOVED;
      if (row.right?.kind === "added") flag |= ADDED;
      const lines = byHunk?.get(row.hunkIndex);
      if (lines) {
        if (row.leftIndex !== null) flag |= lines.get(row.leftIndex) ?? 0;
        if (row.rightIndex !== null) flag |= lines.get(row.rightIndex) ?? 0;
      }
    }
    flags[i] = flag;
  }
  return flags;
}

/**
 * The ticks of rows whose tops are `tops` (a prefix sum, the total last) on a ruler `height`
 * tall, as tall as the viewport: the rows' height maps onto the larger of theirs and the
 * ruler's, so rows that fit draw beside their own lines. A run of flagged rows is one tick,
 * at least its kind's least height and kept inside the ruler; a row whose pixels touch the
 * run's joins it, so two ticks of a kind are a pixel apart at least.
 */
export function rulerTicks(
  flags: Uint8Array,
  tops: readonly number[],
  height: number,
): RulerTick[] {
  const total = tops[tops.length - 1] ?? 0;
  if (height <= 0 || flags.length === 0) return [];
  const span = Math.max(total, height);
  const lists = KINDS.map(() => [] as RulerTick[]);
  // The open run of each kind: its top in pixels, the float end of its rows, its bottom.
  const tops0 = new Float64Array(KINDS.length).fill(-1);
  const ends = new Float64Array(KINDS.length);
  const bottoms = new Float64Array(KINDS.length);

  const close = (k: number): void => {
    if (tops0[k]! < 0) return;
    lists[k]!.push({ kind: KINDS[k]![0], top: tops0[k]!, height: bottoms[k]! - tops0[k]! });
    tops0[k] = -1;
  };

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]!;
    if (flag === 0) continue;
    const y0 = ((tops[i] ?? 0) * height) / span;
    const y1 = ((tops[i + 1] ?? 0) * height) / span;
    for (let k = 0; k < KINDS.length; k += 1) {
      const [, bit, least] = KINDS[k]!;
      if ((flag & bit) === 0) continue;
      const top = Math.max(0, Math.min(Math.floor(y0 + EPSILON), height - least));
      if (tops0[k]! >= 0 && top <= bottoms[k]!) {
        ends[k] = Math.max(ends[k]!, y1);
      } else {
        close(k);
        tops0[k] = top;
        ends[k] = y1;
      }
      bottoms[k] = Math.min(height, Math.max(Math.ceil(ends[k]! - EPSILON), tops0[k]! + least));
    }
  }
  for (let k = 0; k < KINDS.length; k += 1) close(k);
  return lists.flat();
}

/** The slider in the ruler's pixels. */
export interface SliderBox {
  top: number;
  height: number;
}

/**
 * The slider of a view scrolled to `scrollTop` over rows `total` tall, on a ruler `height`
 * tall (the viewport's): the viewport's share of the ruler, at least `MIN_SLIDER`, moving
 * over the ruler less its own height as a thumb does; none while the rows fit.
 */
export function sliderBox(scrollTop: number, total: number, height: number): SliderBox | null {
  if (height <= 0 || total <= height) return null;
  const size = Math.min(height, Math.max(MIN_SLIDER, (height * height) / total));
  const range = total - height;
  const at = Math.min(Math.max(scrollTop, 0), range);
  return { top: (at / range) * (height - size), height: size };
}

/** The scroll position that brings the place at `y` on the ruler to the middle of the view. */
export function scrollForRulerPoint(y: number, total: number, height: number): number {
  if (height <= 0) return 0;
  const centre = (y * Math.max(total, height)) / height;
  return Math.min(Math.max(centre - height / 2, 0), Math.max(0, total - height));
}

/** The scroll position after the slider, `slider` tall, moved `dy` from `from`. */
export function scrollForDrag(
  from: number,
  dy: number,
  total: number,
  height: number,
  slider: number,
): number {
  const range = total - height;
  const travel = height - slider;
  if (range <= 0 || travel <= 0) return 0;
  return Math.min(Math.max(from + (dy * range) / travel, 0), range);
}
