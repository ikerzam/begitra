<script setup lang="ts">
// The card that stands in for a file's rows, shared by generated, large, binary and
// unmerged files: a title, one sentence, and the actions ("Show anyway" where there are
// rows to show, "Mark reviewed" always). A conflicted file of the open repository's operation
// also offers each side's version whole, before "Open in editor".

import { ArrowLeftToLine, ArrowRightToLine, Check, Code } from "@lucide/vue";
import { computed, toRef } from "vue";
import { useI18n } from "vue-i18n";

import { useSideTexts } from "@/branches/useSideTexts";
import Button from "@/components/Button.vue";
import { statusOf } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";
import { sameFolder } from "@/shell/format";
import { useCodeTheme } from "@/shell/useTheme";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useSequencerStore } from "@/stores/sequencer";

import { useFileOpener } from "./useFileOpener";

const props = withDefaults(
  defineProps<{
    file: FileChange;
    reason: "large" | "generated" | "binary" | "unmerged";
    /** Whether "Mark reviewed" is offered (not on the changes screen). */
    reviewable?: boolean;
    /** The working tree an unmerged file opens from in the editor. */
    root?: string | null;
  }>(),
  { reviewable: true, root: null },
);
/** "Show anyway": the owner reveals the file. */
const emit = defineEmits<{ reveal: [] }>();

const { t, n, locale } = useI18n();
const review = useReviewStore();
const repo = useRepoStore();
const sequencer = useSequencerStore();
const sideTexts = useSideTexts();
const opener = useFileOpener(toRef(props, "root"));
const codeTheme = useCodeTheme();

/** The operation's sides, for a conflicted file of the open repository. */
const sides = computed(() => {
  const open = repo.repo?.root;
  if (props.reason !== "unmerged" || sequencer.sides === null || !open) return null;
  if (props.root !== null && !sameFolder(props.root, open)) return null;
  const conflicted = sequencer.conflicts.some((conflict) => conflict.path === props.file.path);
  return conflicted ? sequencer.sides : null;
});

const reviewed = computed(() => review.isReviewed(props.file.path));
const binaryStatus = computed(() =>
  t(`statusLetter.title.${statusOf(props.file.status)}`).toLocaleLowerCase(locale.value),
);
const title = computed(() => {
  switch (props.reason) {
    case "large":
      return t("review.largeTitle", { n: n(props.file.additions + props.file.deletions) });
    case "generated":
      return t("review.generatedTitle", { n: n(props.file.additions) });
    case "binary":
      return t("review.binaryFile", { status: binaryStatus.value });
    case "unmerged":
      return t("review.unmergedTitle");
  }
});
const bodyKeys = {
  large: "review.largeFile",
  generated: "review.generatedFile",
  binary: "review.binaryFileBody",
  unmerged: "review.unmergedFile",
} as const;
const body = computed(() =>
  sides.value !== null ? t("review.unmergedFileSides") : t(bodyKeys[props.reason]),
);
const canShow = computed(() => props.reason === "large" || props.reason === "generated");
</script>

<template>
  <!-- The card sits 24px from the header and the panel edges. -->
  <div class="min-h-0 flex-1 bg-app p-5 text-fg" :data-theme="codeTheme" data-testid="diff-guard">
    <div
      class="flex flex-col items-start rounded-md border border-line-strong p-5 text-md text-fg-secondary"
    >
      <p class="font-medium text-fg" data-testid="diff-guard-title">{{ title }}</p>
      <p class="mt-2">{{ body }}</p>
      <!-- The actions wrap in a narrow card; a long branch name truncates in its button. -->
      <div class="mt-4 flex max-w-full flex-wrap items-center gap-2">
        <Button v-if="canShow" variant="secondary" @click="emit('reveal')">
          {{ t("review.showAnyway") }}
        </Button>
        <template v-if="sides">
          <Button
            variant="secondary"
            class="max-w-full"
            :icon="ArrowLeftToLine"
            :disabled="sequencer.busy"
            :data-tooltip="sideTexts.takeLabel(sides.ours)"
            data-testid="diff-guard-take-ours"
            @click="sequencer.askTakeSide(props.file.path, 'ours')"
          >
            <span class="min-w-0 truncate">{{ sideTexts.takeLabel(sides.ours) }}</span>
          </Button>
          <Button
            variant="secondary"
            class="max-w-full"
            :icon="ArrowRightToLine"
            :disabled="sequencer.busy"
            :data-tooltip="sideTexts.takeLabel(sides.theirs)"
            data-testid="diff-guard-take-theirs"
            @click="sequencer.askTakeSide(props.file.path, 'theirs')"
          >
            <span class="min-w-0 truncate">{{ sideTexts.takeLabel(sides.theirs) }}</span>
          </Button>
        </template>
        <Button
          v-if="props.reason === 'unmerged' && opener.canOpen(props.file)"
          :variant="sides ? 'ghost' : 'secondary'"
          :icon="Code"
          data-testid="diff-guard-editor"
          @click="() => void opener.openFile(props.file)"
        >
          {{ t("fileMenu.openInEditor") }}
        </Button>
        <Button
          v-if="props.reviewable"
          variant="ghost"
          :icon="Check"
          :class="reviewed ? 'text-reviewed' : ''"
          @click="review.toggleReviewed(props.file.path)"
        >
          {{ reviewed ? t("hunkRow.reviewed") : t("hunkRow.markReviewed") }}
        </Button>
      </div>
    </div>
  </div>
</template>
