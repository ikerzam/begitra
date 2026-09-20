// The picker overlay: what it is open for ("Diff from…" or "Compare with…"),
// and what a choice does. The overlay only renders and reports the choice.

import { defineStore } from "pinia";
import { ref } from "vue";

import { useReviewStore, type ReviewTarget } from "./review";
import { useShellStore } from "./shell";

export type PickerMode = { kind: "diff-from" } | { kind: "compare"; subject: string };

/** What a row of the picker stands for. */
export type PickerChoice =
  | { kind: "revision"; rev: string }
  | { kind: "range"; from: string; to: string; threeDot: boolean }
  | { kind: "worktree"; path: string; branch: string | null };

export const usePickerStore = defineStore("picker", () => {
  const review = useReviewStore();
  const shell = useShellStore();

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
    }
    // A "compare" choice only closes the picker.
  }

  return { mode, open, close, choose };
});
