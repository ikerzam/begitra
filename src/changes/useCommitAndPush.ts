// Commit and push (⇧⌘↵ and the palette): where the push of a commit box's changes would go, or
// why it cannot run (`pushPlan`), and the commit followed by that push. A commit never pushes by
// itself: the box's Push button (`useSync`) pushes once the user presses it. A push that cannot
// run is refused before anything is committed, so nothing is left half done; one that would start
// while a fetch, pull or push runs waits for it (`pushWhenFree`). The push follows its commit only
// in the repository the commit was made in.

import { useSync } from "@/remotes/useSync";
import { baseName } from "@/shell/format";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useToastsStore } from "@/stores/toasts";

import { pushPlan, type PushPlan } from "./pushPlan";
import type { ChangesView } from "./useChanges";

export function useCommitAndPush() {
  const repo = useRepoStore();
  const remotes = useRemotesStore();
  const toasts = useToastsStore();
  const sync = useSync();

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
      remotes: sync.remoteNames(),
      amend: view.draft.amend,
      openRepository: view.root !== null && view.root === head?.root,
    });
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

  return { planFor, commitAndPush };
}
