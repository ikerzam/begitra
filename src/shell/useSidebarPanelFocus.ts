// How a sidebar panel holds the focus. It takes the focus when it opens, unless a dialog or a
// menu holds it. It closes on Escape (the focus to its rail icon), on a press outside it and the
// rail (the press goes on to what it pressed), and when the focus moves out of it into the layout;
// a dialog, a menu, the scrims and the rail keep it. Closed any other way (⌘B, a row's
// activation), it gives the focus back to where it was before it opened, or leaves it to the
// layout's list. A row the pointer activated closes the panel under the pointer, so the rest of a
// double click is kept from the layout behind.

import { nextTick, onBeforeUnmount, onMounted, type Ref } from "vue";

import { isOverlayTarget } from "@/shortcuts/registry";
import { useShellStore } from "@/stores/shell";

/** How long and how near a press counts as the rest of a double click. */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_PX = 8;

const RAIL = '[data-testid="sidebar-rail"]';

/** Whether a press or the focus there leaves the panel open. */
function staysOpen(target: Element, panel: HTMLElement | null): boolean {
  return (
    panel?.contains(target) === true ||
    target.closest(RAIL) !== null ||
    target.closest("[data-scrim]") !== null ||
    isOverlayTarget(target)
  );
}

/** Keeps the presses of the next moments near (x, y) from reaching anything. */
function swallowPressesNear(x: number, y: number): void {
  const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"];
  const swallow = (event: Event) => {
    if (!(event instanceof MouseEvent)) return;
    if (Math.abs(event.clientX - x) > DOUBLE_CLICK_PX) return;
    if (Math.abs(event.clientY - y) > DOUBLE_CLICK_PX) return;
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of types) document.addEventListener(type, swallow, true);
  setTimeout(() => {
    for (const type of types) document.removeEventListener(type, swallow, true);
  }, DOUBLE_CLICK_MS);
}

export interface SidebarPanelFocus {
  onKeydown: (event: KeyboardEvent) => void;
  onFocusOut: (event: FocusEvent) => void;
  /** A row of the panel's list was activated: the panel closes. */
  activated: () => void;
}

export function useSidebarPanelFocus(
  panel: Ref<HTMLElement | null>,
  railIcon: () => HTMLElement | null,
  focusFirst: () => void,
): SidebarPanelFocus {
  const shell = useShellStore();
  /** What held the focus before the panel opened, outside the rail. */
  let returnTo: HTMLElement | null = null;
  /** The last press inside the panel, to tell a row the pointer activated. */
  let lastPress: { x: number; y: number; at: number } | null = null;

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (isOverlayTarget(event.target)) return;
    event.preventDefault();
    const icon = railIcon();
    icon?.focus();
    shell.closeSidebarPanel(icon ? "focus" : "other");
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (panel.value?.contains(target)) {
      lastPress = { x: event.clientX, y: event.clientY, at: performance.now() };
      return;
    }
    if (staysOpen(target, panel.value)) return;
    shell.closeSidebarPanel("press");
  }

  /** The focus leaving for the layout closes the panel; none to go to is a blur of the window. */
  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (!(next instanceof Element) || staysOpen(next, panel.value)) return;
    shell.closeSidebarPanel("focus");
  }

  function activated(): void {
    const press = lastPress;
    shell.closeSidebarPanel();
    if (press && performance.now() - press.at < DOUBLE_CLICK_MS)
      swallowPressesNear(press.x, press.y);
  }

  onMounted(() => {
    document.addEventListener("pointerdown", onPointerDown, true);
    const before = document.activeElement;
    returnTo =
      before instanceof HTMLElement && before !== document.body && before.closest(RAIL) === null
        ? before
        : null;
    if (isOverlayTarget(before)) return;
    void nextTick(focusFirst);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    if (shell.sidebarCloseReason !== "other" || shell.sidebarPanel !== null) return;
    const active = document.activeElement;
    if (!(active instanceof Node) || !panel.value?.contains(active)) return;
    if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  });

  return { onKeydown, onFocusOut, activated };
}
