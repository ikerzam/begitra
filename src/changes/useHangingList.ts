// Where a commit box helper's list hangs and when it closes: above its button (under it where
// the window leaves no room above), measured at its natural height and cut to the room; a
// press outside it and its button, and the focus leaving for anything but the button, close
// it. The box never scrolls, so a scroll elsewhere leaves the list where it hangs.

import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

import { hangFrom, viewportSize } from "@/components/placement";

export interface HangingList {
  /** Where the list goes; `height` cuts it to the room, null for its natural height. */
  place: Ref<{ left: number; top: number; height: number | null }>;
  /** Places the list again, once its content changed. */
  measure: () => Promise<void>;
  /** For the list's `focusout`. */
  onFocusOut: (event: FocusEvent) => void;
}

/**
 * `close(refocus)` asks the owner to close the list; `refocus` is false when the focus already
 * went elsewhere.
 */
export function useHangingList(
  panel: Readonly<Ref<HTMLElement | null>>,
  anchor: () => HTMLElement,
  close: (refocus: boolean) => void,
): HangingList {
  const place = ref<{ left: number; top: number; height: number | null }>({
    left: 0,
    top: 0,
    height: null,
  });

  async function measure(): Promise<void> {
    place.value = { ...place.value, height: null };
    await nextTick();
    if (!panel.value) return;
    const box = panel.value.getBoundingClientRect();
    const size = { width: box.width, height: box.height };
    place.value = hangFrom(anchor().getBoundingClientRect(), size, viewportSize(), "top");
  }

  function onFocusOut(event: FocusEvent): void {
    // No next element: the window lost the focus, or a press outside, which closes it itself.
    const next = event.relatedTarget;
    if (!(next instanceof Node)) return;
    if (panel.value?.contains(next) || anchor().contains(next)) return;
    close(false);
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (panel.value?.contains(target) || anchor().contains(target)) return;
    close(true);
  }

  function onResize(): void {
    void measure();
  }

  onMounted(() => {
    void measure();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
  });
  onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("resize", onResize);
  });

  return { place, measure, onFocusOut };
}
