// When the hover card shows: after the pointer rests 600 ms on a row; it stays while the
// pointer moves into the card and goes when it leaves both, on Escape, on scroll (the rows
// report a leave) and when the selection changes.

import { onBeforeUnmount, ref } from "vue";

/** Rest time on a row before the hover card shows. */
export const HOVER_DELAY_MS = 600;
/** Grace period to cross from the row into the card. */
export const HOVER_GRACE_MS = 150;

export interface HoverTarget {
  index: number;
  rect: DOMRect;
}

export function useHoverCard() {
  const target = ref<HoverTarget | null>(null);
  let showTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers(): void {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = undefined;
    hideTimer = undefined;
  }

  function hide(): void {
    clearTimers();
    target.value = null;
  }

  function onRowEnter(index: number, rect: DOMRect): void {
    clearTimers();
    if (target.value && target.value.index !== index) target.value = null;
    if (target.value) return;
    showTimer = setTimeout(() => {
      target.value = { index, rect };
    }, HOVER_DELAY_MS);
  }

  function scheduleHide(): void {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HOVER_GRACE_MS);
  }

  function onCardEnter(): void {
    clearTimeout(hideTimer);
  }

  onBeforeUnmount(clearTimers);

  return {
    target,
    onRowEnter,
    onRowLeave: scheduleHide,
    onCardEnter,
    onCardLeave: scheduleHide,
    hide,
  };
}
