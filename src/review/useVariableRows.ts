// Virtual rows of variable height: the tops come from a prefix sum over the heights, the
// visible range from a binary search on the scroll position. The pure function is shared
// with the performance spec; the composable measures the container like the graph's.

import { computed, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export interface RowRange {
  start: number;
  end: number;
}

/** Prefix sums: `tops[i]` is where row `i` starts, `tops[n]` the total height. */
export function rowTops(heights: readonly number[]): number[] {
  const tops = new Array<number>(heights.length + 1);
  let y = 0;
  for (let i = 0; i < heights.length; i += 1) {
    tops[i] = y;
    y += heights[i] ?? 0;
  }
  tops[heights.length] = y;
  return tops;
}

/** The row containing `y` (the last row for a `y` past the end). */
export function rowAt(tops: readonly number[], y: number): number {
  const count = tops.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((tops[middle] ?? 0) <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Rows to render for a scroll position with `overscan` rows on each side. */
export function visibleRowRange(
  tops: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): RowRange {
  const count = tops.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const first = rowAt(tops, top);
  let last = rowAt(tops, top + Math.max(0, viewportHeight)) + 1;
  if (last > count) last = count;
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + overscan),
  };
}

export function useVariableRows(
  container: Ref<HTMLElement | null>,
  heights: Ref<readonly number[]>,
  overscan = 10,
) {
  const scrollTop = ref(0);
  const viewportHeight = ref(0);
  const tops = computed(() => rowTops(heights.value));
  const totalHeight = computed(() => tops.value[tops.value.length - 1] ?? 0);
  const range = computed(() =>
    visibleRowRange(tops.value, scrollTop.value, viewportHeight.value, overscan),
  );

  function measure(): void {
    const element = container.value;
    if (!element) return;
    scrollTop.value = element.scrollTop;
    viewportHeight.value = element.clientHeight;
  }

  function rowTop(index: number): number {
    return tops.value[index] ?? 0;
  }

  function rowHeight(index: number): number {
    return heights.value[index] ?? 0;
  }

  /** Scrolls so that row `index` starts at the top of the viewport. */
  function scrollToTop(index: number): void {
    const element = container.value;
    if (!element) return;
    element.scrollTop = rowTop(index);
    scrollTop.value = element.scrollTop;
  }

  /** Scrolls the least distance that brings row `index` fully into view. */
  function scrollIntoView(index: number): void {
    const element = container.value;
    if (!element) return;
    const top = rowTop(index);
    const bottom = top + rowHeight(index);
    const height = viewportHeight.value || element.clientHeight;
    if (top < scrollTop.value) element.scrollTop = top;
    else if (bottom > scrollTop.value + height) element.scrollTop = bottom - height;
    else return;
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
    tops,
    onScroll: measure,
    measure,
    rowTop,
    rowHeight,
    scrollToTop,
    scrollIntoView,
  };
}
