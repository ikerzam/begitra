// Keeps Tab inside a panel (dialogs, the palette): the last focusable element wraps to the
// first and back, and a panel with one focusable keeps it. The panel decides what its other
// keys do.

import type { Ref } from "vue";

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(panel: Ref<HTMLElement | null>) {
  /** The focusable elements of the panel, in document order. */
  function focusables(): HTMLElement[] {
    const nodes = panel.value?.querySelectorAll<HTMLElement>(FOCUSABLE);
    return nodes ? Array.from(nodes) : [];
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
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return true;
  }

  return { focusables, onKeydown };
}
