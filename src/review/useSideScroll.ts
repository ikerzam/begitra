// The sideways scroll of the diff's long lines without word wrap: one offset for
// the text of every line, both sides together side by side, as far as the widest line reaches
// past the text column. The wheel (deltaX, or Shift and deltaY), ← → by eight characters and
// the strip at the foot of the rows move it; another file starts at the left edge, and a
// change of layout, width or content keeps it within the new reach.

import { computed, ref, watch, type Ref, type ShallowRef } from "vue";

/** Characters an arrow key moves the text. */
const ARROW_STEP = 8;
/** A wheel delta counted in lines (`deltaMode` 1) moves a row's height per line. */
const LINE_DELTA = 20;

export interface SideScrollOptions {
  /** The text column's width in px (the body less its gutters, halved side by side). */
  textWidth: Ref<number>;
  /** The mono character's width in px. */
  charWidth: Ref<number>;
  /** The widest line the rows show, in columns. */
  widest: Ref<number>;
  /** Word wrap is on: every line shows whole and nothing moves. */
  wrap: Ref<boolean>;
  /** The file shown; another one starts at the left edge. */
  fileKey: Ref<string>;
  /** Reads the widths again before an input moves the text (a width that changed without a
   * resize event, as the zoom or a test can change it). */
  measure: () => void;
  /** Scrolls the rows vertically: a diagonal swipe keeps its vertical part. */
  scrollRowsBy: (dy: number) => void;
  /** The strip at the foot of the rows; its `scrollLeft` is the offset, one for one. */
  strip: Readonly<ShallowRef<HTMLElement | null>>;
}

export function useSideScroll(options: SideScrollOptions) {
  const scrollX = ref(0);
  const strip = options.strip;

  /** How far the text moves: the widest line and one column more, past the text column. */
  const reach = computed(() => {
    if (options.wrap.value || options.widest.value === 0) return 0;
    const width = (options.widest.value + 1) * options.charWidth.value;
    return Math.max(0, Math.ceil(width - options.textWidth.value));
  });

  function set(x: number): void {
    const next = Math.round(Math.min(Math.max(x, 0), reach.value));
    if (next !== scrollX.value) scrollX.value = next;
    if (strip.value && strip.value.scrollLeft !== next) strip.value.scrollLeft = next;
  }

  watch(reach, () => set(scrollX.value));
  watch(options.fileKey, () => set(0));

  /** The wheel: only a sideways delta is taken, and only while there is a reach. */
  function onWheel(event: WheelEvent): void {
    const sideways = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (sideways === 0) return;
    options.measure();
    if (reach.value === 0) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? LINE_DELTA : 1;
    set(scrollX.value + sideways * unit);
    if (event.deltaX !== 0 && event.deltaY !== 0) options.scrollRowsBy(event.deltaY * unit);
  }

  /** ← and → without modifiers move eight characters; true when the key moved the text. */
  function onKey(event: KeyboardEvent): boolean {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
    options.measure();
    if (reach.value === 0) return false;
    const step = ARROW_STEP * options.charWidth.value;
    set(scrollX.value + (event.key === "ArrowRight" ? step : -step));
    return true;
  }

  function onStripScroll(): void {
    if (strip.value) set(strip.value.scrollLeft);
  }

  return { scrollX, reach, onWheel, onKey, onStripScroll };
}
