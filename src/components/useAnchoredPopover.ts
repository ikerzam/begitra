// A popover anchored under a control of the graph's filter bar (the path, the code search, the
// branches matching a pattern): fixed under the control (above it, or turned to its right edge,
// when the window is short of room), so the bar's sideways scroll never cuts it. A press or a
// scroll outside closes it, and so does the focus leaving it for anything but its control, which
// leaves the focus where it went (Tab past its last button). Its field takes the focus once the
// popover is placed: hidden until then, it would refuse it.

import { nextTick, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

import { hangFrom, viewportSize } from "./placement";

export interface AnchoredPopover {
  /** Where it hangs from the control; null until measured, and hidden until then. */
  box: Ref<{ left: number; top: number } | null>;
  /** For the root's `focusout`. */
  onFocusOut: (event: FocusEvent) => void;
}

/**
 * `close(refocus)` asks the owner to close the popover; `refocus` is false when the focus already
 * went elsewhere, and the owner then leaves it there. `focus` runs once the popover is placed.
 */
export function useAnchoredPopover(
  root: Readonly<Ref<HTMLElement | null>>,
  anchor: () => HTMLElement | null | undefined,
  close: (refocus: boolean) => void,
  focus?: (root: HTMLElement) => void,
): AnchoredPopover {
  const box = ref<{ left: number; top: number } | null>(null);

  function place(): void {
    const control = anchor();
    if (!root.value || !control) return;
    const size = root.value.getBoundingClientRect();
    const spot = hangFrom(
      control.getBoundingClientRect(),
      { width: size.width, height: size.height },
      viewportSize(),
    );
    box.value = { left: spot.left, top: spot.top };
  }

  function onPointerDownOutside(event: PointerEvent): void {
    if (!root.value || !(event.target instanceof Node)) return;
    if (root.value.contains(event.target) || anchor()?.contains(event.target)) return;
    close(true);
  }

  function onScroll(event: Event): void {
    if (event.target instanceof Node && root.value?.contains(event.target)) return;
    close(true);
  }

  function onResize(): void {
    void nextTick(place);
  }

  function onFocusOut(event: FocusEvent): void {
    // No next element: the window lost the focus, or a press outside, which closes it itself.
    const next = event.relatedTarget;
    if (!(next instanceof Node)) return;
    if (root.value?.contains(next) || anchor()?.contains(next)) return;
    close(false);
  }

  onMounted(() => {
    document.addEventListener("pointerdown", onPointerDownOutside, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    place();
    if (focus) {
      void nextTick(() => {
        if (root.value) focus(root.value);
      });
    }
  });

  onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", onPointerDownOutside, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
  });

  return { box, onFocusOut };
}
