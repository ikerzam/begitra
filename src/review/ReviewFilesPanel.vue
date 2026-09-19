<script setup lang="ts">
// The files panel of review focus: count, the three hide filters and the file tree.

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import EmptyState from "@/components/EmptyState.vue";
import PanelHeader from "@/components/PanelHeader.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import FileList from "@/detail/FileList.vue";
import { applyFilters } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";

const { t } = useI18n();
const repo = useRepoStore();
const review = useReviewStore();
const list = ref<{ focus(): void } | null>(null);

const files = computed<FileChange[]>(() =>
  repo.detail ? applyFilters(repo.detail.files, review.filters) : [],
);
const count = computed(() => files.value.length);

// Open the first file when the change set arrives and nothing is open yet.
watch(
  files,
  (list) => {
    if (list.length > 0 && !list.some((file) => file.path === review.selectedPath)) {
      review.select(list[0]?.path ?? null);
    }
  },
  { immediate: true },
);

defineExpose({ focus: () => list.value?.focus() });
</script>

<template>
  <section class="flex min-w-0 flex-col border-r border-line" data-testid="review-files">
    <PanelHeader :title="t('review.files')" :count="repo.detail ? count : undefined" />
    <div v-if="repo.detail" class="flex flex-col gap-1 border-b border-line px-3 py-2">
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
      <template v-if="repo.detail?.loading && repo.detail.files.length === 0">
        <SkeletonRow v-for="n in 8" :key="n" :index="n" height="tree" />
      </template>
      <FileList
        v-else-if="repo.detail"
        ref="list"
        :files="files"
        :selected-path="review.selectedPath"
        @select="(file) => review.select(file.path)"
      />
      <EmptyState v-else :message="t('review.noCommit')" />
    </div>
  </section>
</template>
