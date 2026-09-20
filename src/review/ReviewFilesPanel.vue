<script setup lang="ts">
// The files panel of review focus: the count and the target line, the filter and collapse
// actions of the header, the path filter, the three hide toggles and the file tree, with the
// loading, empty and error states of the change set.

import { ArrowDownWideNarrow, ChevronsDownUp, ListFilter, Search } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import EmptyState from "@/components/EmptyState.vue";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import PanelHeader from "@/components/PanelHeader.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import FileList from "@/detail/FileList.vue";
import { applyFilters, pathMatcher, sortBySize } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";
import { targetLabel, useReviewStore } from "@/stores/review";

const { t } = useI18n();
const review = useReviewStore();
const list = ref<{ focus(): void; collapseAll(): void }>();
const filterInput = ref<{ $el: HTMLElement } | null>(null);

const filterOpen = ref(false);
const pathFilter = ref("");
const sortBySizeOn = ref(false);

const files = computed<FileChange[]>(() => {
  const matches = pathMatcher(pathFilter.value);
  const listed = applyFilters(review.files, review.filters).filter((file) => matches(file.path));
  return sortBySizeOn.value ? sortBySize(listed) : listed;
});
const count = computed(() => files.value.length);
const changeSet = computed(() => review.changeSet);
const targetLine = computed(() => {
  const target = review.target;
  if (!target) return "";
  switch (target.kind) {
    case "worktree":
      return t("review.target.worktree");
    case "index":
      return t("review.target.index");
    case "commit":
      return "";
    default:
      return targetLabel(target);
  }
});
const changeSetError = computed(() => changeSet.value?.error !== undefined);

// Open the first file when the change set arrives and nothing is open yet.
watch(
  files,
  (listed) => {
    if (listed.length > 0 && !listed.some((file) => file.path === review.selectedPath)) {
      review.select(listed[0]?.path ?? null);
    }
  },
  { immediate: true },
);

async function toggleFilter(): Promise<void> {
  filterOpen.value = !filterOpen.value;
  if (filterOpen.value) {
    await nextTick();
    filterInput.value?.$el.querySelector("input")?.focus();
  } else {
    pathFilter.value = "";
  }
}

/** j/k from anywhere in review focus: moves the open file through the shown list. */
function moveFile(step: 1 | -1): void {
  const listed = files.value;
  if (listed.length === 0) return;
  const at = listed.findIndex((file) => file.path === review.selectedPath);
  const next = at < 0 ? (step > 0 ? 0 : listed.length - 1) : at + step;
  const file = listed[Math.min(Math.max(next, 0), listed.length - 1)];
  if (file) review.select(file.path);
}

defineExpose({ focus: () => list.value?.focus(), moveFile });
</script>

<template>
  <section class="flex min-w-0 flex-col border-r border-line" data-testid="review-files">
    <PanelHeader :title="t('review.files')" :count="changeSet ? count : undefined">
      <span
        v-if="targetLine"
        class="truncate font-mono text-mono-sm text-fg-secondary"
        data-testid="review-target"
      >
        {{ targetLine }}
      </span>
      <template #actions>
        <IconButton
          :label="t('review.filterPaths')"
          :icon="ListFilter"
          :pressed="filterOpen"
          data-testid="files-filter"
          @click="() => void toggleFilter()"
        />
        <IconButton
          :label="t('review.sortBySize')"
          :icon="ArrowDownWideNarrow"
          :pressed="sortBySizeOn"
          data-testid="files-sort"
          @click="sortBySizeOn = !sortBySizeOn"
        />
        <IconButton
          :label="t('review.collapseAll')"
          :icon="ChevronsDownUp"
          data-testid="files-collapse"
          @click="list?.collapseAll()"
        />
      </template>
    </PanelHeader>
    <div v-if="filterOpen" class="border-b border-line px-3 py-2">
      <Input
        ref="filterInput"
        v-model="pathFilter"
        :placeholder="t('review.filterPlaceholder')"
        :icon="Search"
        data-testid="files-filter-input"
        @keydown.escape="() => void toggleFilter()"
      />
    </div>
    <div v-if="changeSet" class="flex flex-col gap-1 border-b border-line px-3 py-2">
      <Checkbox
        :model-value="review.filters.hideGenerated"
        :label="t('review.hideGenerated')"
        @update:model-value="review.setFilter('hideGenerated', $event)"
      />
      <Checkbox
        :model-value="review.filters.hideLockfiles"
        :label="t('review.hideLockfiles')"
        @update:model-value="review.setFilter('hideLockfiles', $event)"
      />
      <Checkbox
        :model-value="review.filters.hideTests"
        :label="t('review.hideTests')"
        @update:model-value="review.setFilter('hideTests', $event)"
      />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <template v-if="changeSet?.loading && changeSet.files.length === 0">
        <SkeletonRow v-for="n in 8" :key="n" :index="n" height="tree" />
      </template>
      <FileList
        v-if="changeSet"
        ref="list"
        :files="files"
        :selected-path="review.selectedPath"
        :reviewed="review.reviewedFiles"
        @select="(file) => review.select(file.path)"
      />
      <EmptyState
        v-if="changeSet && !changeSet.loading && count === 0 && !changeSetError"
        :message="pathFilter ? t('review.noMatches') : t('review.noChanges')"
        data-testid="review-empty"
      />
      <EmptyState v-if="!changeSet" :message="t('review.noCommit')" />
    </div>
  </section>
</template>
