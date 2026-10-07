// Fetch, Pull and Push for the open repository, one click each: the top bar's buttons, the commit
// box's Push, their keys and the palette read what each would do now (`syncPlan`) and run it.
// Pull sends a fast-forward-only request, or opens the dialog on a branch that diverged; Push
// goes to the upstream, publishes to the only remote, or opens the dialog with several. Nothing
// is offered until the refs are listed: before that a branch reads as having no upstream.

import { computed, ref, watch } from "vue";

import type { Remote } from "@/ipc/schemas";
import { useBulkStore } from "@/stores/bulk";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useSequencerStore } from "@/stores/sequencer";

import { fetchPlan, pullPlan, syncPushPlan, type SyncInput } from "./syncPlan";

/** The latest FETCH_HEAD time of the remotes (Unix seconds), or null when none fetched. */
function latestFetch(list: readonly Remote[]): number | null {
  const latest = Math.max(0, ...list.map((remote) => remote.fetchedAt ?? 0));
  return latest > 0 ? latest : null;
}

export function useSync() {
  const repo = useRepoStore();
  const remotes = useRemotesStore();
  const bulk = useBulkStore();
  const sequencer = useSequencerStore();

  /* The watcher marks the remotes stale on every refs change; the last list read for the open
     repository answers while it is read again, so the buttons do not flicker after a push. Every
     list read (the remotes sheet reads them again without marking them stale) replaces it. */
  const known = ref<{ root: string; names: string[]; fetchedAt: number | null } | null>(null);
  watch(
    () => [repo.state.kind, remotes.loaded, remotes.remotes] as const,
    ([state, loaded, list]) => {
      const root = repo.repo?.root;
      if (loaded && root) {
        known.value = {
          root,
          names: list.map((remote) => remote.name),
          fetchedAt: latestFetch(list),
        };
      }
      if (state === "ready" && !loaded && !remotes.loading) void remotes.load();
    },
    { immediate: true },
  );

  /** The last list read for the open repository; null for another one or none. */
  function knownHere() {
    const root = repo.repo?.root;
    return known.value !== null && known.value.root === root ? known.value : null;
  }

  /** The open repository's remotes as last read; null while they are first read. */
  function remoteNames(): readonly string[] | null {
    if (remotes.loaded) return remotes.remotes.map((remote) => remote.name);
    return knownHere()?.names ?? null;
  }

  /** When the repository last fetched (FETCH_HEAD's time, Unix seconds), or null. */
  const fetchedAt = computed(() =>
    remotes.loaded ? latestFetch(remotes.remotes) : (knownHere()?.fetchedAt ?? null),
  );

  const input = computed<SyncInput>(() => {
    const head = repo.repo;
    const current = repo.currentBranch;
    return {
      ready: repo.state.kind === "ready" && head !== null && repo.refsLoaded,
      branch:
        head && !head.detached && head.currentBranch
          ? {
              name: head.currentBranch,
              upstream: current?.upstream ?? null,
              ahead: current?.ahead ?? null,
              behind: current?.behind ?? null,
              // A branch with no commit has no ref to list.
              unborn: current === undefined,
              // The engine counts nothing against an upstream deleted on the remote.
              gone: !!current?.upstream && current.ahead === null && current.behind === null,
            }
          : null,
      remotes: remoteNames(),
      busy: remotes.inFlight !== null || bulk.running,
      operation: sequencer.inProgress,
    };
  });

  const fetch = computed(() => fetchPlan(input.value));
  const pull = computed(() => pullPlan(input.value));
  const push = computed(() => syncPushPlan(input.value));

  async function runFetch(): Promise<void> {
    if (fetch.value.kind === "fetch") await remotes.fetch(null, false);
  }

  async function runPull(): Promise<void> {
    const plan = pull.value;
    if (plan.kind === "dialog") remotes.ask({ kind: "pull", branch: plan.branch });
    else if (plan.kind === "pull") {
      await remotes.pull({ remote: null, branch: null, rebase: false, ffOnly: true });
    }
  }

  async function runPush(): Promise<void> {
    const plan = push.value;
    if (plan.kind === "dialog") remotes.ask({ kind: "push", branch: plan.branch });
    else if (plan.kind === "push") {
      await remotes.push({
        remote: plan.remote,
        branch: plan.branch,
        tag: null,
        delete: false,
        setUpstream: plan.publish,
        forceWithLease: false,
      });
    }
  }

  return { fetch, pull, push, fetchedAt, remoteNames, runFetch, runPull, runPush };
}
