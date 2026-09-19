<script setup lang="ts">
// The diff panel of review focus: file header and the unified hunks of the open file.

import { Check, Columns2, PanelRightOpen, Rows3 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import DiffRow from "@/components/DiffRow.vue";
import DiffStat from "@/components/DiffStat.vue";
import EmptyState from "@/components/EmptyState.vue";
import HunkRow from "@/components/HunkRow.vue";
import IconButton from "@/components/IconButton.vue";
import { statusOf } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useReviewStore } from "@/stores/review";

import { MAX_LINES, buildRows, hunkRange, hunkSymbol, lineKind, segments } from "./diffRows";
import { useHunkNavigation } from "./useHunkNavigation";

const props = withDefaults(
  defineProps<{
    file: FileChange | null;
    /** The review rail is collapsed; offer the control that brings it back. */
    railCollapsed?: boolean;
  }>(),
  { railCollapsed: false },
);
const emit = defineEmits<{ showOverview: [] }>();

const { t } = useI18n();
const review = useReviewStore();
const body = ref<HTMLElement | null>(null);

const reviewed = computed(() => (props.file ? review.reviewed.has(props.file.path) : false));
const revealed = computed(() => (props.file ? review.revealed.has(props.file.path) : false));
const guarded = computed(
  () => props.file !== null && (props.file.isLarge || props.file.isGenerated) && !revealed.value,
);

const diff = computed(() => buildRows(props.file?.hunks ?? []));

useHunkNavigation(body);
useShortcut("mark-reviewed", () => {
  if (props.file) review.toggleReviewed(props.file.path);
});
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" data-testid="diff-view">
    <header
      class="flex h-panel-header shrink-0 items-center gap-3 border-b border-line px-3 whitespace-nowrap"
    >
      <template v-if="props.file">
        <span
          class="min-w-0 flex-1 truncate font-mono text-mono-sm text-fg"
          data-testid="diff-path"
        >
          {{ props.file.path }}
        </span>
        <span v-if="props.file.isGenerated" class="text-sm text-fg-muted">
          {{ t("detail.generatedLabel") }}
        </span>
        <span v-if="props.file.isBinary" class="text-sm text-fg-muted">{{
          t("detail.binary")
        }}</span>
        <DiffStat
          v-if="!props.file.isBinary"
          :added="props.file.additions"
          :removed="props.file.deletions"
        />
        <IconButton :label="t('review.unified')" :icon="Rows3" pressed />
        <IconButton :label="t('review.sideBySide')" :icon="Columns2" disabled />
        <Button
          variant="ghost"
          :icon="Check"
          :class="reviewed ? 'text-ok' : ''"
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

    <!-- `relative` makes the body the offset parent of the hunk headers n and p scroll to. -->
    <div ref="body" class="relative min-h-0 flex-1 overflow-auto" data-testid="diff-body">
      <EmptyState v-if="!props.file" :message="t('review.noFile')" />
      <div v-else-if="props.file.isBinary" class="p-4">
        <div class="rounded-md border border-line p-4 text-md text-fg-secondary">
          {{ t("review.binaryFile", { status: statusOf(props.file.status) }) }}
        </div>
      </div>
      <div v-else-if="guarded" class="p-4" data-testid="diff-guard">
        <div
          class="flex flex-col items-start gap-3 rounded-md border border-line p-4 text-md text-fg-secondary"
        >
          <p>
            {{
              props.file.isLarge
                ? t("review.largeFile", { n: props.file.additions + props.file.deletions })
                : t("review.generatedFile")
            }}
          </p>
          <div class="flex items-center gap-2">
            <Button variant="secondary" @click="review.reveal(props.file.path)">
              {{ t("review.showAnyway") }}
            </Button>
            <Button variant="ghost" :icon="Check" @click="review.toggleReviewed(props.file.path)">
              {{ t("hunkRow.markReviewed") }}
            </Button>
          </div>
        </div>
      </div>
      <template v-else>
        <template v-for="row in diff.rows" :key="row.key">
          <HunkRow
            v-if="row.hunk"
            data-hunk
            :range="hunkRange(row.hunk)"
            :symbol="hunkSymbol(row.hunk)"
            :reviewed="reviewed"
            @toggle-reviewed="review.toggleReviewed(props.file.path)"
          />
          <DiffRow
            v-else-if="row.line"
            :kind="lineKind(row.line)"
            :old-number="row.line.oldNumber ?? undefined"
            :new-number="row.line.newNumber ?? undefined"
          >
            <template v-for="(segment, i) in segments(row.line)" :key="i">
              <span
                v-if="segment.emphasis"
                :class="row.line.kind === 'added' ? 'bg-add-emphasis' : 'bg-del-emphasis'"
                >{{ segment.text }}</span
              >
              <template v-else>{{ segment.text }}</template>
            </template>
          </DiffRow>
        </template>
        <p
          v-if="diff.truncated"
          class="px-3 py-2 text-sm text-fg-muted"
          data-testid="diff-truncated"
        >
          {{ t("review.truncated", { n: MAX_LINES }) }}
        </p>
      </template>
    </div>
  </section>
</template>
