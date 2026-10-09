// A read behind one of the commit box's helpers: started when its menu opens, its answer
// dropped and its command cancelled when the menu closes first.

import { ref, type Ref } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";

export type HelperRead<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "failed"; error: AppError };

export function useHelperRead<T>(read: (root: string, opId: string) => Promise<T>) {
  const state = ref({ kind: "idle" }) as Ref<HelperRead<T>>;
  let current: string | null = null;

  /** Reads again for `root`, dropping a read still on its way. */
  async function open(root: string): Promise<void> {
    close();
    const opId = newOpId("commit-helper");
    current = opId;
    state.value = { kind: "loading" };
    try {
      const value = await read(root, opId);
      if (current === opId) state.value = { kind: "ready", value };
    } catch (failure) {
      if (current !== opId) return;
      const error = toAppError(failure);
      state.value = error.code === "op.cancelled" ? { kind: "idle" } : { kind: "failed", error };
    }
  }

  /** Forgets the read; one still on its way is cancelled. */
  function close(): void {
    if (current !== null && state.value.kind === "loading") {
      void ipc.cancelOperation(current).catch(() => undefined);
    }
    current = null;
    state.value = { kind: "idle" };
  }

  return { state, open, close };
}
