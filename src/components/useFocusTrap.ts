// Keeps Tab inside a panel (dialogs, the palette): the last focusable element wraps to the
// first and back, focus on the panel itself starts the cycle from an end, and a panel with one
// focusable keeps it. The panel decides what its other keys do.

import type { Ref } from "vue";

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Whether the engine lays elements out; jsdom does not, so there every element counts as rendered. */
function hasLayout(): boolean {
  return document.documentElement.getClientRects().length > 0;
}

/** Whether `element` is rendered: no `hidden` ancestor and, where there is layout, a box. */
export function isRendered(element: HTMLElement, layout = hasLayout()): boolean {
  if (element.closest("[hidden]")) return false;
  if (!layout) return true;
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ visibilityProperty: true });
  }
  return element.getClientRects().length > 0;
}

export function useFocusTrap(panel: Ref<HTMLElement | null>) {
  /** The rendered focusable elements of the panel, in document order. */
  function focusables(): HTMLElement[] {
    const nodes = panel.value?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes) return [];
    const layout = hasLayout();
    return Array.from(nodes).filter((element) => isRendered(element, layout));
  }

  /** Handles a Tab keydown from inside the panel; returns whether the event was a Tab. */
  function onKeydown(event: KeyboardEvent): boolean {
    if (event.key !== "Tab") return false;
    const list = focusables();
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return true;
    }
    const active = document.activeElement;
    const inside = list.some((element) => element === active);
    const target = event.shiftKey
      ? !inside || active === first
        ? last
        : null
      : !inside || active === last
        ? first
        : null;
    if (target) {
      event.preventDefault();
      target.focus();
    }
    return true;
  }

  /**
   * The element a panel focuses when it opens: the one marked `data-autofocus` (or, when
   * the mark sits on a wrapper such as a `Select`'s, its first focusable descendant), else
   * the first focusable, else the panel itself.
   */
  function autofocusTarget(): HTMLElement | null {
    const marked = panel.value?.querySelector<HTMLElement>("[data-autofocus]") ?? null;
    if (marked) {
      if (marked.matches(FOCUSABLE)) return marked;
      const inside = marked.querySelector<HTMLElement>(FOCUSABLE);
      if (inside) return inside;
    }
    return focusables()[0] ?? panel.value ?? null;
  }

  return { focusables, onKeydown, autofocusTarget };
}
