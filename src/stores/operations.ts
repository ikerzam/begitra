// Operations in flight, for the status bar: a label key, optional progress and the op id so
// the user can cancel. The operation shown is the newest one the user started; a background
// read (the working tree's lists, a scan, the Overview's and the dashboard's reads) shows only
// while nothing else runs, so it never hides the label of an action started after it.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

export interface Operation {
  opId: string;
  /** i18n key of the label, e.g. `operations.loadingHistory`. */
  label: string;
  /** Params of the label (`{ branch, remote }` for "Pushing {branch} to {remote}"). */
  params?: Record<string, string>;
  /** A line after the label, such as git's own progress ("Writing objects: 45% (12/27)"). */
  detail?: string;
  /** The operation can be cancelled from the status bar (Escape). */
  cancellable?: boolean;
  /** The network command Escape cancels, for the status bar's hint. */
  cancels?: NetworkCommand;
  /** Units done so far, when known. */
  done?: number;
  /** Units expected, when known. */
  total?: number;
  /** A read nobody waits on: shown only while no other operation runs. */
  background?: boolean;
  startedAt: number;
}

export interface OperationExtra {
  params?: Record<string, string>;
  cancellable?: boolean;
  cancels?: NetworkCommand;
  background?: boolean;
}

/** The network commands the status bar can name. */
export type NetworkCommand = "fetch" | "pull" | "push";

export const useOperationsStore = defineStore("operations", () => {
  const operations = ref<Operation[]>([]);

  /** The newest operation the user started, else the oldest background read. */
  const current = computed(() => {
    const ops = operations.value;
    for (let at = ops.length - 1; at >= 0; at -= 1) {
      if (ops[at]?.background !== true) return ops[at];
    }
    return ops[0];
  });
  const isBusy = computed(() => operations.value.length > 0);

  /** Fraction done of the current operation, or undefined for an indeterminate one. */
  const currentFraction = computed(() => {
    const op = current.value;
    if (!op || op.total === undefined || op.total <= 0 || op.done === undefined) return undefined;
    return Math.min(op.done / op.total, 1);
  });

  function start(opId: string, label: string, total?: number, extra: OperationExtra = {}): void {
    finish(opId);
    operations.value = [
      ...operations.value,
      {
        opId,
        label,
        params: extra.params,
        cancellable: extra.cancellable,
        cancels: extra.cancels,
        background: extra.background,
        total,
        done: total === undefined ? undefined : 0,
        startedAt: Date.now(),
      },
    ];
  }

  /** Replaces the parameters of an operation's label (a bulk operation's count). */
  function setParams(opId: string, params: Record<string, string>): void {
    operations.value = operations.value.map((op) => (op.opId === opId ? { ...op, params } : op));
  }

  /** Replaces the detail line of an operation (the latest progress line). */
  function setDetail(opId: string, detail: string): void {
    operations.value = operations.value.map((op) => (op.opId === opId ? { ...op, detail } : op));
  }

  function progress(opId: string, done: number, total?: number): void {
    operations.value = operations.value.map((op) =>
      op.opId === opId ? { ...op, done, total: total ?? op.total } : op,
    );
  }

  function finish(opId: string): void {
    operations.value = operations.value.filter((op) => op.opId !== opId);
  }

  return {
    operations,
    current,
    isBusy,
    currentFraction,
    start,
    setParams,
    setDetail,
    progress,
    finish,
  };
});
