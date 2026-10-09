// The local branches HEAD left most recently, newest first, as the engine reads them from HEAD's
// reflog: the checkout picker's Recent branches and the palette's "Checkout previous branch".
// Read again after each listing of the open repository's refs (a switch moves HEAD, which a
// listing follows); an older read's answer and another repository's are dropped, and a failed
// read lists none, which leaves the picker its Branches and the palette its other commands.
// After a write here moves HEAD, none is offered until the read that follows the next listing
// answers: the list from before names the branch just entered, or one HEAD left before it.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import * as ipc from "@/ipc/commands";

import { useRepoStore } from "./repo";

export const useRecentBranchesStore = defineStore("recentBranches", () => {
  const repo = useRepoStore();

  /** As the engine answered: newest first, at most five, the current branch aside. */
  const names = ref<string[]>([]);
  /** Bumped by each read and by another repository: only the newest read stores its answer. */
  let request = 0;
  /** HEAD moved through a write here after the last read. */
  const stale = ref(false);

  /**
   * The names the refs listing has as local branches other than HEAD's, in order: a switch or a
   * delete lands with the listing before the read that follows it answers.
   */
  const branches = computed(() =>
    stale.value
      ? []
      : names.value.filter((name) =>
          repo.refs.some(
            (entry) => entry.kind === "local-branch" && entry.name === name && !entry.isCurrent,
          ),
        ),
  );
  /** The branch HEAD left last that is there to go back to; null without one. */
  const previous = computed(() => branches.value[0] ?? null);

  /** Keeps the list it holds when `listed` is the same, so nothing built on it moves. */
  function store(listed: string[]): void {
    const same =
      listed.length === names.value.length && listed.every((name, at) => name === names.value[at]);
    if (!same) names.value = listed;
  }

  async function load(root: string): Promise<void> {
    const mine = ++request;
    try {
      const listed = await ipc.recentBranches(root);
      if (mine === request) store(listed);
    } catch {
      if (mine === request) store([]);
    }
    if (mine === request) stale.value = false;
  }

  /** A write here moved HEAD: a read on its way answers for HEAD before it. */
  function headMoved(): void {
    request += 1;
    stale.value = true;
  }

  // Another repository: its recent branches come with its first listing.
  watch(
    () => repo.repo?.root,
    () => {
      request += 1;
      stale.value = false;
      store([]);
    },
  );

  // Each listing of the refs replaces `repo.refs`.
  watch(
    () => [repo.repo?.root, repo.refs, repo.refsLoaded] as const,
    ([root, , loaded]) => {
      if (root && loaded) void load(root);
    },
    { immediate: true },
  );

  return { names, branches, previous, headMoved };
});
