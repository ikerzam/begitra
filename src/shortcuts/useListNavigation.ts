// Keyboard navigation for lists: arrows and j/k move the selection, Home/End jump, Enter
// activates, and the selected row is scrolled into view. The list owns the selection index;
// the composable only moves it and tells the list which row to reveal.

import { type Ref } from "vue";

export interface ListNavigationOptions {
  /** Number of rows. */
  count: Ref<number>;
  /** Selected row index, or -1 for none. */
  selected: Ref<number>;
  /** Called with the activated index on Enter. */
  onActivate?: (index: number) => void;
  /** Finds the element of a row, so it can be scrolled into view. */
  rowElement?: (index: number) => Element | null | undefined;
  /** Wrap around at both ends. Default: stop at the ends. */
  loop?: boolean;
}

export interface ListNavigation {
  /** Handles a keydown from the list container; returns whether it was consumed. */
  onKeydown: (event: KeyboardEvent) => boolean;
  /** Selects `index` (clamped) and scrolls it into view. */
  select: (index: number) => void;
  moveBy: (delta: number) => void;
}

const nextKeys = new Set(["ArrowDown", "j"]);
const previousKeys = new Set(["ArrowUp", "k"]);

export function useListNavigation(options: ListNavigationOptions): ListNavigation {
  const clamp = (index: number): number => {
    const count = options.count.value;
    if (count <= 0) return -1;
    if (options.loop) return ((index % count) + count) % count;
    return Math.min(Math.max(index, 0), count - 1);
  };

  const select = (index: number): void => {
    const next = clamp(index);
    options.selected.value = next;
    if (next >= 0) {
      const element = options.rowElement?.(next);
      element?.scrollIntoView?.({ block: "nearest" });
    }
  };

  const moveBy = (delta: number): void => {
    const current = options.selected.value;
    select(current < 0 ? (delta > 0 ? 0 : options.count.value - 1) : current + delta);
  };

  const onKeydown = (event: KeyboardEvent): boolean => {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (nextKeys.has(event.key)) {
      moveBy(1);
    } else if (previousKeys.has(event.key)) {
      moveBy(-1);
    } else if (event.key === "Home") {
      select(0);
    } else if (event.key === "End") {
      select(options.count.value - 1);
    } else if (event.key === "Enter") {
      if (options.selected.value >= 0) options.onActivate?.(options.selected.value);
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  };

  return { onKeydown, select, moveBy };
}
