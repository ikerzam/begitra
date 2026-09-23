// "Copy as Markdown" of the review notes, shared by the Notes block and the palette: the notes
// of the current target to the clipboard, with a toast either way.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { copyText } from "@/shell/clipboard";
import { targetLabel, useReviewStore } from "@/stores/review";
import { useToastsStore } from "@/stores/toasts";

import { notesMarkdown } from "./notesMarkdown";

export function useNotesExport() {
  const { t } = useI18n();
  const review = useReviewStore();
  const toasts = useToastsStore();

  const canCopy = computed(() => review.notes.size > 0);

  /** The target's name for the heading: its label, or what the working tree and index are. */
  function label(): string {
    const target = review.target;
    if (!target) return "";
    return targetLabel(target) || t(`review.target.${target.kind}`);
  }

  async function copyNotes(): Promise<void> {
    if (!canCopy.value) return;
    const title = t("review.notesHeading", { target: label() });
    if (await copyText(notesMarkdown(title, review.notes))) {
      toasts.push({ kind: "success", message: t("review.notesCopied") });
    } else {
      toasts.push({ kind: "error", message: t("graph.clipboardUnavailable") });
    }
  }

  return { canCopy, copyNotes };
}
