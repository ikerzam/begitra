// The changes the changes screen's components work on (ChangeLists, CommitBox, ChangesViewer):
// the open repository's store, or the model a `ChangesScope` above them provides (the folder
// view's, one per repository). Conflicts, the operation in progress and review marks belong to
// the open repository alone.

import { inject, provide, type InjectionKey } from "vue";

import { useChangesStore } from "@/stores/changes";
import type { ChangesView } from "@/stores/changesModel";

export type { ChangesView };

const changesKey: InjectionKey<ChangesView> = Symbol("changes");

/** Makes `view` the changes of the components below. */
export function provideChanges(view: ChangesView): void {
  provide(changesKey, view);
}

/** The changes this component works on. */
export function useChanges(): ChangesView {
  return inject(changesKey, null) ?? useChangesStore();
}

/** Whether the changes are the open repository's, whose conflicts and operation show. */
export function useOpenRepositoryChanges(): boolean {
  return inject(changesKey, null) === null;
}
