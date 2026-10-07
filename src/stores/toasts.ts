// Toasts shown by the host in the corner of the shell. Errors, and a toast that holds the only
// way back to what it names, stay until dismissed; the rest go away after a few seconds. A toast
// in a slot replaces the one there, and a toast can hear that it went.

import { defineStore } from "pinia";
import { ref } from "vue";

import type { ToastKind } from "@/components/types";

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  /** Translated message; empty when `key` names it (the host translates keys). */
  message: string;
  /** i18n key of the message, for stores that hold no translator, with its params. */
  key?: string;
  params?: Record<string, unknown>;
  /** Label of the action button; defaults to "Show git output" when `output` is set. */
  action?: string;
  /** i18n key of the action label, as `key` for the message. */
  actionKey?: string;
  /** Raw output shown when the action is pressed (or under the toast when `onAction` runs). */
  output?: string;
  /** What the action does instead of showing the output; the toast goes once it ran. */
  onAction?: () => void;
  /**
   * Stays until dismissed, as an error does: it holds the only way back to what it names, or
   * says that an action did not do all it was asked.
   */
  sticky?: boolean;
  /** One toast stands per slot: a toast pushed into a taken slot dismisses the one there. */
  slot?: string;
  /**
   * Runs when the toast goes without its action: dismissed, timed out, or replaced in its slot.
   * The action decides on its own what becomes of what the toast held.
   */
  onDismiss?: () => void;
}

export const AUTO_DISMISS_MS = 6_000;

export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<ToastEntry[]>([]);
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function push(toast: Omit<ToastEntry, "id">): number {
    if (toast.slot !== undefined) {
      const taken = toasts.value.find((entry) => entry.slot === toast.slot);
      if (taken) dismiss(taken.id);
    }
    const id = nextId;
    nextId += 1;
    toasts.value = [...toasts.value, { ...toast, id }];
    if (toast.kind !== "error" && toast.sticky !== true) {
      timers.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
    }
    return id;
  }

  /** Takes the toast `id` away and answers it, or nothing when it is gone already. */
  function remove(id: number): ToastEntry | undefined {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    const entry = toasts.value.find((toast) => toast.id === id);
    if (entry) toasts.value = toasts.value.filter((toast) => toast.id !== id);
    return entry;
  }

  function dismiss(id: number): void {
    remove(id)?.onDismiss?.();
  }

  /** Runs the toast's action and takes it away; its `onDismiss` does not run. */
  function act(id: number): void {
    remove(id)?.onAction?.();
  }

  /** The toast standing in `slot` with an action, if any. */
  function actionIn(slot: string): ToastEntry | undefined {
    return toasts.value.find((toast) => toast.slot === slot && toast.onAction !== undefined);
  }

  /** Runs the action of the toast standing in `slot`, as its button does (the palette's). */
  function actSlot(slot: string): void {
    const toast = actionIn(slot);
    if (toast) act(toast.id);
  }

  function clear(): void {
    for (const toast of toasts.value) dismiss(toast.id);
  }

  return { toasts, push, dismiss, act, actionIn, actSlot, clear };
});
