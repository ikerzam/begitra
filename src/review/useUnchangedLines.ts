// The unchanged lines of the open file around its hunks: the new side read whole
// (`useNewSide`), the ranges the gap rows revealed (forgotten when another file opens) and the
// Whole file setting; what the rows show of them, and which new-side lines the highlighter
// should colour besides the hunks'.

import { computed, ref, watch, type Ref } from "vue";

import type { FileChange, Hunk, LineRange } from "@/ipc/schemas";
import { useReviewStore, type ReviewTarget } from "@/stores/review";

import { EXPAND_STEP, type GapRowModel, type Unchanged } from "./diffRows";
import { useNewSide } from "./useNewSide";

/** Which lines of a gap to show: all, the 20 after the change above, the 20 before the one below. */
export type RevealWhich = "all" | "next" | "previous";

/** The lines of `gap` that `which` shows. */
export function revealedRange(gap: GapRowModel, which: RevealWhich): LineRange {
  if (which === "next") {
    return { start: gap.newStart, end: Math.min(gap.newEnd, gap.newStart + EXPAND_STEP - 1) };
  }
  if (which === "previous") {
    return { start: Math.max(gap.newStart, gap.newEnd - EXPAND_STEP + 1), end: gap.newEnd };
  }
  return { start: gap.newStart, end: gap.newEnd };
}

export function useUnchangedLines(
  root: Ref<string | null>,
  target: Ref<ReviewTarget | null>,
  file: Ref<FileChange | null>,
  hunks: Ref<readonly Hunk[]>,
  /** Whether the lines are wanted: rows shown with the file's own hunks. */
  enabled: Ref<boolean>,
) {
  const review = useReviewStore();
  const side = useNewSide(root, target, file, hunks, enabled);
  const revealed = ref<LineRange[]>([]);

  watch(
    () => file.value?.path,
    () => {
      revealed.value = [];
    },
  );

  const unchanged = computed<Unchanged>(() => ({
    lines: side.lines.value,
    revealed: revealed.value,
    whole: review.wholeFile,
  }));

  /** The new side's lines shown outside the hunks: every line with Whole file. */
  const shownRanges = computed<readonly LineRange[]>(() => {
    const lines = side.lines.value;
    if (lines === null) return [];
    if (!review.wholeFile) return revealed.value;
    return lines.length > 0 ? [{ start: 1, end: lines.length }] : [];
  });

  /** Whether the gap rows can show their lines. */
  const available = computed(() => side.lines.value !== null);

  function reveal(gap: GapRowModel, which: RevealWhich): void {
    revealed.value = [...revealed.value, revealedRange(gap, which)];
  }

  return { unchanged, shownRanges, available, reveal };
}
