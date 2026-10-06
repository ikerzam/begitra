// The sideways scroll of the diff's long lines without word wrap: one offset for
// the text of every line, both sides together side by side, as far as the widest line reaches
// past the text column. The wheel (a mostly sideways swipe, or Shift and the wheel), ← → by
// eight characters, Shift ← → by a text column and the strip under the rows move it; another
// file starts at the left edge, and a change of layout, width or content keeps it within the
// new reach.

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
  /** The widest text the rendered rows lay out, in px: it corrects the count where a glyph is
   * wider than the count assumed (a symbol drawn as emoji, a fallback font). */
  rendered: Ref<number>;
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
    const counted = (options.widest.value + 1) * options.charWidth.value;
    const laidOut = options.rendered.value + options.charWidth.value;
    return Math.max(0, Math.ceil(Math.max(counted, laidOut) - options.textWidth.value));
  });

  /** Moves the text to `x` px, within the reach (a match the find brings into view). */
  function set(x: number): void {
    const next = Math.round(Math.min(Math.max(x, 0), reach.value));
    if (next !== scrollX.value) scrollX.value = next;
    if (strip.value && strip.value.scrollLeft !== next) strip.value.scrollLeft = next;
  }

  watch(reach, () => set(scrollX.value));
  watch(options.fileKey, () => set(0));

  /**
   * The wheel: Shift and the wheel, or a swipe more sideways than down, and only while there is
   * a reach; a vertical swipe's sideways jitter is left to the page, which keeps its own scroll.
   */
  function onWheel(event: WheelEvent): void {
    const mostlySideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const sideways = mostlySideways ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (sideways === 0) return;
    options.measure();
    if (reach.value === 0) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? LINE_DELTA : 1;
    set(scrollX.value + sideways * unit);
    if (mostlySideways && event.deltaY !== 0) options.scrollRowsBy(event.deltaY * unit);
  }

  /**
   * ← and → move eight characters, Shift ← → a text column less eight (a minified line's
   * 20,000 characters in a few presses); true when the key moved the text.
   */
  function onKey(event: KeyboardEvent): boolean {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    options.measure();
    if (reach.value === 0) return false;
    const char = options.charWidth.value;
    const step = event.shiftKey
      ? Math.max(ARROW_STEP * char, options.textWidth.value - ARROW_STEP * char)
      : ARROW_STEP * char;
    set(scrollX.value + (event.key === "ArrowRight" ? step : -step));
    return true;
  }

  function onStripScroll(): void {
    if (strip.value) set(strip.value.scrollLeft);
  }

  return { scrollX, reach, set, onWheel, onKey, onStripScroll };
}
