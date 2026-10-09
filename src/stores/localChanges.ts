// Local changes in git's way: the question a refusal asks ("Local changes in the way", with the
// ways through the operation it stopped), and the stash git kept when the changes it set aside
// came back with conflicts (a carried switch, git's autostash), for the banner's "Keep it" and
// "Drop the stash…" until it leaves the stash list or another repository opens. A stash kept
// with no conflict (the changes did not come back at all) is a toast that stays instead. The
// stash a stopped merge or rebase holds aside is followed to the operation's end, however it
// ends (the banner's Continue, whose outcome names it, the commit box or a terminal, after which
// the stash list shows it): a stash git keeps then shows the same way, once.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import * as ipc from "@/ipc/commands";
import type { Outcome } from "@/ipc/schemas";
import { shortHash } from "@/shell/format";

import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { useStashStore } from "./stash";
import { useToastsStore } from "./toasts";

export type LocalChangesOperation = "switch" | "merge" | "rebase" | "pull";
/** A switch's ways through ("carry", "leave"), or the others' ("aside": git's autostash). */
export type LocalChangesChoice = "carry" | "leave" | "aside";

export interface LocalChangesPrompt {
  operation: LocalChangesOperation;
  /** What the operation names: the branch switched to, the revision merged or rebased onto. */
  target: string;
  /** git's words, which name the files. */
  detail: string;
  /** Runs the operation again the way chosen; the dialog closes first. */
  run: (choice: LocalChangesChoice) => Promise<unknown>;
}

/** A stash git kept, in the repository it was made in. */
export interface KeptStash {
  root: string;
  stash: string;
}

export const useLocalChangesStore = defineStore("localChanges", () => {
  const repo = useRepoStore();
  const sequencer = useSequencerStore();
  const stash = useStashStore();
  const toasts = useToastsStore();

  const prompt = shallowRef<LocalChangesPrompt | null>(null);
  const kept = ref<KeptStash | null>(null);
  /** The drop of the kept stash awaits its confirmation. */
  const dropAsked = ref(false);
  /** The kept stash showed in the stash list: its absence after that means it went. */
  let listed = false;
  /** The stash a stopped operation held aside, once the operation ended: git kept it when the
   * stash list shows it. */
  let ended: KeptStash | null = null;
  /** The stashes already shown, in the banner or a toast, so that none shows twice. */
  const shownStashes = new Set<string>();

  /** The banner shows: a kept stash of this repository and no operation, which has its own. */
  const keptShown = computed(
    () =>
      kept.value !== null && kept.value.root === repo.repo?.root && sequencer.operation === "none",
  );
  /** The kept stash's row in the stash list, once listed. */
  const keptRow = computed(
    () => stash.stashes.find((row) => row.hash === kept.value?.stash) ?? null,
  );
  /** "Drop the stash…" can run: the banner shows, the stash is listed and no stash write runs. */
  const canDrop = computed(() => keptShown.value && keptRow.value !== null && stash.busy === null);

  function ask(question: LocalChangesPrompt): void {
    prompt.value = question;
  }

  function dismiss(): void {
    prompt.value = null;
  }

  async function choose(choice: LocalChangesChoice): Promise<void> {
    const question = prompt.value;
    prompt.value = null;
    if (question) await question.run(choice);
  }

  /** Keeps the stash a reapply with conflicts left in `root`, for the banner. */
  function keep(root: string, commit: string): void {
    shownStashes.add(commit);
    kept.value = { root, stash: commit };
    dropAsked.value = false;
    listed = stash.stashes.some((row) => row.hash === commit);
  }

  /** A stash git kept with no conflict: the changes did not come back, and the toast says where
   * they are, with the stash list one click away. */
  function report(commit: string): void {
    shownStashes.add(commit);
    toasts.push({
      kind: "info",
      message: "",
      key: "localChanges.stashKept",
      params: { hash: shortHash(commit) },
      sticky: true,
      actionKey: "localChanges.openStashes",
      onAction: () => stash.openSheet(),
    });
  }

  /** "Keep it": the banner goes, the stash stays. */
  function forget(): void {
    kept.value = null;
    dropAsked.value = false;
  }

  /** "Drop the stash…": the confirmation, once the stash is listed. */
  function askDrop(): void {
    if (canDrop.value) dropAsked.value = true;
  }

  function dismissDrop(): void {
    dropAsked.value = false;
  }

  /** The confirmed drop; the stash list's toast keeps the commit's hash, the way back. */
  async function drop(): Promise<boolean> {
    const row = keptRow.value;
    dropAsked.value = false;
    if (!row) return false;
    return stash.drop(row);
  }

  /** The stash git's autostash kept in an outcome: the banner with conflicts, a toast without. */
  function absorb(root: string, outcome: Outcome): void {
    if (!outcome.stash || shownStashes.has(outcome.stash)) return;
    if (outcome.kind === "conflicts") keep(root, outcome.stash);
    else report(outcome.stash);
  }

  /** The held stash of an operation that ended, when the stash list shows git kept it: the
   * conflicts its reapply left, asked of git, choose the banner or the toast. */
  function settleEnded(): void {
    const end = ended;
    if (!end || end.root !== repo.repo?.root) return;
    if (!stash.stashes.some((row) => row.hash === end.stash)) return;
    ended = null;
    if (shownStashes.has(end.stash)) return;
    shownStashes.add(end.stash);
    void ipc
      .conflicts(end.root)
      .catch(() => [])
      .then((paths) => {
        if (repo.repo?.root !== end.root) return;
        if (paths.length > 0) keep(end.root, end.stash);
        else report(end.stash);
      });
  }

  sequencer.onOutcome(absorb);

  watch(
    () => repo.repo?.root,
    (root) => {
      if (kept.value && kept.value.root !== root) forget();
      ended = null;
    },
  );
  // A confirmation asked while the banner showed goes with it.
  watch(keptShown, (shown) => {
    if (!shown) dropAsked.value = false;
  });
  watch(
    () => [repo.repo?.root, sequencer.heldAside] as const,
    ([root, held], [before, heldBefore]) => {
      if (held !== null) ended = null;
      else if (heldBefore !== null && root !== undefined && root === before) {
        ended = { root, stash: heldBefore };
        settleEnded();
      }
    },
  );
  // A stash dropped or popped, here or elsewhere, takes the banner with it; a listing taken
  // before the stash was made, landing after it, does not.
  watch(
    () => stash.stashes,
    (rows) => {
      settleEnded();
      const commit = kept.value?.stash;
      if (!commit) return;
      if (rows.some((row) => row.hash === commit)) listed = true;
      else if (listed) forget();
    },
  );

  return {
    prompt,
    kept,
    keptShown,
    keptRow,
    canDrop,
    dropAsked,
    ask,
    dismiss,
    choose,
    keep,
    forget,
    askDrop,
    dismissDrop,
    drop,
    absorb,
  };
});
