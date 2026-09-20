<script setup lang="ts">
// The file header of the diff panel: the mono path, the generated
// and binary flags, the stats, the layout, wrap and whitespace toggles, "Mark reviewed" and,
// with the review rail collapsed, the control that brings it back.

import { AlignLeft, Check, Columns2, FileDiff, PanelRightOpen, Rows3, WrapText } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import DiffStat from "@/components/DiffStat.vue";
import IconButton from "@/components/IconButton.vue";
import { statusOf } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";
import { useReviewStore } from "@/stores/review";

const props = withDefaults(
  defineProps<{
    file: FileChange | null;
    /** The file would conflict in the comparison being shown. */
    conflict?: boolean;
    /** Inside the comparison: offer "Open in review" instead of the rail control. */
    inComparison?: boolean;
    railCollapsed?: boolean;
  }>(),
  { conflict: false, inComparison: false, railCollapsed: false },
);
const emit = defineEmits<{ showOverview: []; openInReview: [] }>();

const { t, locale } = useI18n();
const review = useReviewStore();

const reviewed = computed(() => (props.file ? review.isReviewed(props.file.path) : false));

/* The status word of the binary flag, in lower case ("binary, added"). */
const binaryStatus = computed(() =>
  props.file
    ? t(`statusLetter.title.${statusOf(props.file.status)}`).toLocaleLowerCase(locale.value)
    : "",
);
</script>

<template>
  <header
    class="flex h-panel-header shrink-0 items-center gap-3 border-b border-line px-3 whitespace-nowrap"
  >
    <template v-if="props.file">
      <span
        class="min-w-0 flex-1 truncate font-mono text-mono-sm text-fg-secondary"
        data-testid="diff-path"
      >
        {{ props.file.path }}
      </span>
      <span v-if="props.conflict" class="text-sm text-danger" data-testid="diff-conflict">
        {{ t("review.wouldConflict") }}
      </span>
      <span v-if="props.file.isGenerated" class="text-sm text-fg-muted">
        {{ t("detail.generatedLabel") }}
      </span>
      <span v-if="props.file.isBinary" class="text-sm text-fg-muted" data-testid="diff-binary">
        {{ t("review.binaryStatus", { status: binaryStatus }) }}
      </span>
      <DiffStat
        v-if="!props.file.isBinary"
        :added="props.file.additions"
        :removed="props.file.deletions"
      />
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
      <Button
        v-if="props.inComparison"
        variant="ghost"
        :icon="FileDiff"
        data-testid="open-in-review"
        @click="emit('openInReview')"
      >
        {{ t("compare.openInReview") }}
      </Button>
      <Button
        variant="ghost"
        :icon="Check"
        :class="reviewed ? 'text-reviewed' : ''"
        data-testid="mark-reviewed"
        @click="review.toggleReviewed(props.file.path)"
      >
        {{ reviewed ? t("hunkRow.reviewed") : t("hunkRow.markReviewed") }}
      </Button>
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
