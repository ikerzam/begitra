// The branch the sidebar's ref lists select: the graph's scope ref, or the row a move just marked.
// A move waits a moment before scoping the graph, so that j/k held over the lists restarts the walk
// once, on the row the user stops at; the row itself is marked at once. The sidebar's three ref
// lists share one, so a move from one list into the next leaves a single pending scope.

import { computed, ref, type ComputedRef, type InjectionKey } from "vue";

import type { Ref as GitRef } from "@/ipc/schemas";
import { useGraphStore } from "@/stores/graph";

const SCOPE_DELAY_MS = 120;

export interface BranchSelection {
  /** The full name of the selected ref, pending or applied; null when the graph is not scoped. */
  selectedName: ComputedRef<string | null>;
  /** Marks the ref at once and scopes the graph to it a moment later. */
  select: (ref: GitRef) => void;
  /** Drops a pending scope (the lists are going away). */
  dispose: () => void;
}

export const branchSelectionKey: InjectionKey<BranchSelection> = Symbol("branchSelection");

export function useBranchSelection(): BranchSelection {
  const graph = useGraphStore();
  const pendingName = ref<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const selectedName = computed(() => {
    if (pendingName.value !== null) return pendingName.value;
    const scope = graph.filters.scope;
    return scope.kind === "ref" ? scope.fullName : null;
  });

  function select(target: GitRef): void {
    pendingName.value = target.fullName;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pendingName.value = null;
      graph.setScope({ kind: "ref", name: target.name, fullName: target.fullName });
    }, SCOPE_DELAY_MS);
  }

  function dispose(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return { selectedName, select, dispose };
}
