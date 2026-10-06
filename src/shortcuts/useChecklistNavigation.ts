// Keyboard navigation of a list of checkboxes that is one tab stop: the arrows and j/k move the
// focus between the boxes that can be ticked, Home and End go to the first and the last, Space
// ticks (the native checkbox's own key), and the box the focus left stays the tab stop.

import { computed, ref, type ComputedRef, type Ref } from "vue";

import { rowStep } from "./useListNavigation";

export interface ChecklistNavigation {
  /** The key of the box that is the list's tab stop: the focused one while listed, else the first. */
  stop: ComputedRef<string | null>;
  onFocusin: (event: FocusEvent) => void;
  onKeydown: (event: KeyboardEvent) => void;
  /** Focuses the tab stop's box; false when the list has none. */
  focusStop: () => boolean;
}

/**
 * `keys` are the boxes that can be ticked, in the list's order, each row carrying its key in the
 * `data-<attribute>` of an element around its box; `list` holds the rows.
 */
export function useChecklistNavigation(options: {
  keys: ComputedRef<string[]>;
  list: Readonly<Ref<HTMLElement | null>>;
  attribute: string;
}): ChecklistNavigation {
  const focused = ref<string | null>(null);
  const stop = computed(() =>
    focused.value !== null && options.keys.value.includes(focused.value)
      ? focused.value
      : (options.keys.value[0] ?? null),
  );

  const boxes = () =>
    options.list.value?.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]:not(:disabled)',
    ) ?? [];

  function focusAt(index: number): boolean {
    const key = options.keys.value[index];
    const box = boxes()[index];
    if (key === undefined || !box) return false;
    focused.value = key;
    box.focus();
    return true;
  }

  function onFocusin(event: FocusEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const key = target.closest<HTMLElement>(`[data-${options.attribute}]`)?.dataset[
      options.attribute
    ];
    if (key !== undefined) focused.value = key;
  }

  function onKeydown(event: KeyboardEvent): void {
    const last = options.keys.value.length - 1;
    const at = stop.value === null ? -1 : options.keys.value.indexOf(stop.value);
    const step = rowStep(event);
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    let next: number;
    if (step !== 0) next = Math.max(0, Math.min(at + step, last));
    else if (plain && event.key === "Home") next = 0;
    else if (plain && event.key === "End") next = last;
    else return;
    event.preventDefault();
    focusAt(next);
  }

  function focusStop(): boolean {
    return stop.value !== null && focusAt(options.keys.value.indexOf(stop.value));
  }

  return { stop, onFocusin, onKeydown, focusStop };
}
