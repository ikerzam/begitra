// The operation in progress (a merge, a rebase, a cherry-pick or a revert stopped on
// conflicts, or a stash apply that conflicted) with its two sides by name, its conflicted paths
// and the stash git's autostash holds aside while it is stopped, for the banner on every screen
// and the conflicts list of the changes screen; continue,
// skip and abort through the sequencer commands, "mark resolved" (`git add`) per file, and a
// file taken whole from one side (asked once, with "Undo" in the toast, which closes when the
// sequencer runs). Reloaded after every branch or history write that may have stopped, and when
// the watcher reports refs or an index change that moved an unmerged entry.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { sideParams } from "@/branches/sides";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type {
  Conflict,
  OperationSides,
  OperationState,
  Outcome,
  RepoChanged,
  SequencerAction,
  Side,
} from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { baseName } from "@/shell/format";

import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { useToastsStore } from "./toasts";

/** The status bar label of each sequencer action. */
const actionLabels: Record<SequencerAction, string> = {
  continue: "operations.continuing",
  skip: "operations.skipping",
  abort: "operations.aborting",
};

export const useSequencerStore = defineStore("sequencer", () => {
  const repo = useRepoStore();
  const operations = useOperationsStore();
  const toasts = useToastsStore();

  const operation = ref<OperationState>("none");
  /** The operation's two sides by name; null without an operation. */
  const sides = ref<OperationSides | null>(null);
  const conflicts = ref<Conflict[]>([]);
  /** The commit of the stash a stopped merge or rebase holds aside (git's autostash); null. */
  const heldAside = ref<string | null>(null);
  const loaded = ref(false);
  const busy = ref(false);
  /** The last failed sequencer action or resolution, for the banner. */
  const error = ref<AppError | null>(null);
  /** The abort confirmation is up (the banner's button or the palette). */
  const abortPrompt = ref(false);
  /** The confirmation of a file taken whole from one side. */
  const takePrompt = ref<{ path: string; side: Side } | null>(null);
  /** The toast that offers to undo the last side taken: one at a time. */
  let undoToast: number | null = null;
  let serial = 0;
  /** What else reads an action's outcome (the stash git kept), registered by its store. */
  const readers: ((root: string, outcome: Outcome) => void)[] = [];

  /** Hands every outcome of a continue, skip or abort to `reader` as well. */
  function onOutcome(reader: (root: string, outcome: Outcome) => void): void {
    readers.push(reader);
  }

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
      sides.value = null;
      conflicts.value = [];
      heldAside.value = null;
      loaded.value = false;
      return;
    }
    serial += 1;
    const mine = serial;
    try {
      const [state, named, paths, held] = await Promise.all([
        ipc.operationState(root),
        // Sides that cannot be named leave the conflicts and the banner as they are, without
        // the two "Use … version" actions.
        ipc.operationSides(root).catch(() => null),
        ipc.conflicts(root),
        // A stash that cannot be read leaves the banner without its line.
        ipc.heldAside(root).catch(() => null),
      ]);
      if (mine !== serial) return;
      operation.value = state;
      sides.value = named;
      conflicts.value = paths;
      heldAside.value = held;
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
    // The stop a side was taken in ends here: its Undo goes with it.
    closeUndo();
    const opId = newOpId("sequencer");
    operations.start(opId, actionLabels[action]);
    try {
      const outcome = await ipc.sequencer(root, action, opId);
      absorb(outcome);
      for (const read of readers) read(root, outcome);
      // A step that stops again may have moved HEAD (a rebase's next pick): the refs say.
      if (outcome.kind === "conflicts") void repo.refreshRefs();
      else repo.reloadWalk(outcome.hash ?? undefined);
      return outcome;
    } catch (failure) {
      error.value = toAppError(failure);
      void load();
      void repo.refreshRefs();
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

  /**
   * A refused side or Undo, in a toast that names the file: the error's own sentence where it
   * has one, else `fallback`, which names the action as well.
   */
  function report(failure: unknown, path: string, fallback: string): void {
    const appError = toAppError(failure);
    const text = errorText(appError, path);
    const generic = text.key === "errors.gitFailed" || text.key === "errors.generic";
    toasts.push({
      kind: "error",
      message: "",
      key: generic ? fallback : text.key,
      params: text.params,
      output: appError.detail ?? appError.message,
    });
  }

  function closeUndo(): void {
    if (undoToast !== null) toasts.dismiss(undoToast);
    undoToast = null;
  }

  /** Asks to take `path` whole from `side`: a conflicted path of an operation with its sides. */
  function askTakeSide(path: string, side: Side): void {
    if (busy.value || sides.value === null) return;
    if (!conflicts.value.some((conflict) => conflict.path === path)) return;
    takePrompt.value = { path, side };
  }

  function dismissTakeSide(): void {
    takePrompt.value = null;
  }

  /** The confirmed side: git writes it, the lists follow, and the toast offers "Undo". */
  async function takeSide(): Promise<boolean> {
    const prompt = takePrompt.value;
    takePrompt.value = null;
    const root = repo.repo?.root;
    const named = sides.value;
    if (!prompt || !root || !named || busy.value) return false;
    busy.value = true;
    const opId = newOpId("take-side");
    operations.start(opId, "operations.takingSide");
    try {
      await ipc.takeSide(root, [prompt.path], prompt.side, opId);
      closeUndo();
      const side = named[prompt.side];
      undoToast = toasts.push({
        kind: "success",
        message: "",
        key: `sequencer.side.used.${side.kind}`,
        params: { file: baseName(prompt.path), ...sideParams(side) },
        actionKey: "sequencer.side.undo",
        onAction: () => void restoreConflict(root, prompt.path),
      });
      return true;
    } catch (failure) {
      report(failure, prompt.path, "sequencer.side.takeFailed");
      return false;
    } finally {
      operations.finish(opId);
      busy.value = false;
      await load();
    }
  }

  /** "Undo" of a side taken: git puts the conflict back, as it stood at the stop. */
  async function restoreConflict(root: string, path: string): Promise<boolean> {
    undoToast = null;
    if (busy.value) return false;
    busy.value = true;
    const opId = newOpId("restore-conflicts");
    operations.start(opId, "operations.restoringConflict");
    try {
      await ipc.restoreConflicts(root, [path], opId);
      return true;
    } catch (failure) {
      report(failure, path, "sequencer.side.undoFailed");
      return false;
    } finally {
      operations.finish(opId);
      busy.value = false;
      if (repo.repo?.root === root) await load();
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

  /**
   * The watcher: an operation starts or ends with the refs (its state files are refs), and the
   * conflicts are the index's unmerged entries, which a working tree change alone cannot move.
   */
  function onRepoChanged(change: RepoChanged): void {
    if (repo.state.kind !== "ready" || busy.value) return;
    const conflicts = change.kinds.includes("index") && change.conflictsChanged;
    if (change.kinds.includes("refs") || conflicts) void load();
  }

  return {
    operation,
    sides,
    conflicts,
    heldAside,
    loaded,
    busy,
    error,
    abortPrompt,
    takePrompt,
    inProgress,
    conflictCount,
    canContinue,
    canSkip,
    load,
    absorb,
    onOutcome,
    act,
    markResolved,
    askTakeSide,
    dismissTakeSide,
    takeSide,
    restoreConflict,
    dismissError,
    askAbort,
    dismissAbort,
    onRepoChanged,
  };
});
