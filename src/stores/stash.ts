// The stash sheet: the stashes from the refs (`stash@{n}` with its message; the
// date when the loaded history holds the stash commit), push with a message and the untracked
// files, apply, pop and drop of the row's stash, named by its commit so that a stash made or
// dropped outside the app cannot put another under the row. A pop or apply that conflicts
// hands over to the sequencer with the stash kept, as git does.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { Outcome } from "@/ipc/schemas";
import { arm } from "@/motion/motion";
import { errorText } from "@/shell/errorMessage";
import { shortHash } from "@/shell/format";

import { useChangesStore } from "./changes";
import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

export interface StashRow {
  /** `n` of `stash@{n}`; 0 is the newest. */
  index: number;
  name: string;
  message: string;
  hash: string;
  /** The stash commit's time when the loaded history lists it. */
  time: number | null;
}

/** The index of `stash@{n}`, or null for another name. */
export function stashIndex(name: string): number | null {
  const match = /^stash@\{(\d+)\}$/.exec(name);
  return match ? Number(match[1]) : null;
}

export const useStashStore = defineStore("stash", () => {
  const repo = useRepoStore();
  const shell = useShellStore();
  const operations = useOperationsStore();
  const sequencer = useSequencerStore();
  const toasts = useToastsStore();
  const changes = useChangesStore();

  const sheetOpen = ref(false);
  /** The stash whose drop awaits confirmation. */
  const dropPrompt = ref<StashRow | null>(null);
  const busy = ref<string | null>(null);

  const stashes = computed<StashRow[]>(() =>
    repo.refs
      .filter((entry) => entry.kind === "stash")
      .map((entry) => ({
        index: stashIndex(entry.name) ?? 0,
        name: entry.name,
        message: entry.message ?? "",
        hash: entry.target,
        time: repo.commits.find((commit) => commit.hash === entry.target)?.author.time ?? null,
      }))
      .sort((a, b) => a.index - b.index),
  );

  /** Opens the sheet; the changes screen's lists load so "Stash N changes" can count. */
  function openSheet(): void {
    sheetOpen.value = true;
    if (!changes.loaded) changes.load();
  }

  function closeSheet(): void {
    sheetOpen.value = false;
    dropPrompt.value = null;
  }

  /**
   * Runs a stash write; `answered` shows git's answer before the refs are listed again, and
   * `listing` arms the list for the rows that listing brings.
   */
  async function write<T>(
    label: string,
    run: (root: string, opId: string) => Promise<T>,
    answered?: (result: T) => void,
    listing: { arm?: "stash" } = {},
  ) {
    const root = repo.repo?.root;
    if (!root || busy.value !== null) return null;
    busy.value = label;
    const opId = newOpId("stash");
    operations.start(opId, label);
    try {
      const result = await run(root, opId);
      answered?.(result);
      return result;
    } catch (failure) {
      const error = toAppError(failure);
      // A stash gone outside the app is said as such: git never ran, so "git refused" is false.
      const text =
        error.code === "stash.not_found"
          ? errorText(error)
          : { key: "stash.failed", params: { message: error.message } };
      toasts.push({
        kind: "error",
        message: "",
        key: text.key,
        params: text.params,
        output: error.detail ?? error.message,
      });
      return null;
    } finally {
      operations.finish(opId);
      busy.value = null;
      void repo.refreshRefs(listing);
    }
  }

  /** A stash git dropped (or popped without conflicts) leaves its row before the listing. */
  function dropped(hash: string): void {
    arm("stash");
    repo.patchRefs({ kind: "drop-stash", hash });
  }

  /** An apply or pop: conflicts keep the stash and hand over; the rest is a toast. */
  function settle(outcome: Outcome, key: string): void {
    if (outcome.kind === "conflicts") {
      sequencer.absorb(outcome);
      closeSheet();
      void shell.setLayoutMode("changes");
      return;
    }
    toasts.push({ kind: "success", message: "", key });
  }

  /** Pushes a stash; git says when there is nothing to save. */
  async function push(message: string | null, includeUntracked: boolean): Promise<boolean> {
    const saved = await write(
      "operations.stashing",
      (root, opId) => ipc.stashPush(root, { message, includeUntracked, paths: [] }, opId),
      undefined,
      { arm: "stash" },
    );
    if (saved === null) return false;
    toasts.push({
      kind: saved ? "success" : "info",
      message: "",
      key: saved ? "stash.pushed" : "stash.nothing",
    });
    return saved;
  }

  async function apply(row: StashRow): Promise<boolean> {
    const outcome = await write("operations.applyingStash", (root, opId) =>
      ipc.stashApply(root, row.hash, opId),
    );
    if (!outcome) return false;
    settle(outcome, "stash.applied");
    return true;
  }

  async function pop(row: StashRow): Promise<boolean> {
    const outcome = await write(
      "operations.poppingStash",
      (root, opId) => ipc.stashPop(root, row.hash, opId),
      // Conflicts keep the stash, as git does.
      (answer) => {
        if (answer.kind !== "conflicts") dropped(row.hash);
      },
    );
    if (!outcome) return false;
    settle(outcome, "stash.popped");
    return true;
  }

  function askDrop(row: StashRow): void {
    dropPrompt.value = row;
  }

  function dismissDrop(): void {
    dropPrompt.value = null;
  }

  /** Drops a stash; the toast keeps its commit hash, which brings it back until `git gc`. */
  async function drop(row: StashRow): Promise<boolean> {
    dropPrompt.value = null;
    const hash = row.hash;
    const done = await write(
      "operations.droppingStash",
      async (root, opId) => {
        await ipc.stashDrop(root, hash, opId);
        return true;
      },
      () => dropped(hash),
    );
    if (done) {
      toasts.push({
        kind: "success",
        message: "",
        key: "stash.dropped",
        params: { hash: shortHash(hash) },
        output: hash ? `git stash apply ${hash}` : "",
        actionKey: hash ? "toast.showCommand" : undefined,
      });
    }
    return done === true;
  }

  return {
    stashes,
    sheetOpen,
    dropPrompt,
    busy,
    openSheet,
    closeSheet,
    push,
    apply,
    pop,
    askDrop,
    dismissDrop,
    drop,
  };
});
