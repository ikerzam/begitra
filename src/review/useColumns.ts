// Characters per line of the diff body when wrapping: the text column of the layout (the
// body minus its gutters, halved side by side) over the width of the mono "M", measured once
// on a canvas and refreshed by a ResizeObserver; 120 until the body is mounted.

import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";

import type { DiffLayout } from "./diffRows";

/** Gutter widths of `DiffRow`: two 44px number columns and the 22px marker. */
const NUMBER_GUTTER = 44;
const MARKER_GUTTER = 22;
const FALLBACK_CHAR_WIDTH = 7.2;
const MIN_COLUMNS = 20;

/** The text column width in px for `layout`, given the body's width. */
export function textColumnWidth(bodyWidth: number, layout: DiffLayout): number {
  const gutters =
    layout === "unified" ? NUMBER_GUTTER * 2 + MARKER_GUTTER : (NUMBER_GUTTER + MARKER_GUTTER) * 2;
  const width = Math.max(0, bodyWidth - gutters);
  return layout === "unified" ? width : width / 2;
}

export function useColumns(body: Ref<HTMLElement | null>, layout: Ref<DiffLayout>) {
  const columns = ref(120);
  let charWidth = FALLBACK_CHAR_WIDTH;
  let observer: ResizeObserver | null = null;

  function measure(): void {
    const element = body.value;
    if (!element) return;
    const width = textColumnWidth(element.clientWidth, layout.value);
    columns.value = Math.max(MIN_COLUMNS, Math.floor(width / charWidth));
  }

  onMounted(() => {
    const probe = document.createElement("canvas").getContext("2d");
    if (probe && body.value) {
      probe.font = getComputedStyle(body.value).font || "12px monospace";
      const measured = probe.measureText("M").width;
      if (measured > 0) charWidth = measured;
    }
    measure();
    if (typeof ResizeObserver !== "undefined" && body.value) {
      observer = new ResizeObserver(() => measure());
      observer.observe(body.value);
    }
  });

  onBeforeUnmount(() => observer?.disconnect());

  watch(layout, measure);

  return { columns, measure };
}
