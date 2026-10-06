<script setup lang="ts">
// The diff panel of review focus: the file header, the find bar while the find is open, and the
// body, which is the rows of the open file or one of its states: the card of a large,
// generated, binary or unmerged file, the image view, and the empty, loading and error states.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { FileChange, Hunk } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { useCodeTheme } from "@/shell/useTheme";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";

import DiffGuard from "./DiffGuard.vue";
import DiffHeader from "./DiffHeader.vue";
import DiffRows from "./DiffRows.vue";
import FindBar from "./FindBar.vue";
import ImageDiff from "./ImageDiff.vue";
import { imageType } from "./sides";
import { useOpenFileShortcut } from "./useFileOpener";

const props = withDefaults(
  defineProps<{
    file: FileChange | null;
    /** The file would conflict in the comparison being shown. */
    conflict?: boolean;
    /** Inside the comparison: the header offers "Open in review". */
    inComparison?: boolean;
    /** The review rail is collapsed; offer the control that brings it back. */
    railCollapsed?: boolean;
  }>(),
  { conflict: false, inComparison: false, railCollapsed: false },
);
const emit = defineEmits<{ showOverview: []; openInReview: [] }>();

const { t } = useI18n();
const repo = useRepoStore();
const review = useReviewStore();
const codeTheme = useCodeTheme();

const root = computed(() => repo.repo?.root ?? null);
const revealed = computed(() => (props.file ? review.revealed.has(props.file.path) : false));
const isImage = computed(() => props.file !== null && imageType(props.file.path) !== null);
const loading = computed(() => review.changeSet?.loading ?? false);
const failed = computed(() => review.changeSet?.error ?? null);
const shownHunk = computed(() => (props.file ? review.shownHunk(props.file.path) : null));
const hunks = computed<Hunk[]>(() =>
  shownHunk.value ? [shownHunk.value] : (props.file?.hunks ?? []),
);

/** Why the file sits behind the card, if it does. */
const guard = computed<"large" | "generated" | "binary" | "unmerged" | null>(() => {
  const file = props.file;
  if (!file || shownHunk.value) return null;
  if (file.isBinary && !isImage.value) return "binary";
  if (file.status === "unmerged" && file.hunks.length === 0) return "unmerged";
  if ((file.isLarge || file.isGenerated) && !revealed.value) {
    return file.isLarge ? "large" : "generated";
  }
  return null;
});

const failedMessage = computed(() => {
  if (!failed.value) return "";
  const text = errorText(failed.value);
  return t("review.diffFailed", {
    name: props.file?.path ?? t("review.theChangeSet"),
    message: t(text.key, text.params),
  });
});

useShortcut("mark-reviewed", () => {
  if (props.file) review.toggleReviewed(props.file.path);
});

/** The rows' own line at the top, read by ⇧⌘E. */
const rows = ref<{ lineAtTop: () => number | null; focus: () => void } | null>(null);
const section = ref<HTMLElement | null>(null);

/** The find closed: the rows take the focus, else (an image, a card, nothing open) the panel. */
function focusAfterFind(): void {
  if (rows.value) rows.value.focus();
  else section.value?.focus();
}
useOpenFileShortcut(
  root,
  computed(() => props.file),
  () => rows.value?.lineAtTop(),
);
</script>

<template>
  <section
    ref="section"
    class="flex min-w-0 flex-1 flex-col outline-none"
    tabindex="-1"
    data-testid="diff-view"
  >
    <DiffHeader
      :file="props.file"
      :conflict="props.conflict"
      :in-comparison="props.inComparison"
      :rail-collapsed="props.railCollapsed"
      :root="root"
      @show-overview="emit('showOverview')"
      @open-in-review="emit('openInReview')"
    />
    <FindBar @close="focusAfterFind" />

    <!-- The banner sits 24px from the header and the panel edges. -->
    <div v-if="failed" class="p-5" data-testid="diff-failed">
      <ErrorBanner
        :message="failedMessage"
        :output="failed.detail ?? failed.message"
        :action="props.file && !shownHunk ? t('review.showNewFile') : ''"
        open
        @action="() => props.file && void review.showNewFile(props.file)"
      />
    </div>

    <div
      v-if="loading && !props.file"
      class="min-h-0 flex-1 overflow-hidden bg-app"
      :data-theme="codeTheme"
      data-testid="diff-loading"
    >
      <SkeletonRow v-for="n in 24" :key="`skeleton-${n}`" :index="n" height="diff" />
    </div>
    <EmptyState v-else-if="!props.file" class="flex-1" :message="t('review.noFile')" />
    <ImageDiff
      v-else-if="isImage && root && review.target"
      :root="root"
      :target="review.target"
      :file="props.file"
    />
    <DiffGuard
      v-else-if="guard"
      :file="props.file"
      :reason="guard"
      :root="root"
      @reveal="review.reveal(props.file.path)"
    />
    <DiffRows
      v-else-if="hunks.length > 0 || !failed"
      ref="rows"
      :file="props.file"
      :hunks="hunks"
      :highlighted="true"
      :find-key="props.file.path"
    />
  </section>
</template>
