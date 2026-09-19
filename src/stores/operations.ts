// Operations in flight, for the status bar: a label key, optional progress and the op id so
// the user can cancel. The first started operation is the one shown.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

export interface Operation {
  opId: string;
  /** i18n key of the label, e.g. `operations.loadingHistory`. */
  label: string;
  /** Units done so far, when known. */
  done?: number;
  /** Units expected, when known. */
  total?: number;
  startedAt: number;
}

export const useOperationsStore = defineStore("operations", () => {
  const operations = ref<Operation[]>([]);

  const current = computed(() => operations.value[0]);
  const isBusy = computed(() => operations.value.length > 0);

  /** Fraction done of the current operation, or undefined for an indeterminate one. */
  const currentFraction = computed(() => {
    const op = current.value;
    if (!op || op.total === undefined || op.total <= 0 || op.done === undefined) return undefined;
    return Math.min(op.done / op.total, 1);
  });

  function start(opId: string, label: string, total?: number): void {
    finish(opId);
    operations.value = [
      ...operations.value,
      { opId, label, total, done: total === undefined ? undefined : 0, startedAt: Date.now() },
    ];
  }

  function progress(opId: string, done: number, total?: number): void {
    operations.value = operations.value.map((op) =>
      op.opId === opId ? { ...op, done, total: total ?? op.total } : op,
    );
  }

  function finish(opId: string): void {
    operations.value = operations.value.filter((op) => op.opId !== opId);
  }

  return { operations, current, isBusy, currentFraction, start, progress, finish };
});
