// Commit and push: where the push of a commit box's changes would go, or why it cannot run
// (`pushPlan`), the commit followed by that push, and the commit the box's button and ⌘↵ make,
// pushed while "Push after commit" is pressed and the push can run. A push that cannot run is
// refused before anything is committed, so nothing is left half done; one that would start while
// a fetch, pull or push runs waits for it (`pushWhenFree`). The push follows its commit only in
// the repository the commit was made in.

import { ref, watch } from "vue";

import { baseName } from "@/shell/format";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";
import { useToastsStore } from "@/stores/toasts";

import { pushPlan, type PushPlan } from "./pushPlan";
import type { ChangesView } from "./useChanges";

export function useCommitAndPush() {
  const repo = useRepoStore();
  const remotes = useRemotesStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();

  /* The remotes decide a branch without upstream. The watcher marks the list stale on every refs
     change; the last list read for the open repository plans while it is read again, so the
     toggle does not flicker after each commit. */
  const known = ref<{ root: string; names: string[] } | null>(null);
  watch(
    () => [repo.state.kind, remotes.loaded] as const,
    ([state, loaded]) => {
      const root = repo.repo?.root;
      if (loaded && root) known.value = { root, names: remotes.remotes.map((r) => r.name) };
      if (state === "ready" && !loaded && !remotes.loading) void remotes.load();
    },
    { immediate: true },
  );

  function remoteNames(): readonly string[] | null {
    if (remotes.loaded) return remotes.remotes.map((remote) => remote.name);
    const root = repo.repo?.root;
    return known.value !== null && known.value.root === root ? known.value.names : null;
  }

  /** What a commit and push of `view` would do now. */
  function planFor(view: ChangesView): PushPlan {
    const head = repo.repo;
    const branch =
      head && !head.detached && head.currentBranch
        ? {
            name: head.currentBranch,
            upstream: repo.currentBranch?.upstream ?? null,
            ahead: repo.currentBranch?.ahead ?? null,
          }
        : null;
    return pushPlan({
      branch,
      remotes: remoteNames(),
      amend: view.draft.amend,
      openRepository: view.root !== null && view.root === head?.root,
    });
  }

  /** Whether the box's commit pushes: the toggle pressed and the push able to run. */
  function willPush(view: ChangesView): boolean {
    return settings.values.pushAfterCommit && planFor(view).kind !== "refused";
  }

  /** Commits, then pushes as the plan says; refused with a toast, committing nothing, otherwise. */
  async function commitAndPush(view: ChangesView): Promise<boolean> {
    if (!view.canCommit) return false;
    const plan = planFor(view);
    if (plan.kind === "refused") {
      toasts.push({ kind: "info", message: "", key: `changes.pushRefused.${plan.reason}` });
      return false;
    }
    const root = repo.repo?.root;
    const amended = view.draft.amend;
    if (!(await view.commit())) return false;
    // A switch while the commit ran (a slow hook): the push commands act on the open repository.
    if (repo.repo?.root !== root) {
      toasts.push({
        kind: "info",
        message: "",
        key: "changes.committedNotPushed",
        params: { name: baseName(root ?? "") },
      });
      return true;
    }
    if (plan.kind === "dialog") {
      remotes.ask({ kind: "push", branch: plan.branch });
      return true;
    }
    const request = {
      remote: plan.remote,
      branch: plan.branch,
      tag: null,
      delete: false,
      setUpstream: plan.publish,
      forceWithLease: false,
    };
    remotes.pushWhenFree(request, { retry: true, amended });
    return true;
  }

  /** The box's commit: the button and ⌘↵. */
  function submit(view: ChangesView): Promise<boolean> {
    return willPush(view) ? commitAndPush(view) : view.commit();
  }

  return { planFor, willPush, commitAndPush, submit };
}
