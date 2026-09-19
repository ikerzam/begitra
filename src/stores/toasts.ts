// Toasts shown by the host in the corner of the shell. Errors stay until dismissed; the rest
// go away after a few seconds.

import { defineStore } from "pinia";
import { ref } from "vue";

import type { ToastKind } from "@/components/types";

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  /** Translated message. */
  message: string;
  /** Label of the action button; defaults to "Show git output" when `output` is set. */
  action?: string;
  /** Raw output shown when the action is pressed. */
  output?: string;
}

export const AUTO_DISMISS_MS = 6_000;

export const useToastsStore = defineStore("toasts", () => {
  const toasts = ref<ToastEntry[]>([]);
  let nextId = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function push(toast: Omit<ToastEntry, "id">): number {
    const id = nextId;
    nextId += 1;
    toasts.value = [...toasts.value, { ...toast, id }];
    if (toast.kind !== "error") {
      timers.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS),
      );
    }
    return id;
  }

  function dismiss(id: number): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    toasts.value = toasts.value.filter((toast) => toast.id !== id);
  }

  function clear(): void {
    for (const toast of toasts.value) dismiss(toast.id);
  }

  return { toasts, push, dismiss, clear };
});
