// The operation in progress (a merge, a rebase, a cherry-pick or a revert stopped on
// conflicts, or a stash apply that conflicted) and its conflicted paths, for the banner on
// every screen and the conflicts list of the changes screen; continue, skip and abort through
// the sequencer commands, and "mark resolved" (`git add`) per file. Reloaded after every
// write that may have stopped, and when the watcher reports refs, status or index.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { Conflict, OperationState, Outcome, SequencerAction } from "@/ipc/schemas";

import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";

/** The status bar label of each sequencer action. */
const actionLabels: Record<SequencerAction, string> = {
  continue: "operations.continuing",
  skip: "operations.skipping",
  abort: "operations.aborting",
};

export const useSequencerStore = defineStore("sequencer", () => {
  const repo = useRepoStore();
  const operations = useOperationsStore();

  const operation = ref<OperationState>("none");
  const conflicts = ref<Conflict[]>([]);
  const loaded = ref(false);
  const busy = ref(false);
  /** The last failed sequencer action or resolution, for the banner. */
  const error = ref<AppError | null>(null);
  /** The abort confirmation is up (the banner's button or the palette). */
  const abortPrompt = ref(false);
  let serial = 0;

  /** Something is in progress: an operation with its state files, or conflicted paths. */
  const inProgress = computed(() => operation.value !== "none" || conflicts.value.length > 0);
  const conflictCount = computed(() => conflicts.value.length);
  /** Continue needs every conflict resolved (git refuses otherwise, with its message). */
  const canContinue = computed(() => operation.value !== "none" && conflicts.value.length === 0);
  /** Skip exists for a rebase, a cherry-pick and a revert (a merge has none). */
  const canSkip = computed(
    () =>
      operation.value === "rebase" ||
      operation.value === "cherry-pick" ||
      operation.value === "revert",
  );

  /** Reads the state and the conflicted paths. */
  async function load(): Promise<void> {
    const root = repo.repo?.root;
    if (!root || repo.state.kind !== "ready") {
      operation.value = "none";
      conflicts.value = [];
      loaded.value = false;
      return;
    }
    serial += 1;
    const mine = serial;
    try {
      const [state, paths] = await Promise.all([ipc.operationState(root), ipc.conflicts(root)]);
      if (mine !== serial) return;
      operation.value = state;
      conflicts.value = paths;
      loaded.value = true;
    } catch (failure) {
      if (mine !== serial) return;
      error.value = toAppError(failure);
    }
  }

  /** An outcome of a write that may stop: the state follows it. */
  function absorb(outcome: Outcome): void {
    if (outcome.kind === "conflicts") {
      conflicts.value = outcome.conflicts;
    }
    void load();
  }

  /** Continues, skips or aborts; the graph lists the history again after a step that moved HEAD. */
  async function act(action: SequencerAction): Promise<Outcome | null> {
    const root = repo.repo?.root;
    if (!root || busy.value) return null;
    busy.value = true;
    error.value = null;
    const opId = newOpId("sequencer");
    operations.start(opId, actionLabels[action]);
    try {
      const outcome = await ipc.sequencer(root, action, opId);
      absorb(outcome);
      if (outcome.kind !== "conflicts") {
        void repo.refreshRefs();
        repo.restartWalk(repo.walkScope, repo.walkFilter, outcome.hash ?? undefined);
      }
      return outcome;
    } catch (failure) {
      error.value = toAppError(failure);
      void load();
      return null;
    } finally {
      operations.finish(opId);
      busy.value = false;
    }
  }

  /** Marks paths resolved (`git add`); the conflicts list follows. */
  async function markResolved(paths: string[]): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root || paths.length === 0 || busy.value) return false;
    busy.value = true;
    error.value = null;
    const opId = newOpId("resolved");
    operations.start(opId, "operations.markingResolved");
    try {
      await ipc.markResolved(root, paths, opId);
      await load();
      return true;
    } catch (failure) {
      error.value = toAppError(failure);
      return false;
    } finally {
      operations.finish(opId);
      busy.value = false;
    }
  }

  function dismissError(): void {
    error.value = null;
  }

  function askAbort(): void {
    if (operation.value !== "none") abortPrompt.value = true;
  }

  function dismissAbort(): void {
    abortPrompt.value = false;
  }

  /** The watcher: refs (a HEAD move), status and index changes may start or end an operation. */
  function onRepoChanged(kinds: string[]): void {
    if (repo.state.kind !== "ready" || busy.value) return;
    if (kinds.includes("refs") || kinds.includes("status") || kinds.includes("index")) {
      void load();
    }
  }

  return {
    operation,
    conflicts,
    loaded,
    busy,
    error,
    abortPrompt,
    inProgress,
    conflictCount,
    canContinue,
    canSkip,
    load,
    absorb,
    act,
    markResolved,
    dismissError,
    askAbort,
    dismissAbort,
    onRepoChanged,
  };
});
