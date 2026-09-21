// The actions of a branch, remote branch or tag, run from the sidebar rows'
// menu and from the graph's ref badges: checkout (a local branch by name, the rest detached
// at their commit), the dialogs of the branches store, a merge or rebase, the comparison
// with the current branch, a push.

import type { Ref as GitRef } from "@/ipc/schemas";
import { useBranchesStore } from "@/stores/branches";
import { useCompareStore } from "@/stores/compare";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";

/** What the menu offers; `checkout` is Enter on a sidebar row too. */
export type BranchAction =
  | "checkout"
  | "createHere"
  | "merge"
  | "rebase"
  | "compare"
  | "rename"
  | "setUpstream"
  | "push"
  | "delete"
  | "deleteTag";

export function useBranchActions() {
  const repo = useRepoStore();

  /** A local branch is checked out by name, a remote branch or a tag detached at its commit. */
  function checkout(ref: GitRef): void {
    if (ref.isCurrent) return;
    void useBranchesStore().checkout(
      ref.kind === "local-branch"
        ? { kind: "branch", name: ref.name }
        : { kind: "detached", rev: ref.name },
    );
  }

  function compareWith(ref: GitRef): void {
    const branch = repo.currentBranch;
    void useCompareStore().open(
      branch
        ? { kind: "revision", rev: branch.fullName, label: branch.name }
        : { kind: "revision", rev: "HEAD", label: "HEAD" },
      { kind: "revision", rev: ref.fullName, label: ref.name },
    );
  }

  function run(kind: BranchAction, ref: GitRef): void {
    const branches = useBranchesStore();
    switch (kind) {
      case "checkout":
        checkout(ref);
        break;
      case "createHere":
        branches.ask({ kind: "create", start: ref.name, startLabel: ref.name });
        break;
      case "merge":
        void branches.merge(ref.name, "default");
        break;
      case "rebase":
        void branches.rebase(ref.name);
        break;
      case "compare":
        compareWith(ref);
        break;
      case "rename":
        branches.ask({ kind: "rename", name: ref.name });
        break;
      case "setUpstream":
        branches.ask({ kind: "upstream", branch: ref.name, current: ref.upstream ?? null });
        break;
      case "push":
        useRemotesStore().ask({ kind: "push", branch: ref.name });
        break;
      case "delete":
        branches.ask({ kind: "delete", name: ref.name, force: false, output: "" });
        break;
      case "deleteTag":
        void branches.deleteTag(ref.name);
        break;
    }
  }

  return { run, checkout, compareWith };
}
