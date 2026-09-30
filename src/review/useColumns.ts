// The text column of the diff body: its width in px (the body minus its gutters, halved side
// by side), the width of the mono "M" measured once on a canvas, and the characters per line
// when wrapping (120 until the body is mounted). A ResizeObserver refreshes them, and
// `measure` does on demand for a width that changed without a resize event.

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
  const charWidth = ref(FALLBACK_CHAR_WIDTH);
  const textWidth = ref(0);
  let observer: ResizeObserver | null = null;

  function measure(): void {
    const element = body.value;
    if (!element) return;
    textWidth.value = textColumnWidth(element.clientWidth, layout.value);
    columns.value = Math.max(MIN_COLUMNS, Math.floor(textWidth.value / charWidth.value));
  }

  /** The mono "M" on a canvas, again when a font loads (Geist Mono can land after mount). */
  function measureChar(): void {
    const probe = document.createElement("canvas").getContext("2d");
    if (probe && body.value) {
      probe.font = getComputedStyle(body.value).font || "12px monospace";
      const measured = probe.measureText("M").width;
      if (measured > 0) charWidth.value = measured;
    }
    measure();
  }

  onMounted(() => {
    measureChar();
    document.fonts?.addEventListener?.("loadingdone", measureChar);
    if (typeof ResizeObserver !== "undefined" && body.value) {
      observer = new ResizeObserver(() => measure());
      observer.observe(body.value);
    }
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    document.fonts?.removeEventListener?.("loadingdone", measureChar);
  });

  watch(layout, measure);

  return { columns, charWidth, textWidth, measure };
}
