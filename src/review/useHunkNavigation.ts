// n and p move the diff body from hunk header to hunk header. The headers' tops come from
// the virtual rows (a header sits at the top of the viewport when the scroll position equals
// its top), so the keys work whether the header is rendered or not.

import type { Ref } from "vue";

import { useShortcut } from "@/shortcuts/useShortcut";

/** A header within this many pixels of the top counts as the one on screen. */
const TOLERANCE = 1;

/** Index of the first header below the top of the viewport, wrapping to the first header. */
export function nextHunkIndex(offsets: number[], top: number): number {
  if (offsets.length === 0) return -1;
  const index = offsets.findIndex((offset) => offset > top + TOLERANCE);
  return index < 0 ? 0 : index;
}

/** Index of the last header above the top of the viewport, wrapping to the last header. */
export function previousHunkIndex(offsets: number[], top: number): number {
  if (offsets.length === 0) return -1;
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    if ((offsets[index] ?? 0) < top - TOLERANCE) return index;
  }
  return offsets.length - 1;
}

export interface HunkNavigationOptions {
  /** Tops of the hunk header rows. */
  offsets: Ref<number[]>;
  /** The current scroll position of the body. */
  scrollTop: Ref<number>;
  /** Scrolls the body to a position. */
  scrollTo: (top: number) => void;
}

/** Binds n and p to scroll between the hunk headers. */
export function useHunkNavigation(options: HunkNavigationOptions): {
  moveHunk: (step: 1 | -1) => void;
} {
  function moveHunk(step: 1 | -1): void {
    const offsets = options.offsets.value;
    const top = options.scrollTop.value;
    const index = step > 0 ? nextHunkIndex(offsets, top) : previousHunkIndex(offsets, top);
    const offset = offsets[index];
    if (offset !== undefined) options.scrollTo(offset);
  }

  useShortcut("next-hunk", () => moveHunk(1));
  useShortcut("previous-hunk", () => moveHunk(-1));

  return { moveHunk };
}
