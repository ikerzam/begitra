<script setup lang="ts">
// Review focus: two 48px rails, the files panel, the diff panel and the review rail, which
// collapses under 1100px until the user asks for it.

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { applyFilters } from "@/detail/groupFiles";
import DiffView from "@/review/DiffView.vue";
import GraphRail from "@/review/GraphRail.vue";
import ReviewFilesPanel from "@/review/ReviewFilesPanel.vue";
import ReviewRail from "@/review/ReviewRail.vue";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { paneLimits, useShellStore, type SidebarTab } from "@/stores/shell";

import PaneResizer from "./PaneResizer.vue";
import SidebarRail from "./SidebarRail.vue";

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();
const review = useReviewStore();
const filesPanel = ref<{ focus(): void } | null>(null);

const files = computed(() => (repo.detail ? applyFilters(repo.detail.files, review.filters) : []));
const openFile = computed(
  () => files.value.find((file) => file.path === review.selectedPath) ?? null,
);
const filesWidth = computed(() => `${shell.paneSizes.files}px`);
const railWidth = computed(() => `${shell.paneSizes.reviewRail}px`);

watch(
  () => repo.detail?.hash ?? null,
  (hash) => review.forCommit(hash),
  { immediate: true },
);

async function leaveToSidebar(tab: SidebarTab): Promise<void> {
  await shell.setLayoutMode("graph");
  await shell.expandSidebar(tab);
}

defineExpose({ focusFiles: () => filesPanel.value?.focus() });
</script>

<template>
  <div class="flex min-h-0 flex-1" data-testid="review-focus">
    <SidebarRail :active="shell.sidebarTab" @select="(tab) => void leaveToSidebar(tab)" />
    <GraphRail
      :commits="repo.commits"
      :selected-index="repo.selectedIndex"
      @select="(index) => repo.select(index)"
      @back="() => void shell.setLayoutMode('graph')"
    />
    <ReviewFilesPanel ref="filesPanel" class="shrink-0" :style="{ width: filesWidth }" />
    <PaneResizer
      :size="shell.paneSizes.files"
      :min="paneLimits.files.min"
      :max="paneLimits.files.max"
      :label="t('review.files')"
      @resize="(px) => void shell.setPaneSize('files', px)"
    />
    <DiffView
      :file="openFile"
      :rail-collapsed="shell.reviewRailCollapsed"
      @show-overview="shell.showReviewRail()"
    />
    <template v-if="!shell.reviewRailCollapsed">
      <PaneResizer
        :size="shell.paneSizes.reviewRail"
        :direction="-1"
        :min="paneLimits.reviewRail.min"
        :max="paneLimits.reviewRail.max"
        :label="t('review.overview')"
        @resize="(px) => void shell.setPaneSize('reviewRail', px)"
      />
      <ReviewRail
        class="shrink-0"
        :style="{ width: railWidth }"
        :files="files"
        :reviewed-count="review.reviewedCount"
        @hide="shell.hideReviewRail()"
      />
    </template>
  </div>
</template>
