// The branch a sidebar panel's ref list selects: the graph's scope ref, or the row a move just
// marked. A move waits a moment before scoping the graph, so that j/k held over the list restarts
// the walk once, on the row the user stops at; the row itself is marked at once. A panel that
// closes meanwhile scopes the graph at once (`flush`), so j and a quick ↵ still scope it.

import { computed, ref, type ComputedRef, type InjectionKey } from "vue";

import type { Ref as GitRef } from "@/ipc/schemas";
import { useGraphStore } from "@/stores/graph";

const SCOPE_DELAY_MS = 120;

export interface BranchSelection {
  /** The full name of the selected ref, pending or applied; null when the graph is not scoped. */
  selectedName: ComputedRef<string | null>;
  /** Marks the ref at once and scopes the graph to it a moment later. */
  select: (ref: GitRef) => void;
  /** Scopes the graph now to a ref still waiting (the panel is closing). */
  flush: () => void;
  /** Drops a pending scope (the list is going away). */
  dispose: () => void;
}

export const branchSelectionKey: InjectionKey<BranchSelection> = Symbol("branchSelection");

export function useBranchSelection(): BranchSelection {
  const graph = useGraphStore();
  const pendingName = ref<string | null>(null);
  let pending: GitRef | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const selectedName = computed(() => {
    if (pendingName.value !== null) return pendingName.value;
    const scope = graph.filters.scope;
    return scope.kind === "ref" ? scope.fullName : null;
  });

  function apply(): void {
    const target = pending;
    dispose();
    if (target) graph.setScope({ kind: "ref", name: target.name, fullName: target.fullName });
  }

  function select(target: GitRef): void {
    pendingName.value = target.fullName;
    pending = target;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(apply, SCOPE_DELAY_MS);
  }

  function flush(): void {
    if (timer !== null) apply();
  }

  function dispose(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
    pendingName.value = null;
  }

  return { selectedName, select, flush, dispose };
}
