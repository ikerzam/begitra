// The changes screen's store: the
// changes model (`changesModel.ts`) of the open repository, with the watches that tie it to the
// repository open. The draft is kept here so that leaving the screen does not lose a
// half-written message.

import { defineStore } from "pinia";
import { watch } from "vue";

import { createChangesModel } from "./changesModel";
import { headTarget, useRepoStore } from "./repo";

export {
  diffTargetOfList,
  lineKey,
  messageOf,
  selectionOf,
  templateBody,
  wholeSelection,
  type ChangeList,
  type ChangeSetState,
  type CommitDraft,
  type FailedWrite,
  type WriteKind,
} from "./changesModel";

export const useChangesStore = defineStore("changes", () => {
  const repo = useRepoStore();
  const model = createChangesModel({
    root: () => repo.repo?.root ?? null,
    // The graph lists the history again with the new commit selected.
    onCommitted: (hash) => repo.reloadWalk(hash),
  });

  // An open or a close empties the lists at once, so no count of the last repository shows
  // meanwhile; the draft goes only when another repository opens, and waits in case the same
  // one comes back. The lists load again once the repository shows its first page of history
  // (or fails to), whatever the layout, after the open's own work, so the top bar and the
  // graph know the counts before the screen opens.
  watch(
    () => repo.repo?.root ?? null,
    (root) => {
      if (root === null) model.clearLists();
      else if (!model.loadedFor(root)) model.reset();
    },
  );
  watch(
    () => repo.repo !== null && (repo.walk !== null || repo.walkError !== null),
    (shown) => {
      if (shown) model.ensureLoaded();
    },
    // A store made after the history showed loads at once too.
    { immediate: true },
  );

  // The staged list is HEAD against the index, so HEAD moving without the index (a soft reset
  // in a terminal) streams it again once the refs listing shows the move. A branch moving
  // elsewhere (a commit in a linked worktree) leaves HEAD, and both lists, alone.
  watch(
    () => (repo.refsLoaded ? headTarget(repo.refs) : undefined),
    (now, before) => {
      const root = repo.repo?.root;
      if (now === undefined || before === undefined || !root || !model.loadedFor(root)) return;
      if (model.loaded.value) model.requestReload("staged", { kind: "full" });
    },
  );

  return model;
});
