<script setup lang="ts">
// The file header of the diff panel: the mono path, the generated and binary flags, the stats,
// the layout, wrap, whitespace and Whole file toggles, "Open in editor" (the working tree's file
// at its first change), "Mark reviewed" and, with the review rail collapsed, the control that
// brings it back.

import {
  AlignLeft,
  Check,
  Code,
  Columns2,
  FileDiff,
  PanelRightOpen,
  Rows3,
  UnfoldVertical,
  WrapText,
} from "@lucide/vue";
import { computed, toRef } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import DiffStat from "@/components/DiffStat.vue";
import IconButton from "@/components/IconButton.vue";
import { statusOf } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import { useReviewStore } from "@/stores/review";

import DiffPath from "./DiffPath.vue";
import { headerLine, useFileOpener } from "./useFileOpener";

const props = withDefaults(
  defineProps<{
    file: FileChange | null;
    /** The file would conflict in the comparison being shown. */
    conflict?: boolean;
    /** Inside the comparison: offer "Open in review" instead of the rail control. */
    inComparison?: boolean;
    railCollapsed?: boolean;
    /** The working tree the file opens from in the editor; none disables the button. */
    root?: string | null;
  }>(),
  { conflict: false, inComparison: false, railCollapsed: false, root: null },
);
const emit = defineEmits<{ showOverview: []; openInReview: [] }>();

const { t, locale } = useI18n();
const review = useReviewStore();
const opener = useFileOpener(toRef(props, "root"));
const wholeFileKeys = useShortcutHint("toggle-whole-file");
const markKeys = useShortcutHint("mark-reviewed");

const reviewed = computed(() => (props.file ? review.isReviewed(props.file.path) : false));
/** The editor button names the line it opens at when the diff tells it. */
const editorLabel = computed(() => {
  const line = props.file ? headerLine(props.file) : null;
  return line === null ? t("fileMenu.openInEditor") : t("lineMenu.openAtLine", { line });
});

/* The status word of the binary flag, in lower case ("binary, added"). */
const binaryStatus = computed(() =>
  props.file
    ? t(`statusLetter.title.${statusOf(props.file.status)}`).toLocaleLowerCase(locale.value)
    : "",
);
</script>

<template>
  <header
    class="diff-header flex h-panel-header shrink-0 items-center gap-3 border-b border-line px-3 whitespace-nowrap"
  >
    <template v-if="props.file">
      <span class="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <DiffPath :path="props.file.path" data-testid="diff-path" />
        <span v-if="props.conflict" class="text-sm text-danger" data-testid="diff-conflict">
          {{ t("review.wouldConflict") }}
        </span>
        <span v-if="props.file.isGenerated" class="text-sm text-fg-muted">
          {{ t("detail.generatedLabel") }}
        </span>
        <span v-if="props.file.isBinary" class="text-sm text-fg-muted" data-testid="diff-binary">
          {{ t("review.binaryStatus", { status: binaryStatus }) }}
        </span>
      </span>
      <DiffStat
        v-if="!props.file.isBinary"
        :added="props.file.additions"
        :removed="props.file.deletions"
      />
      <span class="flex shrink-0 items-center gap-1">
        <IconButton
          :label="t('review.unified')"
          :icon="Rows3"
          :pressed="review.layout === 'unified'"
          data-testid="layout-unified"
          @click="() => void review.setLayout('unified')"
        />
        <IconButton
          :label="t('review.sideBySide')"
          :icon="Columns2"
          :pressed="review.layout === 'side-by-side'"
          data-testid="layout-side-by-side"
          @click="() => void review.setLayout('side-by-side')"
        />
        <IconButton
          :label="t('review.wrap')"
          :icon="WrapText"
          :pressed="review.wrap"
          data-testid="toggle-wrap"
          @click="() => void review.setWrap(!review.wrap)"
        />
        <IconButton
          :label="t('review.ignoreWhitespace')"
          :icon="AlignLeft"
          :pressed="review.ignoreWhitespace"
          data-testid="toggle-whitespace"
          @click="() => void review.setIgnoreWhitespace(!review.ignoreWhitespace)"
        />
        <IconButton
          :label="t('review.wholeFile')"
          :icon="UnfoldVertical"
          :pressed="review.wholeFile"
          :keys="wholeFileKeys"
          data-testid="toggle-whole-file"
          @click="() => void review.setWholeFile(!review.wholeFile)"
        />
      </span>
      <IconButton
        :label="editorLabel"
        :icon="Code"
        :disabled="!opener.canOpen(props.file)"
        data-testid="open-in-editor"
        @click="() => props.file && void opener.openFile(props.file)"
      />
      <IconButton
        v-if="props.inComparison"
        :label="t('compare.openInReview')"
        :icon="FileDiff"
        data-testid="open-in-review"
        @click="emit('openInReview')"
      />
      <!-- A narrow panel gives "Mark reviewed"'s room to the file's name: it becomes an icon
           with its name as the tooltip (the style below). -->
      <Button
        variant="ghost"
        :icon="Check"
        :class="['header-wide', reviewed ? 'text-reviewed' : '']"
        data-testid="mark-reviewed"
        @click="review.toggleReviewed(props.file.path)"
      >
        {{ reviewed ? t("hunkRow.reviewed") : t("hunkRow.markReviewed") }}
      </Button>
      <IconButton
        :label="reviewed ? t('hunkRow.reviewed') : t('hunkRow.markReviewed')"
        :icon="Check"
        :pressed="reviewed"
        :keys="markKeys"
        class="header-narrow"
        data-testid="mark-reviewed-icon"
        @click="review.toggleReviewed(props.file.path)"
      />
    </template>
    <span v-else class="flex-1"></span>
    <IconButton
      v-if="props.railCollapsed"
      :label="t('review.showOverview')"
      :icon="PanelRightOpen"
      data-testid="show-overview"
      @click="emit('showOverview')"
    />
  </header>
</template>

<style scoped>
/* The header measures itself: below 600px "Mark reviewed" shows as an icon, so the file's
   name keeps its room at the window's narrowest panes. Off the spacing scale. */
.diff-header {
  container-type: inline-size;
}
.header-narrow {
  display: none;
}
@container (max-width: 599px) {
  .header-wide {
    display: none;
  }
  .header-narrow {
    display: inline-flex;
  }
}
</style>
