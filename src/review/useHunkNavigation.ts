// n and p move the diff body from hunk header to hunk header. The body must be the offset
// parent of the headers (`position: relative`), so that their `offsetTop` and its `scrollTop`
// share an origin: a header sits at the top of the viewport when the two are equal.

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

/** Binds n and p to scroll `body` between its `[data-hunk]` headers. */
export function useHunkNavigation(body: Ref<HTMLElement | null>): {
  moveHunk: (step: 1 | -1) => void;
} {
  function moveHunk(step: 1 | -1): void {
    const element = body.value;
    if (!element) return;
    const headers = [...element.querySelectorAll<HTMLElement>("[data-hunk]")];
    const offsets = headers.map((header) => header.offsetTop);
    const top = element.scrollTop;
    const index = step > 0 ? nextHunkIndex(offsets, top) : previousHunkIndex(offsets, top);
    const offset = offsets[index];
    if (offset !== undefined) element.scrollTop = offset;
  }

  useShortcut("next-hunk", () => moveHunk(1));
  useShortcut("previous-hunk", () => moveHunk(-1));

  return { moveHunk };
}
