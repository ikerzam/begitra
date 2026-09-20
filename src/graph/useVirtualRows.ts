// Fixed-height virtual rows: only the rows inside the scroll viewport, plus an overscan, are
// rendered, absolutely positioned inside a spacer as tall as the whole list. The range is a
// pure function of the scroll position so the performance spec can measure it without a DOM.

import { computed, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export interface VirtualRange {
  /** First row to render. */
  start: number;
  /** One past the last row to render. */
  end: number;
}

/** Rows to render for a scroll position: the visible ones and `overscan` on each side. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan: number,
): VirtualRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight);
  return {
    start: Math.min(Math.max(first - overscan, 0), count),
    end: Math.min(Math.max(last + overscan, 0), count),
  };
}

export interface VirtualRowsOptions {
  rowHeight: number;
  count: Ref<number>;
  /** Rows rendered beyond each edge of the viewport. Default 10. */
  overscan?: number;
}

export function useVirtualRows(container: Ref<HTMLElement | null>, options: VirtualRowsOptions) {
  const overscan = options.overscan ?? 10;
  const scrollTop = ref(0);
  const viewportHeight = ref(0);

  const range = computed(() =>
    visibleRange(
      scrollTop.value,
      viewportHeight.value,
      options.rowHeight,
      options.count.value,
      overscan,
    ),
  );
  const totalHeight = computed(() => options.count.value * options.rowHeight);

  /** Reads the scroll position and the viewport height from the container. */
  function measure(): void {
    const element = container.value;
    if (!element) return;
    scrollTop.value = element.scrollTop;
    viewportHeight.value = element.clientHeight;
  }

  function rowTop(index: number): number {
    return index * options.rowHeight;
  }

  /** Whether the whole row is inside the viewport. */
  function isVisible(index: number): boolean {
    const top = rowTop(index);
    return (
      top >= scrollTop.value && top + options.rowHeight <= scrollTop.value + viewportHeight.value
    );
  }

  /**
   * Scrolls so that the row is inside the viewport: the nearest edge by default, the middle
   * with `center`. Does nothing when it already is.
   */
  function scrollToIndex(index: number, align: "nearest" | "center" = "nearest"): void {
    const element = container.value;
    if (!element || index < 0) return;
    const top = rowTop(index);
    const bottom = top + options.rowHeight;
    const height = viewportHeight.value || element.clientHeight;
    let next: number | null = null;
    if (align === "center") {
      next = top - Math.max(0, (height - options.rowHeight) / 2);
    } else if (top < scrollTop.value) {
      next = top;
    } else if (bottom > scrollTop.value + height) {
      next = bottom - height;
    }
    if (next === null) return;
    element.scrollTop = Math.max(0, next);
    scrollTop.value = element.scrollTop;
  }

  let observer: ResizeObserver | null = null;

  onMounted(() => {
    measure();
    if (typeof ResizeObserver !== "undefined" && container.value) {
      observer = new ResizeObserver(() => measure());
      observer.observe(container.value);
    }
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return {
    range,
    totalHeight,
    scrollTop,
    viewportHeight,
    /** The container's scroll handler. */
    onScroll: measure,
    measure,
    rowTop,
    isVisible,
    scrollToIndex,
  };
}
