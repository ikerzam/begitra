// The picker overlay: what it is open for ("Diff from…", or "Compare <subject> with…" for
// one side of a comparison), and what a choice does. The overlay only renders and reports
// the choice.

import { defineStore } from "pinia";
import { ref } from "vue";

import { useBranchActions } from "@/branches/useBranchActions";
import { shortHash } from "@/shell/format";

import { useBranchesStore } from "./branches";
import { useCompareStore, type CompareSide } from "./compare";
import { useRepoStore } from "./repo";
import { useReviewStore, type ReviewTarget } from "./review";
import type { CompareEndpoint } from "./settings";
import { useShellStore } from "./shell";

export type PickerMode =
  | { kind: "diff-from" }
  /** A branch action on the chosen ref: checkout, merge into HEAD, rebase HEAD onto, create from. */
  | { kind: "branch-action"; action: "checkout" | "merge" | "rebase" | "create" }
  | {
      kind: "compare";
      /** The side being picked. */
      side: CompareSide;
      /** The endpoint of the other side, named in the title. */
      other: CompareEndpoint;
      /** An endpoint control's pick: the comparison shown changes in its tab, rather than
       * opening another. */
      inTab?: boolean;
    };

/** What a row of the picker stands for. */
export type PickerChoice =
  | { kind: "revision"; rev: string; label?: string }
  | { kind: "range"; from: string; to: string; threeDot: boolean }
  | { kind: "worktree"; path: string; branch: string | null };

/** The folder name of a worktree path, for its label. */
export function worktreeLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

export const usePickerStore = defineStore("picker", () => {
  const review = useReviewStore();
  const shell = useShellStore();
  const repo = useRepoStore();
  const compare = useCompareStore();
  const branches = useBranchesStore();

  const mode = ref<PickerMode | null>(null);

  function open(next: PickerMode): void {
    mode.value = next;
    shell.closePalette();
  }

  function close(): void {
    mode.value = null;
  }

  /** Applies the choice for the current mode and closes. */
  async function choose(choice: PickerChoice): Promise<void> {
    const current = mode.value;
    close();
    if (!current) return;
    if (current.kind === "branch-action") {
      await runBranchAction(current.action, choice);
      return;
    }
    if (current.kind === "diff-from") {
      let target: ReviewTarget;
      switch (choice.kind) {
        case "revision":
          target = { kind: "range", from: choice.rev, to: "HEAD", threeDot: false };
          break;
        case "range":
          target = { kind: "range", from: choice.from, to: choice.to, threeDot: choice.threeDot };
          break;
        case "worktree":
          // A worktree's branch against HEAD; a detached worktree diffs from its folder's HEAD
          // through the branch name it has none of, so the path is not enough here.
          target = {
            kind: "range",
            from: choice.branch ?? "HEAD",
            to: "HEAD",
            threeDot: false,
          };
          break;
      }
      review.setTarget(target);
      await shell.setLayoutMode("review");
      return;
    }
    const chosen = endpointOf(choice);
    if (!chosen) return;
    if (current.inTab) {
      compare.setEndpoint(current.side, chosen);
      return;
    }
    const a = current.side === "a" ? chosen : current.other;
    const b = current.side === "b" ? chosen : current.other;
    compare.open(a, b);
  }

  /** A branch action on the chosen ref: a local branch is checked out by name, the rest detached. */
  async function runBranchAction(
    action: "checkout" | "merge" | "rebase" | "create",
    choice: PickerChoice,
  ): Promise<void> {
    const endpoint = endpointOf(choice);
    if (!endpoint) return;
    const rev = endpoint.rev;
    const local = repo.refs.find(
      (entry) => entry.kind === "local-branch" && (entry.name === rev || entry.fullName === rev),
    );
    switch (action) {
      case "checkout": {
        const remoteBranch = repo.refs.find(
          (entry) =>
            entry.kind === "remote-branch" && (entry.name === rev || entry.fullName === rev),
        );
        // A remote branch checks out as the local branch that tracks it.
        if (!local && remoteBranch) useBranchActions().run("checkout", remoteBranch);
        else {
          await branches.checkout(
            local ? { kind: "branch", name: local.name } : { kind: "detached", rev },
          );
        }
        break;
      }
      case "merge":
        await branches.merge(rev, "default");
        break;
      case "rebase":
        await branches.rebase(rev);
        break;
      case "create":
        branches.ask({ kind: "create", start: rev, startLabel: endpoint.label });
        break;
    }
  }

  /** The endpoint a choice names; a range names none (compare mode lists no Range group). */
  function endpointOf(choice: PickerChoice): CompareEndpoint | null {
    switch (choice.kind) {
      case "revision":
        return { kind: "revision", rev: choice.rev, label: choice.label ?? shortHash(choice.rev) };
      case "worktree": {
        // A worktree is its checked-out commit: the branch, or the detached HEAD's hash.
        const head = repo.worktrees.find((worktree) => worktree.path === choice.path)?.head;
        const rev = choice.branch ?? head;
        return rev ? { kind: "worktree", rev, label: worktreeLabel(choice.path) } : null;
      }
      case "range":
        return null;
    }
  }

  return { mode, open, close, choose };
});
